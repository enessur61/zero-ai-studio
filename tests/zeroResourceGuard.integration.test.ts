import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  ensureZeroResourceSchemaWithPool,
  ZeroResourceSchemaError,
  ZeroResourceLimitError,
  ZeroResourceIdempotencyError,
  ZERO_RESOURCE_POLICIES,
  reserveZeroResourceWithPool,
  settleZeroResourceReservationWithPool,
  getZeroResourceReservationWithPool,
} from '../server/zeroResourceGuard.ts';

const connectionString = process.env.DATABASE_URL;
if (process.env.ZERO_POSTGRES_TESTS !== 'true' || !connectionString) {
  throw new Error('ZERO RESOURCE GUARD integration tests require ZERO_POSTGRES_TESTS=true and DATABASE_URL.');
}
const parsed = new URL(connectionString);
if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
  throw new Error('Refusing to run ZERO RESOURCE GUARD integration tests against a non-local database.');
}

const schema = `zero_resource_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString, max: 1 });
const poolA = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 2 });
const poolB = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 2 });

try {
  await admin.query(`CREATE SCHEMA "${schema}"`);

  // Separate pools model independent application instances. The transaction
  // advisory lock must serialize concurrent, idempotent schema initialization.
  await Promise.all([
    ensureZeroResourceSchemaWithPool(poolA),
    ensureZeroResourceSchemaWithPool(poolB),
  ]);

  const tables = await poolA.query<{ tablename: string }>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = current_schema()
      AND tablename LIKE 'zero_resource_%'
    ORDER BY tablename
  `);
  assert.deepEqual(tables.rows.map((row) => row.tablename), [
    'zero_resource_daily_usage',
    'zero_resource_rate_windows',
    'zero_resource_reservations',
  ]);

  await ensureZeroResourceSchemaWithPool(poolA);
  const afterRepeat = await poolB.query<{ count: string }>(`
    SELECT COUNT(*)::text AS count FROM pg_tables
    WHERE schemaname = current_schema()
      AND tablename LIKE 'zero_resource_%'
  `);
  assert.equal(afterRepeat.rows[0]?.count, '3', 'repeated initialization must not duplicate tables');

  // Existing incompatible tables must not be silently accepted. Since all
  // DDL runs in one transaction, newly-created sibling tables roll back too.
  const badSchema = `zero_resource_bad_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${badSchema}"`);
  const badPool = new Pool({ connectionString, options: `-c search_path=${badSchema}`, max: 1 });
  try {
    await badPool.query('CREATE TABLE zero_resource_daily_usage (wrong_column TEXT)');
    await assert.rejects(
      () => ensureZeroResourceSchemaWithPool(badPool),
      (error: unknown) => error instanceof ZeroResourceSchemaError,
      'schema drift must fail closed',
    );
    const remaining = await badPool.query<{ tablename: string }>(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = current_schema()
      ORDER BY tablename
    `);
    assert.deepEqual(remaining.rows.map((row) => row.tablename), ['zero_resource_daily_usage']);
  } finally {
    await badPool.end();
    await admin.query(`DROP SCHEMA "${badSchema}" CASCADE`);
  }

  // Atomic reservation limits, duplicate handling, expiry and settlement.
  const wanKeyA = `wan-${randomUUID()}`;
  const wanKeyB = `wan-${randomUUID()}`;
  const competing = await Promise.allSettled([
    reserveZeroResourceWithPool(poolA, { principalId: 'admin:primary', resourceId: 'wan-video', idempotencyKey: wanKeyA, units: 1 }),
    reserveZeroResourceWithPool(poolB, { principalId: 'admin:primary', resourceId: 'wan-video', idempotencyKey: wanKeyB, units: 1 }),
  ]);
  const accepted = competing.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof reserveZeroResourceWithPool>>> => item.status === 'fulfilled');
  const denied = competing.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
  assert.equal(accepted.length, 1, 'independent pools must serialize reservations under the concurrency cap');
  assert.equal(denied.length, 1);
  assert.ok(denied[0].reason instanceof ZeroResourceLimitError);
  const wanReservation = accepted[0].value;
  const acceptedWanKey = competing[0].status === 'fulfilled' ? wanKeyA : wanKeyB;
  const sameWan = await reserveZeroResourceWithPool(poolB, {
    principalId: 'admin:primary', resourceId: 'wan-video', idempotencyKey: acceptedWanKey, units: 1,
  });
  assert.equal(sameWan.reservationId, wanReservation.reservationId);
  assert.equal(sameWan.duplicate, true);
  assert.equal(await settleZeroResourceReservationWithPool(poolA, {
    principalId: 'admin:primary', reservationId: wanReservation.reservationId, outcome: 'released',
  }), true);
  const settledWan = await getZeroResourceReservationWithPool(poolB, {
    principalId: 'admin:primary', reservationId: wanReservation.reservationId,
  });
  assert.equal(settledWan?.status, 'released');
  assert.equal(await settleZeroResourceReservationWithPool(poolB, {
    principalId: 'admin:primary', reservationId: wanReservation.reservationId, outcome: 'completed',
  }), false, 'terminal reservation transitions must be idempotent');

  const piperKey = `piper-${randomUUID()}`;
  const piper = await reserveZeroResourceWithPool(poolA, {
    principalId: 'admin:primary', resourceId: 'piper-tts', idempotencyKey: piperKey, units: 250,
  });
  const piperDuplicate = await reserveZeroResourceWithPool(poolB, {
    principalId: 'admin:primary', resourceId: 'piper-tts', idempotencyKey: piperKey, units: 250,
  });
  assert.equal(piperDuplicate.reservationId, piper.reservationId);
  assert.equal(piperDuplicate.duplicate, true);
  await assert.rejects(
    () => reserveZeroResourceWithPool(poolB, {
      principalId: 'admin:primary', resourceId: 'piper-tts', idempotencyKey: piperKey, units: 250,
      requestFingerprint: 'a'.repeat(64),
    }),
    (error: unknown) => error instanceof ZeroResourceIdempotencyError,
    'an idempotency key cannot be replayed with a different request payload',
  );
  await assert.rejects(
    () => reserveZeroResourceWithPool(poolB, {
      principalId: 'admin:primary', resourceId: 'piper-tts', idempotencyKey: piperKey, units: 251,
    }),
    (error: unknown) => error instanceof ZeroResourceIdempotencyError,
    'an idempotency key cannot be reused with different units',
  );

  // Expired reservations stop counting toward concurrency and are terminally released.
  await poolA.query(
    'UPDATE zero_resource_reservations SET expires_at = NOW() - INTERVAL \'1 second\' WHERE reservation_id = $1',
    [piper.reservationId],
  );
  const expired = await reserveZeroResourceWithPool(poolB, {
    principalId: 'admin:primary', resourceId: 'piper-tts', idempotencyKey: `piper-expiry-${randomUUID()}`, units: 100,
  });
  assert.equal((await getZeroResourceReservationWithPool(poolA, {
    principalId: 'admin:primary', reservationId: piper.reservationId,
  }))?.status, 'released');
  await settleZeroResourceReservationWithPool(poolA, {
    principalId: 'admin:primary', reservationId: expired.reservationId, outcome: 'released',
  });

  const piperActiveA = await reserveZeroResourceWithPool(poolA, {
    principalId: 'admin:primary', resourceId: 'piper-tts', idempotencyKey: `piper-active-a-${randomUUID()}`, units: 50,
  });
  const piperActiveB = await reserveZeroResourceWithPool(poolB, {
    principalId: 'admin:primary', resourceId: 'piper-tts', idempotencyKey: `piper-active-b-${randomUUID()}`, units: 50,
  });
  await assert.rejects(
    () => reserveZeroResourceWithPool(poolA, {
      principalId: 'admin:primary', resourceId: 'piper-tts', idempotencyKey: `piper-active-c-${randomUUID()}`, units: 50,
    }),
    (error: unknown) => error instanceof ZeroResourceLimitError,
    'Piper must reject a third concurrent synthesis',
  );
  await settleZeroResourceReservationWithPool(poolA, {
    principalId: 'admin:primary', reservationId: piperActiveA.reservationId, outcome: 'released',
  });
  await settleZeroResourceReservationWithPool(poolB, {
    principalId: 'admin:primary', reservationId: piperActiveB.reservationId, outcome: 'completed',
  });

  // Explicitly exhaust the daily and minute counters to prove both gates fail closed.
  await poolA.query(
    `UPDATE zero_resource_daily_usage SET jobs_started = $3, units_used = $4
     WHERE principal_id = $1 AND resource_id = $2 AND day_utc = (NOW() AT TIME ZONE 'UTC')::date`,
    ['admin:primary', 'piper-tts', ZERO_RESOURCE_POLICIES['piper-tts'].dailyJobs, ZERO_RESOURCE_POLICIES['piper-tts'].dailyUnits],
  );
  await assert.rejects(
    () => reserveZeroResourceWithPool(poolB, {
      principalId: 'admin:primary', resourceId: 'piper-tts', idempotencyKey: `piper-daily-${randomUUID()}`, units: 1,
    }),
    (error: unknown) => error instanceof ZeroResourceLimitError,
    'daily job/unit budgets must be enforced atomically',
  );
  await poolA.query(
    `UPDATE zero_resource_daily_usage SET jobs_started = 0, units_used = 0
     WHERE principal_id = 'admin:primary' AND resource_id = 'piper-tts' AND day_utc = (NOW() AT TIME ZONE 'UTC')::date`,
  );
  // Isolate the minute-limit assertion from the daily budget gate.
  await poolA.query(
    `UPDATE zero_resource_daily_usage SET jobs_started = 0, units_used = 0
     WHERE principal_id = 'admin:primary' AND resource_id = 'piper-tts'
       AND day_utc = (NOW() AT TIME ZONE 'UTC')::date`,
  );
  await poolA.query(
    `UPDATE zero_resource_rate_windows SET request_count = $3
     WHERE principal_id = $1 AND resource_id = $2 AND window_start = date_trunc('minute', NOW())`,
    ['admin:primary', 'piper-tts', ZERO_RESOURCE_POLICIES['piper-tts'].perMinute],
  );
  await assert.rejects(
    () => reserveZeroResourceWithPool(poolB, {
      principalId: 'admin:primary', resourceId: 'piper-tts', idempotencyKey: `piper-rate-${randomUUID()}`, units: 1,
    }),
    (error: unknown) => error instanceof ZeroResourceLimitError,
  );

} finally {
  await Promise.all([poolA.end(), poolB.end()]);
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
}

console.log('ZERO RESOURCE GUARD PostgreSQL schema integration tests passed.');
