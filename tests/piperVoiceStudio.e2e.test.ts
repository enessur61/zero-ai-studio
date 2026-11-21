import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

const mockToken = 'zero-piper-e2e-mock-token-never-production';
const wav = Buffer.alloc(48);
wav.write('RIFF', 0, 'ascii');
wav.writeUInt32LE(wav.length - 8, 4);
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
wav.writeUInt32LE(4, 40);
wav.writeInt16LE(0, 44);
wav.writeInt16LE(0, 46);

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Local test server did not bind a TCP port'));
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

let rejectWorkerAuth = false;
let receivedRequest: { authorization: string | undefined; body: { text?: string; speed?: number } } | null = null;
const worker = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const bodyText = Buffer.concat(chunks).toString('utf8');
  receivedRequest = {
    authorization: req.headers.authorization,
    body: JSON.parse(bodyText) as { text?: string; speed?: number },
  };
  if (req.method !== 'POST' || req.url !== '/tts') {
    res.writeHead(404).end();
    return;
  }
  if (rejectWorkerAuth || req.headers.authorization !== `Bearer ${mockToken}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ detail: 'Unauthorized' }));
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'audio/wav',
    'Content-Length': String(wav.length),
    'Content-Disposition': 'attachment; filename="mock-piper.wav"',
  }).end(wav);
});

let zeroServer: ChildProcess | undefined;
let zeroOutput = '';
let workerListening = false;
let zeroExited = false;

try {
  const workerPort = await listen(worker);
  workerListening = true;
  const zeroPortProbe = createServer();
  const zeroPort = await listen(zeroPortProbe);
  await close(zeroPortProbe);

  zeroServer = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_ENV: 'test',
      PORT: String(zeroPort),
      DATABASE_URL: '',
      ZERO_TTS_WORKER_URL: `http://127.0.0.1:${workerPort}`,
      ZERO_TTS_WORKER_TOKEN: mockToken,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  zeroServer.stdout?.on('data', (chunk: Buffer) => { zeroOutput += chunk.toString(); });
  zeroServer.stderr?.on('data', (chunk: Buffer) => { zeroOutput += chunk.toString(); });
  zeroServer.once('exit', () => { zeroExited = true; });

  const baseUrl = `http://127.0.0.1:${zeroPort}`;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (zeroExited) throw new Error('Isolated ZERO test server exited during startup.');
    try {
      const response = await fetch(`${baseUrl}/api/auth/status`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { ready = true; break; }
    } catch { /* Wait for the local test server to bind. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(ready, true, `Isolated ZERO server did not become ready. Output: ${zeroOutput.slice(-3000)}`);

  const inputText = 'Dies ist ein isolierter Piper-Ende-zu-Ende-Test.';
  const success = await fetch(`${baseUrl}/api/audio/tts/piper`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: inputText, speed: 1.1 }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(success.status, 200);
  const result = await success.json() as {
    audioDataUrl?: string; modelUsed?: string; voice?: string; costEur?: number; paidFallback?: boolean;
  };
  assert.equal(result.audioDataUrl, `data:audio/wav;base64,${wav.toString('base64')}`);
  assert.equal(result.costEur, 0);
  assert.equal(result.paidFallback, false);
  assert.match(result.modelUsed ?? '', /Piper ONNX/);
  assert.match(result.voice ?? '', /Thorsten/);
  assert.deepEqual(receivedRequest, {
    authorization: `Bearer ${mockToken}`,
    body: { text: inputText, speed: 1.1 },
  });

  rejectWorkerAuth = true;
  const denied = await fetch(`${baseUrl}/api/audio/tts/piper`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: inputText, speed: 1 }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(denied.status, 503);
  const deniedResult = await denied.json() as { error?: string; costEur?: number; paidFallback?: boolean };
  assert.equal(deniedResult.costEur, 0);
  assert.equal(deniedResult.paidFallback, false);
  assert.match(deniedResult.error ?? '', /Unauthorized/);
  assert.equal(JSON.stringify(deniedResult).includes(mockToken), false);

  console.log('ZERO Voice Studio isolated end-to-end tests passed: mock Piper WAV, server-side bearer auth, response metadata, zero-cost/no-fallback guard, and unauthorized-worker rejection. No production or database connection was configured.');
} finally {
  if (zeroServer && !zeroExited) {
    zeroServer.kill('SIGTERM');
    await Promise.race([once(zeroServer, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (!zeroExited) zeroServer.kill('SIGKILL');
  }
  if (workerListening) await close(worker);
}
