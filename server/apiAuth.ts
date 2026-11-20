import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface ApiAuthOptions {
  isProduction: boolean;
  adminPassword: string;
  sessionSecret: string;
  hasValidSession: (request: Request) => Promise<boolean>;
  onAuthenticated?: (request: Request, response: Response, next: NextFunction) => void;
}

const PUBLIC_API_PATHS = new Set(['/live', '/health', '/auth/status', '/auth/login', '/auth/logout']);

/** Shared production API gate. Mounted at /api so req.path is API-relative. */
export function createApiAuthMiddleware(options: ApiAuthOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (PUBLIC_API_PATHS.has(req.path)) {
      next();
      return;
    }
    const continueAuthenticated = () => options.onAuthenticated ? options.onAuthenticated(req, res, next) : next();
    if (!options.isProduction) {
      continueAuthenticated();
      return;
    }

    if (options.adminPassword.length < 12 || options.sessionSecret.length < 32) {
      res.status(503).json({
        error: 'ZERO AI STUDIO ist gesperrt: ZERO_ADMIN_PASSWORD (mind. 12 Zeichen) und ZERO_SESSION_SECRET (mind. 32 Zeichen) müssen in der Serverumgebung gesetzt werden.',
      });
      return;
    }

    void options.hasValidSession(req).then((valid) => {
      if (!valid) {
        res.status(401).json({ error: 'Anmeldung erforderlich.' });
        return;
      }
      continueAuthenticated();
    }).catch(next);
  };
}
