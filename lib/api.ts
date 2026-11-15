const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

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
      throw new Error(readApiError(payload, response.status));
    }

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
