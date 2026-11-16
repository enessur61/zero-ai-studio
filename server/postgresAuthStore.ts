import type { Pool } from 'pg';

export interface LoginAttemptResult {
  allowed: boolean;
  attempts: number;
  retryAfterSeconds: number;
}

/**
 * Shared authentication state. All mutations are SQL-atomic so independent
 * Node processes observe the same sessions and per-address login budget.
 */
export function createPostgresAuthStore(database: Pool) {
  let schemaReady: Promise<void> | null = null;

  async function ensureSchema(): Promise<void> {
    if (!schemaReady) {
      schemaReady = (async () => {
        const client = await database.connect();
        try {
          await client.query('BEGIN');
          // Serialize first-use DDL when multiple production instances start together.
          await client.query('SELECT pg_advisory_xact_lock(1514480207, 50)');
          await client.query(`
            CREATE TABLE IF NOT EXISTS zero_auth_sessions (
              token_hash CHAR(64) PRIMARY KEY,
              expires_at TIMESTAMPTZ NOT NULL,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
          `);
          await client.query('CREATE INDEX IF NOT EXISTS zero_auth_sessions_expiry_idx ON zero_auth_sessions (expires_at)');
          await client.query(`
            CREATE TABLE IF NOT EXISTS zero_login_attempts (
              key_hash CHAR(64) PRIMARY KEY,
              attempts INTEGER NOT NULL CHECK (attempts >= 0),
              reset_at TIMESTAMPTZ NOT NULL
            )
          `);
          await client.query(`
            CREATE TABLE IF NOT EXISTS zero_gemini_quota_reservations (
              model_id TEXT PRIMARY KEY,
              reset_date DATE NOT NULL,
              requests_today INTEGER NOT NULL CHECK (requests_today >= 0),
              daily_limit INTEGER NOT NULL CHECK (daily_limit > 0),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
          `);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      })().catch((error) => {
        schemaReady = null;
        throw error;
      });
    }
    await schemaReady;
  }

  async function createSession(tokenHash: string, expiresAt: Date): Promise<void> {
    await ensureSchema();
    await database.query('DELETE FROM zero_auth_sessions WHERE expires_at <= NOW()');
    await database.query(
      `INSERT INTO zero_auth_sessions (token_hash, expires_at)
       VALUES ($1, $2)
       ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [tokenHash, expiresAt]
    );
  }

  async function hasSession(tokenHash: string, now = new Date()): Promise<boolean> {
    await ensureSchema();
    const result = await database.query<{ valid: boolean }>(
      'SELECT expires_at > $2::timestamptz AS valid FROM zero_auth_sessions WHERE token_hash = $1',
      [tokenHash, now]
    );
    if (result.rows[0]?.valid) return true;
    await database.query('DELETE FROM zero_auth_sessions WHERE token_hash = $1 AND expires_at <= $2::timestamptz', [tokenHash, now]);
    return false;
  }

  async function deleteSession(tokenHash: string): Promise<void> {
    await ensureSchema();
    await database.query('DELETE FROM zero_auth_sessions WHERE token_hash = $1', [tokenHash]);
  }

  async function consumeLoginAttempt(
    keyHash: string,
    now: Date,
    windowMs: number,
    maxAttempts: number
  ): Promise<LoginAttemptResult> {
    if (!Number.isSafeInteger(windowMs) || windowMs < 1 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error('Invalid login rate-limit configuration.');
    }
    await ensureSchema();
    await database.query('DELETE FROM zero_login_attempts WHERE reset_at <= $1::timestamptz', [now]);
    const resetAt = new Date(now.getTime() + windowMs);
    const result = await database.query<{ attempts: number; reset_at: Date }>(
      `INSERT INTO zero_login_attempts (key_hash, attempts, reset_at)
       VALUES ($1, 1, $3)
       ON CONFLICT (key_hash) DO UPDATE SET
         attempts = CASE WHEN zero_login_attempts.reset_at <= $2::timestamptz
                         THEN 1 ELSE zero_login_attempts.attempts + 1 END,
         reset_at = CASE WHEN zero_login_attempts.reset_at <= $2::timestamptz
                          THEN $3::timestamptz ELSE zero_login_attempts.reset_at END
       RETURNING attempts, reset_at`,
      [keyHash, now, resetAt]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Login rate-limit reservation returned no row.');
    return {
      allowed: row.attempts <= maxAttempts,
      attempts: row.attempts,
      retryAfterSeconds: Math.max(1, Math.ceil((new Date(row.reset_at).getTime() - now.getTime()) / 1000)),
    };
  }

  async function clearLoginAttempts(keyHash: string): Promise<void> {
    await ensureSchema();
    await database.query('DELETE FROM zero_login_attempts WHERE key_hash = $1', [keyHash]);
  }

  async function reserveGeminiQuota(params: {
    modelId: string;
    resetDate: string;
    currentRequests: number;
    dailyLimit: number;
  }): Promise<{ allowed: boolean; requestsToday: number }> {
    const { modelId, resetDate, currentRequests, dailyLimit } = params;
    if (!modelId || !/^\d{4}-\d{2}-\d{2}$/.test(resetDate) ||
        !Number.isSafeInteger(currentRequests) || currentRequests < 0 ||
        !Number.isSafeInteger(dailyLimit) || dailyLimit < 1) {
      throw new Error('Invalid Gemini quota reservation metadata.');
    }
    await ensureSchema();
    const result = await database.query<{ requests_today: number }>(
      `INSERT INTO zero_gemini_quota_reservations (model_id, reset_date, requests_today, daily_limit)
       VALUES ($1, $2::date, $3 + 1, $4)
       ON CONFLICT (model_id) DO UPDATE SET
         reset_date = EXCLUDED.reset_date,
         requests_today = CASE
           WHEN zero_gemini_quota_reservations.reset_date = EXCLUDED.reset_date
             THEN GREATEST(zero_gemini_quota_reservations.requests_today, EXCLUDED.requests_today - 1) + 1
           ELSE EXCLUDED.requests_today
         END,
         daily_limit = CASE
           WHEN zero_gemini_quota_reservations.reset_date = EXCLUDED.reset_date
             THEN LEAST(zero_gemini_quota_reservations.daily_limit, EXCLUDED.daily_limit)
           ELSE EXCLUDED.daily_limit
         END
       WHERE CASE
         WHEN zero_gemini_quota_reservations.reset_date = EXCLUDED.reset_date
           THEN GREATEST(zero_gemini_quota_reservations.requests_today, EXCLUDED.requests_today - 1)
                < LEAST(zero_gemini_quota_reservations.daily_limit, EXCLUDED.daily_limit)
         ELSE EXCLUDED.requests_today - 1 < EXCLUDED.daily_limit
       END
       RETURNING requests_today`,
      [modelId, resetDate, currentRequests, dailyLimit]
    );
    if (result.rows[0]) return { allowed: true, requestsToday: result.rows[0].requests_today };
    const current = await database.query<{ requests_today: number }>(
      'SELECT requests_today FROM zero_gemini_quota_reservations WHERE model_id = $1',
      [modelId]
    );
    return { allowed: false, requestsToday: current.rows[0]?.requests_today ?? currentRequests };
  }

  async function markGeminiQuotaExhausted(modelId: string, resetDate: string): Promise<void> {
    await ensureSchema();
    await database.query(
      `UPDATE zero_gemini_quota_reservations
       SET requests_today = daily_limit, updated_at = NOW()
       WHERE model_id = $1 AND reset_date = $2::date`,
      [modelId, resetDate]
    );
  }

  async function clearGeminiQuota(modelId: string): Promise<void> {
    await ensureSchema();
    await database.query('DELETE FROM zero_gemini_quota_reservations WHERE model_id = $1', [modelId]);
  }

  return {
    ensureSchema, createSession, hasSession, deleteSession,
    consumeLoginAttempt, clearLoginAttempts, reserveGeminiQuota,
    markGeminiQuotaExhausted, clearGeminiQuota,
  };
}
