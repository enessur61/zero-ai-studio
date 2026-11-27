import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import type { Pool } from 'pg';

const scrypt = promisify(scryptCallback);
const ADMIN_ID = 'admin:primary';
const PASSWORD_BYTES = 64;
const PASSWORD_SALT_BYTES = 16;

export type ZeroAccountRole = 'admin' | 'user';
export interface ZeroUserPrincipal {
  id: string;
  role: ZeroAccountRole;
}
export interface ZeroUserAccount extends ZeroUserPrincipal {
  email: string | null;
  createdAt: Date;
}
export interface ZeroUserSession extends ZeroUserPrincipal {
  expiresAt: Date;
}
export interface VersionedUserState<T> {
  payload: T;
  revision: number;
}
export class UserStateConflictError extends Error {
  constructor(readonly expectedRevision: number, readonly actualRevision: number | null) {
    super('Der benutzergebundene ZERO-Datenstand wurde parallel geändert. Bitte erneut laden.');
    this.name = 'UserStateConflictError';
  }
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().normalize('NFKC').toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('Ungültige E-Mail-Adresse.');
  }
  return normalized;
}

async function hashPassword(password: string): Promise<{ salt: Buffer; hash: Buffer }> {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) {
    throw new Error('Das Passwort muss zwischen 12 und 1024 Zeichen lang sein.');
  }
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const hash = Buffer.from(await scrypt(password, salt, PASSWORD_BYTES));
  return { salt, hash };
}

async function verifyPassword(password: string, salt: Buffer, expectedHash: Buffer): Promise<boolean> {
  if (!Buffer.isBuffer(salt) || salt.length !== PASSWORD_SALT_BYTES ||
      !Buffer.isBuffer(expectedHash) || expectedHash.length !== PASSWORD_BYTES ||
      typeof password !== 'string' || password.length > 1024) return false;
  const actual = Buffer.from(await scrypt(password, salt, PASSWORD_BYTES));
  return timingSafeEqual(actual, expectedHash);
}

/**
 * Additive multi-user foundation. It never rewrites zero_app_state or the
 * legacy admin session table: it snapshots them into admin:primary exactly
 * once, while all new sessions and state are keyed by immutable user IDs.
 */
