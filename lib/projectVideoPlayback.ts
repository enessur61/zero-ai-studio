export interface ProjectVideoPlaybackSnapshot {
  projectId: string;
  assetId: string;
  sceneId: string;
  currentTime: number;
  shouldPlay: boolean;
  savedAt: number;
}

export interface ProjectVideoSnapshotStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const PROJECT_VIDEO_PLAYBACK_SNAPSHOT_KEY = 'zero.project-video.playback.v1';
const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1000;

export function saveProjectVideoPlaybackSnapshot(
  storage: ProjectVideoSnapshotStorage,
  snapshot: Omit<ProjectVideoPlaybackSnapshot, 'savedAt'>,
  now = Date.now(),
): void {
  if (!snapshot.projectId || !snapshot.assetId || !snapshot.sceneId ||
      !Number.isFinite(snapshot.currentTime) || snapshot.currentTime < 0) return;
  storage.setItem(PROJECT_VIDEO_PLAYBACK_SNAPSHOT_KEY, JSON.stringify({
    ...snapshot, currentTime: Math.min(snapshot.currentTime, 24 * 60 * 60), savedAt: now,
  } satisfies ProjectVideoPlaybackSnapshot));
}

export function readProjectVideoPlaybackSnapshot(
  storage: ProjectVideoSnapshotStorage,
  now = Date.now(),
): ProjectVideoPlaybackSnapshot | null {
  try {
    const raw = storage.getItem(PROJECT_VIDEO_PLAYBACK_SNAPSHOT_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ProjectVideoPlaybackSnapshot>;
    if (typeof value.projectId !== 'string' || !value.projectId ||
        typeof value.assetId !== 'string' || !value.assetId ||
        typeof value.sceneId !== 'string' || !value.sceneId ||
        typeof value.currentTime !== 'number' || !Number.isFinite(value.currentTime) || value.currentTime < 0 ||
        typeof value.shouldPlay !== 'boolean' || typeof value.savedAt !== 'number' ||
        !Number.isFinite(value.savedAt) || value.savedAt > now || now - value.savedAt > MAX_SNAPSHOT_AGE_MS) {
      storage.removeItem(PROJECT_VIDEO_PLAYBACK_SNAPSHOT_KEY);
      return null;
    }
    return value as ProjectVideoPlaybackSnapshot;
  } catch {
    storage.removeItem(PROJECT_VIDEO_PLAYBACK_SNAPSHOT_KEY);
    return null;
  }
}

export function persistProjectVideoPlaybackOnUnmount(storage: ProjectVideoSnapshotStorage, snapshot: ProjectVideoPlaybackSnapshot | null, currentTime: number, lastKnownPosition: number, preferLastKnownPosition: boolean, shouldPlay: boolean, now = Date.now()): void {
  if (!snapshot) return;
  const position = preferLastKnownPosition || !Number.isFinite(currentTime) ? lastKnownPosition : currentTime;
  saveProjectVideoPlaybackSnapshot(storage, {
    projectId: snapshot.projectId, assetId: snapshot.assetId, sceneId: snapshot.sceneId,
    currentTime: Math.max(0, position), shouldPlay,
  }, now);
}

export function clearProjectVideoPlaybackSnapshot(storage: ProjectVideoSnapshotStorage): void {
  storage.removeItem(PROJECT_VIDEO_PLAYBACK_SNAPSHOT_KEY);
}

export function shouldOpenVideoStudioForPlaybackSnapshot(
  snapshot: ProjectVideoPlaybackSnapshot | null,
): boolean {
  return snapshot !== null;
}

export function findProjectVideoPlaybackAsset<T extends { id: string; sceneId: string }>(
  snapshot: ProjectVideoPlaybackSnapshot,
  projectId: string | undefined,
  assets: readonly T[],
): T | null {
  if (!projectId || projectId !== snapshot.projectId) return null;
  return assets.find((asset) => asset.id === snapshot.assetId && asset.sceneId === snapshot.sceneId) ?? null;
}
