import assert from 'node:assert/strict';
import {
  clearProjectVideoPlaybackSnapshot,
  PROJECT_VIDEO_PLAYBACK_SNAPSHOT_KEY,
  readProjectVideoPlaybackSnapshot,
  saveProjectVideoPlaybackSnapshot,
  persistProjectVideoPlaybackOnUnmount,
  findProjectVideoPlaybackAsset,
  shouldOpenVideoStudioForPlaybackSnapshot,
  type ProjectVideoSnapshotStorage,
} from '../lib/projectVideoPlayback.ts';

class MemoryStorage implements ProjectVideoSnapshotStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const storage = new MemoryStorage();
const snapshot = {
  projectId: 'project-1',
  assetId: 'asset-1',
  sceneId: 'scene-1',
  currentTime: 42.75,
  shouldPlay: true,
};
saveProjectVideoPlaybackSnapshot(storage, snapshot, 1000);
assert.deepEqual(readProjectVideoPlaybackSnapshot(storage, 1001), { ...snapshot, savedAt: 1000 },
  'the selected clip, scene, position and playback intent survive an auth-gate remount');
const restoredAfterLogin = readProjectVideoPlaybackSnapshot(storage, 1001);
assert.equal(shouldOpenVideoStudioForPlaybackSnapshot(restoredAfterLogin), true,
  'a valid session marker routes the authenticated app back to Video Studio');
const history = [
  { id: 'different-asset', sceneId: 'scene-1', title: 'Wrong clip' },
  { id: 'asset-1', sceneId: 'different-scene', title: 'Wrong scene' },
  { id: 'asset-1', sceneId: 'scene-1', title: 'Selected clip' },
];
assert.equal(findProjectVideoPlaybackAsset(restoredAfterLogin!, 'project-1', history)?.title, 'Selected clip',
  'post-login history lookup restores the exact project, clip and scene');
assert.equal(findProjectVideoPlaybackAsset(restoredAfterLogin!, 'another-project', history), null,
  'a playback marker cannot select a clip from another project');

// Exercise the same unmount persistence helper used when the expired-session
// auth gate removes VideoStudioView. Safari has already reset currentTime.
persistProjectVideoPlaybackOnUnmount(storage, restoredAfterLogin, 0, 42.75, true, true, 1002);
const afterAuthUnmount = readProjectVideoPlaybackSnapshot(storage, 1003);
assert.equal(afterAuthUnmount?.currentTime, 42.75,
  'auth-expiry unmount must not overwrite cached position with Safari currentTime=0');
assert.equal(afterAuthUnmount?.shouldPlay, true, 'auth-expiry unmount preserves previous playback intent');
const afterReloginRemount = readProjectVideoPlaybackSnapshot(storage, 1004);
assert.equal(shouldOpenVideoStudioForPlaybackSnapshot(afterReloginRemount), true);
assert.equal(findProjectVideoPlaybackAsset(afterReloginRemount!, 'project-1', history)?.title, 'Selected clip',
  'a fresh authenticated Video Studio mount restores the exact archived clip after login');
assert.equal(readProjectVideoPlaybackSnapshot(storage, 1000 + 24 * 60 * 60 * 1000 + 1), null,
  'stale recovery markers expire after one day');
assert.equal(storage.getItem(PROJECT_VIDEO_PLAYBACK_SNAPSHOT_KEY), null,
  'expired playback markers are cleared');
saveProjectVideoPlaybackSnapshot(storage, snapshot, 2000);
clearProjectVideoPlaybackSnapshot(storage);
assert.equal(readProjectVideoPlaybackSnapshot(storage, 2001), null, 'manual clear removes the marker');
storage.setItem(PROJECT_VIDEO_PLAYBACK_SNAPSHOT_KEY, '{broken');
assert.equal(readProjectVideoPlaybackSnapshot(storage, 2002), null, 'corrupt marker is rejected safely');
assert.equal(storage.getItem(PROJECT_VIDEO_PLAYBACK_SNAPSHOT_KEY), null);
console.log('Project video playback snapshot tests passed.');
