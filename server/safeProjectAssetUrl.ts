import type { ProjectAsset } from '../src/types/zero.ts';
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