export function createMultiUserAuthStore(database: Pool) {
  let schemaReady: Promise<void> | null = null;

  async function ensureSchema(): Promise<void> {
    if (!schemaReady) {
      schemaReady = (async () => {
        const client = await database.connect();
        let transactionOpen = false;
        let destroyClient = false;
        try {
          await client.query('BEGIN');
          transactionOpen = true;
          await client.query('SELECT pg_advisory_xact_lock(1514480207, 91)');
          await client.query(`
            CREATE TABLE IF NOT EXISTS zero_users (
              user_id TEXT PRIMARY KEY,
              email_normalized TEXT UNIQUE,
              password_salt BYTEA,
              password_hash BYTEA,
              role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              CHECK ((password_salt IS NULL) = (password_hash IS NULL))
            )
          `);
          await client.query(`
            INSERT INTO zero_users (user_id, email_normalized, password_salt, password_hash, role)
            VALUES ('admin:primary', NULL, NULL, NULL, 'admin')
            ON CONFLICT (user_id) DO NOTHING
          `);
          await client.query(`
            CREATE TABLE IF NOT EXISTS zero_user_sessions (
              token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
              user_id TEXT NOT NULL REFERENCES zero_users(user_id) ON DELETE CASCADE,
              expires_at TIMESTAMPTZ NOT NULL,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
          `);
          await client.query('CREATE INDEX IF NOT EXISTS zero_user_sessions_user_expiry_idx ON zero_user_sessions (user_id, expires_at)');
          await client.query(`
            CREATE TABLE IF NOT EXISTS zero_user_app_state (
              user_id TEXT PRIMARY KEY REFERENCES zero_users(user_id) ON DELETE CASCADE,
              payload JSONB NOT NULL,
              revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
          `);
          // The legacy tables are optional during isolated setup. When present,
          // copy only valid admin records and leave every source row untouched.
          await client.query(`
            DO $zero$
            BEGIN
              IF to_regclass('zero_auth_sessions') IS NOT NULL THEN
                INSERT INTO zero_user_sessions (token_hash, user_id, expires_at, created_at)
                SELECT btrim(token_hash::text), 'admin:primary', expires_at, created_at
                FROM zero_auth_sessions
                WHERE expires_at > NOW()
                ON CONFLICT (token_hash) DO NOTHING;
              END IF;
              IF to_regclass('zero_app_state') IS NOT NULL THEN
                INSERT INTO zero_user_app_state (user_id, payload, revision, updated_at)
                SELECT 'admin:primary', payload, GREATEST(revision, 1), updated_at
                FROM zero_app_state
                WHERE id = 'primary'
                ON CONFLICT (user_id) DO NOTHING;
              END IF;
            END;
            $zero$;
          `);
          await client.query('COMMIT');
          transactionOpen = false;
        } catch (error) {
          if (transactionOpen) {
            try { await client.query('ROLLBACK'); }
            catch { destroyClient = true; }
          }
          throw error;
        } finally {
          client.release(destroyClient);
        }
      })().catch((error) => {
        schemaReady = null;
        throw error;
      });
    }
    await schemaReady;
  }

  async function createUser(email: string, password: string): Promise<ZeroUserAccount> {
    await ensureSchema();
    const normalizedEmail = normalizeEmail(email);
    const credentials = await hashPassword(password);
    const userId = 'user:' + randomUUID();
    const result = await database.query<{
      user_id: string; email_normalized: string; role: ZeroAccountRole; created_at: Date;
    }>(
      `INSERT INTO zero_users (user_id, email_normalized, password_salt, password_hash, role)
       VALUES ($1, $2, $3, $4, 'user')
       RETURNING user_id, email_normalized, role, created_at`,
      [userId, normalizedEmail, credentials.salt, credentials.hash],
    );
    const row = result.rows[0];
    if (!row) throw new Error('ZERO-Benutzerkonto konnte nicht angelegt werden.');
    return { id: row.user_id, email: row.email_normalized, role: row.role, createdAt: row.created_at };
  }

  async function authenticateUser(email: string, password: string): Promise<ZeroUserPrincipal | null> {
    await ensureSchema();
    let normalizedEmail: string;
    try { normalizedEmail = normalizeEmail(email); }
    catch { return null; }
    const result = await database.query<{
      user_id: string; role: ZeroAccountRole; password_salt: Buffer | null; password_hash: Buffer | null;
    }>(
      'SELECT user_id, role, password_salt, password_hash FROM zero_users WHERE email_normalized = $1',
      [normalizedEmail],
    );
    const row = result.rows[0];
    if (!row?.password_salt || !row.password_hash ||
        !(await verifyPassword(password, row.password_salt, row.password_hash))) return null;
    return { id: row.user_id, role: row.role };
  }

  async function createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void> {
    await ensureSchema();
    if (!/^[a-f0-9]{64}$/.test(tokenHash) || !Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) {
      throw new Error('Ungültige ZERO-Benutzersitzung.');
    }
    const result = await database.query(
      `INSERT INTO zero_user_sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, $3) ON CONFLICT (token_hash) DO NOTHING RETURNING token_hash`,
      [tokenHash, userId, expiresAt],
    );
    if (!result.rows[0]) throw new Error('ZERO-Sitzungstoken ist bereits registriert.');
  }

  async function getSession(tokenHash: string, now = new Date()): Promise<ZeroUserSession | null> {
    await ensureSchema();
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) return null;
    const result = await database.query<{
      user_id: string; role: ZeroAccountRole; expires_at: Date;
    }>(
      `SELECT s.user_id, u.role, s.expires_at
       FROM zero_user_sessions s JOIN zero_users u ON u.user_id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.role IN ('admin', 'user')`,
      [tokenHash, now],
    );
    const row = result.rows[0];
    return row ? { id: row.user_id, role: row.role, expiresAt: row.expires_at } : null;
  }

  async function deleteSession(tokenHash: string): Promise<void> {
    await ensureSchema();
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) return;
    await database.query('DELETE FROM zero_user_sessions WHERE token_hash = $1', [tokenHash]);
  }

  async function readState<T>(userId: string): Promise<VersionedUserState<T> | null> {
    await ensureSchema();
    const result = await database.query<{ payload: T; revision: string }>(
      'SELECT payload, revision FROM zero_user_app_state WHERE user_id = $1',
      [userId],
    );
    const row = result.rows[0];
    return row ? { payload: row.payload, revision: Number(row.revision) } : null;
  }

  async function writeState<T>(userId: string, payload: T, expectedRevision: number): Promise<number> {
    await ensureSchema();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('Ungültige ZERO-Benutzerrevision.');
    }
    const client = await database.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['zero-user-state:' + userId]);
      const current = await client.query<{ revision: string }>(
        'SELECT revision FROM zero_user_app_state WHERE user_id = $1 FOR UPDATE',
        [userId],
      );
      const revision = current.rows[0] ? Number(current.rows[0].revision) : null;
      if (revision !== null && revision !== expectedRevision) {
        throw new UserStateConflictError(expectedRevision, revision);
      }
      if (revision === null && expectedRevision !== 0) {
        throw new UserStateConflictError(expectedRevision, null);
      }
      const result = revision === null
        ? await client.query<{ revision: string }>(
          `INSERT INTO zero_user_app_state (user_id, payload, revision)
           VALUES ($1, $2::jsonb, 1) ON CONFLICT (user_id) DO NOTHING RETURNING revision`,
          [userId, JSON.stringify(payload)],
        )
        : await client.query<{ revision: string }>(
          `UPDATE zero_user_app_state SET payload = $2::jsonb, revision = revision + 1, updated_at = NOW()
           WHERE user_id = $1 AND revision = $3::bigint RETURNING revision`,
          [userId, JSON.stringify(payload), expectedRevision],
        );
      if (!result.rows[0]) {
        const latest = await client.query<{ revision: string }>(
          'SELECT revision FROM zero_user_app_state WHERE user_id = $1',
          [userId],
        );
        throw new UserStateConflictError(expectedRevision, latest.rows[0] ? Number(latest.rows[0].revision) : null);
      }
      await client.query('COMMIT');
      transactionOpen = false;
      return Number(result.rows[0].revision);
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return { ensureSchema, createUser, authenticateUser, createSession, getSession, deleteSession, readState, writeState };
}

export { ADMIN_ID as ZERO_LEGACY_ADMIN_USER_ID };
