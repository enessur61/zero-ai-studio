import { createHash, randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';

export const MAX_PROJECT_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_PROJECT_VIDEO_STORAGE_BYTES = 500 * 1024 * 1024;
export const MAX_PROJECT_VIDEO_COUNT = 50;
export const MAX_CONCURRENT_PROJECT_VIDEO_STREAMS = 2;
export const MAX_QUEUED_PROJECT_VIDEO_STREAMS = 8;
export const PROJECT_VIDEO_STREAM_QUEUE_TIMEOUT_MS = 8_000;
export class ProjectVideoStreamCapacityError extends Error {
  readonly statusCode = 503;
  constructor(message = 'ZERO video stream capacity is temporarily busy.') {
    super(message); this.name = 'ProjectVideoStreamCapacityError';
  }
}
interface StreamWaiter { resolve: (release: () => void) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
interface StreamAdmissionGate { active: number; queue: StreamWaiter[] }
const streamAdmissionGates = new WeakMap<Pool, StreamAdmissionGate>();
function acquireProjectVideoStreamSlot(database: Pool): Promise<() => void> {
  let gate = streamAdmissionGates.get(database);
  if (!gate) { gate = { active: 0, queue: [] }; streamAdmissionGates.set(database, gate); }
  const state = gate;
  const makeRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = state.queue.shift();
      if (next) { clearTimeout(next.timer); next.resolve(makeRelease()); }
      else state.active -= 1;
    };
  };
  if (state.active < MAX_CONCURRENT_PROJECT_VIDEO_STREAMS) {
    state.active += 1; return Promise.resolve(makeRelease());
  }
  if (state.queue.length >= MAX_QUEUED_PROJECT_VIDEO_STREAMS) {
    return Promise.reject(new ProjectVideoStreamCapacityError());
  }
  return new Promise((resolve, reject) => {
    const waiter: StreamWaiter = {
      resolve, reject,
      timer: setTimeout(() => {
        const index = state.queue.indexOf(waiter);
        if (index >= 0) state.queue.splice(index, 1);
        reject(new ProjectVideoStreamCapacityError('ZERO video stream capacity queue timed out. Please retry shortly.'));
      }, PROJECT_VIDEO_STREAM_QUEUE_TIMEOUT_MS),
    };
    state.queue.push(waiter);
  });
}

export interface ProjectVideoAsset {
  id: string;
  projectId: string;
  sceneId: string;
  jobId: string | null;
  contentType: 'video/mp4' | 'video/webm';
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

interface ProjectVideoRow extends QueryResultRow {
  asset_id: string;
  project_id: string;
  scene_id: string;
  job_id: string | null;
  content_type: 'video/mp4' | 'video/webm';
  size_bytes: string;
  sha256: string;
  created_at: Date | string;
  payload?: Buffer;
}

export class ProjectVideoProjectNotFoundError extends Error {
  constructor() {
    super('Project no longer exists.');
    this.name = 'ProjectVideoProjectNotFoundError';
  }
}

export class ProjectVideoLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectVideoLimitError';
  }
}

export function isValidProjectVideoPayload(value: unknown, contentType: string): value is Buffer {
  if (!Buffer.isBuffer(value) || value.length < 1024 || value.length > MAX_PROJECT_VIDEO_BYTES) return false;
  if (contentType === 'video/mp4') return value.toString('ascii', 4, 8) === 'ftyp';
  if (contentType === 'video/webm') return value.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return false;
}

