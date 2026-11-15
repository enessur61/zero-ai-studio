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

export async function saveSceneVideoClip(projectId: string, sceneId: string, blob: Blob): Promise<void> {
  if (!projectId || !sceneId || blob.size < 1024 || !blob.type.startsWith('video/')) {
    throw new Error('Der Szenenclip ist ungültig und wurde nicht gespeichert.');
  }
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
