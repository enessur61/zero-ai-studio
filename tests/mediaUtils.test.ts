import assert from 'node:assert/strict';
import { parseBase64DataUrl } from '../server/mediaUtils.ts';

const imageBytes = Buffer.from('small image payload');
const imageUrl = `data:image/jpeg;base64,${imageBytes.toString('base64')}`;
const image = parseBase64DataUrl(imageUrl, ['image/jpeg', 'image/png'], 1024);
assert.deepEqual(image, {
  mimeType: 'image/jpeg',
  data: imageBytes.toString('base64'),
  byteLength: imageBytes.length,
});

const parameterizedAudioUrl = `data:audio/webm;codecs=opus;base64,${imageBytes.toString('base64')}`;
assert.equal(
  parseBase64DataUrl(parameterizedAudioUrl, ['audio/webm'], 1024)?.mimeType,
  'audio/webm'
);
assert.equal(parseBase64DataUrl(imageUrl, ['image/png'], 1024), null);
assert.equal(parseBase64DataUrl(imageUrl, ['image/jpeg'], 2), null);
assert.equal(parseBase64DataUrl('data:image/jpeg;base64,%%%bad%%%', ['image/jpeg'], 1024), null);
assert.equal(parseBase64DataUrl('not a data url', ['image/jpeg'], 1024), null);

console.log('Media validation tests passed: MIME types, base64 data, and upload size limits.');
