export type ProjectVideoRecoveryState = 'ready' | 'offline' | 'session-expired' | 'missing' | 'error';

export type RecoveryFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function probeProjectVideoAccess(
  url: string,
  fetcher: RecoveryFetch = fetch,
): Promise<ProjectVideoRecoveryState> {
  try {
    const auth = await fetcher('/api/auth/status', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (auth.status === 401 || auth.status === 403) return 'session-expired';
    if (!auth.ok) return 'error';
    const authPayload = await auth.json() as { authenticated?: unknown };
    if (authPayload.authenticated !== true) return 'session-expired';

    const response = await fetcher(url, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Range: 'bytes=0-0' },
    });
    if (response.status === 401 || response.status === 403) return 'session-expired';
    if (response.status === 404 || response.status === 410) return 'missing';
    const contentRange = response.headers.get('content-range');
    const contentLength = response.headers.get('content-length');
    const acceptsRanges = response.headers.get('accept-ranges');
    if (
      response.status !== 206 ||
      !contentRange ||
      !/^bytes 0-0\/\d+$/.test(contentRange) ||
      contentLength !== '1' ||
      acceptsRanges?.toLowerCase() !== 'bytes'
    ) {
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
  fetcher?: RecoveryFetch;
  windowTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  documentTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  mediaTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  isVisible?: () => boolean;
}

export function watchProjectVideoRecovery(options: ProjectVideoRecoveryOptions): () => void {
  const windowTarget = options.windowTarget ?? window;
  const documentTarget = options.documentTarget ?? document;
  const mediaTarget = options.mediaTarget;
  const isVisible = options.isVisible ?? (() => document.visibilityState !== 'hidden');
  let disposed = false;
  let interrupted = false;
  let checking = false;
  let retryRequested = false;

  const check = async () => {
    if (disposed || !isVisible()) return;
    if (checking) {
      retryRequested = true;
      return;
    }
    checking = true;
    try {
      const state = await probeProjectVideoAccess(options.url, options.fetcher);
      if (disposed) return;
      options.onState(state);
      if (state === 'offline' || state === 'session-expired') interrupted = true;
      if (state === 'ready' && interrupted) {
        interrupted = false;
        options.onResume();
      }
    } finally {
      checking = false;
      if (!disposed && retryRequested && isVisible()) {
        retryRequested = false;
        void check();
      }
    }
  };

  const markBackgrounded = () => { interrupted = true; };
  const markOffline = () => { interrupted = true; options.onState('offline'); };
  const onMediaError = () => { interrupted = true; void check(); };
  const resumeIfVisible = () => { if (isVisible()) void check(); };
  const onVisibilityChange = () => {
    if (isVisible()) void check();
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
    windowTarget.removeEventListener('online', resumeIfVisible);
    windowTarget.removeEventListener('offline', markOffline);
    windowTarget.removeEventListener('focus', resumeIfVisible);
    windowTarget.removeEventListener('pageshow', resumeIfVisible);
    windowTarget.removeEventListener('pagehide', markBackgrounded);
    documentTarget.removeEventListener('visibilitychange', onVisibilityChange);
    mediaTarget?.removeEventListener('error', onMediaError);
  };
}
