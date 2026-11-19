import type { Pool } from 'pg';
import { getPostgresPool } from './persistence.ts';

export type ZeroCostProvider = 'cloudflare-workers-ai' | 'google-gemini-free';

export interface ZeroCostGuardEnvironment {
  ZERO_COST_GUARD_ENABLED?: string;
  ZERO_COST_GUARD_FREE_ONLY_CONFIRMED?: string;
  ZERO_COST_GUARD_DAILY_REQUEST_LIMIT?: string;
  ZERO_CLOUDFLARE_AI_ENABLED?: string;
  ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED?: string;
  DATABASE_URL?: string;
  NODE_ENV?: string;
}

export interface ZeroCostReservation {
  provider: ZeroCostProvider;
  modelId: string;
  studio: string;
  action: string;
}

export interface ZeroCostReservationResult {
  allowed: true;
  dayUtc: string;
  requestsUsed: number;
  dailyLimit: number;
}

export class ZeroCostGuardError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'ZeroCostGuardError';
  }
}

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function validateZeroCostGuardConfig(env: ZeroCostGuardEnvironment): number {
  if (env.ZERO_COST_GUARD_ENABLED !== 'true' || env.ZERO_COST_GUARD_FREE_ONLY_CONFIRMED !== 'true') {
    throw new ZeroCostGuardError('ZERO COST GUARD ist standardmäßig gesperrt. Beide zentralen Freigaben müssen ausdrücklich gesetzt sein.', 'GUARD_DISABLED');
  }
  const limit = Number(env.ZERO_COST_GUARD_DAILY_REQUEST_LIMIT);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) {
    throw new ZeroCostGuardError('Das gemeinsame ZERO-Tagesbudget fehlt oder ist ungültig. Provider-Aufruf sicher blockiert.', 'INVALID_BUDGET');
  }
  return limit;
}

export function assertZeroCostProviderAllowed(
  reservation: ZeroCostReservation,
  env: ZeroCostGuardEnvironment
): number {
  if (!reservation.modelId.trim() || !reservation.studio.trim() || !reservation.action.trim()) {
    throw new ZeroCostGuardError('Unvollständige Provider-Metadaten. Provider-Aufruf sicher blockiert.', 'INVALID_METADATA');
  }
  const limit = validateZeroCostGuardConfig(env);
  if (reservation.provider === 'cloudflare-workers-ai') {
    if (env.ZERO_CLOUDFLARE_AI_ENABLED !== 'true' || env.ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED !== 'true') {
      throw new ZeroCostGuardError('Cloudflare ist ohne beide expliziten Free-Plan-Freigaben gesperrt.', 'PROVIDER_DISABLED');
    }
    return limit;
  }
  if (reservation.provider === 'google-gemini-free') {
    if (env.ZERO_GEMINI_FREE_TIER_ONLY !== 'true') {
      throw new ZeroCostGuardError('Gemini ist nicht ausdrücklich auf Free-Tier-only begrenzt.', 'PROVIDER_DISABLED');
    }
    return limit;
  }
  throw new ZeroCostGuardError('Unbekannter oder kostenpflichtiger Provider ist nicht freigegeben.', 'PROVIDER_NOT_ALLOWLISTED');
}

/**
 * Persistent, shared request budget. PostgreSQL's single-row UPSERT serializes
 * reservations across all ZERO instances and studios. No local production
 * fallback exists: missing DB/configuration and SQL errors fail closed.
 */
