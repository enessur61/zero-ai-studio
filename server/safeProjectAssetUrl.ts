import type { FilmScene, ProjectAsset, ProjectSnapshot } from '../src/types/zero.ts';
import { parseBase64DataUrl } from './mediaUtils.ts';

const DATA_MIMES_BY_ASSET_TYPE: Record<ProjectAsset['type'], readonly string[]> = {
  image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  audio: ['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/mp4'],
  music: ['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/mp4'],
  video: ['video/mp4', 'video/webm'],
  script: ['text/plain'],
};

/** Allow only navigable HTTP(S), known local asset paths, or type-safe data URLs. */
export function isSafeProjectAssetUrl(value: unknown, type: ProjectAsset['type']): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 16 * 1024 * 1024) return false;
  const url = value.trim();

  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && Boolean(parsed.hostname);
    } catch {
      return false;
    }
  }

  if (url.startsWith('/src/assets/')) return true;

  return parseBase64DataUrl(url, DATA_MIMES_BY_ASSET_TYPE[type], 12 * 1024 * 1024) !== null;
}


const PROJECT_ASSET_TYPES: readonly ProjectAsset['type'][] = ['image', 'audio', 'music', 'video', 'script'];

/** Remove malformed or unsafe legacy assets before returning/restoring projects. */
export function sanitizeProjectAssets(value: unknown): ProjectAsset[] {
  if (!Array.isArray(value)) return [];
  return value.filter((asset): asset is ProjectAsset => {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return false;
    const candidate = asset as Partial<ProjectAsset>;
    return typeof candidate.id === 'string' &&
      typeof candidate.title === 'string' &&
      typeof candidate.modelId === 'string' &&
      typeof candidate.createdAt === 'string' &&
      PROJECT_ASSET_TYPES.includes(candidate.type as ProjectAsset['type']) &&
      isSafeProjectAssetUrl(candidate.url, candidate.type as ProjectAsset['type']);
  }).slice(0, 200);
}

/** Strip unsafe legacy scene media URLs without discarding the rest of the scene. */
export function sanitizeProjectScenes(scenes: FilmScene[]): FilmScene[] {
  if (!Array.isArray(scenes)) return [];
  return scenes.map((scene) => {
    const safeScene = { ...scene };
    if (safeScene.imageUrl !== undefined && !isSafeProjectAssetUrl(safeScene.imageUrl, 'image')) {
      delete safeScene.imageUrl;
    }
    if (safeScene.audioDataUrl !== undefined && !isSafeProjectAssetUrl(safeScene.audioDataUrl, 'audio')) {
      delete safeScene.audioDataUrl;
    }
    return safeScene;
  });
}

/** Sanitize all embedded snapshot media, including snapshots created before hardening. */
export function sanitizeProjectSnapshots(snapshots: ProjectSnapshot[]): ProjectSnapshot[] {
  if (!Array.isArray(snapshots)) return [];
  return snapshots.map((snapshot) => snapshot.state
    ? {
        ...snapshot,
        state: {
          ...snapshot.state,
          scenes: sanitizeProjectScenes(snapshot.state.scenes),
          assets: sanitizeProjectAssets(snapshot.state.assets),
        },
      }
    : snapshot);
}
