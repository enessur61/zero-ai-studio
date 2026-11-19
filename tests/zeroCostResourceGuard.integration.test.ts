import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  ensureZeroCostResourceSchema,
  finishZeroCostResourceOperationWithPool,
  heartbeatZeroCostResourceLeaseWithPool,
  reserveZeroCostResourceOperationWithPool,
  withZeroCostResourceOperation,
  ZeroResourceGuardError,
  type ZeroResourceOperationInput,
} from '../server/zeroCostResourceGuard.ts';
import { reserveZeroCostProviderRequestWithPool, setZeroCostGuardPaused } from '../server/zeroCostGuard.ts';

const connectionString = process.env.DATABASE_URL;
if (process.env.ZERO_POSTGRES_TESTS !== 'true' || !connectionString) throw new Error('ZERO PostgreSQL resource integration requires ZERO_POSTGRES_TESTS=true and DATABASE_URL.');
const parsed = new URL(connectionString);
if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) throw new Error('Refusing non-local PostgreSQL integration database.');
const schema = `zero_resource_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString, max: 1 });
const poolA = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 });
const poolB = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 });
const env = {
  ZERO_COST_GUARD_ENABLED: 'true', ZERO_COST_GUARD_FREE_ONLY_CONFIRMED: 'true', ZERO_CLOUDFLARE_AI_ENABLED: 'true',
  ZERO_COST_RESOURCE_GUARD_ENABLED: 'true', ZERO_COST_RESOURCE_GUARD_FREE_ONLY_CONFIRMED: 'true',
  ZERO_COST_GUARD_DAILY_REQUEST_LIMIT: '100', ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED: 'true',
  ZERO_GEMINI_FREE_TIER_ONLY: 'true', DATABASE_URL: connectionString, NODE_ENV: 'test',
  ZERO_RESOURCE_TEXT_DAILY_LIMIT: '3', ZERO_RESOURCE_TEXT_CONCURRENCY: '3',
  ZERO_RESOURCE_IMAGE_DAILY_LIMIT: '5', ZERO_RESOURCE_IMAGE_CONCURRENCY: '1',
  ZERO_RESOURCE_VIDEO_DAILY_LIMIT: '20', ZERO_RESOURCE_VIDEO_CONCURRENCY: '20',
};
const base: ZeroResourceOperationInput = {
  provider: 'cloudflare-workers-ai', modelId: '@cf/zai-org/glm-4.7-flash', resourceType: 'text',
  studio: 'INTEGRATION', action: 'TEST', payload: { prompt: 'hello' },
};
const code = (expected: string) => (error: unknown) => error instanceof ZeroResourceGuardError && error.code === expected;

try {
  const serverVersion = await admin.query('SHOW server_version_num');
  assert.equal(Number(serverVersion.rows[0].server_version_num), 160016, 'integration suite requires PostgreSQL 16.16 exactly');
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await ensureZeroCostResourceSchema(poolA);
  await ensureZeroCostResourceSchema(poolB);

  // 1–4: schema exists, common budget, resource usage and operations tables exist.
  for (const table of ['zero_cost_daily_budget','zero_cost_audit_events','zero_cost_resource_usage','zero_cost_operations','zero_cost_active_leases']) {
    const found = await poolA.query('SELECT to_regclass($1) AS name', [table]);
    assert.ok(found.rows[0].name, `${table} initialized`);
  }

  // 5–7: PR #98 and PR #100 use one compatible global budget and audit schema.
  const legacyReservation = await reserveZeroCostProviderRequestWithPool(poolA, {
    provider: 'cloudflare-workers-ai', modelId: '@cf/zai-org/glm-4.7-flash', studio: 'COMPATIBILITY', action: 'PR98_BUDGET_TEST',
  }, env);
  const sharedBudgetBeforeResource = Number((await poolA.query("SELECT requests_used FROM zero_cost_daily_budget WHERE scope='global'")).rows[0].requests_used);
  assert.equal(sharedBudgetBeforeResource, legacyReservation.requestsUsed);
  const sharedResource = await reserveZeroCostResourceOperationWithPool(poolB, {
    ...base, resourceType: 'video', idempotencyKey: 'compat-shared-budget-0001',
  }, env);
  const sharedBudgetAfterResource = Number((await poolA.query("SELECT requests_used FROM zero_cost_daily_budget WHERE scope='global'")).rows[0].requests_used);
  assert.equal(sharedBudgetAfterResource, sharedBudgetBeforeResource + 1, 'one resource operation increments the same PR #98 global budget exactly once');
  assert.equal(Number((await poolA.query('SELECT COUNT(*)::int AS count FROM zero_cost_audit_events')).rows[0].count), 2, 'both guard paths write to the same audit table');
  await finishZeroCostResourceOperationWithPool(poolB, sharedResource.operation.operationId, sharedResource.leaseToken, 'SUCCEEDED');

  // Both guard APIs compete for one shared global request; only one may win.
  await poolA.query("UPDATE zero_cost_daily_budget SET requests_used = 0, daily_limit = 1, locked = FALSE WHERE scope = 'global'");
  const oneGlobalRequest = { ...env, ZERO_COST_GUARD_DAILY_REQUEST_LIMIT: '1' };
  const crossGuard = await Promise.all([
    reserveZeroCostProviderRequestWithPool(poolA, {
      provider: 'cloudflare-workers-ai', modelId: '@cf/zai-org/glm-4.7-flash', studio: 'COMPATIBILITY', action: 'PR98_CONCURRENT_BUDGET',
    }, oneGlobalRequest).then((value) => ({ kind: 'legacy' as const, value })).catch((error) => ({ kind: 'blocked' as const, error })),
    reserveZeroCostResourceOperationWithPool(poolB, {
      ...base, resourceType: 'video', idempotencyKey: 'compat-cross-guard-race-0001',
    }, oneGlobalRequest).then((value) => ({ kind: 'resource' as const, value })).catch((error) => ({ kind: 'blocked' as const, error })),
  ]);
  assert.equal(crossGuard.filter((item) => item.kind !== 'blocked').length, 1, 'only one guard path may consume the final global request');
  assert.equal(crossGuard.filter((item) => item.kind === 'blocked').length, 1);
  assert.equal(Number((await poolA.query("SELECT requests_used FROM zero_cost_daily_budget WHERE scope = 'global'")).rows[0].requests_used), 1);
  const resourceWinner = crossGuard.find((item) => item.kind === 'resource');
  if (resourceWinner?.kind === 'resource') {
    await finishZeroCostResourceOperationWithPool(poolA, resourceWinner.value.operation.operationId, resourceWinner.value.leaseToken, 'SUCCEEDED');
  }
  await poolA.query("UPDATE zero_cost_daily_budget SET requests_used = 0, daily_limit = 100, locked = FALSE WHERE scope = 'global'");

  // 8–11: idempotency, payload conflict, and cross-pool duplicate protection.
  const first = await reserveZeroCostResourceOperationWithPool(poolA, { ...base, idempotencyKey: 'idem-key-0001' }, env);
  await assert.rejects(() => reserveZeroCostResourceOperationWithPool(poolB, { ...base, idempotencyKey: 'idem-key-0001' }, env), code('IDEMPOTENT_REPLAY'));
  await assert.rejects(() => reserveZeroCostResourceOperationWithPool(poolB, { ...base, payload: { prompt: 'different' }, idempotencyKey: 'idem-key-0001' }, env), code('IDEMPOTENCY_CONFLICT'));
  const row = await poolB.query('SELECT status FROM zero_cost_operations WHERE operation_id = $1', [first.operation.operationId]);
  assert.equal(row.rows[0].status, 'RESERVED');

  // 9–12: successful, failed and unknown transitions have conservative accounting.
  await finishZeroCostResourceOperationWithPool(poolA, first.operation.operationId, first.leaseToken, 'SUCCEEDED');
  assert.equal((await poolB.query('SELECT status FROM zero_cost_operations WHERE operation_id = $1', [first.operation.operationId])).rows[0].status, 'SUCCEEDED');
  const failed = await reserveZeroCostResourceOperationWithPool(poolA, { ...base, resourceType: 'image', idempotencyKey: 'idem-key-0002' }, env);
  await finishZeroCostResourceOperationWithPool(poolA, failed.operation.operationId, failed.leaseToken, 'FAILED');
  assert.equal((await poolB.query('SELECT status FROM zero_cost_operations WHERE operation_id = $1', [failed.operation.operationId])).rows[0].status, 'FAILED');
  const unknown = await reserveZeroCostResourceOperationWithPool(poolA, { ...base, resourceType: 'audio', idempotencyKey: 'idem-key-0003' }, env);
  await finishZeroCostResourceOperationWithPool(poolA, unknown.operation.operationId, unknown.leaseToken, 'UNKNOWN');
  assert.equal((await poolB.query('SELECT status FROM zero_cost_operations WHERE operation_id = $1', [unknown.operation.operationId])).rows[0].status, 'UNKNOWN');
  assert.equal(Number((await poolB.query("SELECT reserved_units FROM zero_cost_resource_usage WHERE resource_type = 'audio'")).rows[0].reserved_units), 1);

  // 13–16: leases, heartbeat, token validation and serialized concurrency.
  const leased = await reserveZeroCostResourceOperationWithPool(poolA, { ...base, resourceType: 'image', idempotencyKey: 'idem-key-0004' }, env);
  await heartbeatZeroCostResourceLeaseWithPool(poolB, leased.operation.operationId, leased.leaseToken);
  await assert.rejects(() => heartbeatZeroCostResourceLeaseWithPool(poolB, leased.operation.operationId, 'wrong-token'), code('LEASE_INVALID'));
  await finishZeroCostResourceOperationWithPool(poolA, leased.operation.operationId, leased.leaseToken, 'SUCCEEDED');
  const oneSlotEnv = { ...env, ZERO_RESOURCE_IMAGE_CONCURRENCY: '1' };
  const held = await reserveZeroCostResourceOperationWithPool(poolA, { ...base, resourceType: 'image', idempotencyKey: 'idem-key-0005' }, oneSlotEnv);
  await assert.rejects(() => reserveZeroCostResourceOperationWithPool(poolB, { ...base, resourceType: 'image', idempotencyKey: 'idem-key-0006' }, oneSlotEnv), code('CONCURRENCY_LIMIT'));
  await finishZeroCostResourceOperationWithPool(poolA, held.operation.operationId, held.leaseToken, 'SUCCEEDED');

  // 17–19: daily resource limit is atomic and rollback does not consume global request budget.
  const beforeBudget = Number((await poolA.query("SELECT requests_used FROM zero_cost_daily_budget WHERE scope='global'")).rows[0].requests_used);
  const limitedEnv = { ...env, ZERO_RESOURCE_TEXT_DAILY_LIMIT: '3' };
  const text1 = await reserveZeroCostResourceOperationWithPool(poolA, { ...base, idempotencyKey: 'idem-key-0007' }, limitedEnv);
  const text2 = await reserveZeroCostResourceOperationWithPool(poolB, { ...base, idempotencyKey: 'idem-key-0008' }, limitedEnv);
  await assert.rejects(() => reserveZeroCostResourceOperationWithPool(poolA, { ...base, idempotencyKey: 'idem-key-0009' }, limitedEnv), code('RESOURCE_DAILY_LIMIT'));
  const afterBlockedBudget = Number((await poolB.query("SELECT requests_used FROM zero_cost_daily_budget WHERE scope='global'")).rows[0].requests_used);
  assert.equal(afterBlockedBudget, beforeBudget + 2, 'failed resource reservation rolls back the shared global budget increment');
  await finishZeroCostResourceOperationWithPool(poolA, text1.operation.operationId, text1.leaseToken, 'FAILED');
  await finishZeroCostResourceOperationWithPool(poolB, text2.operation.operationId, text2.leaseToken, 'FAILED');

  // 20: expired in-flight leases are conservatively reconciled to UNKNOWN.
  const expiredNow = new Date(Date.now() - 16 * 60 * 1000);
  const expired = await reserveZeroCostResourceOperationWithPool(poolA, { ...base, resourceType: 'video', idempotencyKey: 'idem-key-expired' }, env, expiredNow);
  await reserveZeroCostResourceOperationWithPool(poolB, { ...base, resourceType: 'image', idempotencyKey: 'idem-key-expirer' }, env);
  assert.equal((await poolA.query('SELECT status FROM zero_cost_operations WHERE operation_id = $1', [expired.operation.operationId])).rows[0].status, 'UNKNOWN');

  // 21–23: concurrent reservations across pools, helper success, and failure => UNKNOWN.
  const concurrentEnv = { ...env, ZERO_RESOURCE_VIDEO_DAILY_LIMIT: '20', ZERO_RESOURCE_VIDEO_CONCURRENCY: '20' };
  const parallel = await Promise.all(Array.from({ length: 12 }, (_, i) => reserveZeroCostResourceOperationWithPool(i % 2 ? poolA : poolB,
    { ...base, resourceType: 'video', idempotencyKey: `parallel-key-${String(i).padStart(4,'0')}` }, concurrentEnv).then((value) => value).catch((error) => error)));
  assert.equal(parallel.filter((item) => !(item instanceof Error)).length, 12, 'cross-pool concurrent reservations all fit configured quota');
  const wrapped = await withZeroCostResourceOperation({ ...base, resourceType: 'text', idempotencyKey: 'idem-key-0010', env }, async () => 'mock-result', env, poolA);
  assert.equal(wrapped, 'mock-result');
  await assert.rejects(() => withZeroCostResourceOperation({ ...base, resourceType: 'text', idempotencyKey: 'idem-key-0011', env }, async () => { throw new Error('simulated ambiguous provider timeout'); }, env, poolB), (error: unknown) => error instanceof ZeroResourceGuardError && error.code === 'OPERATION_UNKNOWN');
  const knownProviderFailure = new Error('429 RESOURCE_EXHAUSTED');
  let knownFailureAttempts = 0;
  const knownFailureKey = 'known-provider-429-0001';
  const beforeKnownFailureBudget = Number((await poolA.query("SELECT requests_used FROM zero_cost_daily_budget WHERE scope='global'")).rows[0].requests_used);
  await assert.rejects(() => withZeroCostResourceOperation({ ...base, resourceType: 'video', idempotencyKey: knownFailureKey, env }, async () => {
    knownFailureAttempts += 1;
    throw knownProviderFailure;
  }, env, poolA, undefined, () => 'FAILED'), (error: unknown) => error === knownProviderFailure);
  assert.equal(knownFailureAttempts, 1, 'definitive provider rejection is not retried');
  const knownFailureHash = createHash('sha256').update(knownFailureKey).digest('hex');
  const knownFailureStatus = await poolA.query('SELECT status FROM zero_cost_operations WHERE idempotency_hash = $1', [knownFailureHash]);
  assert.equal(knownFailureStatus.rows[0].status, 'FAILED', 'definitive provider rejection is recorded as FAILED rather than UNKNOWN');
  const afterKnownFailureBudget = Number((await poolA.query("SELECT requests_used FROM zero_cost_daily_budget WHERE scope='global'")).rows[0].requests_used);
  assert.equal(afterKnownFailureBudget, beforeKnownFailureBudget + 1, 'definitive failed provider request remains counted in the global request budget');

  const unknownResultKey = 'unknown-result-classification-0001';
  let unknownResultAttempts = 0;
  await assert.rejects(() => withZeroCostResourceOperation({
    ...base, resourceType: 'video', idempotencyKey: unknownResultKey,
  }, async () => { unknownResultAttempts += 1; return 'ambiguous-http-response'; }, env, poolA, () => 'UNKNOWN'), code('OPERATION_UNKNOWN'));
  assert.equal(unknownResultAttempts, 1, 'an UNKNOWN result classification never re-executes the provider');
  const unknownResultHash = createHash('sha256').update(unknownResultKey).digest('hex');
  const unknownResultStatus = await poolA.query('SELECT status FROM zero_cost_operations WHERE idempotency_hash = $1', [unknownResultHash]);
  assert.equal(unknownResultStatus.rows[0].status, 'UNKNOWN', 'UNKNOWN result is persisted once without a second finish attempt');
  const usage = await poolA.query("SELECT reserved_units, consumed_units FROM zero_cost_resource_usage WHERE resource_type='text'");
  assert.ok(Number(usage.rows[0].reserved_units) >= 1, 'ambiguous provider operation remains charged as reserved');

  // Shared manual pause from PR #98 blocks both reservation APIs in PR #100's transaction.
  await setZeroCostGuardPaused(poolA, true, 100);
  await assert.rejects(() => reserveZeroCostResourceOperationWithPool(poolB, {
    ...base, resourceType: 'video', idempotencyKey: 'compat-paused-resource-0001',
  }, env), code('BUDGET_EXHAUSTED'));
  await assert.rejects(() => reserveZeroCostProviderRequestWithPool(poolA, {
    provider: 'cloudflare-workers-ai', modelId: '@cf/zai-org/glm-4.7-flash', studio: 'COMPATIBILITY', action: 'PR98_PAUSED_TEST',
  }, env), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'BUDGET_EXHAUSTED');
  await setZeroCostGuardPaused(poolB, false, 100);
  const resumed = await reserveZeroCostResourceOperationWithPool(poolA, {
    ...base, resourceType: 'video', idempotencyKey: 'compat-resumed-resource-0001',
  }, env);
  await finishZeroCostResourceOperationWithPool(poolA, resumed.operation.operationId, resumed.leaseToken, 'SUCCEEDED');

  console.log('ZERO resource PostgreSQL 16.16 integration passed: exact PostgreSQL 16.16 version, PR #98/#100 shared budget/audit/lock/pause, cross-guard atomicity, resource quotas, idempotency, leases, UNKNOWN handling, cross-pool concurrency and rollback.');
} finally {
  await poolA.end(); await poolB.end();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
}
