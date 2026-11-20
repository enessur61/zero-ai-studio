import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import {
  probeProjectVideoAccess,
  watchProjectVideoRecovery,
  type ProjectVideoRecoveryState,
} from '../lib/projectVideoRecovery.ts';

const app = express();
let authenticated = true;
let clipRequests = 0;
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
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
console.log('Project video recovery tests passed: local HTTP byte-range probe, background/foreground, session expiry/re-login, offline handling; browser lifecycle is simulated, no physical device or paid service is claimed.');
