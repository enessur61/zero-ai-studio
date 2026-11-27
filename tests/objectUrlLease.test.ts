import assert from 'node:assert/strict';
import { ObjectUrlLease } from '../lib/objectUrlLease.ts';

{
  const revoked: string[] = [];
  const lease = new ObjectUrlLease((url) => revoked.push(url));
  lease.adopt('blob:track-1');
  lease.adopt('blob:sfx-1');
  assert.equal(lease.release('blob:track-1'), true);
  assert.equal(lease.release('blob:track-1'), false, 'a URL is revoked at most once');
  assert.deepEqual(revoked, ['blob:track-1']);
  assert.deepEqual(lease.releaseAll(), ['blob:sfx-1']);
  assert.deepEqual(revoked, ['blob:track-1', 'blob:sfx-1']);
}

{
  const revoked: string[] = [];
  const lease = new ObjectUrlLease((url) => revoked.push(url));
  lease.adopt('blob:track-old');
  assert.equal(lease.replace('blob:track-old', 'blob:track-new'), 'blob:track-new');
  assert.equal(lease.has('blob:track-old'), false, 'replacing a track releases the previous blob URL');
  assert.equal(lease.has('blob:track-new'), true, 'the replacement track remains owned until cleanup');
  assert.deepEqual(revoked, ['blob:track-old']);
  assert.deepEqual(lease.releaseAll(), ['blob:track-new']);
  assert.deepEqual(revoked, ['blob:track-old', 'blob:track-new']);
}

{
  const revoked: string[] = [];
  const lease = new ObjectUrlLease((url) => revoked.push(url));
  lease.adopt('blob:music-to-video');
  assert.equal(lease.transfer('blob:music-to-video'), true);
  assert.equal(lease.has('blob:music-to-video'), false);
  assert.deepEqual(lease.releaseAll(), []);
  assert.deepEqual(revoked, [], 'transferred audio stays valid for Video Studio ownership');
}

{
  const revoked: string[] = [];
  const lease = new ObjectUrlLease((url) => revoked.push(url));
  lease.adopt('data:audio/wav;base64,AAAA');
  assert.deepEqual(lease.releaseAll(), [], 'data URLs are not object URLs and must not be revoked');
  assert.deepEqual(revoked, []);
}

console.log('Object URL lease tests passed: replacement, one-time cleanup, transfer and data URL safety.');
