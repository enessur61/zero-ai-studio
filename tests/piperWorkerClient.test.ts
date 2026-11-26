import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { postPiperWorkerTts, resolvePiperReplay } from '../server/piperWorkerClient.ts';

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

let requestSeen: { authorization?: string; text?: string; speed?: number } | null = null;
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requestSeen = {
    authorization: request.headers.authorization,
    ...JSON.parse(Buffer.concat(chunks).toString('utf8')),
  };
  response.writeHead(200, { 'Content-Type': 'audio/wav' });
  response.end(wav);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
try {
  const controller = new AbortController();
  const response = await postPiperWorkerTts({
    baseUrl: `http://127.0.0.1:${address.port}`,
    headers: { Authorization: 'Bearer local-test-secret' },
    text: 'ZERO lokaler Mock-Worker-Test',
    speed: 0.96,
    idempotencyKey: 'worker-client-test-001',
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wav);
  assert.deepEqual(requestSeen, {
    authorization: 'Bearer local-test-secret',
    text: 'ZERO lokaler Mock-Worker-Test',
    speed: 0.96,
  });

  const cached = { audioDataUrl: 'data:audio/wav;base64,AA==', resourceReservation: 'reservation' };
  assert.deepEqual(resolvePiperReplay('completed', cached), { kind: 'replay', payload: cached });
  assert.deepEqual(resolvePiperReplay('reserved', null), { kind: 'processing' });
  assert.deepEqual(resolvePiperReplay('completed', null), { kind: 'completed_without_result' });
  assert.deepEqual(resolvePiperReplay('released', null), { kind: 'released' });
  console.log('Piper mock-worker HTTP integration and idempotent replay tests passed (localhost only; no provider calls).');
} finally {
  server.close();
  await once(server, 'close');
}
