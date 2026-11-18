export type VideoObjectUrlKind = 'restored' | 'generated' | 'export';
export interface VideoObjectUrlReference { projectId: string; sceneId?: string; kind: VideoObjectUrlKind; }
interface SceneReference { projectId: string; sceneId: string; kind: VideoObjectUrlKind; }
interface PreviewReference { referenceId: string; projectId: string; kind: VideoObjectUrlKind; }
interface RegistryEntry { scenes: Map<string, SceneReference>; previews: Map<string, PreviewReference>; }
export interface ObjectUrlApi { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void; }

/** Owns object URLs created by one Video Studio instance and reference-counts their consumers. */
export class VideoObjectUrlRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  constructor(private readonly urlApi: ObjectUrlApi = URL) {}

  create(blob: Blob, reference: VideoObjectUrlReference): string {
    const url = this.urlApi.createObjectURL(blob);
    this.register(url, reference);
    return url;
  }

  register(url: string, reference: VideoObjectUrlReference): void {
    if (!url.startsWith('blob:')) return;
    const entry = this.getOrCreate(url);
    if (reference.sceneId) entry.scenes.set(this.sceneKey(reference.projectId, reference.sceneId), {
      projectId: reference.projectId, sceneId: reference.sceneId, kind: reference.kind,
    });
  }

  retainPreview(url: string, referenceId: string, projectId: string, kind: VideoObjectUrlKind): void {
    const entry = this.entries.get(url);
    if (entry) entry.previews.set(referenceId, { referenceId, projectId, kind });
  }

  releasePreview(url: string, referenceId: string): boolean {
    const entry = this.entries.get(url);
    if (!entry || !entry.previews.delete(referenceId)) return false;
    return this.revokeIfUnused(url);
  }

  releaseSceneReference(url: string, projectId: string, sceneId: string): boolean {
    const entry = this.entries.get(url);
    if (!entry || !entry.scenes.delete(this.sceneKey(projectId, sceneId))) return false;
    return this.revokeIfUnused(url);
  }

  getProjectUrls(projectId: string, kind?: VideoObjectUrlKind): string[] {
    const urls: string[] = [];
    for (const [url, entry] of this.entries) {
      const sceneMatch = [...entry.scenes.values()].some((ref) => ref.projectId === projectId && (!kind || ref.kind === kind));
      const previewMatch = [...entry.previews.values()].some((ref) => ref.projectId === projectId && (!kind || ref.kind === kind));
      if (sceneMatch || previewMatch) urls.push(url);
    }
    return urls;
  }

  releaseProjectRestored(projectId: string): string[] {
    const revoked: string[] = [];
    for (const [url, entry] of this.entries) {
      for (const [key, ref] of entry.scenes) {
        if (ref.projectId === projectId && ref.kind === 'restored') entry.scenes.delete(key);
      }
      for (const [key, ref] of entry.previews) {
        if (ref.projectId === projectId && ref.kind === 'restored') entry.previews.delete(key);
      }
      if (this.revokeIfUnused(url)) revoked.push(url);
    }
    return revoked;
  }

  releaseAll(): string[] {
    const urls = [...this.entries.keys()];
    this.entries.clear();
    urls.forEach((url) => this.urlApi.revokeObjectURL(url));
    return urls;
  }

  has(url: string): boolean { return this.entries.has(url); }

  private getOrCreate(url: string): RegistryEntry {
    let entry = this.entries.get(url);
    if (!entry) { entry = { scenes: new Map(), previews: new Map() }; this.entries.set(url, entry); }
    return entry;
  }

  private sceneKey(projectId: string, sceneId: string): string { return `${projectId}\u0000${sceneId}`; }

  private revokeIfUnused(url: string): boolean {
    const entry = this.entries.get(url);
    if (!entry || entry.scenes.size > 0 || entry.previews.size > 0) return false;
    this.entries.delete(url);
    this.urlApi.revokeObjectURL(url);
    return true;
  }
}