import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPostgresPool } from './persistence.ts';
import { assertZeroCostProviderAllowed, ZeroCostGuardError, ZERO_COST_ADVISORY_LOCK } from './zeroCostGuard.ts';
import { applyZeroSchemaMigrationsWithClient } from './schemaMigrations.ts';

export type ZeroResourceType = 'text' | 'image' | 'audio' | 'video';
export type ZeroOperationStatus = 'RESERVED' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
export type ZeroResourceProvider = 'cloudflare-workers-ai' | 'google-gemini-free';

export interface ZeroResourceLimit {
  dailyUnits: number;
  concurrency: number;
  maxInputBytes: number;
  maxInputChars: number;
  maxDurationSeconds: number;
  perMinute: number;
}
export type ZeroResourceLimits = Record<ZeroResourceType, ZeroResourceLimit>;

export interface ZeroResourceEnvironment {
  ZERO_COST_GUARD_ENABLED?: string;
  ZERO_COST_GUARD_FREE_ONLY_CONFIRMED?: string;
  ZERO_CLOUDFLARE_AI_ENABLED?: string;
  ZERO_COST_RESOURCE_GUARD_ENABLED?: string;
  ZERO_COST_RESOURCE_GUARD_FREE_ONLY_CONFIRMED?: string;
  ZERO_COST_GUARD_DAILY_REQUEST_LIMIT?: string;
  ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED?: string;
  ZERO_GEMINI_FREE_TIER_ONLY?: string;
  ZERO_RESOURCE_TEXT_DAILY_LIMIT?: string;
  ZERO_RESOURCE_IMAGE_DAILY_LIMIT?: string;
  ZERO_RESOURCE_AUDIO_DAILY_LIMIT?: string;
  ZERO_RESOURCE_VIDEO_DAILY_LIMIT?: string;
  ZERO_RESOURCE_TEXT_CONCURRENCY?: string;
  ZERO_RESOURCE_IMAGE_CONCURRENCY?: string;
  ZERO_RESOURCE_AUDIO_CONCURRENCY?: string;
  ZERO_RESOURCE_VIDEO_CONCURRENCY?: string;
  DATABASE_URL?: string;
  NODE_ENV?: string;
}

export interface ZeroResourceOperationInput {
  provider: ZeroResourceProvider;
  modelId: string;
  resourceType: ZeroResourceType;
  studio: string;
  action: string;
  payload: unknown;
  idempotencyKey?: string;
  principal?: string;
  units?: number;
  inputBytes?: number;
  inputChars?: number;
  durationSeconds?: number;
  env?: ZeroResourceEnvironment;
}

export interface ZeroResourceOperation {
  operationId: string;
  status: ZeroOperationStatus;
  dayUtc: string;
  resourceType: ZeroResourceType;
  reservedUnits: number;
  replayed: boolean;
}

export class ZeroResourceGuardError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'ZeroResourceGuardError';
  }
}

const RESOURCE_TYPES = new Set<ZeroResourceType>(['text', 'image', 'audio', 'video']);
const MAX_LIMITS: ZeroResourceLimits = {
  text: { dailyUnits: 20, concurrency: 3, maxInputBytes: 128_000, maxInputChars: 32_768, maxDurationSeconds: 0, perMinute: 5 },
  image: { dailyUnits: 5, concurrency: 1, maxInputBytes: 8 * 1024 * 1024, maxInputChars: 2_048, maxDurationSeconds: 0, perMinute: 1 },
  audio: { dailyUnits: 10, concurrency: 1, maxInputBytes: 10 * 1024 * 1024, maxInputChars: 0, maxDurationSeconds: 300, perMinute: 2 },
  video: { dailyUnits: 12, concurrency: 1, maxInputBytes: 100 * 1024 * 1024, maxInputChars: 0, maxDurationSeconds: 60, perMinute: 1 },
};
const MAX_DAILY = 10_000;
const MAX_CONCURRENCY = 20;
const LEASE_TTL_SECONDS = 15 * 60;
const UNKNOWN_LEASE_TTL_SECONDS = 24 * 60 * 60;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
function parseBounded(envValue: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (envValue === undefined || envValue.trim() === '') return fallback;
  const parsed = Number(envValue);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ZeroResourceGuardError(`Ungültige serverseitige ZERO-Ressourcengrenze: ${name}.`, 'INVALID_LIMIT');
  }
  return parsed;
}

