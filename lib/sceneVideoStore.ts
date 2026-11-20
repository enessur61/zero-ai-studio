const DB_NAME = 'zero-ai-studio-media';
const STORE_NAME = 'scene-videos';
const DB_VERSION = 1;

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
  blob: Blob,
  jobId?: string
): Promise<SceneVideoStorageStatus> {
  if (!projectId || !sceneId || blob.size < 1024 || !blob.type.startsWith('video/')) {
    throw new Error('Der Szenenclip ist ungültig und wurde nicht gespeichert.');
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
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', 'X-Zero-Video-Type': blob.type };
    if (jobId) headers['X-Zero-Wan-Job-Id'] = jobId;
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/video`,
      { method: 'PUT', credentials: 'same-origin', headers, body: blob }
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error || 'ZERO konnte den Clip nicht dauerhaft speichern.');
    }
    const payload = await response.json() as { serverPersisted?: boolean };
    serverPersisted = payload.serverPersisted === true;
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

export async function cacheSceneVideoClip(projectId: string, sceneId: string, blob: Blob): Promise<void> {
  if (!projectId || !sceneId || blob.size < 1024 || !blob.type.startsWith('video/')) {
    throw new Error('Der Szenenclip ist ungültig und wurde nicht lokal zwischengespeichert.');
  }
  await saveLocally(projectId, sceneId, blob);
}

export async function deleteSceneVideoClip(projectId: string, sceneId: string): Promise<void> {
  if (!projectId || !sceneId) return;
  const db = await openMediaDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(clipKey(projectId, sceneId));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Lokaler Szenenclip konnte nicht gelöscht werden.'));
      tx.onabort = () => reject(tx.error || new Error('Löschen des lokalen Szenenclips wurde abgebrochen.'));
    });
  } finally {
    db.close();
  }
}

export async function deleteProjectSceneVideos(projectId: string): Promise<void> {
  if (!projectId) return;
  const db = await openMediaDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const objectStore = tx.objectStore(STORE_NAME);
      const request = objectStore.getAllKeys();
      request.onsuccess = () => {
        const prefix = `${projectId}:`;
        for (const key of request.result) {
          if (typeof key === 'string' && key.startsWith(prefix)) objectStore.delete(key);
        }
      };
      request.onerror = () => reject(request.error || new Error('Lokale Projektclips konnten nicht gefunden werden.'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Lokale Projektclips konnten nicht gelöscht werden.'));
      tx.onabort = () => reject(tx.error || new Error('Löschen der lokalen Projektclips wurde abgebrochen.'));
    });
  } finally {
    db.close();
  }
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

/** PostgreSQL is the cross-device source of truth; IndexedDB is only an offline fallback. */
export async function loadSceneVideoClip(projectId: string, sceneId: string): Promise<Blob | null> {
  if (!projectId || !sceneId) return null;
  try {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/video`,
      { credentials: 'same-origin', cache: 'no-store' }
    );
    if (response.status === 404 || (response.status >= 400 && response.status < 500)) return null;
    if (response.ok) {
      const remote = await response.blob();
      if (remote.type.startsWith('video/') && remote.size >= 1024) {
        try { await saveLocally(projectId, sceneId, remote); } catch { /* remote copy remains durable */ }
        return remote;
      }
      return null;
    }
  } catch {
    // Fall back to the local cache when the server is temporarily unavailable.
  }

  try {
    return await loadLocally(projectId, sceneId);
  } catch {
    return null;
  }
}
