import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [filmDirector, server, worker] = await Promise.all([
  readFile('components/FilmDirectorView.tsx', 'utf8'),
  readFile('server.ts', 'utf8'),
  readFile('piper-worker/app.py', 'utf8'),
]);

assert.match(filmDirector, /api\/audio\/tts\/piper/);
assert.doesNotMatch(filmDirector, /apiRequest<\{ audioDataUrl: string \}>\('\/api\/audio\/tts'/);
assert.match(server, /app\.post\('\/api\/audio\/tts\/piper'/);
assert.match(server, /paidFallback: false/);
assert.match(worker, /VOICE="de_DE-thorsten-medium"/);
assert.match(worker, /"cost_eur":0,"paid_fallback":False/);

console.log('Film Director Piper routing tests passed: German voiceovers use the free Piper worker without paid fallback.');
