import { runtimeConfig } from './runtimeConfig.ts';
import { Pool } from 'pg';

let pool: Pool | null = null;
let stateStore: ReturnType<typeof createPostgresStateStore> | null = null;

export interface VersionedPersistentState<T> {
  payload: T;
  revision: number;
}

export class PersistentStateConflictError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number | null;

  constructor(expectedRevision: number, actualRevision: number | null) {
    super(
      actualRevision === null
        ? 'Der gespeicherte ZERO-Datenstand wurde zwischenzeitlich entfernt. Bitte erneut laden.'
        : `Der ZERO-Datenstand wurde parallel geändert (erwartet Revision ${expectedRevision}, aktuell ${actualRevision}). Bitte erneut laden und den Vorgang wiederholen.`
    );
    this.name = 'PersistentStateConflictError';
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

/**
 * A state store bound to one PostgreSQL pool. Exported so integration tests can
 * exercise the exact production SQL through two independent pools/connections.
 */
export function createPostgresStateStore(database: Pool) {
  let schemaReady: Promise<void> | null = null;

  async function ensureSchema(): Promise<void> {
    if (!schemaReady) {
      schemaReady = (async () => {
        await database.query(`
          CREATE TABLE IF NOT EXISTS zero_app_state (
            id TEXT PRIMARY KEY CHECK (id = 'primary'),
            payload JSONB NOT NULL,
            revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        // Backward-compatible migration for databases created before revisions.
        await database.query(`
          ALTER TABLE zero_app_state
          ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1
        `);
        await database.query(`
          CREATE TABLE IF NOT EXISTS zero_backup_files (
            id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            content_type TEXT NOT NULL,
            payload BYTEA NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await database.query(`
          CREATE TABLE IF NOT EXISTS zero_backup_auto_state (
            id TEXT PRIMARY KEY CHECK (id = 'zip-auto'),
            last_success_at TIMESTAMPTZ
          )
        `);
      })().catch((error) => {
        schemaReady = null;
        throw error;
      });
    }
    await schemaReady;
  }

  async function read<T>(): Promise<VersionedPersistentState<T> | null> {
    await ensureSchema();
    const result = await database.query<{ payload: T; revision: string }>(
      "SELECT payload, revision FROM zero_app_state WHERE id = 'primary'"
    );
    const row = result.rows[0];
    return row ? { payload: row.payload, revision: Number(row.revision) } : null;
  }

  async function write<T>(
    payload: T,
    expectedRevision: number,
    backupFile?: { id: string; filename: string; contentType: string; payload: Buffer },
    recordAutoBackupSuccess = false
  ): Promise<number> {
    await ensureSchema();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('Ungültige erwartete PostgreSQL-Revision.');
    }

    const client = await database.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      // Every primary-state mutation shares this database-wide transaction lock.
      await client.query('SELECT pg_advisory_xact_lock(1514480207, 1)');

      const current = await client.query<{ revision: string }>(
        "SELECT revision FROM zero_app_state WHERE id = 'primary' FOR UPDATE"
      );
      const currentRevision = current.rows[0] ? Number(current.rows[0].revision) : null;
      let nextRevision: number;

      if (currentRevision === null) {
        if (expectedRevision !== 0) throw new PersistentStateConflictError(expectedRevision, null);
        const inserted = await client.query<{ revision: string }>(
          `INSERT INTO zero_app_state (id, payload, revision, updated_at)
           VALUES ('primary', $1::jsonb, 1, NOW())
           ON CONFLICT (id) DO NOTHING
           RETURNING revision`,
          [JSON.stringify(payload)]
        );
        if (!inserted.rows[0]) {
          const winner = await client.query<{ revision: string }>(
            "SELECT revision FROM zero_app_state WHERE id = 'primary'"
          );
          throw new PersistentStateConflictError(
            expectedRevision,
            winner.rows[0] ? Number(winner.rows[0].revision) : null
          );
        }
        nextRevision = Number(inserted.rows[0].revision);
      } else {
        if (currentRevision !== expectedRevision) {
          throw new PersistentStateConflictError(expectedRevision, currentRevision);
        }
        const updated = await client.query<{ revision: string }>(
          `UPDATE zero_app_state
           SET payload = $1::jsonb, revision = revision + 1, updated_at = NOW()
           WHERE id = 'primary' AND revision = $2::bigint
           RETURNING revision`,
          [JSON.stringify(payload), expectedRevision]
        );
        if (!updated.rows[0]) {
          const latest = await client.query<{ revision: string }>(
            "SELECT revision FROM zero_app_state WHERE id = 'primary'"
          );
          throw new PersistentStateConflictError(
            expectedRevision,
            latest.rows[0] ? Number(latest.rows[0].revision) : null
          );
        }
        nextRevision = Number(updated.rows[0].revision);
      }

      // The archive bytes and the JSONB metadata/revision commit together.
      if (backupFile) {
        await client.query(
          `INSERT INTO zero_backup_files (id, filename, content_type, payload)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO UPDATE SET filename = EXCLUDED.filename,
             content_type = EXCLUDED.content_type, payload = EXCLUDED.payload`,
          [backupFile.id, backupFile.filename, backupFile.contentType, backupFile.payload]
        );
      }

      // The successful-auto-backup marker commits with the exact state and ZIP blob.
      if (recordAutoBackupSuccess) {
        if (!backupFile) throw new Error('Auto-Backup-Erfolg benötigt eine atomare ZIP-Datei.');
        await client.query(
          `INSERT INTO zero_backup_auto_state (id, last_success_at)
           VALUES ('zip-auto', NOW())
           ON CONFLICT (id) DO UPDATE SET last_success_at = EXCLUDED.last_success_at`
        );
      }

      await client.query('COMMIT');
      transactionStarted = false;
      return nextRevision;
    } catch (error) {
      if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function acquireAutoBackupLease(minimumIntervalMs = 15 * 60 * 1000): Promise<{
    complete: () => Promise<void>;
    release: () => Promise<void>;
  } | null> {
    if (!Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs < 0) {
      throw new Error('Ungültiges Auto-Backup-Intervall.');
    }
    await ensureSchema();
    const client = await database.connect();
    let lockAcquired = false;
    try {
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(1514480207, 2) AS locked'
      );
      lockAcquired = Boolean(lock.rows[0]?.locked);
      if (!lockAcquired) {
        client.release();
        return null;
      }
      const state = await client.query<{ last_success_at: Date | null }>(
        "SELECT last_success_at FROM zero_backup_auto_state WHERE id = 'zip-auto'"
      );
      const lastSuccess = state.rows[0]?.last_success_at;
      if (lastSuccess && Date.now() - new Date(lastSuccess).getTime() < minimumIntervalMs) {
        const unlocked = await client.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock(1514480207, 2) AS unlocked'
        );
        if (unlocked.rows[0]?.unlocked !== true) {
          throw new Error('PostgreSQL Auto-Backup-Lease konnte nicht freigegeben werden.');
        }
        lockAcquired = false;
        client.release();
        return null;
      }
      let finishPromise: Promise<void> | null = null;
      const finish = (): Promise<void> => {
        if (!finishPromise) {
          finishPromise = (async () => {
            let destroyClient = false;
            try {
              if (lockAcquired) {
                const unlocked = await client.query<{ unlocked: boolean }>(
                  'SELECT pg_advisory_unlock(1514480207, 2) AS unlocked'
                );
                if (unlocked.rows[0]?.unlocked !== true) {
                  throw new Error('PostgreSQL Auto-Backup-Lease war beim Freigeben nicht mehr im Besitz der Session.');
                }
                lockAcquired = false;
              }
            } catch (error) {
              // A session-level lock survives a pool checkout boundary. Destroy the
              // physical connection if explicit unlock cannot be confirmed.
              destroyClient = true;
              throw error;
            } finally {
              client.release(destroyClient);
            }
          })();
        }
        return finishPromise;
      };
      return {
        // The success timestamp is written by the backup publication transaction,
        // never by this lease-release operation.
        complete: () => finish(),
        release: () => finish(),
      };
    } catch (error) {
      let destroyClient = !lockAcquired;
      if (lockAcquired) {
        try {
          const unlocked = await client.query<{ unlocked: boolean }>(
            'SELECT pg_advisory_unlock(1514480207, 2) AS unlocked'
          );
          if (unlocked.rows[0]?.unlocked === true) lockAcquired = false;
          else destroyClient = true;
        } catch {
          destroyClient = true;
        }
      }
      client.release(destroyClient);
      throw error;
    }
  }

  async function inspectBackupConsistency(): Promise<{
    orphanedBlobIds: string[];
    missingBlobIds: string[];
  }> {
    await ensureSchema();
    // Read metadata and blob rows from one repeatable-read snapshot. Separate
    // pool.query calls can straddle an atomic backup commit and report a false
    // orphan/missing pair even though both rows committed together.
    const client = await database.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      transactionStarted = true;
      const state = await client.query<{
        backups: Array<{ id?: string }>;
        zip_backups: Array<{ id?: string }>;
      }>(
        `SELECT COALESCE(payload->'backups', '[]'::jsonb) AS backups,
                COALESCE(payload->'backupConfig'->'zipBackups', '[]'::jsonb) AS zip_backups
         FROM zero_app_state WHERE id = 'primary'`
      );
      const blobs = await client.query<{ id: string }>('SELECT id FROM zero_backup_files');
      const metadataIds = new Set<string>();
      for (const item of [...(state.rows[0]?.backups ?? []), ...(state.rows[0]?.zip_backups ?? [])]) {
        if (typeof item.id === 'string' && item.id.length > 0) metadataIds.add(item.id);
      }
      const blobIds = new Set(blobs.rows.map((row) => row.id));
      await client.query('COMMIT');
      transactionStarted = false;
      return {
        orphanedBlobIds: [...blobIds].filter((id) => !metadataIds.has(id)).sort(),
        missingBlobIds: [...metadataIds].filter((id) => !blobIds.has(id)).sort(),
      };
    } catch (error) {
      if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    ensureSchema,
    read,
    write,
    acquireAutoBackupLease,
    inspectBackupConsistency,
    writeWithBackup: <T>(
      payload: T,
      expectedRevision: number,
      backupFile: { id: string; filename: string; contentType: string; payload: Buffer },
      recordAutoBackupSuccess = false
    ) => write(payload, expectedRevision, backupFile, recordAutoBackupSuccess),
  };
}

export function getPostgresPool(): Pool {
  if (!runtimeConfig.DATABASE_URL) {
    throw new Error('DATABASE_URL fehlt. In Produktion ist eine dauerhafte PostgreSQL-Datenbank erforderlich.');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: runtimeConfig.DATABASE_URL,
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      statement_timeout: 15_000,
      application_name: 'zero-ai-studio',
    });
    pool.on('error', (error) => {
      console.error('[ZERO PostgreSQL] Unerwarteter Pool-Fehler:', error.message);
    });
  }
  return pool;
}

