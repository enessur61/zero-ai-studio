import assert from 'node:assert/strict';
import { clearStableIdempotencyKey, getStableIdempotencyKey, ApiRequestError } from '../lib/api.ts';

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const storage = new MemoryStorage();
let generated = 0;
const createKey = () => `stable-test-key-${++generated}`;
const body = JSON.stringify({ prompt: 'retry me', model: 'free-model' });
const first = await getStableIdempotencyKey('/api/image/generate', body, storage, createKey);
const retry = await getStableIdempotencyKey('/api/image/generate', body, storage, createKey);
assert.equal(retry, first, 'same endpoint and exact body reuse the persisted key');
assert.equal(generated, 1, 'retry does not generate another key');

const changedBody = JSON.stringify({ prompt: 'changed prompt', model: 'free-model' });
const changed = await getStableIdempotencyKey('/api/image/generate', changedBody, storage, createKey);
assert.notEqual(changed, first, 'changed payload gets a different key');
const changedEndpoint = await getStableIdempotencyKey('/api/audio/tts', body, storage, createKey);
assert.notEqual(changedEndpoint, first, 'different endpoint gets a different key');

await clearStableIdempotencyKey('/api/image/generate', body, storage);
const afterSuccess = await getStableIdempotencyKey('/api/image/generate', body, storage, createKey);
assert.notEqual(afterSuccess, first, 'successful completion clears the retry key for a future intentional request');

const replayError = new ApiRequestError('already exists', 409, {
  code: 'OPERATION_REPLAY', operation: { operationId: '00000000-0000-4000-8000-000000000001', status: 'RESERVED' },
});
assert.equal(replayError.code, 'OPERATION_REPLAY');
assert.equal(replayError.operation?.status, 'RESERVED');
console.log('ZERO client idempotency tests passed (stable retries, changed-payload isolation, cleanup, replay metadata).');