export function getZeroResourceLimits(env: ZeroResourceEnvironment = process.env): ZeroResourceLimits {
  const result = structuredClone(MAX_LIMITS);
  for (const type of RESOURCE_TYPES) {
    const key = type.toUpperCase();
    result[type].dailyUnits = parseBounded((env as Record<string, string | undefined>)[`ZERO_RESOURCE_${key}_DAILY_LIMIT`], result[type].dailyUnits, 1, MAX_DAILY, `${key}_DAILY_LIMIT`);
    result[type].concurrency = parseBounded((env as Record<string, string | undefined>)[`ZERO_RESOURCE_${key}_CONCURRENCY`], result[type].concurrency, 1, MAX_CONCURRENCY, `${key}_CONCURRENCY`);
    result[type].perMinute = parseBounded((env as Record<string, string | undefined>)[`ZERO_RESOURCE_${key}_PER_MINUTE_LIMIT`], result[type].perMinute, 1, 1_000, `${key}_PER_MINUTE_LIMIT`);
  }
  return result;
}

export function validateZeroResourceOperation(input: ZeroResourceOperationInput, env: ZeroResourceEnvironment = input.env ?? process.env): ZeroResourceLimits {
  if (env.ZERO_COST_RESOURCE_GUARD_ENABLED !== 'true' || env.ZERO_COST_RESOURCE_GUARD_FREE_ONLY_CONFIRMED !== 'true') {
    throw new ZeroResourceGuardError('ZERO Ressourcenwächter ist nicht ausdrücklich aktiviert; Provider-Aufruf blockiert.', 'GUARD_DISABLED');
  }
  if (!RESOURCE_TYPES.has(input.resourceType)) {
    throw new ZeroResourceGuardError('Ungültiger ZERO-Ressourcentyp.', 'INVALID_METADATA');
  }
  try {
    // The cost guard owns the single canonical provider allowlist and free-tier gates.
    assertZeroCostProviderAllowed({
      provider: input.provider, modelId: input.modelId, studio: input.studio, action: input.action,
    }, env);
  } catch (error) {
    if (error instanceof ZeroCostGuardError) throw new ZeroResourceGuardError(error.message, error.code);
    throw error;
  }
  const limits = getZeroResourceLimits(env);
  const configured = limits[input.resourceType];
  const units = input.units ?? 1;
  if (!Number.isSafeInteger(units) || units < 1 || units > configured.dailyUnits) {
    throw new ZeroResourceGuardError('Ungültige Anzahl reservierter ZERO-Ressourceneinheiten.', 'INVALID_UNITS');
  }
  if (input.inputBytes !== undefined && (!Number.isSafeInteger(input.inputBytes) || input.inputBytes < 0 || input.inputBytes > configured.maxInputBytes)) {
    throw new ZeroResourceGuardError('Eingabe überschreitet das serverseitige ZERO-Größenlimit.', 'INPUT_TOO_LARGE');
  }
  if (input.inputChars !== undefined && (!Number.isSafeInteger(input.inputChars) || input.inputChars < 0 || (configured.maxInputChars > 0 && input.inputChars > configured.maxInputChars))) {
    throw new ZeroResourceGuardError('Eingabe überschreitet das serverseitige ZERO-Zeichenlimit.', 'INPUT_TOO_LARGE');
  }
  if (input.durationSeconds !== undefined && (!Number.isFinite(input.durationSeconds) || input.durationSeconds < 0 || (configured.maxDurationSeconds > 0 && input.durationSeconds > configured.maxDurationSeconds))) {
    throw new ZeroResourceGuardError('Dauer überschreitet das serverseitige ZERO-Limit.', 'DURATION_TOO_LONG');
  }
  if (input.idempotencyKey !== undefined && (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200)) {
    throw new ZeroResourceGuardError('Idempotenzschlüssel muss 8 bis 200 Zeichen lang sein.', 'INVALID_IDEMPOTENCY_KEY');
  }
  return limits;
}

