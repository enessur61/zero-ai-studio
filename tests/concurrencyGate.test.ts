import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { createConcurrencyGate } from '../server/concurrencyGate.ts';

const gate = createConcurrencyGate(2, 7);
const app = express();
let releaseFirst!: () => void;
let releaseSecond!: () => void;
const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
let entered = 0;

app.get('/zip/:id', gate.middleware, async (_req, res) => {
  entered++;
  if (entered === 1) await firstGate;
  else if (entered === 2) await secondGate;
  res.json({ ok: true });
});

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;

try {
  const first = fetch(`${base}/zip/first`);
  while (entered < 1) await new Promise((resolve) => setImmediate(resolve));
  const second = fetch(`${base}/zip/second`);
  while (entered < 2) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(gate.activeCount(), 2, 'both admitted requests must hold a slot');
  const rejected = await fetch(`${base}/zip/third`);
  assert.equal(rejected.status, 429, 'third concurrent ZIP operation must be rejected');
  assert.equal(rejected.headers.get('retry-after'), '7');
  assert.deepEqual(await rejected.json(), {
    error: 'Zu viele gleichzeitige ZIP-Operationen. Bitte später erneut versuchen.',
    code: 'ZIP_CONCURRENCY_LIMIT',
  });
  assert.equal(entered, 2, 'rejected request must not enter the ZIP handler');

  releaseFirst();
  assert.equal((await (await first).json()).ok, true);
  while (gate.activeCount() !== 1) await new Promise((resolve) => setImmediate(resolve));
  const replacement = fetch(`${base}/zip/replacement`);
  while (entered < 3) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.activeCount(), 2, 'completed slot must be reusable');
  releaseSecond();
  assert.equal((await (await second).json()).ok, true);
  // The replacement is the third admitted handler and is released by the same
  // second gate, proving capacity returns to its configured ceiling.
  assert.equal((await (await replacement).json()).ok, true);
  while (gate.activeCount() !== 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.activeCount(), 0, 'all response slots must be released');
} finally {
  releaseFirst();
  releaseSecond();
  server.close();
  await once(server, 'close');
}

assert.throws(() => createConcurrencyGate(0), /positive safe integer/);
console.log('ZIP concurrent request gate tests passed.');