function getStateStore(): ReturnType<typeof createPostgresStateStore> {
  if (!stateStore) stateStore = createPostgresStateStore(getPostgresPool());
  return stateStore;
}

export async function ensurePostgresSchema(): Promise<void> {
  await getStateStore().ensureSchema();
}

export async function readPersistentState<T>(): Promise<VersionedPersistentState<T> | null> {
  return getStateStore().read<T>();
}

export async function writePersistentState<T>(payload: T, expectedRevision: number): Promise<number> {
  return getStateStore().write(payload, expectedRevision);
}

export async function writePersistentStateWithBackupFile<T>(
  payload: T,
  expectedRevision: number,
  backupFile: { id: string; filename: string; contentType: string; payload: Buffer },
  recordAutoBackupSuccess = false
): Promise<number> {
  return getStateStore().write(payload, expectedRevision, backupFile, recordAutoBackupSuccess);
}


export type PersistentAutoBackupLease = {
  complete: () => Promise<void>;
  release: () => Promise<void>;
};

/**
 * Shared production wrapper for automatic ZIP backup creation. A failed archive
 * build or publication always attempts to release the session-level lease.
 */
export async function withPersistentAutoBackupLease<T>(
  acquireLease: () => Promise<PersistentAutoBackupLease | null>,
  createBackup: () => Promise<T>
): Promise<T | null> {
  const lease = await acquireLease();
  if (!lease) return null;
  try {
    const backup = await createBackup();
    await lease.complete();
    return backup;
  } catch (error) {
    try {
      await lease.release();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'Auto-Backup fehlgeschlagen und die Advisory-Lock-Freigabe musste die Verbindung verwerfen.'
      );
    }
    throw error;
  }
}

