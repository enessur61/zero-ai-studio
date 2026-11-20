export type ProjectVideoRecoveryState = 'ready' | 'offline' | 'session-expired' | 'missing' | 'error';

export type RecoveryFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type ProjectVideoMediaFailure = 'network' | 'decode' | 'unsupported' | 'aborted' | 'unknown';

export function classifyProjectVideoMediaError(code: number | null | undefined): ProjectVideoMediaFailure {
  if (code === 2) return 'network';
  if (code === 3) return 'decode';
  if (code === 4) return 'unsupported';
  if (code === 1) return 'aborted';
  return 'unknown';
}

export async function probeProjectVideoAccess(
  url: string,
  fetcher: RecoveryFetch = fetch,
  signal?: AbortSignal,
): Promise<ProjectVideoRecoveryState> {
  try {
    const auth = await fetcher('/api/auth/status', {
      credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json' }, signal,
    });
    if (auth.status === 401 || auth.status === 403) return 'session-expired';
    if (!auth.ok) return 'error';
    const authPayload = await auth.json() as { authenticated?: unknown };
    if (authPayload.authenticated !== true) return 'session-expired';

    const response = await fetcher(url, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: { Range: 'bytes=0-0' }, signal,
    });
    if (response.status === 401 || response.status === 403) return 'session-expired';
    if (response.status === 404 || response.status === 410) return 'missing';
    const contentRange = response.headers.get('content-range');
    const contentLength = response.headers.get('content-length');
    const acceptsRanges = response.headers.get('accept-ranges');
    if (response.status !== 206 || !contentRange || !/^bytes 0-0\/\d+$/.test(contentRange) ||
        contentLength !== '1' || acceptsRanges?.toLowerCase() !== 'bytes') {
      await response.body?.cancel().catch(() => undefined);
      return 'error';
    }
    await response.body?.cancel().catch(() => undefined);
    return 'ready';
  } catch (error) {
    return error instanceof TypeError ? 'offline' : 'error';
  }
}

export interface ProjectVideoRecoveryOptions {
  url: string;
  onState: (state: ProjectVideoRecoveryState) => void;
  onResume: () => void;
  onMediaFailure?: (failure: ProjectVideoMediaFailure) => void;
  getMediaErrorCode?: () => number | null | undefined;
  fetcher?: RecoveryFetch;
  windowTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  documentTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  mediaTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  isVisible?: () => boolean;
  probeTimeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

export function watchProjectVideoRecovery(options: ProjectVideoRecoveryOptions): () => void {
  const windowTarget = options.windowTarget ?? window;
  const documentTarget = options.documentTarget ?? document;
  const mediaTarget = options.mediaTarget;
  const isVisible = options.isVisible ?? (() => document.visibilityState !== 'hidden');
  const timeoutMs = Math.max(250, options.probeTimeoutMs ?? 8000);
  const maxRetries = Math.max(0, options.maxRetries ?? 3);
  const retryBaseDelayMs = Math.max(50, options.retryBaseDelayMs ?? 500);
  let disposed = false;
  let interrupted = false;
  let checking = false;
  let retryRequested = false;
  let retryAttempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let activeController: AbortController | undefined;

  const clearRetry = () => {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
  };
  const scheduleRetry = () => {
    if (disposed || !isVisible() || retryTimer !== undefined || retryAttempts >= maxRetries) return;
    const delay = Math.min(4000, retryBaseDelayMs * (2 ** retryAttempts));
    retryAttempts += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void check();
    }, delay);
  };

  const check = async () => {
    if (disposed || !isVisible()) return;
    if (checking) {
      retryRequested = true;
      return;
    }
    checking = true;
    const controller = new AbortController();
    activeController = controller;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const state = await probeProjectVideoAccess(options.url, options.fetcher, controller.signal);
      if (disposed) return;
      options.onState(state);
      if (state === 'offline' || state === 'error') {
        interrupted = true;
        scheduleRetry();
      } else if (state === 'session-expired' || state === 'missing') {
        interrupted = state === 'session-expired';
        clearRetry();
        retryAttempts = 0;
      } else if (state === 'ready') {
        clearRetry();
        retryAttempts = 0;
        if (interrupted) {
          interrupted = false;
          options.onResume();
        }
      }
    } finally {
      clearTimeout(timeout);
      if (activeController === controller) activeController = undefined;
      checking = false;
      if (!disposed && retryRequested && isVisible()) {
        retryRequested = false;
        clearRetry();
        retryAttempts = 0;
        void check();
      }
    }
  };

  const markBackgrounded = () => { interrupted = true; };
  const markOffline = () => {
    interrupted = true;
    clearRetry();
    options.onState('offline');
  };
  const onMediaError = () => {
    const failure = classifyProjectVideoMediaError(options.getMediaErrorCode?.());
    options.onMediaFailure?.(failure);
    if (failure === 'aborted') return;
    if (failure === 'network') {
      interrupted = true;
      void check();
    } else {
      clearRetry();
      retryAttempts = 0;
      options.onState('error');
    }
  };
  const resumeIfVisible = () => {
    if (!isVisible()) return;
    clearRetry();
    retryAttempts = 0;
    void check();
  };
  const onVisibilityChange = () => {
    if (isVisible()) resumeIfVisible();
    else markBackgrounded();
  };

  windowTarget.addEventListener('online', resumeIfVisible);
  windowTarget.addEventListener('offline', markOffline);
  windowTarget.addEventListener('focus', resumeIfVisible);
  windowTarget.addEventListener('pageshow', resumeIfVisible);
  windowTarget.addEventListener('pagehide', markBackgrounded);
  documentTarget.addEventListener('visibilitychange', onVisibilityChange);
  mediaTarget?.addEventListener('error', onMediaError);
  void check();

  return () => {
    disposed = true;
    clearRetry();
    activeController?.abort();
    windowTarget.removeEventListener('online', resumeIfVisible);
    windowTarget.removeEventListener('offline', markOffline);
    windowTarget.removeEventListener('focus', resumeIfVisible);
    windowTarget.removeEventListener('pageshow', resumeIfVisible);
    windowTarget.removeEventListener('pagehide', markBackgrounded);
    documentTarget.removeEventListener('visibilitychange', onVisibilityChange);
    mediaTarget?.removeEventListener('error', onMediaError);
  };
}
