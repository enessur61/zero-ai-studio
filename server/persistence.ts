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

  async function write<T>(payload: T, expectedRevision: number): Promise<number> {
    await ensureSchema();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('Ungültige erwartete PostgreSQL-Revision.');
    }

    // Revision 0 means "insert only if the primary row does not exist".
    // Existing rows are updated only when their revision matches the caller.
    const result = await database.query<{ revision: string }>(
      `INSERT INTO zero_app_state (id, payload, revision, updated_at)
       SELECT 'primary', $1::jsonb, 1, NOW()
       WHERE $2::bigint = 0
       ON CONFLICT (id) DO UPDATE
         SET payload = EXCLUDED.payload,
             revision = zero_app_state.revision + 1,
             updated_at = NOW()
       WHERE zero_app_state.revision = $2::bigint
       RETURNING revision`,
      [JSON.stringify(payload), expectedRevision]
    );
    if (result.rows[0]) return Number(result.rows[0].revision);

    const current = await database.query<{ revision: string }>(
      "SELECT revision FROM zero_app_state WHERE id = 'primary'"
    );
    throw new PersistentStateConflictError(
      expectedRevision,
      current.rows[0] ? Number(current.rows[0].revision) : null
    );
  }

  return { ensureSchema, read, write };
}

function getPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL fehlt. In Produktion ist eine dauerhafte PostgreSQL-Datenbank erforderlich.');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 3,
      idleTimeoutMillis: 30_000,
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
  if (!stateStore) stateStore = createPostgresStateStore(getPool());
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

export async function writeBackupFile(
  id: string,
  filename: string,
  contentType: string,
  payload: Buffer
): Promise<void> {
  await ensurePostgresSchema();
  await getPool().query(
    `INSERT INTO zero_backup_files (id, filename, content_type, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET filename = EXCLUDED.filename,
       content_type = EXCLUDED.content_type, payload = EXCLUDED.payload`,
    [id, filename, contentType, payload]
  );
}

export async function readBackupFile(id: string): Promise<Buffer> {
  await ensurePostgresSchema();
  const result = await getPool().query<{ payload: Buffer }>(
    'SELECT payload FROM zero_backup_files WHERE id = $1',
    [id]
  );
  if (!result.rows[0]) throw new Error('Backup-Datei nicht gefunden.');
  return result.rows[0].payload;
}

export async function deleteBackupFile(id: string): Promise<void> {
  await ensurePostgresSchema();
  await getPool().query('DELETE FROM zero_backup_files WHERE id = $1', [id]);
}

export async function checkPostgresConnection(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  await ensurePostgresSchema();
  await getPool().query('SELECT 1');
  return true;
}
