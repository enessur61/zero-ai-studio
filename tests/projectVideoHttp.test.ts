import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { sendProjectVideoStream, parseProjectVideoRange } from '../server/projectVideoHttp.ts';

const bytes = Buffer.alloc(1024 * 1024 + 17, 0x6a);
const asset = {
  id: 'video-http-test',
  projectId: 'project-http-test',
  sceneId: 'scene-http-test',
  jobId: null,
  contentType: 'video/mp4' as const,
  sizeBytes: bytes.length,
  sha256: 'a'.repeat(64),
  createdAt: new Date(0).toISOString(),
  close: async () => undefined,
  chunksForRange: (start = 0, end = bytes.length - 1) => (async function* () {
    for (let offset = start; offset <= end; offset += 64 * 1024) {
      yield bytes.subarray(offset, Math.min(end + 1, offset + 64 * 1024));
    }
  })(),
};

assert.deepEqual(parseProjectVideoRange('bytes=10-19', bytes.length, undefined, `"${asset.sha256}"`),
  { kind: 'partial', start: 10, end: 19 });
assert.deepEqual(parseProjectVideoRange('bytes=-10', bytes.length, undefined, `"${asset.sha256}"`),
  { kind: 'partial', start: bytes.length - 10, end: bytes.length - 1 });
assert.deepEqual(parseProjectVideoRange('bytes=10-', bytes.length, `"${asset.sha256}"`, `"${asset.sha256}"`),
  { kind: 'partial', start: 10, end: bytes.length - 1 });
assert.deepEqual(parseProjectVideoRange('bytes=10-', bytes.length, '"stale"', `"${asset.sha256}"`),
  { kind: 'full', start: 0, end: bytes.length - 1 });
assert.deepEqual(parseProjectVideoRange('bytes=0-1,3-4', bytes.length, undefined, `"${asset.sha256}"`),
  { kind: 'invalid' });

