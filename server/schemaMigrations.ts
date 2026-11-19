import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { ZERO_COST_ADVISORY_LOCK } from './zeroCostGuard.ts';

export interface ZeroSchemaMigration {
  version: number;
  name: string;
  sql: string;
}

interface AppliedMigration extends QueryResultRow {
  version: number;
  name: string;
  checksum: string;
}

export const ZERO_SCHEMA_MIGRATIONS: readonly ZeroSchemaMigration[] = [
  {
    version: 1,
    name: 'resource-operation-metadata-and-rolling-rate-window',
    sql: `
      ALTER TABLE zero_cost_operations
        ADD COLUMN IF NOT EXISTS request_fingerprint CHAR(64),
        ADD COLUMN IF NOT EXISTS worker_kind TEXT,
        ADD COLUMN IF NOT EXISTS worker_job_id UUID,
        ADD COLUMN IF NOT EXISTS dispatch_state TEXT NOT NULL DEFAULT 'NOT_SENT',
        ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS last_error_code TEXT;

      UPDATE zero_cost_operations
      SET request_fingerprint = payload_hash
      WHERE request_fingerprint IS NULL;

      ALTER TABLE zero_cost_operations
        ALTER COLUMN request_fingerprint SET NOT NULL;

      ALTER TABLE zero_cost_active_leases
        ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS lease_generation INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE zero_cost_operations
        ADD CONSTRAINT zero_cost_operations_fingerprint_sha256_check
        CHECK (request_fingerprint ~ '^[a-f0-9]{64}$');

      ALTER TABLE zero_cost_operations
        ADD CONSTRAINT zero_cost_operations_dispatch_state_check
        CHECK (dispatch_state IN ('NOT_SENT', 'SENT', 'ACCEPTED', 'CONFIRMED'));

      ALTER TABLE zero_cost_operations
        ADD CONSTRAINT zero_cost_operations_worker_kind_check
        CHECK (worker_kind IS NULL OR worker_kind IN ('wan', 'piper'));

      ALTER TABLE zero_cost_operations
        ADD CONSTRAINT zero_cost_operations_principal_hash_sha256_check
        CHECK (principal_hash ~ '^[a-f0-9]{64}$');

      ALTER TABLE zero_cost_active_leases
        ADD CONSTRAINT zero_cost_active_leases_generation_check
        CHECK (lease_generation > 0);

      CREATE TABLE IF NOT EXISTS zero_cost_resource_rate_events (
        operation_id UUID PRIMARY KEY
          REFERENCES zero_cost_operations(operation_id) ON DELETE CASCADE,
        principal_hash CHAR(64) NOT NULL
          CHECK (principal_hash ~ '^[a-f0-9]{64}$'),
        resource_type TEXT NOT NULL
          CHECK (resource_type IN ('text', 'image', 'audio', 'video')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS zero_cost_resource_rate_principal_idx
        ON zero_cost_resource_rate_events (principal_hash, resource_type, created_at);

      CREATE INDEX IF NOT EXISTS zero_cost_resource_rate_global_idx
        ON zero_cost_resource_rate_events (resource_type, created_at);
    `,
  },
  {
    version: 2,
    name: 'principal-scoped-resource-daily-usage',
    sql: `
      CREATE TABLE IF NOT EXISTS zero_cost_principal_resource_usage (
        day_utc DATE NOT NULL,
        principal_hash CHAR(64) NOT NULL
          CHECK (principal_hash ~ '^[a-f0-9]{64}(migration: ZeroSchemaMigration): string {
  return createHash('sha256').update(migration.sql).digest('hex');
}

async function applyZeroSchemaMigrations(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS zero_schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL,
      checksum CHAR(64) NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const applied = await client.query<AppliedMigration>(
    'SELECT version, name, checksum FROM zero_schema_migrations ORDER BY version'
  );
  const appliedByVersion = new Map(applied.rows.map((row) => [Number(row.version), row]));

  for (const migration of ZERO_SCHEMA_MIGRATIONS) {
    const checksum = getZeroSchemaMigrationChecksum(migration);
    const existing = appliedByVersion.get(migration.version);
    if (existing) {
      if (existing.name !== migration.name || existing.checksum.trim() !== checksum) {
        throw new Error(`ZERO schema migration ${migration.version} checksum/name mismatch.`);
      }
      continue;
    }

    await client.query(migration.sql);
    await client.query(
      'INSERT INTO zero_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
      [migration.version, migration.name, checksum],
    );
  }
}

/**
 * Run versioned ZERO schema migrations on a caller-owned transaction.
 * The caller must have started a transaction and acquired ZERO_COST_ADVISORY_LOCK.
 */
export async function applyZeroSchemaMigrationsWithClient(client: PoolClient): Promise<void> {
  await applyZeroSchemaMigrations(client);
}

/** Run migrations atomically using the shared ZERO cost/resource advisory lock. */
export async function runZeroSchemaMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let transactionOpen = false;
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', ZERO_COST_ADVISORY_LOCK);
    await applyZeroSchemaMigrations(client);
    await client.query('COMMIT');
    transactionOpen = false;
  } catch {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        destroyClient = true;
      }
    }
    throw new Error('ZERO schema migrations failed; resource operations remain blocked.');
  } finally {
    client.release(destroyClient);
  }
}
),
        resource_type TEXT NOT NULL
          CHECK (resource_type IN ('text', 'image', 'audio', 'video')),
        reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
        consumed_units INTEGER NOT NULL DEFAULT 0 CHECK (consumed_units >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (day_utc, principal_hash, resource_type)
      );

      CREATE INDEX IF NOT EXISTS zero_cost_principal_resource_usage_lookup_idx
        ON zero_cost_principal_resource_usage (principal_hash, day_utc, resource_type);
    `,
  },
];

export function getZeroSchemaMigrationChecksum(migration: ZeroSchemaMigration): string {
  return createHash('sha256').update(migration.sql).digest('hex');
}

async function applyZeroSchemaMigrations(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS zero_schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL,
      checksum CHAR(64) NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const applied = await client.query<AppliedMigration>(
    'SELECT version, name, checksum FROM zero_schema_migrations ORDER BY version'
  );
  const appliedByVersion = new Map(applied.rows.map((row) => [Number(row.version), row]));

  for (const migration of ZERO_SCHEMA_MIGRATIONS) {
    const checksum = getZeroSchemaMigrationChecksum(migration);
    const existing = appliedByVersion.get(migration.version);
    if (existing) {
      if (existing.name !== migration.name || existing.checksum.trim() !== checksum) {
        throw new Error(`ZERO schema migration ${migration.version} checksum/name mismatch.`);
      }
      continue;
    }

    await client.query(migration.sql);
    await client.query(
      'INSERT INTO zero_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
      [migration.version, migration.name, checksum],
    );
  }
}

/**
 * Run versioned ZERO schema migrations on a caller-owned transaction.
 * The caller must have started a transaction and acquired ZERO_COST_ADVISORY_LOCK.
 */
export async function applyZeroSchemaMigrationsWithClient(client: PoolClient): Promise<void> {
  await applyZeroSchemaMigrations(client);
}

/** Run migrations atomically using the shared ZERO cost/resource advisory lock. */
export async function runZeroSchemaMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let transactionOpen = false;
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', ZERO_COST_ADVISORY_LOCK);
    await applyZeroSchemaMigrations(client);
    await client.query('COMMIT');
    transactionOpen = false;
  } catch {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        destroyClient = true;
      }
    }
    throw new Error('ZERO schema migrations failed; resource operations remain blocked.');
  } finally {
    client.release(destroyClient);
  }
}
