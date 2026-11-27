const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const volatileIdempotencyKeys = new Map<string, string>();

type KeyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultKeyStorage(): KeyStorage | undefined {
  try { return typeof window !== 'undefined' ? window.localStorage : undefined; } catch { return undefined; }
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  // This fallback only namespaces local retry records; the actual key remains random.
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export async function getStableIdempotencyKey(
  url: string,
  body: string,
  storage: KeyStorage | undefined = defaultKeyStorage(),
  createKey: () => string = () => globalThis.crypto?.randomUUID?.() ?? `zero-${Date.now()}-${Math.random().toString(36).slice(2)}`,
): Promise<string> {
  const storageKey = `zero:idempotency:${await sha256Hex(`${url}\n${body}`)}`;
  try {
    const existing = storage?.getItem(storageKey) ?? volatileIdempotencyKeys.get(storageKey);
    if (existing) return existing;
  } catch { /* private browsing may deny storage; keep a page-local retry key */ }
  const key = createKey();
  volatileIdempotencyKeys.set(storageKey, key);
  try { storage?.setItem(storageKey, key); } catch { /* page-local fallback remains available */ }
  return key;
}

export async function clearStableIdempotencyKey(
  url: string,
  body: string,
  storage: KeyStorage | undefined = defaultKeyStorage(),
): Promise<void> {
  const storageKey = `zero:idempotency:${await sha256Hex(`${url}\n${body}`)}`;
  volatileIdempotencyKeys.delete(storageKey);
  try { storage?.removeItem(storageKey); } catch { /* best-effort cleanup */ }
}

export interface ZeroOperationStatus {
  operationId: string;
  status: 'RESERVED' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  dayUtc: string;
  resourceType: 'text' | 'image' | 'audio' | 'video';
  reservedUnits: number;
  updatedAt: string;
}

export class ApiRequestError extends Error {
  readonly code?: string;
  readonly operation?: { operationId?: string; status?: string };
  readonly recovery?: ZeroOperationStatus;

  constructor(message: string, readonly status: number, readonly payload: unknown, recovery?: ZeroOperationStatus) {
    super(message);
    this.name = 'ApiRequestError';
    const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    this.code = typeof data.code === 'string' ? data.code : undefined;
    this.operation = data.operation && typeof data.operation === 'object'
      ? data.operation as { operationId?: string; status?: string } : undefined;
    this.recovery = recovery;
  }
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

  if (callerSignal?.aborted) forwardCallerAbort();
  else callerSignal?.addEventListener('abort', forwardCallerAbort, { once: true });

  const headers = new Headers(options?.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  const method = (options?.method ?? 'GET').toUpperCase();
  const body = typeof options?.body === 'string' ? options.body : undefined;
  const ownsIdempotencyKey = method === 'POST' && url.startsWith('/api/') && Boolean(body) && !headers.has('Idempotency-Key');
  if (ownsIdempotencyKey && body) headers.set('Idempotency-Key', await getStableIdempotencyKey(url, body));

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
      try { payload = JSON.parse(responseText); } catch { payload = responseText; }
    }

    if (!response.ok) {
      let recovery: ZeroOperationStatus | undefined;
      const errorData = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      const operation = errorData.operation && typeof errorData.operation === 'object'
        ? errorData.operation as { operationId?: unknown } : undefined;
      if (errorData.code === 'OPERATION_REPLAY' && typeof operation?.operationId === 'string') {
        try {
          const statusResponse = await fetch(`/api/zero/operations/${encodeURIComponent(operation.operationId)}`, {
            credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
          });
          if (statusResponse.ok) {
            const statusPayload = await statusResponse.json() as { operation?: ZeroOperationStatus };
            recovery = statusPayload.operation;
          }
        } catch { /* the original replay metadata remains available */ }
      }
      const message = recovery
        ? `${readApiError(payload, response.status)} Aktueller Auftragsstatus: ${recovery.status}.`
        : readApiError(payload, response.status);
      throw new ApiRequestError(message, response.status, payload, recovery);
    }

    if (typeof payload === 'string') throw new Error('Der Server hat keine gültige JSON-Antwort gesendet.');
    if (ownsIdempotencyKey && body) await clearStableIdempotencyKey(url, body);
    return payload as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      if (callerSignal?.aborted) throw new Error('Anfrage wurde abgebrochen.');
      throw new Error('ZERO hat zu lange auf den Server gewartet (3 Minuten). Bitte denselben Auftrag erneut versuchen.');
    }
    if (controller.signal.aborted && !callerSignal?.aborted) {
      throw new Error('ZERO hat zu lange auf den Server gewartet (3 Minuten). Bitte denselben Auftrag erneut versuchen.');
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
