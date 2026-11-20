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

/**
 * Downloads a clip in bounded byte windows. If a mobile connection drops,
 * only the current window is retried; completed windows are kept as Blob parts.
 */
export async function downloadSceneVideoInRanges(
  url: string,
  fetcher: typeof fetch = fetch,
  chunkBytes = 1024 * 1024,
): Promise<Blob> {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 64 * 1024 || chunkBytes > 4 * 1024 * 1024) {
    throw new Error('Ungültige Download-Blockgröße.');
  }
  const head = await fetcher(url, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store' });
  if (!head.ok) throw new Error(`ZERO-Clip konnte nicht vorbereitet werden (HTTP ${head.status}).`);
  const totalBytes = Number(head.headers.get('content-length'));
  const contentType = head.headers.get('content-type') || 'application/octet-stream';
  const etag = head.headers.get('etag');
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1024 || totalBytes > 100 * 1024 * 1024 ||
      !['video/mp4', 'video/webm'].includes(contentType)) {
    throw new Error('ZERO hat ungültige Clip-Metadaten für den Download geliefert.');
  }

  const parts: Blob[] = [];
  for (let start = 0; start < totalBytes;) {
    const end = Math.min(totalBytes - 1, start + chunkBytes - 1);
    let part: Blob | null = null;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3 && !part; attempt += 1) {
      try {
        const headers: Record<string, string> = { Range: `bytes=${start}-${end}` };
        if (etag) headers['If-Range'] = etag;
        const response = await fetcher(url, {
          method: 'GET', credentials: 'same-origin', cache: 'no-store', headers,
        });
        const contentRange = response.headers.get('content-range') || '';
        const match = /^bytes (\\d+)-(\\d+)\\/(\\d+)$/.exec(contentRange);
        if (response.status !== 206 || !match ||
            Number(match[1]) !== start || Number(match[2]) !== end || Number(match[3]) !== totalBytes) {
          throw new Error('ZERO hat einen unvollständigen oder nicht passenden Bytebereich geliefert.');
        }
        const received = await response.blob();
        if (received.size !== end - start + 1) throw new Error('ZERO-Downloadblock ist unvollständig.');
        part = received;
      } catch (error) {
        lastError = error;
      }
    }
    if (!part) {
      throw new Error(`ZERO-Download bei Byte ${start} konnte nicht fortgesetzt werden: ${lastError instanceof Error ? lastError.message : 'Verbindungsfehler'}`);
    }
    parts.push(part);
    start = end + 1;
  }
  return new Blob(parts, { type: contentType });
}

/** PostgreSQL is the cross-device source of truth; IndexedDB is only an offline fallback. */
export async function loadSceneVideoClip(projectId: string, sceneId: string): Promise<Blob | null> {
  if (!projectId || !sceneId) return null;
  try {
    const url = `/api/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/video`;
    const remote = await downloadSceneVideoInRanges(url);
    try { await saveLocally(projectId, sceneId, remote); } catch { /* remote copy remains durable */ }
    return remote;
  } catch {
    // Fall back to the local cache when the server is temporarily unavailable.
  }

  try {
    return await loadLocally(projectId, sceneId);
  } catch {
    return null;
  }
}
