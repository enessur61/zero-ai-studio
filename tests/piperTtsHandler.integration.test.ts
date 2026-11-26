import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApiAuthMiddleware } from '../server/apiAuth.ts';
import { createPiperTtsHandler, type PiperCachedResult } from '../server/piperTtsHandler.ts';
import { postPiperWorkerTts } from '../server/piperWorkerClient.ts';
import { isPiperWorkerHealthPayload } from '../server/piperWorkerHealth.ts';

const wav = Buffer.alloc(52);
wav.write('RIFF', 0, 'ascii'); wav.writeUInt32LE(44, 4); wav.write('WAVE', 8, 'ascii');
wav.write('fmt ', 12, 'ascii'); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22); wav.writeUInt32LE(22050, 24); wav.writeUInt32LE(44100, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36, 'ascii'); wav.writeUInt32LE(8, 40);

let workerMode: 'ok' | 'unhealthy' | 'server-error' | 'reject' = 'ok';
let workerEnabled = true;
let synthCalls = 0;
const workerIdempotency = new Map<string, 'unknown' | 'completed'>();
const workerServer = createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(workerMode === 'unhealthy' ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, auth_configured: true, engine: 'Piper ONNX CPU', model_id: 'de_DE-thorsten-medium',
      voice: 'de_DE-thorsten-medium', engine_version: '1.8.0',
      model_revision: 'cf910fb59f1d79ab3b625a63993a108751c6c25d',
      voice_revision: 'cf910fb59f1d79ab3b625a63993a108751c6c25d',
      engine_license: 'GPL-3.0-or-later', voice_dataset_license: 'CC0',
      voice_training_base: 'rdh (nl_BE, one Flemish speaker, CC0)',
      model_sha256: 'fd270eb3d1ebf91d763f8a0f949b1b1bebdfefaea18c3aaf8577dd34536e064f',
      cost_eur: 0, paid_fallback: false, commercial_use_confirmed: false,
    }));
    return;
  }
  if (req.url !== '/tts') { res.writeHead(404).end(); return; }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(req.headers.authorization, 'Bearer local-only-test-token');
  const key = String(req.headers['idempotency-key'] ?? '');
  assert.ok(key);
  assert.equal(body.text.length > 0, true);
  const prior = workerIdempotency.get(key);
  if (prior === 'completed') { res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(wav.length), 'x-zero-tts-replayed': 'true' }).end(wav); return; }
  if (prior === 'unknown') { res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({detail:'UNKNOWN result; duplicate inference blocked'})); return; }
  workerIdempotency.set(key, 'unknown');
  synthCalls++;
  if (workerMode === 'server-error') { res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({detail:'temporary worker failure'})); return; }
  if (workerMode === 'reject') { workerIdempotency.delete(key); res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({detail:'invalid request'})); return; }
  workerIdempotency.set(key, 'completed');
  res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(wav.length) }).end(wav);
});
workerServer.listen(0, '127.0.0.1');
await once(workerServer, 'listening');
const address = workerServer.address();
assert.ok(address && typeof address === 'object');
const workerUrl = `http://127.0.0.1:${address.port}`;