export async function reserveZeroCostProviderRequestWithPool(
  pool: Pool,
  reservation: ZeroCostReservation,
  env: ZeroCostGuardEnvironment
): Promise<ZeroCostReservationResult> {
  const dailyLimit = assertZeroCostProviderAllowed(reservation, env);
  if (!env.DATABASE_URL) {
    throw new ZeroCostGuardError('Persistente PostgreSQL-Kostenkontrolle nicht verfügbar. Provider-Aufruf sicher blockiert.', 'PERSISTENCE_UNAVAILABLE');
  }
  const client = await pool.connect();
  const dayUtc = utcDay();
  let committed = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(1514480207, 71)');
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
    const result = await client.query<{ requests_used: number; daily_limit: number }>(`
      INSERT INTO zero_cost_daily_budget (scope, day_utc, requests_used, daily_limit)
      VALUES ('global', $1::date, 1, $2)
      ON CONFLICT (scope) DO UPDATE SET
        day_utc = EXCLUDED.day_utc,
        requests_used = CASE
          WHEN zero_cost_daily_budget.day_utc = EXCLUDED.day_utc
            THEN zero_cost_daily_budget.requests_used + 1
          ELSE 1
        END,
        daily_limit = CASE
          WHEN zero_cost_daily_budget.day_utc = EXCLUDED.day_utc
            THEN LEAST(zero_cost_daily_budget.daily_limit, EXCLUDED.daily_limit)
          ELSE EXCLUDED.daily_limit
        END,
        updated_at = NOW()
      WHERE zero_cost_daily_budget.locked = FALSE
        AND CASE
          WHEN zero_cost_daily_budget.day_utc = EXCLUDED.day_utc
            THEN zero_cost_daily_budget.requests_used < LEAST(zero_cost_daily_budget.daily_limit, EXCLUDED.daily_limit)
          ELSE EXCLUDED.daily_limit > 0
        END
      RETURNING requests_used, daily_limit
    `, [dayUtc, dailyLimit]);

    if (!result.rows[0]) {
      const current = await client.query<{ day_utc: string; requests_used: number; daily_limit: number; locked: boolean }>(
        "SELECT day_utc::text, requests_used, daily_limit, locked FROM zero_cost_daily_budget WHERE scope = 'global' FOR UPDATE"
      );
      const row = current.rows[0];
      const reason = !row ? 'Budgetzustand fehlt.' : row.locked ? 'Budget wurde manuell gesperrt.' : 'Gemeinsames ZERO-Tagesbudget ausgeschöpft.';
      await client.query(`
        INSERT INTO zero_cost_audit_events
          (day_utc, provider, model_id, studio, action, decision, requests_used, daily_limit, reason)
        VALUES ($1::date, $2, $3, $4, $5, 'BLOCKED', $6, $7, $8)
      `, [dayUtc, reservation.provider, reservation.modelId, reservation.studio, reservation.action,
        row?.requests_used ?? null, row?.daily_limit ?? dailyLimit, reason]);
      await client.query('COMMIT');
      committed = true;
      throw new ZeroCostGuardError(reason + ' Kein kostenpflichtiger Fallback.', 'BUDGET_EXHAUSTED');
    }

    const row = result.rows[0];
    await client.query(`
      INSERT INTO zero_cost_audit_events
        (day_utc, provider, model_id, studio, action, decision, requests_used, daily_limit, reason)
      VALUES ($1::date, $2, $3, $4, $5, 'RESERVED_FREE', $6, $7, 'Atomare kostenlose Anfrage reserviert.')
    `, [dayUtc, reservation.provider, reservation.modelId, reservation.studio, reservation.action,
      row.requests_used, row.daily_limit]);
    await client.query('COMMIT');
    committed = true;
    return { allowed: true, dayUtc, requestsUsed: row.requests_used, dailyLimit: row.daily_limit };
  } catch (error) {
    if (!committed) await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof ZeroCostGuardError) throw error;
    throw new ZeroCostGuardError('Persistente Kostenreservierung fehlgeschlagen. Provider-Aufruf sicher blockiert.', 'PERSISTENCE_ERROR');
  } finally {
    client.release();
  }
}

export async function reserveZeroCostProviderRequest(
  reservation: ZeroCostReservation,
  env: ZeroCostGuardEnvironment = process.env
): Promise<ZeroCostReservationResult> {
  if (!env.DATABASE_URL) {
    throw new ZeroCostGuardError('Persistente PostgreSQL-Kostenkontrolle nicht verfügbar. Provider-Aufruf sicher blockiert.', 'PERSISTENCE_UNAVAILABLE');
  }
  return reserveZeroCostProviderRequestWithPool(getPostgresPool(), reservation, env);
}
