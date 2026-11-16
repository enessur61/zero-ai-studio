import type { RequestHandler } from 'express';

/**
 * Express 4 does not automatically forward rejected promises returned by route
 * handlers. Also release operation-scoped resources only after the handler has
 * settled; response close alone does not mean asynchronous work has stopped.
 */
export function asyncRoute(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next))
      .catch(next)
      .finally(async () => {
        const settle = res.locals?.zeroConcurrencyHandlerSettled;
        if (typeof settle === 'function') {
          try {
            await settle();
          } catch (error) {
            console.error('[ZERO] Operation resource release failed:', error);
          }
        }
      });
  };
}