const reservations = new Map<string, { reservationId: string; status: 'reserved'|'completed'|'released'; fingerprint: string }>();
const results = new Map<string, PiperCachedResult>();
let reservationCount = 0;
const app = express();
app.use(express.json());
app.use('/api', createApiAuthMiddleware({
  isProduction: true, adminPassword: 'not-used-test-password', sessionSecret: 'x'.repeat(40),
  hasValidSession: async (req) => ['zero_session=valid', 'zero_session=other'].includes(String(req.headers.cookie ?? '')),
  onAuthenticated: (req, res, next) => { res.locals.zeroPrincipal = { id: req.headers.cookie === 'zero_session=other' ? 'admin:secondary' : 'admin:primary' }; next(); },
}));
app.post('/api/audio/tts/piper', createPiperTtsHandler({
  getPrincipal: (res) => res.locals.zeroPrincipal ?? null,
  getWorker: () => workerEnabled ? ({ baseUrl: new URL(workerUrl), headers: { Authorization: 'Bearer local-only-test-token' } }) : null,
  reserve: async ({ principalId, idempotencyKey, requestFingerprint }) => {
    const scopedKey = `${principalId}:${idempotencyKey}`;
    const existing = reservations.get(scopedKey);
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) {
        const error = new Error('idempotency conflict'); error.name = 'ZeroResourceIdempotencyError'; throw error;
      }
      return { reservationId: existing.reservationId, status: existing.status, duplicate: true };
    }
    const row = { reservationId: `reservation-${++reservationCount}`, status: 'reserved' as const, fingerprint: requestFingerprint };
    reservations.set(scopedKey, row);
    return { reservationId: row.reservationId, status: row.status, duplicate: false };
  },
  getCached: async (_principal, id) => results.get(id) ?? null,
  saveCached: async (_principal, id, payload) => { results.set(id, payload); },
  settle: async (_principal, id, outcome) => {
    const row = [...reservations.values()].find((item) => item.reservationId === id);
    if (row && row.status === 'reserved') row.status = outcome;
  },
  verifyHealth: async (worker) => {
    const response = await fetch(new URL('/health', worker.baseUrl), { headers: worker.headers, redirect: 'error' });
    return response.ok && isPiperWorkerHealthPayload(await response.json());
  },
  synthesize: ({ worker, text, speed, idempotencyKey, signal }) => postPiperWorkerTts({
    baseUrl: worker.baseUrl.toString(), headers: worker.headers, text, speed, idempotencyKey, signal,
  }),
  readBody: async (response, maxBytes) => {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error('body too large');
    return bytes;
  },
}));
const http = app.listen(0, '127.0.0.1');
await once(http, 'listening');
const httpAddress = http.address();
assert.ok(httpAddress && typeof httpAddress === 'object');
const apiUrl = `http://127.0.0.1:${httpAddress.port}/api/audio/tts/piper`;
const send = (key: string, text: string, authenticated = true, cookie = 'zero_session=valid') => fetch(apiUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'idempotency-key': key, ...(authenticated ? { cookie } : {}) },
  body: JSON.stringify({ text }),
});

try {
  assert.equal((await send('unauth-key-0001', 'auth check', false)).status, 401);
  const first = await send('piper-test-key-001', 'Hallo ZERO');
  assert.equal(first.status, 200);
  const payload = await first.json() as PiperCachedResult;
  assert.equal(payload.audioDataUrl, `data:audio/wav;base64,${wav.toString('base64')}`);
  assert.equal(synthCalls, 1);

  const replay = await send('piper-test-key-001', 'Hallo ZERO');
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), payload);
  assert.equal(synthCalls, 1, 'completed idempotency replay must not synthesize twice');
  assert.equal((await send('piper-test-key-001', 'different text')).status, 409);
  const otherPrincipal = await send('piper-test-key-001', 'Hallo ZERO', true, 'zero_session=other');
  assert.equal(otherPrincipal.status, 200, 'the same client key must be isolated between authenticated principals');
  assert.equal(synthCalls, 2);
  assert.equal(workerIdempotency.size, 2, 'worker idempotency keys must be principal-scoped');

  workerEnabled = false;
  assert.equal((await send('piper-disabled-key-01', 'disabled worker')).status, 503);
  assert.equal(reservations.get('admin:primary:piper-disabled-key-01')?.status, 'released');
  workerEnabled = true;

  workerMode = 'unhealthy';
  assert.equal((await send('piper-health-key-01', 'health failure')).status, 503);
  assert.equal(reservations.get('admin:primary:piper-health-key-01')?.status, 'released');

  workerMode = 'server-error';
  assert.equal((await send('piper-5xx-key-0001', 'unknown worker outcome')).status, 503);
  assert.equal(reservations.get('admin:primary:piper-5xx-key-0001')?.status, 'reserved');
  assert.equal((await send('piper-5xx-key-0001', 'unknown worker outcome')).status, 409);
  assert.equal(reservations.get('piper-5xx-key-0001')?.status, 'reserved');
  assert.equal(synthCalls, 3, 'uncertain worker result must not be submitted twice');

  workerMode = 'reject';
  assert.equal((await send('piper-4xx-key-0001', 'rejected request')).status, 400);
  assert.equal(reservations.get('admin:primary:piper-4xx-key-0001')?.status, 'released');
  console.log('Production Piper handler integration passed: auth, local health, reservation, WAV cache/replay, fingerprint conflict, 4xx release and uncertain 5xx no-duplicate behavior. Localhost only; no provider calls.');
} finally {
  http.close(); workerServer.close();
  await Promise.all([once(http, 'close'), once(workerServer, 'close')]);
}
