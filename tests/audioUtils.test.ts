import assert from 'node:assert/strict';
import { pcmBase64ToWavDataUrl } from '../server/audioUtils.ts';

const pcm = Buffer.from([0x00, 0x00, 0xff, 0x7f]);
const dataUrl = pcmBase64ToWavDataUrl(pcm.toString('base64'), 'audio/L16;codec=pcm;rate=24000');
assert.ok(dataUrl.startsWith('data:audio/wav;base64,'));

const wav = Buffer.from(dataUrl.split(',')[1], 'base64');
assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
assert.equal(wav.readUInt16LE(20), 1);
assert.equal(wav.readUInt16LE(22), 1);
assert.equal(wav.readUInt32LE(24), 24_000);
assert.equal(wav.readUInt32LE(28), 48_000);
assert.equal(wav.readUInt16LE(32), 2);
assert.equal(wav.readUInt16LE(34), 16);
assert.equal(wav.toString('ascii', 36, 40), 'data');
assert.equal(wav.readUInt32LE(40), pcm.length);
assert.deepEqual(wav.subarray(44), pcm);

assert.throws(() => pcmBase64ToWavDataUrl('not base64!'), /gültigen PCM/);
assert.throws(() => pcmBase64ToWavDataUrl(Buffer.from([1]).toString('base64')), /unvollständige PCM/);

const existingWav = Buffer.from('RIFF----WAVE').toString('base64');
assert.equal(
  pcmBase64ToWavDataUrl(existingWav, 'audio/wav'),
  `data:audio/wav;base64,${existingWav}`
);

console.log('Audio tests passed: PCM is wrapped in a valid WAV container.');
