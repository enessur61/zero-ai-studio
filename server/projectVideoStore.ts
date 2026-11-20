import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

export const MAX_PROJECT_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_PROJECT_VIDEO_STORAGE_BYTES = 500 * 1024 * 1024;
export const MAX_PROJECT_VIDEO_COUNT = 50;
export const PROJECT_VIDEO_RETENTION_DAYS = 90;

export interface ProjectVideoAsset {
  id: string;
  projectId: string;
  sceneId: string;
  jobId: string | null;
  contentType: 'video/mp4' | 'video/webm';
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
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
  expires_at: Date | string;
  payload?: Buffer;
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
    expiresAt: new Date(row.expires_at).toISOString(),
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
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '${PROJECT_VIDEO_RETENTION_DAYS} days'),
      UNIQUE (principal_hash, job_id)
    )
  `);
  await database.query(`
    CREATE INDEX IF NOT EXISTS zero_project_video_assets_project_idx
    ON zero_project_video_assets (principal_hash, project_id, created_at DESC)
  `);
  await database.query(`
    CREATE INDEX IF NOT EXISTS zero_project_video_assets_expiry_idx
    ON zero_project_video_assets (expires_at)
  `);
}

async function pruneExpiredWithClient(client: PoolClient, principalHash: string): Promise<void> {
  await client.query(
    'DELETE FROM zero_project_video_assets WHERE principal_hash = $1 AND expires_at <= NOW()',
    [principalHash],
  );
}

export function createProjectVideoAssetStore(database: Pool) {
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
  }): Promise<ProjectVideoAsset> {
    if (!/^[a-f0-9]{64}$/.test(input.principalHash)) throw new Error('Authenticated principal is required.');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.projectId) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.sceneId)) {
      throw new Error('Invalid project or scene identifier.');
    }
    if (input.jobId && !/^[0-9a-f-]{36}$/i.test(input.jobId)) throw new Error('Invalid Wan job identifier.');
    if (!isValidProjectVideoPayload(input.payload, input.contentType)) {
      throw new Error('Invalid or oversized project video payload.');
    }
    await ready();
    const client = await database.connect();
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`zero-project-video:${input.principalHash}:${input.projectId}`]);
      await pruneExpiredWithClient(client, input.principalHash);

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
             WHERE principal_hash = $1 AND project_id = $2 AND expires_at > NOW() AND asset_id <> $3`,
            [input.principalHash, input.projectId, row.asset_id],
          );
          if (Number(usage.rows[0]?.bytes ?? 0) + input.payload.length > MAX_PROJECT_VIDEO_STORAGE_BYTES) {
            throw new ProjectVideoLimitError('Dieses Projekt hat das Speicherlimit von 500 MB erreicht. Bitte ältere Clips manuell löschen.');
          }
          const digest = createHash('sha256').update(input.payload).digest('hex');
          const updated = await client.query<ProjectVideoRow>(
            `UPDATE zero_project_video_assets
             SET content_type = $2, size_bytes = $3, sha256 = $4, payload = $5,
                 created_at = NOW(), expires_at = NOW() + INTERVAL '${PROJECT_VIDEO_RETENTION_DAYS} days'
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
         WHERE principal_hash = $1 AND project_id = $2 AND expires_at > NOW()`,
        [input.principalHash, input.projectId],
      );
      const usedBytes = Number(usage.rows[0]?.bytes ?? 0);
      const count = Number(usage.rows[0]?.count ?? 0);
      if (count >= MAX_PROJECT_VIDEO_COUNT) {
        throw new ProjectVideoLimitError('Dieses Projekt hat das Limit von 50 gespeicherten Clips erreicht. Bitte Clips manuell löschen.');
      }
      if (usedBytes + input.payload.length > MAX_PROJECT_VIDEO_STORAGE_BYTES) {
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
    await database.query(
      'DELETE FROM zero_project_video_assets WHERE principal_hash = $1 AND expires_at <= NOW()',
      [principalHash],
    );
    const result = await database.query<ProjectVideoRow>(
      `SELECT * FROM zero_project_video_assets
       WHERE project_id = $1 AND principal_hash = $2 AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT $3`,
      [projectId, principalHash, MAX_PROJECT_VIDEO_COUNT],
    );
    return result.rows.map(toAsset);
  }

  async function get(assetId: string, projectId: string, principalHash: string): Promise<(ProjectVideoAsset & { payload: Buffer }) | null> {
    await ready();
    const result = await database.query<ProjectVideoRow>(
      `SELECT * FROM zero_project_video_assets
       WHERE asset_id = $1 AND project_id = $2 AND principal_hash = $3 AND expires_at > NOW()`,
      [assetId, projectId, principalHash],
    );
    const row = result.rows[0];
    return row?.payload ? { ...toAsset(row), payload: row.payload } : null;
  }

  async function getLatestForScene(projectId: string, sceneId: string, principalHash: string): Promise<(ProjectVideoAsset & { payload: Buffer }) | null> {
    await ready();
    const result = await database.query<ProjectVideoRow>(
      `SELECT * FROM zero_project_video_assets
       WHERE project_id = $1 AND scene_id = $2 AND principal_hash = $3 AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [projectId, sceneId, principalHash],
    );
    const row = result.rows[0];
    return row?.payload ? { ...toAsset(row), payload: row.payload } : null;
  }

  async function remove(assetId: string, projectId: string, principalHash: string): Promise<boolean> {
    await ready();
    const result = await database.query(
      'DELETE FROM zero_project_video_assets WHERE asset_id = $1 AND project_id = $2 AND principal_hash = $3',
      [assetId, projectId, principalHash],
    );
    return result.rowCount === 1;
  }

  async function removeProject(projectId: string, principalHash: string): Promise<number> {
    await ready();
    const result = await database.query(
      'DELETE FROM zero_project_video_assets WHERE project_id = $1 AND principal_hash = $2',
      [projectId, principalHash],
    );
    return result.rowCount ?? 0;
  }

  return { put, list, get, getLatestForScene, remove, removeProject };
}
