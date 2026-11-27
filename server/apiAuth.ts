import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface ApiAuthOptions {
  isProduction: boolean;
  adminPassword: string;
  sessionSecret: string;
  hasValidSession: (request: Request) => Promise<boolean>;
  onAuthenticated?: (request: Request, response: Response, next: NextFunction) => void;
}

const PUBLIC_API_PATHS = new Set(['/live', '/health', '/auth/status', '/auth/login', '/auth/logout']);
const ORIGIN_PROTECTED_PUBLIC_PATHS = new Set(['/auth/login', '/auth/logout']);

function hasExactSameOrigin(request: Request): boolean {
  const origin = request.get('origin');
  const host = request.get('host');
  if (!origin || !host || (request.protocol !== 'http' && request.protocol !== 'https')) return false;
  try {
    const parsedOrigin = new URL(origin);
    const expectedOrigin = new URL(request.protocol + '://' + host);
    return parsedOrigin.origin === origin &&
      parsedOrigin.protocol === request.protocol + ':' &&
      parsedOrigin.username === '' &&
      parsedOrigin.password === '' &&
      parsedOrigin.pathname === '/' &&
      parsedOrigin.search === '' &&
      parsedOrigin.hash === '' &&
      parsedOrigin.origin === expectedOrigin.origin;
  } catch {
    return false;
  }
}

/** Shared production API gate. Mounted at /api so req.path is API-relative. */
export function createApiAuthMiddleware(options: ApiAuthOptions): RequestHandler {
  return (req, res, next): void => {
    if (PUBLIC_API_PATHS.has(req.path)) {
      // Login and logout mutate authentication state. SameSite cookies are a
      // second layer, not a substitute for validating the browser Origin.
      if (options.isProduction && ORIGIN_PROTECTED_PUBLIC_PATHS.has(req.path) && !hasExactSameOrigin(req)) {
        res.status(403).json({ error: 'Ungültiger oder fehlender Origin-Header.' });
        return;
      }
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
    }).catch(() => {
      // Authentication storage failures must fail closed with an explicit
      // availability response, not fall through to a generic application 500.
      if (!res.headersSent) {
        res.status(503).json({ error: 'Authentifizierung derzeit nicht verfügbar.' });
      }
    });
  };
}
