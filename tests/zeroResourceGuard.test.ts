import assert from 'node:assert/strict';
import {
  ensureZeroResourceSchemaWithPool,
  validateZeroResourceSchemaSnapshot,
  ZeroResourceSchemaError,
  ZERO_RESOURCE_ADVISORY_LOCK,
  ZERO_RESOURCE_POLICIES,
  reserveZeroResourceWithPool,
} from '../server/zeroResourceGuard.ts';

const columns = ([
  ['zero_resource_daily_usage', 'principal_id', 'text', 'NO'],
  ['zero_resource_daily_usage', 'resource_id', 'text', 'NO'],
  ['zero_resource_daily_usage', 'day_utc', 'date', 'NO'],
  ['zero_resource_daily_usage', 'jobs_started', 'bigint', 'NO'],
  ['zero_resource_daily_usage', 'units_used', 'bigint', 'NO'],
  ['zero_resource_daily_usage', 'updated_at', 'timestamp with time zone', 'NO'],
  ['zero_resource_reservations', 'reservation_id', 'text', 'NO'],
  ['zero_resource_reservations', 'idempotency_key', 'text', 'NO'],
  ['zero_resource_reservations', 'request_fingerprint', 'text', 'NO'],
  ['zero_resource_reservations', 'principal_id', 'text', 'NO'],
  ['zero_resource_reservations', 'resource_id', 'text', 'NO'],
  ['zero_resource_reservations', 'status', 'text', 'NO'],
  ['zero_resource_reservations', 'units_reserved', 'bigint', 'NO'],
  ['zero_resource_reservations', 'created_at', 'timestamp with time zone', 'NO'],
  ['zero_resource_reservations', 'expires_at', 'timestamp with time zone', 'NO'],
  ['zero_resource_reservations', 'completed_at', 'timestamp with time zone', 'YES'],
  ['zero_resource_rate_windows', 'principal_id', 'text', 'NO'],
  ['zero_resource_rate_windows', 'resource_id', 'text', 'NO'],
  ['zero_resource_rate_windows', 'window_start', 'timestamp with time zone', 'NO'],
  ['zero_resource_rate_windows', 'request_count', 'integer', 'NO'],
  ['zero_resource_rate_windows', 'updated_at', 'timestamp with time zone', 'NO'],
] as const).map(([table_name, column_name, data_type, is_nullable]) => ({
  table_name, column_name, data_type, is_nullable,
}));

const constraints = ([
  ['zero_resource_daily_usage', 'PRIMARY KEY (principal_id, resource_id, day_utc)'],
  ['zero_resource_daily_usage', 'CHECK ((jobs_started >= 0))'],
  ['zero_resource_daily_usage', 'CHECK ((units_used >= 0))'],
  ['zero_resource_reservations', 'PRIMARY KEY (reservation_id)'],
  ['zero_resource_reservations', 'UNIQUE (idempotency_key)'],
  ['zero_resource_reservations', 'CHECK ((length(request_fingerprint) = 64))'],
  ['zero_resource_reservations', "CHECK ((status = ANY (ARRAY['reserved'::text, 'completed'::text, 'released'::text])))"],
  ['zero_resource_reservations', 'CHECK ((units_reserved >= 0))'],
  ['zero_resource_rate_windows', 'PRIMARY KEY (principal_id, resource_id, window_start)'],
  ['zero_resource_rate_windows', 'CHECK ((request_count >= 0))'],
] as const).map(([table_name, definition]) => ({ table_name, definition }));

validateZeroResourceSchemaSnapshot(columns, constraints);
assert.deepEqual(ZERO_RESOURCE_ADVISORY_LOCK, [1514480207, 72]);

assert.equal(ZERO_RESOURCE_POLICIES['wan-video'].maxConcurrent, 1);
assert.equal(ZERO_RESOURCE_POLICIES['wan-video'].dailyJobs, 6);
assert.equal(ZERO_RESOURCE_POLICIES['piper-tts'].maxUnitsPerJob, 5000);
await assert.rejects(
  () => reserveZeroResourceWithPool({} as never, {
    principalId: 'client:forged', resourceId: 'wan-video', idempotencyKey: 'unit-test-key-1', units: 1,
  }),
  (error: unknown) => error instanceof ZeroResourceSchemaError,
  'client-supplied identities must fail closed',
);
await assert.rejects(
  () => reserveZeroResourceWithPool({} as never, {
    principalId: 'admin:primary', resourceId: 'unknown-worker', idempotencyKey: 'unit-test-key-2', units: 1,
  }),
  (error: unknown) => error instanceof ZeroResourceSchemaError,
  'unlisted resources must fail closed',
);
await assert.rejects(
  () => reserveZeroResourceWithPool({} as never, {
    principalId: 'admin:primary', resourceId: 'piper-tts', idempotencyKey: 'unit-test-key-3', units: 5001,
  }),
  (error: unknown) => error instanceof ZeroResourceSchemaError,
  'oversized resource units must fail closed',
);


