import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import {
  classifyProjectVideoMediaError,
  probeProjectVideoAccess,
  watchProjectVideoRecovery,
  type ProjectVideoRecoveryState,
} from '../lib/projectVideoRecovery.ts';

const app = express();
let authenticated = true;
let clipRequests = 0;
let mediaErrorCode = 2;
app.get('/api/auth/status', (_req, res) => res.json({ required: true, authenticated }));
app.get('/clip', (req, res) => {
  clipRequests += 1;
  if (!authenticated) return res.status(401).json({ error: 'Session expired' });
  if (req.headers.range !== 'bytes=0-0') return res.status(400).end();
  res.status(206).set({
    'Accept-Ranges': 'bytes',
    'Content-Range': 'bytes 0-0/4',
    'Content-Length': '1',
    ETag: '"stable"',
  }).send(Buffer.from('x'));
});
const server = app.listen(0);
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Recovery HTTP test server did not bind.');
const base = `http://127.0.0.1:${address.port}`;
const url = `${base}/clip`;
const testFetch = (input: RequestInfo | URL, init?: RequestInit) => fetch(new URL(String(input), base), init);
const waitFor = async (condition: () => boolean, message: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
};

try {
  assert.equal(await probeProjectVideoAccess(url, testFetch), 'ready');
  assert.ok(clipRequests > 0, 'probe must validate access with a one-byte HTTP range');

  const windowEvents = new EventTarget();
  const documentEvents = new EventTarget();
  const mediaEvents = new EventTarget();
  let visible = true;
  const states: ProjectVideoRecoveryState[] = [];
  let resumes = 0;
  const stop = watchProjectVideoRecovery({
    url,
    fetcher: testFetch,
    mediaTarget: mediaEvents,
    getMediaErrorCode: () => mediaErrorCode,
    onState: (state) => states.push(state),
    onResume: () => { resumes += 1; },
    windowTarget: windowEvents,
    documentTarget: documentEvents,
    isVisible: () => visible,
  });
  await waitFor(() => states.at(-1) === 'ready', 'initial authenticated range probe did not finish');

  visible = false;
  windowEvents.dispatchEvent(new Event('pagehide'));
  documentEvents.dispatchEvent(new Event('visibilitychange'));
  const requestsBeforeBackground = clipRequests;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(clipRequests, requestsBeforeBackground, 'backgrounding must not start polling or buffer media');

  visible = true;
  documentEvents.dispatchEvent(new Event('visibilitychange'));
  await waitFor(() => resumes === 1, 'foreground recovery did not signal media resume');

  windowEvents.dispatchEvent(new Event('offline'));
  assert.equal(states.at(-1), 'offline', 'the browser offline event must be surfaced immediately');
  windowEvents.dispatchEvent(new Event('online'));
  await waitFor(() => resumes === 2, 'network restoration did not resume media');

  authenticated = false;
  mediaEvents.dispatchEvent(new Event('error'));
  await waitFor(() => states.at(-1) === 'session-expired', 'expired session was not detected');

  authenticated = true;
  windowEvents.dispatchEvent(new Event('pageshow'));
  await waitFor(() => states.at(-1) === 'ready' && resumes === 3, 're-login did not restore access and resume media');
  assert.equal(resumes, 3, 'successful re-login must signal one recovery');
  assert.equal(classifyProjectVideoMediaError(2), 'network');
  assert.equal(classifyProjectVideoMediaError(3), 'decode');
  assert.equal(classifyProjectVideoMediaError(4), 'unsupported');
  assert.equal(classifyProjectVideoMediaError(1), 'aborted');
  mediaErrorCode = 1;
  const requestsBeforeAbortedMedia = clipRequests;
  mediaEvents.dispatchEvent(new Event('error'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(states.at(-1), 'ready', 'Safari cancellation while replacing a source is not a decoder fault');
  assert.equal(clipRequests, requestsBeforeAbortedMedia, 'aborted media requests do not start recovery probes');

  mediaErrorCode = 3;
  const requestsBeforeDecoderFailure = clipRequests;
  mediaEvents.dispatchEvent(new Event('error'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(states.at(-1), 'error');
  assert.equal(clipRequests, requestsBeforeDecoderFailure, 'decoder errors must not trigger network retries');

  stop();
  const requestsAfterStop = clipRequests;
  windowEvents.dispatchEvent(new Event('online'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(clipRequests, requestsAfterStop, 'disposed monitor must detach all lifecycle listeners');

  const offline = await probeProjectVideoAccess(url, async () => { throw new TypeError('network unavailable'); });
  assert.equal(offline, 'offline');
  const missing = await probeProjectVideoAccess(url, async (input) => {
    if (String(input) === '/api/auth/status') return new Response(JSON.stringify({ authenticated: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response(null, { status: 404 });
  });
  assert.equal(missing, 'missing');

  const invalidRangeProbe = await probeProjectVideoAccess(url, async (input) => {
    if (String(input) === '/api/auth/status') {
      return new Response(JSON.stringify({ authenticated: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('two bytes', {
      status: 206,
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes 0-1/4', 'Content-Length': '2' },
    });
  });
  assert.equal(invalidRangeProbe, 'error', 'a probe must reject a malformed or oversized range response');

  const mediaUnauthorized = await probeProjectVideoAccess(url, async (input) => {
    if (String(input) === '/api/auth/status') {
      return new Response(JSON.stringify({ authenticated: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(null, { status: 401 });
  });
  assert.equal(mediaUnauthorized, 'session-expired', 'a session may expire between the auth probe and media request');

  let releaseFirstAuth!: (response: Response) => void;
  const firstAuth = new Promise<Response>((resolve) => { releaseFirstAuth = resolve; });
  let authCalls = 0;
  let overlapResumes = 0;
  const overlapFetcher = async (input: RequestInfo | URL) => {
    if (String(input) === '/api/auth/status') {
      authCalls += 1;
      if (authCalls === 1) return firstAuth;
      return new Response(JSON.stringify({ authenticated: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(new Uint8Array([0]), {
      status: 206,
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes 0-0/4', 'Content-Length': '1' },
    });
  };
  const overlapWindow = new EventTarget();
  const overlapDocument = new EventTarget();
  const stopOverlap = watchProjectVideoRecovery({
    url,
    fetcher: overlapFetcher,
    onState: () => undefined,
    onResume: () => { overlapResumes += 1; },
    windowTarget: overlapWindow,
    documentTarget: overlapDocument,
    isVisible: () => true,
  });
  overlapWindow.dispatchEvent(new Event('offline'));
  overlapWindow.dispatchEvent(new Event('online'));
  releaseFirstAuth(new Response(JSON.stringify({ authenticated: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  await waitFor(() => authCalls >= 2, 'an online event received during a pending probe must schedule a follow-up check');
  await waitFor(() => overlapResumes === 1, 'overlapping lifecycle events must recover exactly once');
  stopOverlap();

  let timeoutAborted = false;
  const timeoutStates: ProjectVideoRecoveryState[] = [];
  const stopTimeout = watchProjectVideoRecovery({
    url,
    fetcher: (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        timeoutAborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    }),
    onState: (state) => timeoutStates.push(state),
    onResume: () => undefined,
    windowTarget: new EventTarget(),
    documentTarget: new EventTarget(),
    isVisible: () => true,
    probeTimeoutMs: 250,
    maxRetries: 0,
  });
  await waitFor(() => timeoutStates.includes('error'), 'stalled probe did not time out');
  assert.equal(timeoutAborted, true, 'probe timeout aborts the active request');
  stopTimeout();

  let retryCalls = 0;
  const retryStates: ProjectVideoRecoveryState[] = [];
  const stopRetries = watchProjectVideoRecovery({
    url,
    fetcher: async () => {
      retryCalls += 1;
      return new Response('unavailable', { status: 503 });
    },
    onState: (state) => retryStates.push(state),
    onResume: () => undefined,
    windowTarget: new EventTarget(),
    documentTarget: new EventTarget(),
    isVisible: () => true,
    probeTimeoutMs: 1000,
    maxRetries: 2,
    retryBaseDelayMs: 50,
  });
  await waitFor(() => retryCalls === 3, 'expected initial probe and two bounded retries');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(retryCalls, 3, 'recovery retry budget is enforced');
  assert.equal(retryStates.at(-1), 'error');
  stopRetries();
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
console.log('Project video recovery tests passed: local HTTP byte-range probe, background/foreground, session expiry/re-login, offline handling; browser lifecycle is simulated, no physical device or paid service is claimed.');
