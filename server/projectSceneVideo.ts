import { isSafeProjectAssetUrl } from './safeProjectAssetUrl.ts';
import type { StudioProject } from '../src/types/zero.ts';

export type SceneVideoLookupResult =
  | { kind: 'project_not_found' }
  | { kind: 'scene_not_found' }
  | { kind: 'media_not_found' }
  | { kind: 'invalid_media' }
  | { kind: 'found'; dataUrl: string };

export function lookupProjectSceneVideo(
  projects: readonly StudioProject[],
  projectId: string,
  sceneId: string,
): SceneVideoLookupResult {
  const project = projects.find((item) => item.id === projectId);
  if (!project) return { kind: 'project_not_found' };

  const scene = project.scenes.find((item) => item.id === sceneId);
  if (!scene) return { kind: 'scene_not_found' };

  const assetKey = `zero-scene-video:${scene.id}`;
  const asset = project.assets.find((item) => item.type === 'video' && item.modelId === assetKey);
  if (!asset) return { kind: 'media_not_found' };
  if (!isSafeProjectAssetUrl(asset.url, 'video')) return { kind: 'invalid_media' };
  return { kind: 'found', dataUrl: asset.url };
}
