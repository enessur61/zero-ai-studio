import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

export class ZeroIdempotencyKeyRequiredError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_REQUIRED';
  constructor() {
    super('Für kostenverbrauchende ZERO-Anfragen ist ein Idempotency-Key-Header erforderlich.');
    this.name = 'ZeroIdempotencyKeyRequiredError';
  }
}

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
  if (!principal.trim()) {
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

/** Hash the request-scoped idempotency key; request fingerprints are compared separately. */
export function createZeroIdempotencyKey(): string {
  const context = zeroPrincipalStorage.getStore();
  if (!context?.requestIdempotencyKey.trim()) throw new ZeroIdempotencyKeyRequiredError();
  return createHash('sha256').update(context.requestIdempotencyKey).digest('hex');
}
