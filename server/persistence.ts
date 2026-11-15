import { Pool } from 'pg';

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

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

export async function ensurePostgresSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const client = getPool();
      await client.query(`
        CREATE TABLE IF NOT EXISTS zero_app_state (
          id TEXT PRIMARY KEY CHECK (id = 'primary'),
          payload JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
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

export async function readPersistentState<T>(): Promise<T | null> {
  await ensurePostgresSchema();
  const result = await getPool().query<{ payload: T }>(
    "SELECT payload FROM zero_app_state WHERE id = 'primary'"
  );
  return result.rows[0]?.payload ?? null;
}

export async function writePersistentState<T>(payload: T): Promise<void> {
  await ensurePostgresSchema();
  await getPool().query(
    `INSERT INTO zero_app_state (id, payload, updated_at)
     VALUES ('primary', $1::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
    [JSON.stringify(payload)]
  );
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
