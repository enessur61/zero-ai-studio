import type { RequestHandler } from 'express';

/**
 * Express 4 does not automatically forward rejected promises returned by route
 * handlers. Wrap async handlers so failures reach the central error middleware.
 */
export function asyncRoute(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}
