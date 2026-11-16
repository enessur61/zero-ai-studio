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
        await database.query(`
          CREATE TABLE IF NOT EXISTS zero_auth_sessions (
            token_hash CHAR(64) PRIMARY KEY,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await database.query('CREATE INDEX IF NOT EXISTS zero_auth_sessions_expiry_idx ON zero_auth_sessions (expires_at)');
        await database.query(`
          CREATE TABLE IF NOT EXISTS zero_login_attempts (
            key_hash CHAR(64) PRIMARY KEY,
            attempts INTEGER NOT NULL CHECK (attempts >= 0),
            reset_at TIMESTAMPTZ NOT NULL
          )
        `);
      })().catch((error) => {
        schemaReady = null;
        throw error;
      });
    }
    await schemaReady;
  }

  async function createSession(tokenHash: string, expiresAt: Date): Promise<void> {
    await ensureSchema();
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

  return { ensureSchema, createSession, hasSession, deleteSession, consumeLoginAttempt, clearLoginAttempts };
}
