import { apiRequest } from './api.ts';

const DB_NAME = 'zero-ai-studio-media';
const STORE_NAME = 'scene-videos';
const DB_VERSION = 1;
const MAX_REMOTE_CLIP_BYTES = 11 * 1024 * 1024;

function openMediaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Lokaler Videospeicher ist in diesem Browser nicht verfügbar.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('ZERO-Videospeicher konnte nicht geöffnet werden.'));
    request.onblocked = () => reject(new Error('ZERO-Videospeicher ist durch einen anderen Tab blockiert.'));
  });
}

function clipKey(projectId: string, sceneId: string): string {
  return `${projectId}:${sceneId}`;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('Szenenclip konnte nicht für die Serverspeicherung vorbereitet werden.'));
    reader.onerror = () => reject(reader.error || new Error('Szenenclip konnte nicht gelesen werden.'));
    reader.readAsDataURL(blob);
  });
}

export interface SceneVideoStorageStatus {
  persistent: boolean | null;
  usageBytes: number | null;
  quotaBytes: number | null;
  localSaved: boolean;
  serverPersisted: boolean | null;
}

/** Best-effort request to protect local media from automatic browser eviction. */
export async function requestSceneVideoStoragePersistence(
  storage?: StorageManager
): Promise<SceneVideoStorageStatus> {
  const manager = storage ?? (typeof navigator !== 'undefined' ? navigator.storage : undefined);
  if (!manager) return { persistent: null, usageBytes: null, quotaBytes: null, localSaved: false, serverPersisted: null };

  let persistent: boolean | null = null;
  try {
    persistent = await manager.persisted();
    if (!persistent) persistent = await manager.persist();
  } catch {
    persistent = null;
  }

  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;
  try {
    const estimate = await manager.estimate();
    usageBytes = typeof estimate.usage === 'number' ? estimate.usage : null;
    quotaBytes = typeof estimate.quota === 'number' ? estimate.quota : null;
  } catch {
    // Estimates are advisory only.
  }

  return { persistent, usageBytes, quotaBytes, localSaved: false, serverPersisted: null };
}

async function saveLocally(projectId: string, sceneId: string, blob: Blob): Promise<void> {
  const db = await openMediaDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(blob, clipKey(projectId, sceneId));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Szenenclip konnte nicht lokal gespeichert werden.'));
      tx.onabort = () => reject(tx.error || new Error('Speichern des Szenenclips wurde abgebrochen.'));
    });
  } finally {
    db.close();
  }
}

export async function saveSceneVideoClip(
  projectId: string,
  sceneId: string,
  blob: Blob
): Promise<SceneVideoStorageStatus> {
  if (!projectId || !sceneId || blob.size < 1024 || !blob.type.startsWith('video/')) {
    throw new Error('Der Szenenclip ist ungültig und wurde nicht gespeichert.');
  }
  if (blob.size > MAX_REMOTE_CLIP_BYTES) {
    throw new Error('Der Szenenclip ist größer als 11 MB und kann nicht in ZERO-Projekten synchronisiert werden. Bitte zuerst exportieren oder komprimieren.');
  }

  const storageStatus = await requestSceneVideoStoragePersistence();
  let localSaved = false;
  let serverPersisted: boolean | null = false;
  let localError: unknown;
  let serverError: unknown;

  try {
    await saveLocally(projectId, sceneId, blob);
    localSaved = true;
  } catch (error) {
    localError = error;
  }

  try {
    const dataUrl = await blobToDataUrl(blob);
    await apiRequest<{ ok: boolean; serverPersisted: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/video`,
      { method: 'PUT', body: JSON.stringify({ dataUrl }) }
    );
    serverPersisted = true;
  } catch (error) {
    serverError = error;
  }

  if (!localSaved && !serverPersisted) {
    const details = [localError, serverError]
      .filter(Boolean)
      .map((error) => error instanceof Error ? error.message : String(error))
      .join('; ');
    throw new Error(`Szenenclip konnte weder lokal noch auf dem ZERO-Server gespeichert werden. ${details}`);
  }

  return { ...storageStatus, localSaved, serverPersisted };
}

async function loadLocally(projectId: string, sceneId: string): Promise<Blob | null> {
  const db = await openMediaDb();
  try {
    return await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(clipKey(projectId, sceneId));
      request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
      request.onerror = () => reject(request.error || new Error('Gespeicherter Szenenclip konnte nicht gelesen werden.'));
    });
  } finally {
    db.close();
  }
}

/** Local IndexedDB is the fast cache; PostgreSQL-backed project assets are the cross-device source of truth. */
export async function loadSceneVideoClip(projectId: string, sceneId: string): Promise<Blob | null> {
  if (!projectId || !sceneId) return null;
  try {
    const local = await loadLocally(projectId, sceneId);
    if (local) return local;
  } catch {
    // Continue with the durable server copy if browser storage is unavailable.
  }

  try {
    const remote = await apiRequest<{ dataUrl: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/video`
    );
    const response = await fetch(remote.dataUrl);
    if (!response.ok) return null;
    const blob = await response.blob();
    return blob.type.startsWith('video/') && blob.size >= 1024 ? blob : null;
  } catch {
    return null;
  }
}
