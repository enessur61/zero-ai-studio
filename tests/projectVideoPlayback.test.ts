import assert from 'node:assert/strict';
import {
  clearProjectVideoPlaybackSnapshot,
  PROJECT_VIDEO_PLAYBACK_SNAPSHOT_KEY,
  readProjectVideoPlaybackSnapshot,
  saveProjectVideoPlaybackSnapshot,
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
