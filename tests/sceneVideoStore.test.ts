import assert from 'node:assert/strict';
import { requestSceneVideoStoragePersistence } from '../lib/sceneVideoStore.ts';

const granted = await requestSceneVideoStoragePersistence({
  persisted: async () => false,
  persist: async () => true,
  estimate: async () => ({ usage: 1024, quota: 8192 }),
} as unknown as StorageManager);
assert.deepEqual(granted, { persistent: true, usageBytes: 1024, quotaBytes: 8192, localSaved: false, serverPersisted: null });

let persistCalls = 0;
const denied = await requestSceneVideoStoragePersistence({
  persisted: async () => false,
  persist: async () => { persistCalls += 1; return false; },
  estimate: async () => ({ usage: 4096, quota: 8192 }),
} as unknown as StorageManager);
assert.equal(denied.persistent, false);
assert.equal(persistCalls, 1);
assert.equal(denied.usageBytes, 4096);

const alreadyPersistent = await requestSceneVideoStoragePersistence({
  persisted: async () => true,
  persist: async () => { throw new Error('must not request again'); },
  estimate: async () => ({}),
} as unknown as StorageManager);
assert.equal(alreadyPersistent.persistent, true);
assert.equal(alreadyPersistent.usageBytes, null);

const unavailable = await requestSceneVideoStoragePersistence(undefined);
assert.deepEqual(unavailable, { persistent: null, usageBytes: null, quotaBytes: null, localSaved: false, serverPersisted: null });

const browserError = await requestSceneVideoStoragePersistence({
  persisted: async () => { throw new Error('storage denied'); },
  persist: async () => true,
  estimate: async () => { throw new Error('estimate unavailable'); },
} as unknown as StorageManager);
assert.deepEqual(browserError, { persistent: null, usageBytes: null, quotaBytes: null });

console.log('Scene video storage tests passed: persistent grant, denial, unsupported API, and browser errors.');
