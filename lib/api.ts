const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

type IdempotencyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const IDEMPOTENCY_STORAGE_PREFIX = 'zero:pending-request:v1:';

function getIdempotencyStorage(): IdempotencyStorage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}

async function getRequestFingerprint(url: string, body: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Sichere ZERO-Wiederholungskennung ist auf diesem Gerät nicht verfügbar.');
  const input = new TextEncoder().encode(`${url}\n${body}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Reuses a pending logical request key across retries/reloads, then clears it after a definitive response. */
export async function getOrCreatePersistentIdempotencyKey(
  url: string, body: string, storage: IdempotencyStorage | undefined = getIdempotencyStorage(),
  createKey: () => string = () => globalThis.crypto.randomUUID(),
): Promise<{ key: string; clear: () => Promise<void> }> {
  if (!storage) throw new Error('ZERO kann keine sichere Wiederholungskennung dauerhaft speichern. Bitte Speicherzugriff aktivieren und erneut versuchen.');
  const slot = IDEMPOTENCY_STORAGE_PREFIX + await getRequestFingerprint(url, body);
  const existing = storage.getItem(slot);
  const key = existing && existing.length >= 8 && existing.length <= 200 ? existing : createKey();
  if (!existing) storage.setItem(slot, key);
  return { key, clear: async () => { if (storage.getItem(slot) === key) storage.removeItem(slot); } };
}


function readApiError(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const message = (payload as { error?: unknown }).error;
    if (typeof message === 'string' && message.trim()) return message;
  }
  if (typeof payload === 'string' && payload.trim()) return payload;
  return `HTTP Fehler ${status}`;
}

export async function apiRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const callerSignal = options?.signal;
  const timeoutId = setTimeout(
    () => controller.abort(new DOMException('Anfrage hat das Zeitlimit überschritten.', 'TimeoutError')),
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const forwardCallerAbort = () => controller.abort(callerSignal?.reason);

  if (callerSignal?.aborted) {
    forwardCallerAbort();
  } else {
    callerSignal?.addEventListener('abort', forwardCallerAbort, { once: true });
  }

  const headers = new Headers(options?.headers);
  const method = (options?.method ?? 'GET').toUpperCase();
  let persistentIdempotency: Awaited<ReturnType<typeof getOrCreatePersistentIdempotencyKey>> | undefined;
  if (method === 'POST' && url.startsWith('/api/') && typeof options?.body === 'string' && !headers.has('Idempotency-Key')) {
    persistentIdempotency = await getOrCreatePersistentIdempotencyKey(url, options.body);
    headers.set('Idempotency-Key', persistentIdempotency.key);
  }
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');

  const { signal: _ignoredSignal, ...requestOptions } = options ?? {};

  try {
    const response = await fetch(url, {
      ...requestOptions,
      headers,
      credentials: requestOptions.credentials ?? 'same-origin',
      signal: controller.signal,
    });

    const responseText = await response.text();
    let payload: unknown = null;
    if (responseText) {
      try {
        payload = JSON.parse(responseText);
      } catch {
        payload = responseText;
      }
    }

    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) await persistentIdempotency?.clear();
      throw new Error(readApiError(payload, response.status));
    }
    await persistentIdempotency?.clear();

    if (typeof payload === 'string') {
      throw new Error('Der Server hat keine gültige JSON-Antwort gesendet.');
    }
    return payload as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      if (callerSignal?.aborted) throw new Error('Anfrage wurde abgebrochen.');
      throw new Error('ZERO hat zu lange auf den Server gewartet (3 Minuten). Bitte erneut versuchen.');
    }
    if (controller.signal.aborted && !callerSignal?.aborted) {
      throw new Error('ZERO hat zu lange auf den Server gewartet (3 Minuten). Bitte erneut versuchen.');
    }
    if (error instanceof TypeError) {
      throw new Error('ZERO konnte den Server nicht erreichen. Prüfe deine Internetverbindung und versuche es erneut.');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    callerSignal?.removeEventListener('abort', forwardCallerAbort);
  }
}
