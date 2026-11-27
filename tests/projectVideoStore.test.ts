import assert from 'node:assert/strict';
import {
  isValidProjectVideoPayload,
  MAX_PROJECT_VIDEO_BYTES,
  MAX_PROJECT_VIDEO_COUNT,
  MAX_PROJECT_VIDEO_STORAGE_BYTES,
} from '../server/projectVideoStore.ts';

const mp4 = Buffer.alloc(2048);
mp4.write('ftyp', 4, 'ascii');
assert.equal(isValidProjectVideoPayload(mp4, 'video/mp4'), true);
const legacyLimitMp4 = Buffer.alloc(8 * 1024 * 1024 + 1);
legacyLimitMp4.write('ftyp', 4, 'ascii');
assert.equal(isValidProjectVideoPayload(legacyLimitMp4, 'video/mp4'), true, 'MP4 clips larger than the former 8 MB limit are accepted');
assert.equal(isValidProjectVideoPayload(mp4, 'video/webm'), false);

const webm = Buffer.alloc(2048);
Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(webm);
assert.equal(isValidProjectVideoPayload(webm, 'video/webm'), true);
assert.equal(isValidProjectVideoPayload(webm, 'video/mp4'), false);

assert.equal(isValidProjectVideoPayload(Buffer.alloc(1023), 'video/mp4'), false);
assert.equal(isValidProjectVideoPayload(Buffer.alloc(MAX_PROJECT_VIDEO_BYTES + 1), 'video/mp4'), false);
assert.equal(isValidProjectVideoPayload(Buffer.alloc(2048), 'application/octet-stream'), false);
assert.equal(isValidProjectVideoPayload('not-a-buffer', 'video/mp4'), false);

assert.equal(MAX_PROJECT_VIDEO_BYTES, 100 * 1024 * 1024);
assert.equal(MAX_PROJECT_VIDEO_STORAGE_BYTES, 500 * 1024 * 1024);
assert.equal(MAX_PROJECT_VIDEO_COUNT, 50);

console.log('ZERO project video payload and retention policy tests passed.');