export async function acquirePersistentAutoBackupLease(minimumIntervalMs?: number): Promise<{
  complete: () => Promise<void>;
  release: () => Promise<void>;
} | null> {
  return getStateStore().acquireAutoBackupLease(minimumIntervalMs);
}

/**
 * Acquire one of the same cross-process ZIP slots used by HTTP ZIP routes.
 * Background automatic backups must share the global memory/CPU budget too.
 */
export async function acquirePersistentZipOperationLease(database: Pool = getPostgresPool()): Promise<{
  release: () => Promise<void>;
} | null> {
  const client = await database.connect();
  let lockId: number | null = null;
  try {
    for (let slot = 0; slot < 2; slot++) {
      const candidate = 3 + slot;
      const result = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(1514480207, $1) AS locked',
        [candidate]
      );
      if (result.rows[0]?.locked === true) {
        lockId = candidate;
        break;
      }
    }
    if (lockId === null) {
      client.release();
      return null;
    }

    let released = false;
    return {
      release: async () => {
        if (released) return;
        let destroy = false;
        try {
          const result = await client.query<{ unlocked: boolean }>(
            'SELECT pg_advisory_unlock(1514480207, $1) AS unlocked',
            [lockId]
          );
          if (result.rows[0]?.unlocked !== true) {
            destroy = true;
            throw new Error('PostgreSQL ZIP operation lease could not be confirmed as released.');
          }
          released = true;
        } catch (error) {
          destroy = true;
          throw error;
        } finally {
          if (!released) released = true;
          client.release(destroy);
        }
      },
    };
  } catch (error) {
    // A failed advisory-lock query can have an ambiguous server-side outcome.
    // Never return that physical connection to the pool with a possible lock.
    client.release(true);
    throw error;
  }
}

