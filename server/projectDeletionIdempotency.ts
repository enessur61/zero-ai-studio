import { createHash } from 'node:crypto';
import { getPostgresPool } from './persistence.ts';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;
const TOMBSTONE_TTL_HOURS = 24;

function hashIdempotencyKey(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function ensureProjectDeletionIdempotencySchema(): Promise<void> {
  const pool = getPostgresPool();
  const client = await pool.connect();
  let transactionOpen = false;
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    // Serialize first-use DDL across production instances.
    await client.query('SELECT pg_advisory_xact_lock(1514480207, 74)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS zero_project_deletion_idempotency (
        project_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        idempotency_key_hash CHAR(64) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '${TOMBSTONE_TTL_HOURS} hours'),
        PRIMARY KEY (project_id, principal_id)
      )
    `);
    await client.query('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        destroyClient = true;
      }
    }
    throw error;
  } finally {
    client.release(destroyClient);
  }
}

export async function recordProjectDeletionIdempotency(
  projectId: string,
  principalId: string,
  idempotencyKey: string,
): Promise<void> {
  if (!projectId || projectId.length > 128 || !principalId || principalId.length > 128) {
    throw new Error('Invalid project deletion identity.');
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new Error('A valid Idempotency-Key is required for project deletion.');
  }

  await ensureProjectDeletionIdempotencySchema();
  const pool = getPostgresPool();
  await pool.query(
    `INSERT INTO zero_project_deletion_idempotency
      (project_id, principal_id, idempotency_key_hash, created_at, expires_at)
     VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '${TOMBSTONE_TTL_HOURS} hours')
     ON CONFLICT (project_id, principal_id) DO UPDATE
       SET idempotency_key_hash = EXCLUDED.idempotency_key_hash,
           created_at = NOW(),
           expires_at = EXCLUDED.expires_at`,
    [projectId, principalId, hashIdempotencyKey(idempotencyKey)],
  );
}

export async function isProjectDeletionIdempotentRetry(
  projectId: string,
  principalId: string,
  idempotencyKey: string,
): Promise<boolean> {
  if (!projectId || projectId.length > 128 || !principalId || principalId.length > 128) return false;
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) return false;

  await ensureProjectDeletionIdempotencySchema();
  const pool = getPostgresPool();
  const result = await pool.query(
    `SELECT 1
       FROM zero_project_deletion_idempotency
      WHERE project_id = $1
        AND principal_id = $2
        AND idempotency_key_hash = $3
        AND expires_at > NOW()
      LIMIT 1`,
    [projectId, principalId, hashIdempotencyKey(idempotencyKey)],
  );
  return result.rowCount === 1;
}
