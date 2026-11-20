import assert from 'node:assert/strict';
import { getOrCreatePersistentIdempotencyKey } from '../lib/api.ts';

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const storage = new MemoryStorage();
let sequence = 0;
const createKey = () => `test-request-key-${++sequence}`;
const url = '/api/image/generate';
const body = JSON.stringify({ prompt: 'rainy Berlin', model: 'flux' });

const firstPageRequest = await getOrCreatePersistentIdempotencyKey(url, body, storage, createKey);
const reloadedPageRequest = await getOrCreatePersistentIdempotencyKey(url, body, storage, createKey);
assert.equal(reloadedPageRequest.key, firstPageRequest.key, 'retry after reload reuses the persisted logical-request key');

const duplicateRequest = await getOrCreatePersistentIdempotencyKey(url, body, storage, createKey);
assert.equal(duplicateRequest.key, firstPageRequest.key, 'duplicate requests share one pending idempotency key');

const differentJob = await getOrCreatePersistentIdempotencyKey(url, JSON.stringify({ prompt: 'different scene', model: 'flux' }), storage, createKey);
assert.notEqual(differentJob.key, firstPageRequest.key, 'different logical payloads never reuse a key');

await firstPageRequest.clear();
const laterIdenticalJob = await getOrCreatePersistentIdempotencyKey(url, body, storage, createKey);
assert.notEqual(laterIdenticalJob.key, firstPageRequest.key, 'a completed request gets a fresh key when intentionally submitted again');

console.log('ZERO API idempotency tests passed (reload retry, duplicate request, distinct job and key lifecycle).');
