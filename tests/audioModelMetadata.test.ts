import assert from 'node:assert/strict';
import { resolveAudioModelId } from '../lib/audioModelMetadata.ts';

assert.equal(
  resolveAudioModelId('gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'),
  'gemini-3.8-flash-lite-tts',
  'persist the model actually selected by ZERO CORE, not the preferred UI option',
);
assert.equal(
  resolveAudioModelId('  Piper ONNX · de_DE-thorsten-medium  ', 'piper-tts-de-worker'),
  'Piper ONNX · de_DE-thorsten-medium',
  'preserve the actual Piper worker model metadata',
);
assert.equal(resolveAudioModelId(undefined, 'fallback-model'), 'fallback-model');
assert.equal(resolveAudioModelId('   ', 'fallback-model'), 'fallback-model');
assert.equal(resolveAudioModelId(123, 'fallback-model'), 'fallback-model');

console.log('Audio model metadata tests passed.');