const app = express();
let aborted = false;
app.get('/clip', (req, res) => {
  const streamAsset = {
    ...asset,
    chunksForRange: (start = 0, end = bytes.length - 1) => (async function* () {
      try {
        for (let offset = start; offset <= end; offset += 64 * 1024) {
          yield bytes.subarray(offset, Math.min(end + 1, offset + 64 * 1024));
        }
      } finally {
        if (req.query.watchAbort === '1') aborted = true;
      }
    })(),
  };
  sendProjectVideoStream(req, res, streamAsset, req.query.download === '1');
});
const server = app.listen(0);
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Test HTTP server did not bind a TCP port.');
const baseUrl = `http://127.0.0.1:${address.port}`;
try {
  const range = await fetch(`${baseUrl}/clip`, { headers: { Range: 'bytes=100-199' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('accept-ranges'), 'bytes');
  assert.equal(range.headers.get('content-range'), `bytes 100-199/${bytes.length}`);
  assert.equal(range.headers.get('content-length'), '100');
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(100, 200));

  const invalid = await fetch(`${baseUrl}/clip`, { headers: { Range: `bytes=${bytes.length}-` } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), `bytes */${bytes.length}`);

  // Simulate an interrupted native download and the browser's subsequent
  // validator-backed range retry. The test checks byte continuity without
  // constructing a Blob or assembling the complete file in application memory.
  const initialPart = await fetch(`${baseUrl}/clip?download=1`, { headers: { Range: 'bytes=0-65535' } });
  assert.equal(initialPart.status, 206);
  const stableEtag = initialPart.headers.get('etag');
  assert.ok(stableEtag);
  const firstBytes = Buffer.from(await initialPart.arrayBuffer());
  const resumedPart = await fetch(`${baseUrl}/clip?download=1`, {
    headers: { Range: `bytes=65536-${bytes.length - 1}`, 'If-Range': stableEtag },
  });
  assert.equal(resumedPart.status, 206);
  assert.equal(resumedPart.headers.get('content-range'), `bytes 65536-${bytes.length - 1}/${bytes.length}`);
  assert.equal(resumedPart.headers.get('etag'), stableEtag);
  const resumedBytes = Buffer.from(await resumedPart.arrayBuffer());
  assert.deepEqual(Buffer.concat([firstBytes, resumedBytes]), bytes, 'range retry must continue at the exact byte offset for the same immutable asset');

  const download = await fetch(`${baseUrl}/clip?download=1`, { headers: { Range: 'bytes=0-15' } });
  assert.equal(download.status, 206);
  assert.match(download.headers.get('content-disposition') ?? '', /^attachment;/);
  assert.equal((await download.arrayBuffer()).byteLength, 16);

  const interrupted = await fetch(`${baseUrl}/clip?watchAbort=1`, { headers: { Range: 'bytes=0-65535' } });
  assert.equal(interrupted.status, 206);
  const reader = interrupted.body?.getReader();
  assert.ok(reader);
  const first = await reader.read();
  assert.ok(first.value && first.value.length > 0);
  await reader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(aborted, true, 'closing a partial transfer must cancel the underlying generator');

  const staleValidator = await fetch(`${baseUrl}/clip`, {
    headers: { Range: 'bytes=0-15', 'If-Range': '"stale"' },
  });
  assert.equal(staleValidator.status, 200, 'stale If-Range must safely fall back to a full response');
  assert.equal(staleValidator.headers.get('content-length'), String(bytes.length));
  await staleValidator.body?.cancel();
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
// Idle timeout must terminate a stalled response and close its asset lease.
let timedOutAssetClosed = false;
const stalledApp = express();
stalledApp.get('/stalled', (req, res) => sendProjectVideoStream(req, res, {
  ...asset, close: async () => { timedOutAssetClosed = true; },
  chunksForRange: () => (async function* () {
    yield bytes.subarray(0, 16); await new Promise(() => undefined);
  })(),
}, false, { idleTimeoutMs: 30, maxLifetimeMs: 500 }));
const stalledServer = stalledApp.listen(0);
await once(stalledServer, 'listening');
const stalledAddress = stalledServer.address();
if (!stalledAddress || typeof stalledAddress === 'string') throw new Error('Stalled stream test server did not bind.');
try {
  const stalledResponse = await fetch('http://127.0.0.1:' + stalledAddress.port + '/stalled');
  const stalledReader = stalledResponse.body?.getReader();
  assert.ok(stalledReader);
  await assert.rejects(() => stalledReader.read(), 'idle timeout terminates stalled response');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(timedOutAssetClosed, true, 'idle timeout releases the stream lease');
} finally {
  await new Promise<void>((resolve, reject) => stalledServer.close((error) => error ? reject(error) : resolve()));
}

// Continuous data cannot keep a response alive beyond its absolute lifetime.
let lifetimeAssetClosed = false;
const lifetimeApp = express();
lifetimeApp.get('/long-lived', (req, res) => sendProjectVideoStream(req, res, {
  ...asset, close: async () => { lifetimeAssetClosed = true; },
  chunksForRange: () => (async function* () {
    while (true) { yield bytes.subarray(0, 16); await new Promise((resolve) => setTimeout(resolve, 8)); }
  })(),
}, false, { idleTimeoutMs: 100, maxLifetimeMs: 45 }));
const lifetimeServer = lifetimeApp.listen(0);
await once(lifetimeServer, 'listening');
const lifetimeAddress = lifetimeServer.address();
if (!lifetimeAddress || typeof lifetimeAddress === 'string') throw new Error('Lifetime stream test server did not bind.');
try {
  const response = await fetch('http://127.0.0.1:' + lifetimeAddress.port + '/long-lived');
  const reader = response.body?.getReader();
  assert.ok(reader);
  await assert.rejects(async () => { while (!(await reader.read()).done) { /* drain */ } },
    'absolute lifetime terminates a stream even while data keeps arriving');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(lifetimeAssetClosed, true, 'absolute lifetime releases the stream lease');
} finally {
  await new Promise<void>((resolve, reject) => lifetimeServer.close((error) => error ? reject(error) : resolve()));
}
console.log('Project video HTTP range, resume, cancellation, idle/lifetime timeout and download tests passed.');
