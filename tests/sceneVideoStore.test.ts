import assert from 'node:assert/strict';
import { downloadSceneVideoInRanges, requestSceneVideoStoragePersistence } from '../lib/sceneVideoStore.ts';

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
assert.deepEqual(browserError, { persistent: null, usageBytes: null, quotaBytes: null, localSaved: false, serverPersisted: null });


const videoBytes = Buffer.alloc(2 * 1024 * 1024 + 37, 0x5a);
let firstRangeAttempts = 0;
const rangeRequests: string[] = [];
const rangeFetch: typeof fetch = async (_input, init) => {
  if (init?.method === 'HEAD') {
    return new Response(null, { status: 200, headers: {
      'content-length': String(videoBytes.length), 'content-type': 'video/mp4', etag: '"video-hash"',
    } });
  }
  const headers = new Headers(init?.headers);
  const range = headers.get('Range') || '';
  rangeRequests.push(range);
  const match = /^bytes=(\d+)-(\d+)$/.exec(range);
  assert.ok(match, 'client requests a valid bounded byte range');
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start === 0 && firstRangeAttempts++ === 0) throw new Error('simulated mobile network interruption');
  return new Response(videoBytes.subarray(start, end + 1), { status: 206, headers: {
    'content-type': 'video/mp4',
    'content-range': `bytes ${start}-${end}/${videoBytes.length}`,
    'content-length': String(end - start + 1),
  } });
};
const resumedVideo = await downloadSceneVideoInRanges('/clip', rangeFetch, 1024 * 1024);
assert.equal(resumedVideo.size, videoBytes.length);
assert.equal(Buffer.compare(Buffer.from(await resumedVideo.arrayBuffer()), videoBytes), 0,
  'range retry reconstructs the exact original clip');
assert.equal(rangeRequests.length, 4, 'first mobile range is retried, then later windows continue');
assert.deepEqual(rangeRequests.slice(0, 3), ['bytes=0-1048575', 'bytes=0-1048575', 'bytes=1048576-2097151']);

const invalidRangeFetch: typeof fetch = async (_input, init) => init?.method === 'HEAD'
  ? new Response(null, { status: 200, headers: { 'content-length': '2048', 'content-type': 'video/mp4' } })
  : new Response(new Uint8Array(2048), { status: 200, headers: { 'content-type': 'video/mp4' } });
await assert.rejects(() => downloadSceneVideoInRanges('/clip', invalidRangeFetch), /Bytebereich/);

console.log('Scene video storage tests passed: persistent grant, denial, unsupported API, and browser errors.');