export async function inspectPersistentBackupConsistency(): Promise<{
  orphanedBlobIds: string[];
  missingBlobIds: string[];
}> {
  return getStateStore().inspectBackupConsistency();
}

export async function writeBackupFile(
  id: string,
  filename: string,
  contentType: string,
  payload: Buffer
): Promise<void> {
  await ensurePostgresSchema();
  await getPostgresPool().query(
    `INSERT INTO zero_backup_files (id, filename, content_type, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET filename = EXCLUDED.filename,
       content_type = EXCLUDED.content_type, payload = EXCLUDED.payload`,
    [id, filename, contentType, payload]
  );
}

export async function readBackupFile(id: string, maxBytes?: number, database?: Pool): Promise<Buffer> {
  if (database) await createPostgresStateStore(database).ensureSchema();
  else await ensurePostgresSchema();
  const result = await (database ?? getPostgresPool()).query<{ payload: Buffer | null; size_bytes: string }>(
    `SELECT
       CASE WHEN $2::bigint IS NULL OR octet_length(payload) <= $2::bigint
         THEN payload ELSE NULL END AS payload,
       octet_length(payload)::text AS size_bytes
     FROM zero_backup_files WHERE id = $1`,
    [id, maxBytes ?? null]
  );
  if (!result.rows[0]) throw new Error('Backup-Datei nicht gefunden.');
  if (result.rows[0].payload === null) {
    throw new Error(`Backup-Datei überschreitet das Größenlimit von ${maxBytes} Bytes (gespeichert: ${result.rows[0].size_bytes} Bytes).`);
  }
  return result.rows[0].payload;
}

export async function deleteBackupFile(id: string): Promise<void> {
  await ensurePostgresSchema();
  await getPostgresPool().query('DELETE FROM zero_backup_files WHERE id = $1', [id]);
}

export async function checkPostgresConnection(): Promise<boolean> {
  if (!runtimeConfig.DATABASE_URL) return false;
  await ensurePostgresSchema();
  await getPostgresPool().query('SELECT 1');
  return true;
}
