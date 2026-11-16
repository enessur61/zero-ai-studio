import type { RequestHandler } from 'express';

type HeaderResponse = {
  setHeader(name: string, value: string): unknown;
};

export function applySecurityHeaders(response: HeaderResponse, isSecure: boolean): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');

  // Only emit HSTS when Express has positively identified an HTTPS request.
  // Behind a TLS-terminating proxy, configure ZERO_TRUST_PROXY_HOPS first.
  if (isSecure) {
    response.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
}

export function configureTrustProxy(
  app: { set(setting: string, value: number): unknown },
  rawValue = process.env.ZERO_TRUST_PROXY_HOPS
): void {
  if (rawValue === undefined || rawValue.trim() === '') return;

  const normalized = rawValue.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error('ZERO_TRUST_PROXY_HOPS muss eine nichtnegative ganze Zahl sein.');
  }

  const hops = Number(normalized);
  if (!Number.isSafeInteger(hops)) {
    throw new Error('ZERO_TRUST_PROXY_HOPS liegt außerhalb des sicheren Zahlenbereichs.');
  }

  app.set('trust proxy', hops);
}

export const securityHeaders: RequestHandler = (req, res, next) => {
  applySecurityHeaders(res, req.secure);
  next();
};
