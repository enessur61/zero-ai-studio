import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

export interface ZeroPrincipalContext {
  principal: string;
  requestIdempotencyKey: string;
}

const zeroPrincipalStorage = new AsyncLocalStorage<ZeroPrincipalContext>();

/** Establish a trusted principal and request retry key for one authenticated API request. */
export function runWithZeroPrincipal<T>(
  principal: string,
  requestIdempotencyKey: string,
  callback: () => T,
): T {
  if (!principal.trim() || !requestIdempotencyKey.trim()) {
    throw new Error('ZERO principal context is incomplete.');
  }
  return zeroPrincipalStorage.run({ principal, requestIdempotencyKey }, callback);
}

export function getZeroPrincipalContext(): ZeroPrincipalContext | undefined {
  return zeroPrincipalStorage.getStore();
}

export function requireZeroPrincipal(): string {
  const context = zeroPrincipalStorage.getStore();
  if (!context?.principal) throw new Error('Authenticated ZERO principal context is required.');
  return context.principal;
}

/** Derive one stable provider-operation key from the request key and full request fingerprint. */
export function createZeroIdempotencyKey(requestFingerprint: string): string {
  const context = zeroPrincipalStorage.getStore();
  if (!context?.requestIdempotencyKey) throw new Error('ZERO Idempotency-Key context is required.');
  if (!/^[a-f0-9]{64}$/.test(requestFingerprint)) throw new Error('ZERO request fingerprint is invalid.');
  return createHash('sha256')
    .update(context.requestIdempotencyKey + ':' + requestFingerprint)
    .digest('hex');
}
