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

/**
 * Derive an operation-scoped key from the authenticated request key.
 * Supplying the same scope on a retry yields the same key; distinct operations
 * in one request receive distinct keys. Only the digest is persisted.
 */
export function createZeroIdempotencyKey(operationScope?: string): string {
  const context = zeroPrincipalStorage.getStore();
  if (!context?.requestIdempotencyKey) throw new Error('ZERO Idempotency-Key context is required.');
  if (operationScope !== undefined && !operationScope.trim()) {
    throw new Error('ZERO operation idempotency scope is incomplete.');
  }
  const hash = createHash('sha256').update(context.requestIdempotencyKey);
  if (operationScope !== undefined) hash.update('\0').update(operationScope);
  return hash.digest('hex');
}


/** Return a stable, non-reversible identifier for forwarding principal scope to trusted workers. */
export function createZeroPrincipalHash(): string {
  const context = zeroPrincipalStorage.getStore();
  if (!context?.principal) throw new Error('Authenticated ZERO principal context is required.');
  return createHash('sha256').update(context.principal).digest('hex');
}