function toAsset(row: ProjectVideoRow): ProjectVideoAsset {
  return {
    id: row.asset_id,
    projectId: row.project_id,
    sceneId: row.scene_id,
    jobId: row.job_id,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function ensureSchema(database: Pool): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS zero_project_video_assets (
      asset_id UUID PRIMARY KEY,
      project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
      scene_id TEXT NOT NULL CHECK (length(scene_id) BETWEEN 1 AND 128),
      principal_hash CHAR(64) NOT NULL CHECK (principal_hash ~ '^[a-f0-9]{64}$'),
      job_id UUID,
      content_type TEXT NOT NULL CHECK (content_type IN ('video/mp4', 'video/webm')),
      size_bytes BIGINT NOT NULL CHECK (size_bytes BETWEEN 1024 AND ${MAX_PROJECT_VIDEO_BYTES}),
      sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
      payload BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (principal_hash, job_id)
    )
  `);
  await database.query(`
    CREATE INDEX IF NOT EXISTS zero_project_video_assets_project_idx
    ON zero_project_video_assets (principal_hash, project_id, created_at DESC)
  `);
}

export interface ProjectVideoStoreLimits {
  maxProjectVideoBytes?: number;
  maxProjectStorageBytes?: number;
  maxProjectVideoCount?: number;
}

export function createProjectVideoAssetStore(
  database: Pool,
  configuredLimits: ProjectVideoStoreLimits = {},
) {
  const limits = {
    maxProjectVideoBytes: configuredLimits.maxProjectVideoBytes ?? MAX_PROJECT_VIDEO_BYTES,
    maxProjectStorageBytes: configuredLimits.maxProjectStorageBytes ?? MAX_PROJECT_VIDEO_STORAGE_BYTES,
    maxProjectVideoCount: configuredLimits.maxProjectVideoCount ?? MAX_PROJECT_VIDEO_COUNT,
  };
  if (
    !Number.isSafeInteger(limits.maxProjectVideoBytes) || limits.maxProjectVideoBytes < 1024 ||
    limits.maxProjectVideoBytes > MAX_PROJECT_VIDEO_BYTES ||
    !Number.isSafeInteger(limits.maxProjectStorageBytes) || limits.maxProjectStorageBytes < limits.maxProjectVideoBytes ||
    limits.maxProjectStorageBytes > MAX_PROJECT_VIDEO_STORAGE_BYTES ||
    !Number.isSafeInteger(limits.maxProjectVideoCount) || limits.maxProjectVideoCount < 1 ||
    limits.maxProjectVideoCount > MAX_PROJECT_VIDEO_COUNT
  ) throw new Error('Invalid project video storage limits.');
  let schemaReady: Promise<void> | null = null;
  const ready = async () => {
    if (!schemaReady) schemaReady = ensureSchema(database).catch((error) => {
      schemaReady = null;
      throw error;
    });
    await schemaReady;
  };

  async function put(input: {
    projectId: string;
    sceneId: string;
    principalHash: string;
    jobId?: string | null;
    contentType: 'video/mp4' | 'video/webm';
    payload: Buffer;
    isProjectActive?: () => Promise<boolean>;
  }): Promise<ProjectVideoAsset> {
    if (!/^[a-f0-9]{64}$/.test(input.principalHash)) throw new Error('Authenticated principal is required.');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.projectId) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.sceneId)) {
      throw new Error('Invalid project or scene identifier.');
    }
    if (input.jobId && !/^[0-9a-f-]{36}$/i.test(input.jobId)) throw new Error('Invalid Wan job identifier.');
    if (!isValidProjectVideoPayload(input.payload, input.contentType) || input.payload.length > limits.maxProjectVideoBytes) {
      throw new Error('Invalid or oversized project video payload.');
    }
    await ready();
    const client = await database.connect();
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      await client.query("SET LOCAL statement_timeout = '120s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`zero-project-video:${input.principalHash}:${input.projectId}`]);
      // Re-check the authoritative PostgreSQL project state while holding the
      // same lock as deletion. This closes the stale-read upload/delete race.
      if (input.isProjectActive && !(await input.isProjectActive())) {
        throw new ProjectVideoProjectNotFoundError();
      }

      if (input.jobId) {
        const existing = await client.query<ProjectVideoRow>(
          'SELECT * FROM zero_project_video_assets WHERE principal_hash = $1 AND job_id = $2 FOR UPDATE',
          [input.principalHash, input.jobId],
        );
        if (existing.rows[0]) {
          const row = existing.rows[0];
          if (row.project_id !== input.projectId || row.scene_id !== input.sceneId) {
            throw new Error('Wan job is already archived under a different project or scene.');
          }
          const usage = await client.query<{ bytes: string }>(
            `SELECT COALESCE(SUM(size_bytes), 0)::text AS bytes
             FROM zero_project_video_assets
             WHERE principal_hash = $1 AND project_id = $2 AND asset_id <> $3`,
            [input.principalHash, input.projectId, row.asset_id],
          );
          if (Number(usage.rows[0]?.bytes ?? 0) + input.payload.length > limits.maxProjectStorageBytes) {
            throw new ProjectVideoLimitError('Dieses Projekt hat das Speicherlimit von 500 MB erreicht. Bitte ältere Clips manuell löschen.');
          }
          const digest = createHash('sha256').update(input.payload).digest('hex');
          const updated = await client.query<ProjectVideoRow>(
            `UPDATE zero_project_video_assets
             SET content_type = $2, size_bytes = $3, sha256 = $4, payload = $5,
                 created_at = NOW()
             WHERE asset_id = $1 RETURNING *`,
            [row.asset_id, input.contentType, input.payload.length, digest, input.payload],
          );
          await client.query('COMMIT');
          inTransaction = false;
          return toAsset(updated.rows[0]);
        }
      }

      const usage = await client.query<{ bytes: string; count: string }>(
        `SELECT COALESCE(SUM(size_bytes), 0)::text AS bytes, COUNT(*)::text AS count
         FROM zero_project_video_assets
         WHERE principal_hash = $1 AND project_id = $2`,
        [input.principalHash, input.projectId],
      );
      const usedBytes = Number(usage.rows[0]?.bytes ?? 0);
      const count = Number(usage.rows[0]?.count ?? 0);
      if (count >= limits.maxProjectVideoCount) {
        throw new ProjectVideoLimitError('Dieses Projekt hat das Limit von 50 gespeicherten Clips erreicht. Bitte Clips manuell löschen.');
      }
      if (usedBytes + input.payload.length > limits.maxProjectStorageBytes) {
        throw new ProjectVideoLimitError('Dieses Projekt hat das Speicherlimit von 500 MB erreicht. Bitte ältere Clips manuell löschen.');
      }

      const assetId = randomUUID();
      const digest = createHash('sha256').update(input.payload).digest('hex');
      const inserted = await client.query<ProjectVideoRow>(
        `INSERT INTO zero_project_video_assets
          (asset_id, project_id, scene_id, principal_hash, job_id, content_type, size_bytes, sha256, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [assetId, input.projectId, input.sceneId, input.principalHash, input.jobId ?? null,
          input.contentType, input.payload.length, digest, input.payload],
      );
      await client.query('COMMIT');
      inTransaction = false;
      return toAsset(inserted.rows[0]);
    } catch (error) {
      if (inTransaction) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function list(projectId: string, principalHash: string): Promise<ProjectVideoAsset[]> {
    await ready();
    const result = await database.query<ProjectVideoRow>(
      `SELECT * FROM zero_project_video_assets
       WHERE project_id = $1 AND principal_hash = $2
       ORDER BY created_at DESC LIMIT $3`,
      [projectId, principalHash, limits.maxProjectVideoCount],
    );
    return result.rows.map(toAsset);
  }

  async function readVideo(
    query: string,
    values: unknown[],
  ): Promise<(ProjectVideoAsset & { payload: Buffer }) | null> {
    await ready();
    const client = await database.connect();
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      await client.query("SET LOCAL statement_timeout = '120s'");
      const result = await client.query<ProjectVideoRow>(query, values);
      await client.query('COMMIT');
      inTransaction = false;
      const row = result.rows[0];
      return row?.payload ? { ...toAsset(row), payload: row.payload } : null;
    } catch (error) {
      if (inTransaction) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function get(assetId: string, projectId: string, principalHash: string): Promise<(ProjectVideoAsset & { payload: Buffer }) | null> {
    return readVideo(
      `SELECT * FROM zero_project_video_assets
       WHERE asset_id = $1 AND project_id = $2 AND principal_hash = $3`,
      [assetId, projectId, principalHash],
    );
  }

  async function getLatestForScene(projectId: string, sceneId: string, principalHash: string): Promise<(ProjectVideoAsset & { payload: Buffer }) | null> {
    return readVideo(
      `SELECT * FROM zero_project_video_assets
       WHERE project_id = $1 AND scene_id = $2 AND principal_hash = $3
       ORDER BY created_at DESC LIMIT 1`,
      [projectId, sceneId, principalHash],
    );
  }

  async function remove(assetId: string, projectId: string, principalHash: string): Promise<boolean> {
    await ready();
    const client = await database.connect();
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      await client.query("SET LOCAL statement_timeout = '120s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `zero-project-video:${principalHash}:${projectId}`,
      ]);
      const result = await client.query(
        'DELETE FROM zero_project_video_assets WHERE asset_id = $1 AND project_id = $2 AND principal_hash = $3',
        [assetId, projectId, principalHash],
      );
      await client.query('COMMIT');
      inTransaction = false;
      return result.rowCount === 1;
    } catch (error) {
      if (inTransaction) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function removeProject(projectId: string, principalHash: string): Promise<number> {
    if (!/^[a-f0-9]{64}$/.test(principalHash)) throw new Error('Authenticated principal is required.');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) throw new Error('Invalid project identifier.');
    await ready();
    const client = await database.connect();
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      await client.query("SET LOCAL statement_timeout = '120s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `zero-project-video:${principalHash}:${projectId}`,
      ]);
      const result = await client.query(
        'DELETE FROM zero_project_video_assets WHERE project_id = $1 AND principal_hash = $2',
        [projectId, principalHash],
      );
      await client.query('COMMIT');
      inTransaction = false;
      return result.rowCount ?? 0;
    } catch (error) {
      if (inTransaction) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }


  async function openRead(
    assetId: string,
    projectId: string,
    principalHash: string,
  ): Promise<(ProjectVideoAsset & { chunksForRange: (start?: number, end?: number) => AsyncIterable<Buffer>; close: () => Promise<void> }) | null> {
    if (!/^[a-f0-9]{64}$/.test(principalHash)) throw new Error('Authenticated principal is required.');
    await ready();
    const releaseAdmission = await acquireProjectVideoStreamSlot(database);
    let client: Awaited<ReturnType<Pool['connect']>> | null = null;
    let inTransaction = false;
    try {
      client = await database.connect();
      await client.query('BEGIN'); inTransaction = true;
      await client.query("SET LOCAL statement_timeout = '120s'");
      // Shared row lock preserves byte consistency until the response closes.
      const result = await client.query<ProjectVideoRow>(
        `SELECT asset_id, project_id, scene_id, job_id, content_type,
                octet_length(payload)::text AS size_bytes, sha256, created_at
         FROM zero_project_video_assets
         WHERE asset_id = $1 AND project_id = $2 AND principal_hash = $3
         FOR SHARE`,
        [assetId, projectId, principalHash],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query('ROLLBACK'); inTransaction = false;
        client.release(); client = null; releaseAdmission(); return null;
      }
      const asset = toAsset(row);
      let released = false;
      const close = async () => {
        if (released) return;
        released = true;
        try {
          if (inTransaction) { await client!.query('COMMIT').catch(() => undefined); inTransaction = false; }
        } finally { client!.release(); releaseAdmission(); }
      };
      const chunksForRange = (rangeStart = 0, rangeEnd = asset.sizeBytes - 1): AsyncIterable<Buffer> => {
        const start = Math.max(0, Math.min(asset.sizeBytes - 1, Math.floor(rangeStart)));
        const end = Math.max(start, Math.min(asset.sizeBytes - 1, Math.floor(rangeEnd)));
        return (async function* (): AsyncGenerator<Buffer> {
          try {
            const chunkBytes = 256 * 1024;
            for (let offset = start; offset <= end; offset += chunkBytes) {
              const length = Math.min(chunkBytes, end - offset + 1);
              const chunkResult = await client!.query<{ chunk: Buffer }>(
                'SELECT substring(payload FROM $2 FOR $3) AS chunk FROM zero_project_video_assets WHERE asset_id = $1',
                [assetId, offset + 1, length],
              );
              const chunk = chunkResult.rows[0]?.chunk;
              if (!Buffer.isBuffer(chunk) || chunk.length !== length) throw new Error('Project video stream returned an incomplete database chunk.');
              yield chunk;
            }
          } finally { await close(); }
        })();
      };
      return { ...asset, chunksForRange, close };
    } catch (error) {
      if (inTransaction && client) await client.query('ROLLBACK').catch(() => undefined);
      client?.release(); releaseAdmission(); throw error;
    }
  }

  async function openReadLatestForScene(
    projectId: string,
    sceneId: string,
    principalHash: string,
  ): Promise<(ProjectVideoAsset & { chunksForRange: (start?: number, end?: number) => AsyncIterable<Buffer>; close: () => Promise<void> }) | null> {
    await ready();
    const lookup = await database.query<{ asset_id: string }>(
      `SELECT asset_id FROM zero_project_video_assets
       WHERE project_id = $1 AND scene_id = $2 AND principal_hash = $3
       ORDER BY created_at DESC LIMIT 1`,
      [projectId, sceneId, principalHash],
    );
    const assetId = lookup.rows[0]?.asset_id;
    return assetId ? openRead(assetId, projectId, principalHash) : null;
  }

  return { put, list, get, getLatestForScene, openRead, openReadLatestForScene, remove, removeProject };
}
