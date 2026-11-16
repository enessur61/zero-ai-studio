import assert from 'node:assert/strict';
import { isSafeProjectAssetUrl } from '../server/safeProjectAssetUrl.ts';

assert.equal(isSafeProjectAssetUrl('https://cdn.example.com/image.png', 'image'), true);
assert.equal(isSafeProjectAssetUrl('http://localhost:3000/media.wav', 'audio'), true);
assert.equal(isSafeProjectAssetUrl('/src/assets/seed.jpg', 'image'), true);
assert.equal(isSafeProjectAssetUrl('data:image/png;base64,AAAA', 'image'), true);
assert.equal(isSafeProjectAssetUrl('data:audio/wav;base64,AAAA', 'audio'), true);
assert.equal(isSafeProjectAssetUrl('data:video/mp4;base64,AAAA', 'video'), true);
assert.equal(isSafeProjectAssetUrl('data:text/plain;base64,SGVsbG8=', 'script'), true);
assert.equal(isSafeProjectAssetUrl('javascript:alert(1)', 'image'), false);
assert.equal(isSafeProjectAssetUrl('data:text/html;base64,PHNjcmlwdD4=', 'image'), false);
assert.equal(isSafeProjectAssetUrl('data:image/svg+xml;base64,PHN2Zz4=', 'image'), false);
assert.equal(isSafeProjectAssetUrl('data:image/png;base64,AAAA', 'audio'), false);
assert.equal(isSafeProjectAssetUrl('https://', 'image'), false);
assert.equal(isSafeProjectAssetUrl('blob:https://example.com/id', 'video'), false);
assert.equal(isSafeProjectAssetUrl('https://cdn.example.com/large.bin', 'image'.repeat(100000)), false);
console.log('Project asset URL validation tests passed.');
