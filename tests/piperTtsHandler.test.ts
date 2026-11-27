import assert from 'node:assert/strict';
import { createPiperTtsHandler, type PiperTtsHandlerDependencies } from '../server/piperTtsHandler.ts';

function createWav(): Buffer {
  const wav = Buffer.alloc(52);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(44, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(22050, 24);
  wav.writeUInt32LE(44100, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(8, 40);
  return wav;
}

async function invoke(dependencies: PiperTtsHandlerDependencies, headers: Record<string, string> = {}) {
  let statusCode = 200;
  let payload: unknown;
  const responsePromise = new Promise<{ status: number; payload: unknown }>((resolve, reject) => {
    const response = {
      status(code: number) { statusCode = code; return this; },
      json(value: unknown) { payload = value; resolve({ status: statusCode, payload }); return this; },
    };
    const request = {
      body: { text: 'ZERO Piper handler regression test', speed: 1 },
      get(name: string) { return headers[name.toLowerCase()]; },
    };
    const next = (error?: unknown) => reject(error ?? new Error('Unexpected next() call'));
    createPiperTtsHandler(dependencies)(request as never, response as never, next);
  });
  return responsePromise;
}

function dependencies(overrides: Partial<PiperTtsHandlerDependencies> = {}) {
  const wav = createWav();
  const calls = { reserve: 0, synthesize: 0, save: 0, settled: [] as string[], workerKeys: [] as string[] };
  const base: PiperTtsHandlerDependencies = {
    getPrincipal: () => ({ id: 'admin:primary' }),
    getWorker: () => ({ baseUrl: new URL('http://127.0.0.1:8000'), headers: { Authorization: 'Bearer test' } }),
    reserve: async () => {
      calls.reserve += 1;
      return { reservationId: '00000000-0000-4000-8000-000000000001', status: 'reserved', duplicate: false };
    },
    getCached: async () => null,
    saveCached: async () => { calls.save += 1; },
    settle: async (_principalId, _reservationId, outcome) => { calls.settled.push(outcome); return true; },
    verifyHealth: async () => true,
    synthesize: async ({ idempotencyKey }) => {
      calls.synthesize += 1;
      calls.workerKeys.push(idempotencyKey);
      return new Response(wav, { status: 200, headers: { 'content-type': 'audio/wav' } });
    },
    readBody: async (response) => Buffer.from(await response.arrayBuffer()),
  };
  return { deps: { ...base, ...overrides }, calls };
}

const key = { 'idempotency-key': 'piper-handler-test-001' };
{
  const { deps, calls } = dependencies();
  const result = await invoke(deps, key);
  assert.equal(result.status, 200);
  assert.equal(calls.reserve, 1, 'a new Piper job must reserve quota before worker execution');
  assert.equal(calls.synthesize, 1);
  assert.equal(calls.save, 1);
  assert.deepEqual(calls.settled, ['completed']);
  assert.equal(calls.workerKeys[0].length, 64);
}

{
  const { deps, calls } = dependencies({
    synthesize: async () => new Response(JSON.stringify({ detail: 'worker timed out after admission' }), { status: 408 }),
  });
  const result = await invoke(deps, key);
  assert.equal(result.status, 503);
  assert.deepEqual(calls.settled, [],
    'an ambiguous worker timeout must keep its reservation for idempotent recovery');
}

{
  const { deps, calls } = dependencies({
    synthesize: async () => new Response(JSON.stringify({ detail: 'worker rejected before processing' }), { status: 429 }),
  });
  const result = await invoke(deps, key);
  assert.equal(result.status, 503);
  assert.deepEqual(calls.settled, ['released'],
    'a definite worker rate-limit rejection must release the active reservation');
}

{
  const { deps, calls } = dependencies({
    reserve: async () => { throw new Error('PostgreSQL unavailable'); },
  });
  const result = await invoke(deps, key);
  assert.equal(result.status, 503);
  assert.equal(calls.synthesize, 0,
    'Piper must never call the worker when persistent resource reservation fails');
}

{
  const { deps, calls } = dependencies({
    reserve: async () => ({
      reservationId: '00000000-0000-4000-8000-000000000001',
      status: 'reserved',
      duplicate: true,
    }),
  });
  const result = await invoke(deps, key);
  assert.equal(result.status, 200);
  assert.equal(calls.reserve, 1);
  assert.equal(calls.synthesize, 1,
    'an uncertain duplicate may recover only through the same worker idempotency key');
  assert.deepEqual(calls.settled, ['completed']);
}

console.log('Piper handler reservation, timeout recovery and fail-closed regression tests passed (mock worker only).');
