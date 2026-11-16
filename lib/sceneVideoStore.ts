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
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
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
}

/** Best-effort request to protect local media from automatic browser eviction. */
export async function requestSceneVideoStoragePersistence(
  storage?: StorageManager
): Promise<SceneVideoStorageStatus> {
  const manager = storage ?? (typeof navigator !== 'undefined' ? navigator.storage : undefined);
  if (!manager) return { persistent: null, usageBytes: null, quotaBytes: null };

  let persistent: boolean | null = null;
  try {
    persistent = await manager.persisted();
    if (!persistent) persistent = await manager.persist();
  } catch {
    // A denied/unsupported persistence request must not block a local save.
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

  return { persistent, usageBytes, quotaBytes };
}

export async function saveSceneVideoClip(
  projectId: string,
  sceneId: string,
  blob: Blob
): Promise<SceneVideoStorageStatus> {
  if (!projectId || !sceneId || blob.size < 1024 || !blob.type.startsWith('video/')) {
    throw new Error('Der Szenenclip ist ungültig und wurde nicht gespeichert.');
  }
  const storageStatus = await requestSceneVideoStoragePersistence();
  const db = await openMediaDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(blob, clipKey(projectId, sceneId));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Szenenclip konnte nicht dauerhaft gespeichert werden.'));
      tx.onabort = () => reject(tx.error || new Error('Speichern des Szenenclips wurde abgebrochen.'));
    });
  } finally {
    db.close();
  }
  return storageStatus;
}

export async function loadSceneVideoClip(projectId: string, sceneId: string): Promise<Blob | null> {
  if (!projectId || !sceneId) return null;
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