async function createSchema(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS zero_cost_daily_budget (
      scope TEXT PRIMARY KEY,
      day_utc DATE NOT NULL,
      requests_used INTEGER NOT NULL CHECK (requests_used >= 0),
      daily_limit INTEGER NOT NULL CHECK (daily_limit > 0),
      locked BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS zero_cost_audit_events (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      day_utc DATE NOT NULL,
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      studio TEXT NOT NULL,
      action TEXT NOT NULL,
      decision TEXT NOT NULL,
      requests_used INTEGER,
      daily_limit INTEGER,
      reason TEXT NOT NULL
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS zero_cost_resource_usage (
      day_utc DATE NOT NULL,
      scope_hash TEXT NOT NULL,
      resource_type TEXT NOT NULL CHECK (resource_type IN ('text','image','audio','video')),
      reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
      consumed_units INTEGER NOT NULL DEFAULT 0 CHECK (consumed_units >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (day_utc, scope_hash, resource_type)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS zero_cost_operations (
      operation_id UUID PRIMARY KEY,
      principal_hash TEXT NOT NULL,
      idempotency_hash TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      resource_type TEXT NOT NULL CHECK (resource_type IN ('text','image','audio','video')),
      day_utc DATE NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('RESERVED','SUCCEEDED','FAILED','UNKNOWN')),
      reserved_units INTEGER NOT NULL CHECK (reserved_units > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (principal_hash, idempotency_hash)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS zero_cost_active_leases (
      operation_id UUID PRIMARY KEY REFERENCES zero_cost_operations(operation_id) ON DELETE CASCADE,
      resource_type TEXT NOT NULL CHECK (resource_type IN ('text','image','audio','video')),
      lease_token_hash TEXT NOT NULL,
      acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ACTIVE','UNKNOWN','RELEASED'))
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS zero_cost_resource_usage_day_idx ON zero_cost_resource_usage (day_utc, resource_type)');
  await client.query("CREATE INDEX IF NOT EXISTS zero_cost_active_leases_expiry_idx ON zero_cost_active_leases (resource_type, expires_at) WHERE status IN ('ACTIVE','UNKNOWN')");
}

const schemaReadyByPool = new WeakMap<Pool, Promise<void>>();

export async function ensureZeroCostResourceSchema(pool: Pool): Promise<void> {
  const ready = schemaReadyByPool.get(pool);
  if (ready) return ready;
  const initialization = (async () => {
    const client = await pool.connect();
    let destroyClient = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', ZERO_COST_ADVISORY_LOCK);
      await createSchema(client);
      await applyZeroSchemaMigrationsWithClient(client);
      await client.query('COMMIT');
    } catch {
      try {
        await client.query('ROLLBACK');
      } catch {
        destroyClient = true;
      }
      throw new ZeroResourceGuardError('ZERO-Ressourcenschema konnte nicht sicher initialisiert werden.', 'SCHEMA_ERROR');
    } finally {
      client.release(destroyClient);
    }
  })();
  schemaReadyByPool.set(pool, initialization);
  try {
    await initialization;
  } catch (error) {
    schemaReadyByPool.delete(pool);
    throw error;
  }
}

export async function reserveZeroCostResourceOperationWithPool(
  pool: Pool,
  input: ZeroResourceOperationInput,
  env: ZeroResourceEnvironment = input.env ?? process.env,
  now = new Date()
): Promise<{ operation: ZeroResourceOperation; leaseToken: string }> {
  const limits = validateZeroResourceOperation(input, env);
  const dailyLimit = Number(env.ZERO_COST_GUARD_DAILY_REQUEST_LIMIT);
  const units = input.units ?? 1;
  const principalHash = digest(input.principal ?? 'zero-server');
  const idempotencyKey = input.idempotencyKey ?? randomUUID();
  const idempotencyHash = digest(idempotencyKey);
  const payloadHash = digest(JSON.stringify(input.payload ?? null));
  const operationId = randomUUID();
  const leaseToken = randomBytes(32).toString('hex');
  const dayUtc = utcDay(now);
  const limit = limits[input.resourceType];

  await ensureZeroCostResourceSchema(pool);
  const client = await pool.connect();
  let committed = false;
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', ZERO_COST_ADVISORY_LOCK);
    // A crashed process cannot leave a RESERVED operation appearing live forever.
    // Expired ACTIVE leases become UNKNOWN and remain charged for reconciliation.
    await client.query(`
      UPDATE zero_cost_operations o SET status = 'UNKNOWN', updated_at = NOW()
      FROM zero_cost_active_leases l
      WHERE l.operation_id = o.operation_id AND o.status = 'RESERVED'
        AND l.status = 'ACTIVE' AND l.expires_at <= $1
    `, [now]);
    await client.query(`
      UPDATE zero_cost_active_leases SET status = 'UNKNOWN', expires_at = $1
      WHERE status = 'ACTIVE' AND expires_at <= $2
    `, [new Date(now.getTime() + UNKNOWN_LEASE_TTL_SECONDS * 1000), now]);

    const prior = await client.query<{ operation_id: string; status: ZeroOperationStatus; payload_hash: string; day_utc: string; reserved_units: number }>(
      'SELECT operation_id, status, payload_hash, day_utc::text, reserved_units FROM zero_cost_operations WHERE principal_hash = $1 AND idempotency_hash = $2 FOR UPDATE',
      [principalHash, idempotencyHash]
    );
    if (prior.rows[0]) {
      if (prior.rows[0].payload_hash !== payloadHash) {
        throw new ZeroResourceGuardError('Idempotenzschlüssel wurde mit einer anderen Nutzlast wiederverwendet.', 'IDEMPOTENCY_CONFLICT');
      }
      throw new ZeroResourceGuardError(`Idempotente Wiederholung blockiert; bestehender Vorgang ${prior.rows[0].operation_id} hat Status ${prior.rows[0].status}.`, 'IDEMPOTENT_REPLAY');
    }

    const rate = await client.query<{ principal_count: number; global_count: number }>(`
      SELECT
        COUNT(*) FILTER (WHERE principal_hash = $1)::int AS principal_count,
        COUNT(*)::int AS global_count
      FROM zero_cost_resource_rate_events
      WHERE resource_type = $2
        AND created_at > $3::timestamptz - INTERVAL '60 seconds'
        AND created_at <= $3::timestamptz
    `, [principalHash, input.resourceType, now]);
    const principalRate = Number(rate.rows[0]?.principal_count ?? 0);
    const globalRate = Number(rate.rows[0]?.global_count ?? 0);
    if (principalRate >= limit.perMinute || globalRate >= limit.perMinute) {
      throw new ZeroResourceGuardError('ZERO-Ressourcen-Minutenlimit erreicht.', 'RATE_LIMITED');
    }
    const budget = await client.query<{ requests_used: number; daily_limit: number }>(`
      INSERT INTO zero_cost_daily_budget (scope, day_utc, requests_used, daily_limit)
      VALUES ('global', $1::date, 1, $2)
      ON CONFLICT (scope) DO UPDATE SET
        day_utc = EXCLUDED.day_utc,
        requests_used = CASE WHEN zero_cost_daily_budget.day_utc = EXCLUDED.day_utc
          THEN zero_cost_daily_budget.requests_used + 1 ELSE 1 END,
        daily_limit = CASE WHEN zero_cost_daily_budget.day_utc = EXCLUDED.day_utc
          THEN LEAST(zero_cost_daily_budget.daily_limit, EXCLUDED.daily_limit) ELSE EXCLUDED.daily_limit END,
        updated_at = NOW()
      WHERE zero_cost_daily_budget.locked = FALSE
        AND CASE WHEN zero_cost_daily_budget.day_utc = EXCLUDED.day_utc
          THEN zero_cost_daily_budget.requests_used < LEAST(zero_cost_daily_budget.daily_limit, EXCLUDED.daily_limit)
          ELSE TRUE END
      RETURNING requests_used, daily_limit
    `, [dayUtc, dailyLimit]);
    if (!budget.rows[0]) throw new ZeroResourceGuardError('Gemeinsames ZERO-Tagesbudget ausgeschöpft oder manuell pausiert.', 'BUDGET_EXHAUSTED');

    const scopeHash = digest('global');
    const usage = await client.query<{ reserved_units: number; consumed_units: number }>(`
      INSERT INTO zero_cost_resource_usage (day_utc, scope_hash, resource_type, reserved_units, consumed_units)
      VALUES ($1::date, $2, $3, $4, 0)
      ON CONFLICT (day_utc, scope_hash, resource_type) DO UPDATE SET
        reserved_units = zero_cost_resource_usage.reserved_units + EXCLUDED.reserved_units,
        updated_at = NOW()
      WHERE zero_cost_resource_usage.reserved_units + zero_cost_resource_usage.consumed_units + EXCLUDED.reserved_units <= $5
      RETURNING reserved_units, consumed_units
    `, [dayUtc, scopeHash, input.resourceType, units, limit.dailyUnits]);
    if (!usage.rows[0]) throw new ZeroResourceGuardError(`ZERO-${input.resourceType}-Tageslimit ausgeschöpft.`, 'RESOURCE_DAILY_LIMIT');

    const active = await client.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM zero_cost_active_leases
      WHERE resource_type = $1 AND status IN ('ACTIVE','UNKNOWN') AND expires_at > $2
    `, [input.resourceType, now]);
    if (Number(active.rows[0]?.count ?? 0) >= limit.concurrency) {
      throw new ZeroResourceGuardError(`ZERO-${input.resourceType}-Parallelitätslimit erreicht.`, 'CONCURRENCY_LIMIT');
    }

    await client.query(`
      INSERT INTO zero_cost_operations
        (operation_id, principal_hash, idempotency_hash, payload_hash, request_fingerprint, provider, model_id, resource_type, day_utc, status, reserved_units)
      VALUES ($1::uuid, $2, $3, $4, $4, $5, $6, $7, $8::date, 'RESERVED', $9)
    `, [operationId, principalHash, idempotencyHash, payloadHash, input.provider, input.modelId, input.resourceType, dayUtc, units]);
    await client.query(`
      INSERT INTO zero_cost_resource_rate_events (operation_id, principal_hash, resource_type, created_at)
      VALUES ($1::uuid, $2, $3, $4::timestamptz)
    `, [operationId, principalHash, input.resourceType, now]);
    await client.query(`
      INSERT INTO zero_cost_active_leases (operation_id, resource_type, lease_token_hash, expires_at, status)
      VALUES ($1::uuid, $2, $3, $4, 'ACTIVE')
    `, [operationId, input.resourceType, digest(leaseToken), new Date(now.getTime() + LEASE_TTL_SECONDS * 1000)]);
    await client.query(`
      INSERT INTO zero_cost_audit_events
        (day_utc, provider, model_id, studio, action, decision, requests_used, daily_limit, reason)
      VALUES ($1::date, $2, $3, $4, $5, 'RESERVED_FREE', $6, $7, 'Atomare ZERO-Ressourcen- und Tagesbudgetreservierung.')
    `, [dayUtc, input.provider, input.modelId, input.studio, input.action, budget.rows[0].requests_used, budget.rows[0].daily_limit]);
    await client.query('COMMIT');
    committed = true;
    return { operation: { operationId, status: 'RESERVED', dayUtc, resourceType: input.resourceType, reservedUnits: units, replayed: false }, leaseToken };
  } catch (error) {
    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch {
        destroyClient = true;
      }
    }
    if (error instanceof ZeroResourceGuardError) throw error;
    throw new ZeroResourceGuardError('Atomare ZERO-Ressourcenreservierung fehlgeschlagen; Provider-Aufruf blockiert.', 'PERSISTENCE_ERROR');
  } finally {
    client.release(destroyClient);
  }
}

export async function finishZeroCostResourceOperationWithPool(
  pool: Pool,
  operationId: string,
  leaseToken: string,
  outcome: Exclude<ZeroOperationStatus, 'RESERVED'>,
  now = new Date()
): Promise<void> {
  const client = await pool.connect();
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', ZERO_COST_ADVISORY_LOCK);
    const result = await client.query<{
      status: ZeroOperationStatus; day_utc: string; principal_hash: string; resource_type: ZeroResourceType; reserved_units: number;
    }>(`
      SELECT o.status, o.day_utc::text, o.principal_hash, o.resource_type, o.reserved_units
      FROM zero_cost_operations o
      JOIN zero_cost_active_leases l ON l.operation_id = o.operation_id
      WHERE o.operation_id = $1::uuid AND l.lease_token_hash = $2
      FOR UPDATE OF o, l
    `, [operationId, digest(leaseToken)]);
    const op = result.rows[0];
    if (!op) throw new ZeroResourceGuardError('ZERO-Lease fehlt oder Token ist ungültig.', 'LEASE_INVALID');
    if (op.status !== 'RESERVED') throw new ZeroResourceGuardError('ZERO-Vorgang wurde bereits abgeschlossen.', 'OPERATION_FINAL');
    if (outcome === 'SUCCEEDED') {
      await client.query(`
        UPDATE zero_cost_resource_usage
        SET reserved_units = GREATEST(0, reserved_units - $1),
            consumed_units = consumed_units + $1, updated_at = NOW()
        WHERE day_utc = $2::date AND scope_hash = $3 AND resource_type = $4
      `, [op.reserved_units, op.day_utc, digest('global'), op.resource_type]);
      await client.query("UPDATE zero_cost_active_leases SET status = 'RELEASED', expires_at = $2 WHERE operation_id = $1::uuid", [operationId, now]);
    } else if (outcome === 'FAILED') {
      await client.query(`
        UPDATE zero_cost_resource_usage
        SET reserved_units = GREATEST(0, reserved_units - $1), updated_at = NOW()
        WHERE day_utc = $2::date AND scope_hash = $3 AND resource_type = $4
      `, [op.reserved_units, op.day_utc, digest('global'), op.resource_type]);
      await client.query("UPDATE zero_cost_active_leases SET status = 'RELEASED', expires_at = $2 WHERE operation_id = $1::uuid", [operationId, now]);
    } else {
      await client.query("UPDATE zero_cost_active_leases SET status = 'UNKNOWN', expires_at = $2 WHERE operation_id = $1::uuid", [operationId, new Date(now.getTime() + UNKNOWN_LEASE_TTL_SECONDS * 1000)]);
      // UNKNOWN remains charged as reserved and is never retried/refunded automatically.
    }
    await client.query('UPDATE zero_cost_operations SET status = $2, updated_at = NOW() WHERE operation_id = $1::uuid', [operationId, outcome]);
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      destroyClient = true;
    }
    if (error instanceof ZeroResourceGuardError) throw error;
    throw new ZeroResourceGuardError('ZERO-Ergebnisstatus konnte nicht sicher gespeichert werden.', 'PERSISTENCE_ERROR');
  } finally {
    client.release(destroyClient);
  }
}

export async function withZeroCostResourceOperation<T>(
  input: ZeroResourceOperationInput,
  execute: () => Promise<T>,
  env: ZeroResourceEnvironment = input.env ?? process.env,
  pool: Pool | undefined = undefined,
  classifyResult: (result: T) => 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' = () => 'SUCCEEDED',
  classifyError: (error: unknown) => 'FAILED' | 'UNKNOWN' = () => 'UNKNOWN'
): Promise<T> {
  if (!env.DATABASE_URL) throw new ZeroResourceGuardError('PostgreSQL fehlt; Provider-Aufruf sicher blockiert.', 'PERSISTENCE_UNAVAILABLE');
  const databasePool = pool ?? getPostgresPool();
  const { operation, leaseToken } = await reserveZeroCostResourceOperationWithPool(databasePool, input, env);
  let result: T;
  try {
    result = await execute();
  } catch (error) {
    // Definitive provider rejections release the resource reservation; ambiguous
    // transport failures stay UNKNOWN and are never automatically retried.
    let outcome: 'FAILED' | 'UNKNOWN' = 'UNKNOWN';
    try { outcome = classifyError(error); } catch { outcome = 'UNKNOWN'; }
    try {
      await finishZeroCostResourceOperationWithPool(databasePool, operation.operationId, leaseToken, outcome);
    } catch {
      throw new ZeroResourceGuardError('ZERO-Ergebnis konnte nicht dauerhaft gespeichert werden; Reservierung bleibt sicher bestehen.', 'PERSISTENCE_ERROR');
    }
    if (outcome === 'FAILED') throw error;
    throw new ZeroResourceGuardError('Provider-Ausgang ist unklar; Status UNKNOWN, keine automatische Wiederholung.', 'OPERATION_UNKNOWN');
  }

  // Persist a response-classified UNKNOWN exactly once. The deliberate signal
  // below must not enter the provider-error handler and finish the lease twice.
  let outcome: ZeroOperationStatus;
  try { outcome = classifyResult(result); } catch { outcome = 'UNKNOWN'; }
  try {
    await finishZeroCostResourceOperationWithPool(databasePool, operation.operationId, leaseToken, outcome);
  } catch {
    throw new ZeroResourceGuardError('ZERO-Ergebnis konnte nicht dauerhaft gespeichert werden; Reservierung bleibt sicher bestehen.', 'PERSISTENCE_ERROR');
  }
  if (outcome === 'UNKNOWN') {
    throw new ZeroResourceGuardError('Provider-Ergebnis ist nicht eindeutig; Vorgang bleibt UNKNOWN und wird nicht wiederholt.', 'OPERATION_UNKNOWN');
  }
  return result;
}

export async function heartbeatZeroCostResourceLeaseWithPool(pool: Pool, operationId: string, leaseToken: string): Promise<void> {
  const result = await pool.query(`
    UPDATE zero_cost_active_leases
    SET expires_at = NOW() + INTERVAL '15 minutes'
    WHERE operation_id = $1::uuid AND lease_token_hash = $2 AND status = 'ACTIVE' AND expires_at > NOW()
  `, [operationId, digest(leaseToken)]);
  if (result.rowCount !== 1) throw new ZeroResourceGuardError('ZERO-Lease abgelaufen oder ungültig.', 'LEASE_INVALID');
}
