import type { RequestHandler } from 'express';

export type ConcurrencyGate = {
  middleware: RequestHandler;
  activeCount: () => number;
};

/**
 * Bounds concurrent memory-heavy requests in one Node.js process.
 * The slot is released on either response completion or client disconnect.
 */
export function createConcurrencyGate(maxConcurrent: number, retryAfterSeconds = 5): ConcurrencyGate {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error('maxConcurrent must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
    throw new Error('retryAfterSeconds must be a positive safe integer.');
  }

  let active = 0;
  const middleware: RequestHandler = (_req, res, next) => {
    if (active >= maxConcurrent) {
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        error: 'Zu viele gleichzeitige ZIP-Operationen. Bitte später erneut versuchen.',
        code: 'ZIP_CONCURRENCY_LIMIT',
      });
      return;
    }

    active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active--;
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  };

  return { middleware, activeCount: () => active };
}
