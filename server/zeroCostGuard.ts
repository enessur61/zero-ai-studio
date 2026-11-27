import type { Pool, PoolClient } from 'pg';
import { getPostgresPool } from './persistence.ts';

export type ZeroCostProvider = 'cloudflare-workers-ai' | 'google-gemini-free';
export const ZERO_COST_ADVISORY_LOCK: [number, number] = [1514480207, 71];

const ALLOWED_CLOUDFLARE_MODELS = new Set([
  '@cf/zai-org/glm-4.7-flash',
  '@cf/black-forest-labs/flux-1-schnell',
  '@cf/openai/whisper-large-v3-turbo',
  '@cf/moondream/moondream3.1-9B-A2B',
]);
const ALLOWED_GEMINI_FREE_MODELS = new Set([
  'gemini-3.8-flash', 'gemini-2.5-flash-lite', 'gemini-3.6-flash',
  'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash-lite-tts',
  'gemini-3.8-flash-tts', 'gemini-3.5-transcribe', 'gemini-embedding-2', 'gemini-web-grounding',
]);

export interface ZeroCostGuardEnvironment {
  ZERO_COST_GUARD_ENABLED?: string;
  ZERO_COST_GUARD_FREE_ONLY_CONFIRMED?: string;
  ZERO_COST_GUARD_DAILY_REQUEST_LIMIT?: string;
  ZERO_CLOUDFLARE_AI_ENABLED?: string;
  ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED?: string;
  ZERO_GEMINI_FREE_TIER_ONLY?: string;
  ZERO_COST_RESOURCE_GUARD_ENABLED?: string;
  ZERO_COST_RESOURCE_GUARD_FREE_ONLY_CONFIRMED?: string;
  DATABASE_URL?: string;
  NODE_ENV?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  GEMINI_API_KEY?: string;
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

/** Strict browser Origin validation for state-changing same-origin endpoints. */
export function isSameOriginRequest(
  origin: string | undefined,
  host: string | undefined,
  protocol: string
): boolean {
  if (!origin || !host || (protocol !== 'http' && protocol !== 'https')) return false;
  try {
    const parsedOrigin = new URL(origin);
    const expectedOrigin = new URL(`${protocol}://${host}`);
    return parsedOrigin.origin === origin &&
      parsedOrigin.protocol === protocol + ':' &&
      parsedOrigin.username === '' && parsedOrigin.password === '' &&
      parsedOrigin.pathname === '/' && parsedOrigin.search === '' && parsedOrigin.hash === '' &&
      parsedOrigin.origin === expectedOrigin.origin;
  } catch {
    return false;
  }
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
    if (!ALLOWED_CLOUDFLARE_MODELS.has(reservation.modelId)) {
      throw new ZeroCostGuardError('Cloudflare-Modell ist nicht in der kostenlosen ZERO-Freigabeliste.', 'MODEL_NOT_ALLOWLISTED');
    }
    if (env.ZERO_CLOUDFLARE_AI_ENABLED !== 'true' || env.ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED !== 'true') {
      throw new ZeroCostGuardError('Cloudflare ist ohne beide expliziten Free-Plan-Freigaben gesperrt.', 'PROVIDER_DISABLED');
    }
    return limit;
  }
  if (reservation.provider === 'google-gemini-free') {
    if (!ALLOWED_GEMINI_FREE_MODELS.has(reservation.modelId)) {
      throw new ZeroCostGuardError('Gemini-Modell ist nicht in der kostenlosen ZERO-Freigabeliste.', 'MODEL_NOT_ALLOWLISTED');
    }
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
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    throw new ZeroCostGuardError('PostgreSQL-Verbindung fehlgeschlagen. Provider-Aufruf sicher blockiert.', 'PERSISTENCE_ERROR');
  }
  const dayUtc = utcDay();
  let committed = false;
  let transactionOpen = true;
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', ZERO_COST_ADVISORY_LOCK);
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
    await client.query("DELETE FROM zero_cost_audit_events WHERE created_at < NOW() - INTERVAL '90 days'");
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
      transactionOpen = false;
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
    transactionOpen = false;
    return { allowed: true, dayUtc, requestsUsed: row.requests_used, dailyLimit: row.daily_limit };
  } catch (error) {
    if (!committed && transactionOpen) {
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch {
        destroyClient = true;
      }
    }
    if (error instanceof ZeroCostGuardError) throw error;
    throw new ZeroCostGuardError('Persistente Kostenreservierung fehlgeschlagen. Provider-Aufruf sicher blockiert.', 'PERSISTENCE_ERROR');
  } finally {
    client.release(destroyClient);
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


export interface ZeroCostGuardStatus {
  dayUtc: string;
  requestsUsed: number;
  dailyLimit: number;
  remainingRequests: number;
  paused: boolean;
  configured: boolean;
  providers: {
    cloudflare: 'FREIGEGEBEN' | 'GESPERRT';
    gemini: 'FREIGEGEBEN' | 'GESPERRT';
  };
  recentEvents: Array<{
    createdAt: string;
    provider: string;
    modelId: string;
    studio: string;
    action: string;
    decision: string;
    reason: string;
    requestsUsed: number | null;
    dailyLimit: number | null;
  }>;
}

export async function getZeroCostGuardStatus(
  pool: Pool,
  env: ZeroCostGuardEnvironment = process.env
): Promise<ZeroCostGuardStatus> {
  const today = utcDay();
  let costGuardConfigured = false;
  try {
    validateZeroCostGuardConfig(env);
    costGuardConfigured = true;
  } catch {
    costGuardConfigured = false;
  }
  // The effective provider gate also requires Phase 2.1's resource guard.
  const resourceGuardConfigured = env.ZERO_COST_RESOURCE_GUARD_ENABLED === 'true' &&
    env.ZERO_COST_RESOURCE_GUARD_FREE_ONLY_CONFIRMED === 'true';
  const configured = costGuardConfigured && resourceGuardConfigured;
  const client = await pool.connect();
  try {
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
    const budget = await client.query<{
      day_utc: string; requests_used: number; daily_limit: number; locked: boolean;
    }>("SELECT day_utc::text, requests_used, daily_limit, locked FROM zero_cost_daily_budget WHERE scope = 'global'");
    const row = budget.rows[0];
    const currentDay = row?.day_utc === today;
    const requestsUsed = currentDay ? Number(row?.requests_used ?? 0) : 0;
    const configuredLimit = costGuardConfigured ? Number(env.ZERO_COST_GUARD_DAILY_REQUEST_LIMIT) : 0;
    const dailyLimit = configuredLimit > 0 && currentDay && row
      ? Math.min(configuredLimit, Number(row.daily_limit))
      : configuredLimit;
    const remainingRequests = Math.max(0, dailyLimit - requestsUsed);
    const events = await client.query<{
      created_at: Date; provider: string; model_id: string; studio: string; action: string;
      decision: string; reason: string; requests_used: number | null; daily_limit: number | null;
    }>(`
      SELECT created_at, provider, model_id, studio, action, decision, reason, requests_used, daily_limit
      FROM zero_cost_audit_events ORDER BY id DESC LIMIT 20
    `);
    return {
      dayUtc: today,
      requestsUsed,
      dailyLimit,
      remainingRequests,
      paused: row?.locked ?? false,
      configured,
      providers: {
        cloudflare: configured && remainingRequests > 0 && !row?.locked && env.ZERO_CLOUDFLARE_AI_ENABLED === 'true' &&
          env.ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED === 'true' && Boolean(env.CLOUDFLARE_ACCOUNT_ID?.trim() && env.CLOUDFLARE_API_TOKEN?.trim()) ? 'FREIGEGEBEN' : 'GESPERRT',
        gemini: configured && remainingRequests > 0 && !row?.locked && env.ZERO_GEMINI_FREE_TIER_ONLY === 'true' && Boolean(env.GEMINI_API_KEY?.trim()) ? 'FREIGEGEBEN' : 'GESPERRT',
      },
      recentEvents: events.rows.map((event) => ({
        createdAt: new Date(event.created_at).toISOString(),
        provider: event.provider,
        modelId: event.model_id,
        studio: event.studio,
        action: event.action,
        decision: event.decision,
        reason: event.reason,
        requestsUsed: event.requests_used,
        dailyLimit: event.daily_limit,
      })),
    };
  } finally {
    client.release();
  }
}

export async function setZeroCostGuardPaused(
  pool: Pool,
  paused: boolean,
  configuredDailyLimit: number
): Promise<void> {
  if (!Number.isSafeInteger(configuredDailyLimit) || configuredDailyLimit < 1 || configuredDailyLimit > 100_000) {
    throw new ZeroCostGuardError('Ungültiges Tagesbudget. Pause/Resume wurde nicht gespeichert.', 'INVALID_BUDGET');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', ZERO_COST_ADVISORY_LOCK);
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
      INSERT INTO zero_cost_daily_budget (scope, day_utc, requests_used, daily_limit, locked)
      VALUES ('global', $1::date, 0, $2, $3)
      ON CONFLICT (scope) DO UPDATE SET
        locked = EXCLUDED.locked,
        daily_limit = CASE
          WHEN zero_cost_daily_budget.day_utc = EXCLUDED.day_utc
            THEN LEAST(zero_cost_daily_budget.daily_limit, EXCLUDED.daily_limit)
          ELSE EXCLUDED.daily_limit
        END,
        updated_at = NOW()
    `, [utcDay(), configuredDailyLimit, paused]);
    await client.query(`
      INSERT INTO zero_cost_audit_events
        (day_utc, provider, model_id, studio, action, decision, requests_used, daily_limit, reason)
      SELECT $1::date, 'zero-cost-guard', 'manual-control', 'ZERO ADMIN', $2, $3,
        requests_used, daily_limit, $4
      FROM zero_cost_daily_budget WHERE scope = 'global'
    `, [utcDay(), paused ? 'MANUAL_PAUSE' : 'MANUAL_RESUME',
      paused ? 'PAUSED' : 'RESUMED',
      paused ? 'Manuelle Pause durch Administrator aktiviert.' : 'Manuelle Pause durch Administrator aufgehoben.']);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof ZeroCostGuardError) throw error;
    throw new ZeroCostGuardError('Manuelle Kostenwächter-Sperre konnte nicht dauerhaft gespeichert werden.', 'PERSISTENCE_ERROR');
  } finally {
    client.release();
  }
}
