import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { createConcurrencyGate } from '../server/concurrencyGate.ts';

const gate = createConcurrencyGate(1, 7);
const app = express();
let release!: () => void;
const blocked = new Promise<void>((resolve) => { release = resolve; });
let entered = 0;

app.get('/zip/:id', gate.middleware, async (_req, res) => {
  entered++;
  if (entered === 1) await blocked;
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
  assert.equal(gate.activeCount(), 1, 'admitted request must hold the only slot');

  const rejected = await fetch(`${base}/zip/second`);
  assert.equal(rejected.status, 429, 'second concurrent ZIP operation must be rejected');
  assert.equal(rejected.headers.get('retry-after'), '7');
  assert.deepEqual(await rejected.json(), {
    error: 'Zu viele gleichzeitige ZIP-Operationen. Bitte später erneut versuchen.',
    code: 'ZIP_CONCURRENCY_LIMIT',
  });
  assert.equal(entered, 1, 'rejected request must not enter the ZIP handler');

  release();
  assert.equal((await (await first).json()).ok, true);
  while (gate.activeCount() !== 0) await new Promise((resolve) => setImmediate(resolve));

  const retry = await fetch(`${base}/zip/retry`);
  assert.equal(retry.status, 200, 'a later request must be admitted after the slot is released');
  assert.deepEqual(await retry.json(), { ok: true });
  assert.equal(entered, 2);
  while (gate.activeCount() !== 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.activeCount(), 0, 'response completion must release the slot');
} finally {
  release();
  server.close();
  await once(server, 'close');
}

assert.throws(() => createConcurrencyGate(0), /positive safe integer/);
console.log('ZIP concurrent request gate tests passed.');
