import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [view, app, types, server] = await Promise.all([
  readFile('components/PiperVoiceStudioView.tsx', 'utf8'),
  readFile('App.tsx', 'utf8'),
  readFile('src/types/zero.ts', 'utf8'),
  readFile('server.ts', 'utf8'),
]);

assert.match(view, /\/api\/audio\/tts\/piper/);
assert.match(view, /MAX_TEXT_LENGTH = 5000/);
assert.match(view, /min="0\.75"/);
assert.match(view, /max="1\.25"/);
assert.match(view, /download="ZERO-Voice-Thorsten\.wav"/);
assert.match(view, /paidFallback !== false/);
assert.match(view, /costEur !== 0/);
assert.doesNotMatch(view, /ZERO_TTS_WORKER_TOKEN|Authorization/);
assert.match(app, /PiperVoiceStudioView/);
assert.match(app, /id: 'voice', label: 'VOICE STUDIO'/);
assert.match(types, /\| 'voice'/);
assert.match(server, /app\.post\('\/api\/audio\/tts\/piper'/);
assert.match(server, /paidFallback: false/);

console.log('ZERO Voice Studio tests passed: Piper-only routing, 5,000-character limit, bounded speed, WAV download and server-side token handling.');
