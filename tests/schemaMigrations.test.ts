import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import {
  getZeroSchemaMigrationChecksum,
  runZeroSchemaMigrations,
  ZERO_SCHEMA_MIGRATIONS,
} from '../server/schemaMigrations.ts';

interface MigrationRow {
  version: number;
  name: string;
  checksum: string;
}

class FakeMigrationClient {
  rows: MigrationRow[] = [];
  statements: string[] = [];
  failMigration = false;
  failRollback = false;
  destroyed = false;
  private transactionRows: MigrationRow[] | null = null;

  async query(sql: string, values: unknown[] = []): Promise<{ rows: MigrationRow[]; rowCount: number }> {
    this.statements.push(sql);
    const normalized = sql.trim().toUpperCase();
    if (normalized === 'BEGIN') {
      this.transactionRows = this.rows.map((row) => ({ ...row }));
      return { rows: [], rowCount: 0 };
    }
    if (normalized === 'COMMIT') {
      this.transactionRows = null;
      return { rows: [], rowCount: 0 };
    }
    if (normalized === 'ROLLBACK' && this.failRollback) throw new Error('simulated rollback failure');
    if (normalized === 'ROLLBACK') {
      if (this.transactionRows) this.rows = this.transactionRows.map((row) => ({ ...row }));
      this.transactionRows = null;
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith('SELECT VERSION, NAME, CHECKSUM')) {
      return { rows: [...this.rows], rowCount: this.rows.length };
    }
    if (normalized.startsWith('INSERT INTO ZERO_SCHEMA_MIGRATIONS')) {
      this.rows.push({
        version: Number(values[0]),
        name: String(values[1]),
        checksum: String(values[2]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (this.failMigration && normalized.includes('ZERO_PROJECT_VIDEO_ASSETS_PRINCIPAL_HASH_V4_CHECK')) {
      throw new Error('simulated migration 4 failure');
    }
    return { rows: [], rowCount: 0 };
  }

  release(error?: Error | boolean): void {
    this.destroyed = Boolean(error);
  }
}

function poolFor(client: FakeMigrationClient): Pool {
  return { connect: async () => client } as unknown as Pool;
}

const migration = ZERO_SCHEMA_MIGRATIONS[0];
const principalMigration = ZERO_SCHEMA_MIGRATIONS[1];
const projectVideoMigration = ZERO_SCHEMA_MIGRATIONS[2];
const projectVideoReconciliationMigration = ZERO_SCHEMA_MIGRATIONS[3];
assert.ok(migration && principalMigration && projectVideoMigration && projectVideoReconciliationMigration, 'all four additive migrations are registered');
assert.match(getZeroSchemaMigrationChecksum(migration), /^[a-f0-9]{64}$/);
assert.match(migration.sql, /request_fingerprint CHAR\(64\)/);
assert.match(migration.sql, /principal_hash/);
assert.match(migration.sql, /lease_generation/);
assert.match(migration.sql, /zero_cost_resource_rate_events/);
assert.match(migration.sql, /created_at/);
assert.match(principalMigration.sql, /zero_cost_principal_resource_usage/);
assert.match(principalMigration.sql, /principal_hash CHAR\(64\)/);
assert.match(principalMigration.sql, /FROM zero_cost_operations/);
assert.match(principalMigration.sql, /status IN \('RESERVED', 'UNKNOWN'\)/);
assert.match(projectVideoMigration.sql, /zero_project_video_assets/);
assert.match(projectVideoMigration.sql, /principal_hash CHAR\(64\)/);
assert.match(projectVideoMigration.sql, /payload BYTEA NOT NULL/);
assert.match(projectVideoMigration.sql, /size_bytes BIGINT NOT NULL CHECK \(size_bytes BETWEEN 1024 AND 104857600\)/);
assert.equal(projectVideoReconciliationMigration.version, 4);
assert.equal(projectVideoReconciliationMigration.name, 'reconcile-project-video-assets-schema');
assert.ok(projectVideoReconciliationMigration.sql.includes('pg_attribute'));
assert.ok(projectVideoReconciliationMigration.sql.includes('pg_constraint'));
assert.ok(projectVideoReconciliationMigration.sql.includes('pg_get_constraintdef'));
assert.ok(projectVideoReconciliationMigration.sql.includes('pg_index'));
assert.ok(projectVideoReconciliationMigration.sql.includes("'^[a-f0-9]{64}' || chr(36)"));
assert.ok(projectVideoReconciliationMigration.sql.includes('NOT VALID'));
assert.ok(projectVideoReconciliationMigration.sql.includes('VALIDATE CONSTRAINT'));
assert.ok(projectVideoReconciliationMigration.sql.includes('indoption'));

const client = new FakeMigrationClient();
await runZeroSchemaMigrations(poolFor(client));
assert.equal(client.rows.length, 4, 'first run records all four migrations');
assert.ok(client.statements.some((sql) => sql.includes('pg_advisory_xact_lock')), 'migration uses the shared advisory lock');
assert.ok(client.statements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS zero_cost_resource_rate_events')), 'migration creates the rolling rate-event table');
assert.ok(client.statements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS zero_cost_principal_resource_usage')), 'migration creates principal daily usage');
assert.ok(client.statements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS zero_project_video_assets')), 'migration creates principal-bound durable video assets');
const firstMigrationStatementCount = client.statements.length;

await runZeroSchemaMigrations(poolFor(client));
assert.equal(client.rows.length, 4, 'second run does not duplicate any migration');
assert.ok(client.statements.length > firstMigrationStatementCount, 'second run still verifies migration state');
assert.equal(client.statements.filter((sql) => sql === migration.sql).length, 1, 'first applied migration SQL is not replayed');
assert.equal(client.statements.filter((sql) => sql === principalMigration.sql).length, 1, 'principal migration SQL is not replayed');
assert.equal(client.statements.filter((sql) => sql === projectVideoMigration.sql).length, 1, 'project video migration SQL is not replayed');
assert.equal(client.statements.filter((sql) => sql === projectVideoReconciliationMigration.sql).length, 1, 'project video reconciliation migration SQL is not replayed');

const mismatch = new FakeMigrationClient();
mismatch.rows.push({ version: migration.version, name: migration.name, checksum: '0'.repeat(64) });
await assert.rejects(
  () => runZeroSchemaMigrations(poolFor(mismatch)),
  /ZERO schema migrations failed/,
);
assert.ok(mismatch.statements.includes('ROLLBACK'), 'checksum mismatch rolls back');

const failedMigration4 = new FakeMigrationClient();
failedMigration4.rows = ZERO_SCHEMA_MIGRATIONS.slice(0, 3).map((item) => ({
  version: item.version,
  name: item.name,
  checksum: getZeroSchemaMigrationChecksum(item),
}));
failedMigration4.failMigration = true;
await assert.rejects(
  () => runZeroSchemaMigrations(poolFor(failedMigration4)),
  /ZERO schema migrations failed/,
);
assert.deepEqual(failedMigration4.rows.map((row) => row.version), [1, 2, 3],
  'a failed migration 4 must preserve previously committed migration versions');
assert.ok(failedMigration4.statements.includes('ROLLBACK'), 'migration 4 failure rolls back');

const failed = new FakeMigrationClient();
failed.failMigration = true;
failed.failRollback = true;
await assert.rejects(
  () => runZeroSchemaMigrations(poolFor(failed)),
  /ZERO schema migrations failed/,
);
assert.equal(failed.destroyed, true, 'connection is destroyed when rollback fails');

console.log('ZERO schema migration unit tests passed (checksum, idempotency, lock, rollback and connection destruction).');
