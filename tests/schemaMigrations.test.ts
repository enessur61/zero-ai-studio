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

  async query(sql: string, values: unknown[] = []): Promise<{ rows: MigrationRow[]; rowCount: number }> {
    this.statements.push(sql);
    const normalized = sql.trim().toUpperCase();
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
    if (normalized === 'ROLLBACK' && this.failRollback) {
      throw new Error('simulated rollback failure');
    }
    if (this.failMigration && normalized.startsWith('ALTER TABLE ZERO_COST_OPERATIONS')) {
      throw new Error('simulated migration failure');
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
assert.ok(migration && principalMigration && projectVideoMigration, 'all additive migrations are registered');
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

const client = new FakeMigrationClient();
await runZeroSchemaMigrations(poolFor(client));
assert.equal(client.rows.length, 3, 'first run records all three migrations');
assert.ok(client.statements.some((sql) => sql.includes('pg_advisory_xact_lock')), 'migration uses the shared advisory lock');
assert.ok(client.statements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS zero_cost_resource_rate_events')), 'migration creates the rolling rate-event table');
assert.ok(client.statements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS zero_cost_principal_resource_usage')), 'migration creates principal daily usage');
assert.ok(client.statements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS zero_project_video_assets')), 'migration creates principal-bound durable video assets');
const firstMigrationStatementCount = client.statements.length;

await runZeroSchemaMigrations(poolFor(client));
assert.equal(client.rows.length, 3, 'second run does not duplicate any migration');
assert.ok(client.statements.length > firstMigrationStatementCount, 'second run still verifies migration state');
assert.equal(client.statements.filter((sql) => sql === migration.sql).length, 1, 'first applied migration SQL is not replayed');
assert.equal(client.statements.filter((sql) => sql === principalMigration.sql).length, 1, 'principal migration SQL is not replayed');
assert.equal(client.statements.filter((sql) => sql === projectVideoMigration.sql).length, 1, 'project video migration SQL is not replayed');

const mismatch = new FakeMigrationClient();
mismatch.rows.push({ version: migration.version, name: migration.name, checksum: '0'.repeat(64) });
await assert.rejects(
  () => runZeroSchemaMigrations(poolFor(mismatch)),
  /ZERO schema migrations failed/,
);
assert.ok(mismatch.statements.includes('ROLLBACK'), 'checksum mismatch rolls back');

const failed = new FakeMigrationClient();
failed.failMigration = true;
failed.failRollback = true;
await assert.rejects(
  () => runZeroSchemaMigrations(poolFor(failed)),
  /ZERO schema migrations failed/,
);
assert.equal(failed.destroyed, true, 'connection is destroyed when rollback fails');

console.log('ZERO schema migration unit tests passed (checksum, idempotency, lock, rollback and connection destruction).');
