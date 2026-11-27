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
          CHECK (principal_hash ~ '^[a-f0-9]{64}$'),
        resource_type TEXT NOT NULL
          CHECK (resource_type IN ('text', 'image', 'audio', 'video')),
        reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
        consumed_units INTEGER NOT NULL DEFAULT 0 CHECK (consumed_units >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (day_utc, principal_hash, resource_type)
      );

      CREATE INDEX IF NOT EXISTS zero_cost_principal_resource_usage_lookup_idx
        ON zero_cost_principal_resource_usage (principal_hash, day_utc, resource_type);

      INSERT INTO zero_cost_principal_resource_usage
        (day_utc, principal_hash, resource_type, reserved_units, consumed_units)
      SELECT
        day_utc,
        principal_hash,
        resource_type,
        SUM(CASE WHEN status IN ('RESERVED', 'UNKNOWN') THEN reserved_units ELSE 0 END)::integer,
        SUM(CASE WHEN status = 'SUCCEEDED' THEN reserved_units ELSE 0 END)::integer
      FROM zero_cost_operations
      GROUP BY day_utc, principal_hash, resource_type
      ON CONFLICT (day_utc, principal_hash, resource_type) DO NOTHING;
    `,
  },
  {
    version: 3,
    name: 'principal-bound-durable-project-video-assets',
    sql: `
      CREATE TABLE IF NOT EXISTS zero_project_video_assets (
        asset_id UUID PRIMARY KEY,
        project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
        scene_id TEXT NOT NULL CHECK (length(scene_id) BETWEEN 1 AND 128),
        principal_hash CHAR(64) NOT NULL CHECK (principal_hash ~ '^[a-f0-9]{64}$'),
        job_id UUID,
        content_type TEXT NOT NULL CHECK (content_type IN ('video/mp4', 'video/webm')),
        size_bytes BIGINT NOT NULL CHECK (size_bytes BETWEEN 1024 AND 104857600),
        sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
        payload BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (principal_hash, job_id)
      );

      CREATE INDEX IF NOT EXISTS zero_project_video_assets_project_idx
        ON zero_project_video_assets (principal_hash, project_id, created_at DESC);
    `,
  },

  {
    version: 4,
    name: 'reconcile-project-video-assets-schema',
    sql: `
      DO $migration$
      DECLARE
        target_table regclass;
        expected record;
        actual_type text;
        actual_not_null boolean;
        created_at_default text;
        invalid_count bigint;
        asset_id_att smallint;
        principal_hash_att smallint;
        job_id_att smallint;
        existing_pk record;
      BEGIN
        target_table := to_regclass(format('%I.%I', current_schema(), 'zero_project_video_assets'));
        IF target_table IS NULL THEN
          RAISE EXCEPTION 'Migration 4: video asset table missing in schema %', current_schema();
        END IF;

        FOR expected IN
          SELECT * FROM (VALUES
            ('asset_id', 'uuid', true),
            ('project_id', 'text', true),
            ('scene_id', 'text', true),
            ('principal_hash', 'character(64)', true),
            ('job_id', 'uuid', false),
            ('content_type', 'text', true),
            ('size_bytes', 'bigint', true),
            ('sha256', 'character(64)', true),
            ('payload', 'bytea', true),
            ('created_at', 'timestamp with time zone', true)
          ) AS e(name, type_name, not_null)
        LOOP
          SELECT format_type(a.atttypid, a.atttypmod), a.attnotnull
          INTO actual_type, actual_not_null
          FROM pg_attribute a
          WHERE a.attrelid = target_table AND a.attname = expected.name
            AND a.attnum > 0 AND NOT a.attisdropped;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Migration 4: required column % is missing', expected.name;
          END IF;
          IF actual_type <> expected.type_name OR actual_not_null IS DISTINCT FROM expected.not_null THEN
            RAISE EXCEPTION 'Migration 4: incompatible type or nullability for column %', expected.name;
          END IF;
        END LOOP;

        SELECT pg_get_expr(d.adbin, d.adrelid)
        INTO created_at_default
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = target_table AND a.attname = 'created_at';
        IF created_at_default IS NULL THEN
          EXECUTE format('ALTER TABLE %s ALTER COLUMN created_at SET DEFAULT NOW()', target_table);
        ELSIF lower(created_at_default) <> 'now()' THEN
          RAISE EXCEPTION 'Migration 4: unexpected created_at default: %', created_at_default;
        END IF;

        IF EXISTS (
          SELECT 1
          FROM pg_attrdef d
          JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
          WHERE d.adrelid = target_table
            AND a.attname IN (
              'asset_id', 'project_id', 'scene_id', 'principal_hash',
              'job_id', 'content_type', 'size_bytes', 'sha256', 'payload'
            )
        ) THEN
          RAISE EXCEPTION 'Migration 4: unexpected default on a non-created_at column';
        END IF;

        SELECT max(a.attnum) FILTER (WHERE a.attname = 'asset_id'),
               max(a.attnum) FILTER (WHERE a.attname = 'principal_hash'),
               max(a.attnum) FILTER (WHERE a.attname = 'job_id')
        INTO asset_id_att, principal_hash_att, job_id_att
        FROM pg_attribute a
        WHERE a.attrelid = target_table AND a.attnum > 0 AND NOT a.attisdropped;

        SELECT count(*) INTO invalid_count
        FROM zero_project_video_assets
        WHERE asset_id IS NULL
          OR project_id IS NULL OR length(project_id) NOT BETWEEN 1 AND 128
          OR scene_id IS NULL OR length(scene_id) NOT BETWEEN 1 AND 128
          OR principal_hash IS NULL OR principal_hash !~ ('^[a-f0-9]{64}' || chr(36))
          OR content_type IS NULL OR content_type NOT IN ('video/mp4', 'video/webm')
          OR size_bytes IS NULL OR size_bytes NOT BETWEEN 1024 AND 104857600
          OR sha256 IS NULL OR sha256 !~ ('^[a-f0-9]{64}' || chr(36))
          OR payload IS NULL OR created_at IS NULL;
        IF invalid_count > 0 THEN
          RAISE EXCEPTION 'Migration 4: % existing rows violate video asset invariants', invalid_count;
        END IF;

        SELECT count(*) INTO invalid_count
        FROM (SELECT asset_id FROM zero_project_video_assets GROUP BY asset_id HAVING count(*) > 1) d;
        IF invalid_count > 0 THEN
          RAISE EXCEPTION 'Migration 4: duplicate asset_id values';
        END IF;

        SELECT count(*) INTO invalid_count
        FROM (
          SELECT principal_hash, job_id FROM zero_project_video_assets
          WHERE job_id IS NOT NULL GROUP BY principal_hash, job_id HAVING count(*) > 1
        ) d;
        IF invalid_count > 0 THEN
          RAISE EXCEPTION 'Migration 4: duplicate principal_hash/job_id values';
        END IF;

        SELECT c.contype, c.conname, c.conkey INTO existing_pk
        FROM pg_constraint c WHERE c.conrelid = target_table AND c.contype = 'p';
        IF FOUND AND existing_pk.conkey <> ARRAY[asset_id_att]::smallint[] THEN
          RAISE EXCEPTION 'Migration 4: existing primary key does not cover asset_id';
        ELSIF NOT FOUND THEN
          EXECUTE format('ALTER TABLE %s ADD CONSTRAINT zero_project_video_assets_asset_id_v4_pkey PRIMARY KEY (asset_id)', target_table);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint c
          WHERE c.conrelid = target_table AND c.contype = 'u'
            AND c.conkey = ARRAY[principal_hash_att, job_id_att]::smallint[]
        ) THEN
          EXECUTE format('ALTER TABLE %s ADD CONSTRAINT zero_project_video_assets_principal_job_v4_key UNIQUE (principal_hash, job_id)', target_table);
        END IF;

        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = target_table
            AND conname IN (
              'zero_project_video_assets_project_id_v4_check',
              'zero_project_video_assets_scene_id_v4_check',
              'zero_project_video_assets_principal_hash_v4_check',
              'zero_project_video_assets_content_type_v4_check',
              'zero_project_video_assets_size_bytes_v4_check',
              'zero_project_video_assets_sha256_v4_check'
            )
        ) THEN
          RAISE EXCEPTION 'Migration 4: reserved v4 constraint name already exists';
        END IF;
      END
      $migration$;

      ALTER TABLE zero_project_video_assets
        ADD CONSTRAINT zero_project_video_assets_project_id_v4_check
        CHECK (length(project_id) BETWEEN 1 AND 128) NOT VALID;
      ALTER TABLE zero_project_video_assets VALIDATE CONSTRAINT zero_project_video_assets_project_id_v4_check;

      ALTER TABLE zero_project_video_assets
        ADD CONSTRAINT zero_project_video_assets_scene_id_v4_check
        CHECK (length(scene_id) BETWEEN 1 AND 128) NOT VALID;
      ALTER TABLE zero_project_video_assets VALIDATE CONSTRAINT zero_project_video_assets_scene_id_v4_check;

      ALTER TABLE zero_project_video_assets
        ADD CONSTRAINT zero_project_video_assets_content_type_v4_check
        CHECK (content_type IN ('video/mp4', 'video/webm')) NOT VALID;
      ALTER TABLE zero_project_video_assets VALIDATE CONSTRAINT zero_project_video_assets_content_type_v4_check;

      ALTER TABLE zero_project_video_assets
        ADD CONSTRAINT zero_project_video_assets_size_bytes_v4_check
        CHECK (size_bytes BETWEEN 1024 AND 104857600) NOT VALID;
      ALTER TABLE zero_project_video_assets VALIDATE CONSTRAINT zero_project_video_assets_size_bytes_v4_check;

      ALTER TABLE zero_project_video_assets
        ADD CONSTRAINT zero_project_video_assets_sha256_v4_check
        CHECK (sha256 ~ ('^[a-f0-9]{64}' || chr(36))) NOT VALID;
      ALTER TABLE zero_project_video_assets VALIDATE CONSTRAINT zero_project_video_assets_sha256_v4_check;

      DO $migration$
      DECLARE
        target_table regclass;
        strict_check record;
        normalized_definition text;
        strict_check_found boolean := false;
      BEGIN
        target_table := to_regclass(format('%I.%I', current_schema(), 'zero_project_video_assets'));
        FOR strict_check IN
          SELECT c.conname, c.convalidated, pg_get_constraintdef(c.oid, false) AS definition
          FROM pg_constraint c
          WHERE c.conrelid = target_table AND c.contype = 'c'
        LOOP
          normalized_definition := lower(regexp_replace(strict_check.definition, '[[:space:]()]', '', 'g'));
          IF position('principal_hash' IN normalized_definition) > 0
             AND (
               position('^[a-f0-9]{64}$' IN normalized_definition) > 0
               OR (
                 position('^[a-f0-9]{64}' IN normalized_definition) > 0
                 AND position('chr(36)' IN normalized_definition) > 0
               )
             ) THEN
            strict_check_found := true;
            IF NOT strict_check.convalidated THEN
              EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', target_table, strict_check.conname);
            END IF;
          END IF;
        END LOOP;

        IF NOT strict_check_found THEN
          EXECUTE format(
            'ALTER TABLE %s ADD CONSTRAINT zero_project_video_assets_principal_hash_v4_check CHECK (principal_hash ~ (''^[a-f0-9]{64}'' || chr(36))) NOT VALID',
            target_table
          );
          EXECUTE format(
            'ALTER TABLE %s VALIDATE CONSTRAINT zero_project_video_assets_principal_hash_v4_check',
            target_table
          );
        END IF;
      END
      $migration$;

      DO $migration$
      DECLARE
        target_table regclass;
        index_oid oid;
        index_valid boolean;
        index_ready boolean;
        index_unique boolean;
        no_predicate boolean;
        access_method text;
        key_count smallint;
        total_count smallint;
        index_columns text[];
        index_options smallint[];
      BEGIN
        target_table := to_regclass(format('%I.%I', current_schema(), 'zero_project_video_assets'));
        SELECT i.indexrelid, i.indisvalid, i.indisready, i.indisunique,
               i.indpred IS NULL, am.amname, i.indnkeyatts, i.indnatts
        INTO index_oid, index_valid, index_ready, index_unique,
             no_predicate, access_method, key_count, total_count
        FROM pg_index i
        JOIN pg_class idx ON idx.oid = i.indexrelid
        JOIN pg_am am ON am.oid = idx.relam
        WHERE i.indrelid = target_table AND idx.relname = 'zero_project_video_assets_project_idx';

        IF FOUND THEN
          SELECT array_agg(a.attname ORDER BY k.ordinality),
                 array_agg(o.option_value ORDER BY o.ordinality)
          INTO index_columns, index_options
          FROM pg_index i
          CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
          JOIN LATERAL unnest(i.indoption) WITH ORDINALITY AS o(option_value, ordinality)
            ON o.ordinality = k.ordinality
          WHERE i.indexrelid = index_oid AND k.ordinality <= i.indnkeyatts;

          IF NOT index_valid OR NOT index_ready OR index_unique OR NOT no_predicate
             OR access_method <> 'btree' OR key_count <> 3 OR total_count <> 3
             OR index_columns <> ARRAY['principal_hash', 'project_id', 'created_at']::text[]
             OR index_options <> ARRAY[0, 0, 3]::smallint[] THEN
            RAISE EXCEPTION 'Migration 4: existing project video index has incompatible definition';
          END IF;
        ELSE
          EXECUTE format(
            'CREATE INDEX zero_project_video_assets_project_idx ON %s (principal_hash, project_id, created_at DESC)',
            target_table
          );
        END IF;
      END
      $migration$;
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