assert.throws(
  () => validateZeroResourceSchemaSnapshot(columns.slice(1), constraints),
  (error: unknown) => error instanceof ZeroResourceSchemaError,
  'missing columns must fail closed',
);
assert.throws(
  () => validateZeroResourceSchemaSnapshot(
    columns.map((column, index) => index === 0 ? { ...column, data_type: 'integer' } : column),
    constraints,
  ),
  (error: unknown) => error instanceof ZeroResourceSchemaError,
  'column type drift must fail closed',
);
assert.throws(
  () => validateZeroResourceSchemaSnapshot(columns, constraints.slice(1)),
  (error: unknown) => error instanceof ZeroResourceSchemaError,
  'missing primary/check/unique constraints must fail closed',
);

function fakePool(options: { mismatch?: boolean; rollbackFails?: boolean; beginFails?: boolean } = {}) {
  const calls: string[] = [];
  let releases: Array<Error | boolean | undefined> = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql.trim());
      if (sql === 'BEGIN' && options.beginFails) throw new Error('BEGIN response lost after server-side start');
      if (sql.includes('FROM information_schema.columns')) {
        return { rows: options.mismatch ? columns.slice(1) : columns };
      }
      if (sql.includes('FROM pg_constraint')) return { rows: constraints };
      if (sql === 'ROLLBACK' && options.rollbackFails) throw new Error('rollback transport failure');
      return { rows: [] };
    },
    release: (error?: Error | boolean) => { releases.push(error); },
  };
  return {
    pool: { connect: async () => client } as never,
    calls,
    releases: () => releases,
  };
}

const healthy = fakePool();
await ensureZeroResourceSchemaWithPool(healthy.pool);
assert.equal(healthy.calls.filter((sql) => sql === 'BEGIN').length, 1);
assert.equal(healthy.calls.filter((sql) => sql.includes('pg_advisory_xact_lock')).length, 1);
assert.equal(healthy.calls.filter((sql) => sql.startsWith('CREATE TABLE IF NOT EXISTS')).length, 3);
assert.equal(healthy.calls.at(-1), 'COMMIT');
assert.deepEqual(healthy.releases(), [false]);

// Calling twice is intentionally safe: DDL is idempotent and every call
// revalidates the catalog instead of trusting a process-local ready flag.
await ensureZeroResourceSchemaWithPool(healthy.pool);
assert.equal(healthy.calls.filter((sql) => sql === 'COMMIT').length, 2);

const uncertainBegin = fakePool({ beginFails: true });
await assert.rejects(
  () => ensureZeroResourceSchemaWithPool(uncertainBegin.pool),
  (error: unknown) => error instanceof ZeroResourceSchemaError,
);
assert.equal(uncertainBegin.calls.at(-1), 'ROLLBACK', 'uncertain BEGIN must attempt rollback');
assert.deepEqual(uncertainBegin.releases(), [false], 'connection is reusable only after rollback succeeds');

const mismatch = fakePool({ mismatch: true });
await assert.rejects(
  () => ensureZeroResourceSchemaWithPool(mismatch.pool),
  (error: unknown) => error instanceof ZeroResourceSchemaError,
);
assert.equal(mismatch.calls.at(-1), 'ROLLBACK');
assert.deepEqual(mismatch.releases(), [false]);

const brokenRollback = fakePool({ mismatch: true, rollbackFails: true });
await assert.rejects(() => ensureZeroResourceSchemaWithPool(brokenRollback.pool));
assert.equal(brokenRollback.releases().length, 1);
assert.equal(brokenRollback.releases()[0], true, 'connection with uncertain transaction state must be destroyed');

console.log('ZERO RESOURCE GUARD schema tests passed (no provider/network calls).');
