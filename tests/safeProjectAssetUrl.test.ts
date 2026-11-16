import assert from 'node:assert/strict';
import { isSafeProjectAssetUrl, sanitizeProjectAssets, sanitizeProjectScenes, sanitizeProjectSnapshots } from '../server/safeProjectAssetUrl.ts';

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
assert.equal(isSafeProjectAssetUrl('data:image/png,not-base64', 'image'), false);
assert.equal(isSafeProjectAssetUrl('data:image/png;base64,AAAA', 'audio'), false);
assert.equal(isSafeProjectAssetUrl('https://', 'image'), false);
assert.equal(isSafeProjectAssetUrl('blob:https://example.com/id', 'video'), false);
assert.equal(isSafeProjectAssetUrl('x'.repeat(16 * 1024 * 1024 + 1), 'image'), false);

const validAsset = {
  id: 'asset-ok', type: 'image', title: 'Valid image',
  url: 'data:image/png;base64,AAAA', modelId: 'test', createdAt: '2026-11-16T00:00:00.000Z'
};
const legacyUnsafeAsset = {
  id: 'asset-bad', type: 'image', title: 'Unsafe image',
  url: 'javascript:alert(1)', modelId: 'legacy', createdAt: '2026-11-16T00:00:00.000Z'
};
assert.deepEqual(sanitizeProjectAssets([validAsset, legacyUnsafeAsset, { id: 'broken' }]), [validAsset]);

const legacyScene = {
  imageUrl: 'javascript:alert(1)',
  audioDataUrl: 'data:text/html;base64,PHNjcmlwdD4=',
  title: 'Legacy scene'
};
const cleanScenes = sanitizeProjectScenes([legacyScene as never]);
assert.equal(cleanScenes[0].imageUrl, undefined);
assert.equal(cleanScenes[0].audioDataUrl, undefined);
assert.equal(cleanScenes[0].title, 'Legacy scene');

const legacySnapshot = {
  id: 'snap-old', version: 1, note: 'Legacy', createdAt: '2026-11-16T00:00:00.000Z',
  sceneCount: 1, totalDurationSec: 5,
  state: {
    title: 'Legacy project', logline: '', genre: 'Drama', targetDurationSec: 5,
    concept: '', story: '', screenplay: '', characterIds: [],
    scenes: [legacyScene as never], assets: [legacyUnsafeAsset as never], status: 'Konzept'
  }
};
const cleanSnapshots = sanitizeProjectSnapshots([legacySnapshot as never]);
assert.equal(cleanSnapshots[0].state?.scenes[0].imageUrl, undefined);
assert.deepEqual(cleanSnapshots[0].state?.assets, []);

console.log('Project asset URL validation tests passed.');
