import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export const ZERO_RESOURCE_ADVISORY_LOCK = [1514480207, 72] as const;

export type ZeroResourceId = 'wan-video' | 'piper-tts' | 'searxng';

export class ZeroResourceSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZeroResourceSchemaError';
  }
}

type ColumnShape = { table_name: string; column_name: string; data_type: string; is_nullable: 'YES' | 'NO' };

const REQUIRED_COLUMNS: Record<string, Record<string, { type: string; nullable: boolean }>> = {
  zero_resource_daily_usage: {
    principal_id: { type: 'text', nullable: false },
    resource_id: { type: 'text', nullable: false },
    day_utc: { type: 'date', nullable: false },
    jobs_started: { type: 'bigint', nullable: false },
    units_used: { type: 'bigint', nullable: false },
    updated_at: { type: 'timestamp with time zone', nullable: false },
  },
  zero_resource_reservations: {
    reservation_id: { type: 'text', nullable: false },
    idempotency_key: { type: 'text', nullable: false },
    request_fingerprint: { type: 'text', nullable: false },
    principal_id: { type: 'text', nullable: false },
    resource_id: { type: 'text', nullable: false },
    status: { type: 'text', nullable: false },
    units_reserved: { type: 'bigint', nullable: false },
    created_at: { type: 'timestamp with time zone', nullable: false },
    expires_at: { type: 'timestamp with time zone', nullable: false },
    completed_at: { type: 'timestamp with time zone', nullable: true },
  },
  zero_resource_rate_windows: {
    principal_id: { type: 'text', nullable: false },
    resource_id: { type: 'text', nullable: false },
    window_start: { type: 'timestamp with time zone', nullable: false },
    request_count: { type: 'integer', nullable: false },
    updated_at: { type: 'timestamp with time zone', nullable: false },
  },
};

const REQUIRED_CONSTRAINTS = [
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
] as const;

function normalizeConstraint(value: string): string {
  return value.replaceAll('"', '').replace(/[()\s]/g, '').toLowerCase();
}

/**
 * Validates the actual catalog shape, not merely whether CREATE TABLE IF NOT
 * EXISTS succeeded. This catches stale or manually-created incompatible tables.
 */
export function validateZeroResourceSchemaSnapshot(
  columns: ColumnShape[],
  constraints: Array<{ table_name: string; definition: string }>,
): void {
  const expectedCount = Object.values(REQUIRED_COLUMNS).reduce((sum, table) => sum + Object.keys(table).length, 0);
  if (columns.length !== expectedCount) {
    throw new ZeroResourceSchemaError('ZERO RESOURCE GUARD: PostgreSQL-Schema hat eine unerwartete Spaltenanzahl.');
  }

  for (const [tableName, expectedColumns] of Object.entries(REQUIRED_COLUMNS)) {
    const actual = columns.filter((column) => column.table_name === tableName);
    if (actual.length !== Object.keys(expectedColumns).length) {
      throw new ZeroResourceSchemaError(`ZERO RESOURCE GUARD: Ungültige Spaltenstruktur in ${tableName}.`);
    }
    for (const [columnName, expected] of Object.entries(expectedColumns)) {
      const column = actual.find((entry) => entry.column_name === columnName);
      if (!column || column.data_type !== expected.type || (column.is_nullable === 'YES') !== expected.nullable) {
        throw new ZeroResourceSchemaError(`ZERO RESOURCE GUARD: Inkompatible Spalte ${tableName}.${columnName}.`);
      }
    }
  }

  const normalized = constraints.map((entry) => ({
    table: entry.table_name,
    definition: normalizeConstraint(entry.definition),
  }));
  for (const [table, definition] of REQUIRED_CONSTRAINTS) {
    const wanted = normalizeConstraint(definition);
    if (!normalized.some((entry) => entry.table === table && entry.definition.includes(wanted))) {
      throw new ZeroResourceSchemaError(`ZERO RESOURCE GUARD: Fehlende oder inkompatible Constraint in ${table}: ${definition}`);
    }
  }
}

async function createSchema(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS zero_resource_daily_usage (
      principal_id TEXT NOT NULL CHECK (length(btrim(principal_id)) BETWEEN 1 AND 128),
      resource_id TEXT NOT NULL CHECK (length(btrim(resource_id)) BETWEEN 1 AND 64),
      day_utc DATE NOT NULL,
      jobs_started BIGINT NOT NULL DEFAULT 0 CHECK (jobs_started >= 0),
      units_used BIGINT NOT NULL DEFAULT 0 CHECK (units_used >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (principal_id, resource_id, day_utc)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS zero_resource_reservations (
      reservation_id TEXT PRIMARY KEY CHECK (length(btrim(reservation_id)) BETWEEN 1 AND 128),
      idempotency_key TEXT NOT NULL UNIQUE CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
      request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
      principal_id TEXT NOT NULL CHECK (length(btrim(principal_id)) BETWEEN 1 AND 128),
      resource_id TEXT NOT NULL CHECK (length(btrim(resource_id)) BETWEEN 1 AND 64),
      status TEXT NOT NULL CHECK (status IN ('reserved', 'completed', 'released')),
      units_reserved BIGINT NOT NULL CHECK (units_reserved >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS zero_resource_rate_windows (
      principal_id TEXT NOT NULL CHECK (length(btrim(principal_id)) BETWEEN 1 AND 128),
      resource_id TEXT NOT NULL CHECK (length(btrim(resource_id)) BETWEEN 1 AND 64),
      window_start TIMESTAMPTZ NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (principal_id, resource_id, window_start)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS zero_resource_reservations_expiry_idx
    ON zero_resource_reservations (status, expires_at)
  `);
}

export async function ensureZeroResourceSchemaWithPool(pool: Pool): Promise<void> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    throw new ZeroResourceSchemaError('ZERO RESOURCE GUARD: PostgreSQL-Verbindung nicht verfügbar; Ressource bleibt gesperrt.');
  }

  // Treat BEGIN as uncertain until a successful rollback/commit proves the connection state.
  let transactionStarted = true;
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [...ZERO_RESOURCE_ADVISORY_LOCK]);
    await createSchema(client);

    const columnResult = await client.query<ColumnShape>(`
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position
    `, [Object.keys(REQUIRED_COLUMNS)]);

    const constraintResult = await client.query<{ table_name: string; definition: string }>(`
      SELECT relation.relname AS table_name, pg_get_constraintdef(constraint_row.oid) AS definition
      FROM pg_constraint constraint_row
      JOIN pg_class relation ON relation.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = current_schema()
        AND relation.relname = ANY($1::text[])
        AND constraint_row.contype IN ('p', 'u', 'c')
    `, [Object.keys(REQUIRED_COLUMNS)]);

    validateZeroResourceSchemaSnapshot(columnResult.rows, constraintResult.rows);
    await client.query('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {
        destroyClient = true;
      }
    }
    if (error instanceof ZeroResourceSchemaError) throw error;
    throw new ZeroResourceSchemaError('ZERO RESOURCE GUARD: Schema-Initialisierung fehlgeschlagen; Ressourcen bleiben gesperrt.');
  } finally {
    client.release(destroyClient);
  }
}

export async function ensureZeroResourceSchema(): Promise<void> {
  const { getPostgresPool } = await import('./persistence.ts');
  const pool = getPostgresPool();
  if (!pool) throw new ZeroResourceSchemaError('ZERO RESOURCE GUARD: PostgreSQL ist nicht konfiguriert; Ressourcen bleiben gesperrt.');
  await ensureZeroResourceSchemaWithPool(pool);
}


export type ZeroResourcePolicy = {
  dailyJobs: number;
  dailyUnits: number;
  maxConcurrent: number;
  perMinute: number;
  reservationTtlSeconds: number;
  maxUnitsPerJob: number;
};

/**
 * Conservative server-owned ceilings. Units are one 5-second Wan shot or
 * Piper input characters. These are local safety caps, not provider quotas.
 */
export const ZERO_RESOURCE_POLICIES: Readonly<Record<'wan-video' | 'piper-tts', ZeroResourcePolicy>> = Object.freeze({
  'wan-video': Object.freeze({
    dailyJobs: 15, dailyUnits: 15, maxConcurrent: 1, perMinute: 2,
    reservationTtlSeconds: 2 * 60 * 60, maxUnitsPerJob: 1,
  }),
  'piper-tts': Object.freeze({
    dailyJobs: 40, dailyUnits: 50_000, maxConcurrent: 2, perMinute: 6,
    reservationTtlSeconds: 5 * 60, maxUnitsPerJob: 5_000,
  }),
});

export type ZeroResourceReservation = {
  reservationId: string;
  principalId: string;
  resourceId: 'wan-video' | 'piper-tts';
  units: number;
  status: 'reserved' | 'completed' | 'released';
  expiresAt: string;
  duplicate: boolean;
};

export class ZeroResourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZeroResourceLimitError';
  }
}

export class ZeroResourceIdempotencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZeroResourceIdempotencyError';
  }
}

function assertReservationInput(input: {
  principalId: string; resourceId: string; idempotencyKey: string; units: number; requestFingerprint?: string;
}): asserts input is {
  principalId: 'admin:primary'; resourceId: 'wan-video' | 'piper-tts'; idempotencyKey: string; units: number; requestFingerprint?: string;
} {
  if (input.principalId !== 'admin:primary') {
    throw new ZeroResourceSchemaError('ZERO RESOURCE GUARD: Nicht vertrauenswürdige oder unbekannte Identität; Ressource bleibt gesperrt.');
  }
  if (input.resourceId !== 'wan-video' && input.resourceId !== 'piper-tts') {
    throw new ZeroResourceSchemaError('ZERO RESOURCE GUARD: Nicht freigegebene Ressource.');
  }
  if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(input.idempotencyKey)) {
    throw new ZeroResourceSchemaError('ZERO RESOURCE GUARD: Ungültiger Idempotenzschlüssel.');
  }
  if (input.requestFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(input.requestFingerprint)) {
    throw new ZeroResourceSchemaError('ZERO RESOURCE GUARD: Ungültiger Anfrage-Fingerabdruck.');
  }
  const policy = ZERO_RESOURCE_POLICIES[input.resourceId];
  if (!Number.isSafeInteger(input.units) || input.units < 1 || input.units > policy.maxUnitsPerJob) {
    throw new ZeroResourceSchemaError('ZERO RESOURCE GUARD: Ungültige Ressourcenmenge.');
  }
}

export async function reserveZeroResourceWithPool(
  pool: Pool,
  input: { principalId: string; resourceId: string; idempotencyKey: string; units: number; requestFingerprint?: string },
): Promise<ZeroResourceReservation> {
  assertReservationInput(input);
  const policy = ZERO_RESOURCE_POLICIES[input.resourceId];
  const requestFingerprint = input.requestFingerprint ?? createHash('sha256').update(`${input.resourceId}:${input.units}`).digest('hex');
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    throw new ZeroResourceSchemaError('ZERO RESOURCE GUARD: PostgreSQL nicht verfügbar; Ressource bleibt gesperrt.');
  }
  // Treat BEGIN as uncertain until a successful rollback/commit proves the connection state.
  let transactionStarted = true;
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [...ZERO_RESOURCE_ADVISORY_LOCK]);
    await client.query(
      `UPDATE zero_resource_reservations
       SET status = 'released'
       WHERE resource_id = $1 AND status = 'reserved' AND expires_at <= NOW()`,
      [input.resourceId],
    );
    await client.query(`DELETE FROM zero_resource_rate_windows WHERE window_start < NOW() - INTERVAL '2 days'`);
    await client.query(`DELETE FROM zero_resource_daily_usage WHERE day_utc < (NOW() AT TIME ZONE 'UTC')::date - 90`);
    await client.query(`DELETE FROM zero_resource_reservations WHERE status <> 'reserved' AND expires_at < NOW() - INTERVAL '30 days'`);

    const existing = await client.query<{
      reservation_id: string; principal_id: string; resource_id: string;
      units_reserved: string; request_fingerprint: string; status: 'reserved' | 'completed' | 'released'; expires_at: Date;
    }>(
      `SELECT reservation_id, principal_id, resource_id, units_reserved::text, request_fingerprint, status, expires_at
       FROM zero_resource_reservations WHERE idempotency_key = $1 FOR UPDATE`,
      [input.idempotencyKey],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.principal_id !== input.principalId || row.resource_id !== input.resourceId ||
          Number(row.units_reserved) !== input.units || row.request_fingerprint !== requestFingerprint) {
        throw new ZeroResourceIdempotencyError('ZERO RESOURCE GUARD: Idempotenzschlüssel wurde bereits mit anderen Parametern verwendet.');
      }
      await client.query('COMMIT');
      transactionStarted = false;
      return {
        reservationId: row.reservation_id,
        principalId: row.principal_id,
        resourceId: row.resource_id as 'wan-video' | 'piper-tts',
        units: Number(row.units_reserved),
        status: row.status,
        expiresAt: new Date(row.expires_at).toISOString(),
        duplicate: true,
      };
    }

    await client.query(
      `INSERT INTO zero_resource_daily_usage (principal_id, resource_id, day_utc, jobs_started, units_used)
       VALUES ($1, $2, (NOW() AT TIME ZONE 'UTC')::date, 0, 0)
       ON CONFLICT (principal_id, resource_id, day_utc) DO NOTHING`,
      [input.principalId, input.resourceId],
    );
    const usage = await client.query<{ jobs_started: string; units_used: string }>(
      `SELECT jobs_started::text, units_used::text FROM zero_resource_daily_usage
       WHERE principal_id = $1 AND resource_id = $2
         AND day_utc = (NOW() AT TIME ZONE 'UTC')::date FOR UPDATE`,
      [input.principalId, input.resourceId],
    );
    const jobs = Number(usage.rows[0]?.jobs_started);
    const units = Number(usage.rows[0]?.units_used);
    if (!Number.isSafeInteger(jobs) || !Number.isSafeInteger(units)) {
      throw new ZeroResourceSchemaError('ZERO RESOURCE GUARD: Tagesbudget ist ungültig; Ressource bleibt gesperrt.');
    }
    if (jobs + 1 > policy.dailyJobs || units + input.units > policy.dailyUnits) {
      throw new ZeroResourceLimitError('ZERO RESOURCE GUARD: Tagesbudget für diese Ressource ist ausgeschöpft.');
    }

    const active = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM zero_resource_reservations
       WHERE principal_id = $1 AND resource_id = $2 AND status = 'reserved' AND expires_at > NOW()`,
      [input.principalId, input.resourceId],
    );
    if (Number(active.rows[0]?.count) >= policy.maxConcurrent) {
      throw new ZeroResourceLimitError('ZERO RESOURCE GUARD: Parallelitätslimit für diese Ressource erreicht.');
    }

    await client.query(
      `INSERT INTO zero_resource_rate_windows (principal_id, resource_id, window_start, request_count)
       VALUES ($1, $2, date_trunc('minute', NOW()), 0)
       ON CONFLICT (principal_id, resource_id, window_start) DO NOTHING`,
      [input.principalId, input.resourceId],
    );
    const rate = await client.query<{ request_count: number }>(
      `SELECT request_count FROM zero_resource_rate_windows
       WHERE principal_id = $1 AND resource_id = $2 AND window_start = date_trunc('minute', NOW())
       FOR UPDATE`,
      [input.principalId, input.resourceId],
    );
    if (!Number.isSafeInteger(rate.rows[0]?.request_count) || rate.rows[0].request_count >= policy.perMinute) {
      throw new ZeroResourceLimitError('ZERO RESOURCE GUARD: Minutenlimit für diese Ressource erreicht.');
    }

    const reservationId = randomUUID();
    const inserted = await client.query<{ expires_at: Date }>(
      `INSERT INTO zero_resource_reservations
       (reservation_id, idempotency_key, request_fingerprint, principal_id, resource_id, status, units_reserved, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'reserved', $6, NOW() + ($7::int * INTERVAL '1 second'))
       RETURNING expires_at`,
      [reservationId, input.idempotencyKey, requestFingerprint, input.principalId, input.resourceId, input.units, policy.reservationTtlSeconds],
    );
    await client.query(
      `UPDATE zero_resource_daily_usage SET jobs_started = jobs_started + 1,
       units_used = units_used + $3, updated_at = NOW()
       WHERE principal_id = $1 AND resource_id = $2 AND day_utc = (NOW() AT TIME ZONE 'UTC')::date`,
      [input.principalId, input.resourceId, input.units],
    );
    await client.query(
      `UPDATE zero_resource_rate_windows SET request_count = request_count + 1, updated_at = NOW()
       WHERE principal_id = $1 AND resource_id = $2 AND window_start = date_trunc('minute', NOW())`,
      [input.principalId, input.resourceId],
    );
    await client.query('COMMIT');
    transactionStarted = false;
    return {
      reservationId, principalId: input.principalId, resourceId: input.resourceId,
      units: input.units, status: 'reserved',
      expiresAt: new Date(inserted.rows[0].expires_at).toISOString(), duplicate: false,
    };
  } catch (error) {
    if (transactionStarted) {
      try { await client.query('ROLLBACK'); } catch { destroyClient = true; }
    }
    if (error instanceof ZeroResourceSchemaError ||
        error instanceof ZeroResourceLimitError ||
        error instanceof ZeroResourceIdempotencyError) throw error;
    throw new ZeroResourceSchemaError('ZERO RESOURCE GUARD: Reservierung fehlgeschlagen; Ressource bleibt gesperrt.');
  } finally {
    client.release(destroyClient);
  }
}

export async function settleZeroResourceReservationWithPool(
  pool: Pool,
  input: { principalId: string; reservationId: string; outcome: 'completed' | 'released' },
): Promise<boolean> {
  if (input.principalId !== 'admin:primary' || !/^[0-9a-f-]{36}$/i.test(input.reservationId)) {
    throw new ZeroResourceSchemaError('ZERO RESOURCE GUARD: Ungültige Reservierungsidentität.');
  }
  let client: PoolClient;
  try { client = await pool.connect(); } catch {
    throw new ZeroResourceSchemaError('ZERO RESOURCE GUARD: PostgreSQL nicht verfügbar; Reservierung bleibt unverändert.');
  }
  // Treat BEGIN as uncertain until a successful rollback/commit proves the connection state.
  let transactionStarted = true;
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [...ZERO_RESOURCE_ADVISORY_LOCK]);
    const result = await client.query(
      `UPDATE zero_resource_reservations
       SET status = $3, completed_at = CASE WHEN $3 = 'completed' THEN NOW() ELSE completed_at END
       WHERE reservation_id = $1 AND principal_id = $2 AND status = 'reserved'
       RETURNING reservation_id`,
      [input.reservationId, input.principalId, input.outcome],
    );
    await client.query('COMMIT');
    transactionStarted = false;
    return result.rowCount === 1;
  } catch {
    if (transactionStarted) {
      try { await client.query('ROLLBACK'); } catch { destroyClient = true; }
    }
    throw new ZeroResourceSchemaError('ZERO RESOURCE GUARD: Reservierungsabschluss fehlgeschlagen; Ressource bleibt gesperrt.');
  } finally {
    client.release(destroyClient);
  }
}

export async function getZeroResourceReservationWithPool(
  pool: Pool,
  input: { principalId: string; reservationId: string },
): Promise<ZeroResourceReservation | null> {
  if (input.principalId !== 'admin:primary' || !/^[0-9a-f-]{36}$/i.test(input.reservationId)) {
    throw new ZeroResourceSchemaError('ZERO RESOURCE GUARD: Ungültige Reservierungsidentität.');
  }
  const result = await pool.query<{
    reservation_id: string; principal_id: string; resource_id: string;
    units_reserved: string; status: 'reserved' | 'completed' | 'released'; expires_at: Date;
  }>(
    `SELECT reservation_id, principal_id, resource_id, units_reserved::text, status, expires_at
     FROM zero_resource_reservations WHERE reservation_id = $1 AND principal_id = $2`,
    [input.reservationId, input.principalId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.status === 'reserved' && new Date(row.expires_at).getTime() <= Date.now()) {
    await settleZeroResourceReservationWithPool(pool, {
      principalId: input.principalId, reservationId: input.reservationId, outcome: 'released',
    });
    return { reservationId: row.reservation_id, principalId: row.principal_id,
      resourceId: row.resource_id as 'wan-video' | 'piper-tts', units: Number(row.units_reserved),
      status: 'released', expiresAt: new Date(row.expires_at).toISOString(), duplicate: true };
  }
  return { reservationId: row.reservation_id, principalId: row.principal_id,
    resourceId: row.resource_id as 'wan-video' | 'piper-tts', units: Number(row.units_reserved),
    status: row.status, expiresAt: new Date(row.expires_at).toISOString(), duplicate: true };
}

export async function reserveZeroResource(input: {
  principalId: string; resourceId: string; idempotencyKey: string; units: number; requestFingerprint?: string;
}): Promise<ZeroResourceReservation> {
  await ensureZeroResourceSchema();
  const { getPostgresPool } = await import('./persistence.ts');
  const pool = getPostgresPool();
  if (!pool) throw new ZeroResourceSchemaError('ZERO RESOURCE GUARD: PostgreSQL nicht konfiguriert; Ressource bleibt gesperrt.');
  return reserveZeroResourceWithPool(pool, input);
}

export async function settleZeroResourceReservation(input: {
  principalId: string; reservationId: string; outcome: 'completed' | 'released';
}): Promise<boolean> {
  await ensureZeroResourceSchema();
  const { getPostgresPool } = await import('./persistence.ts');
  const pool = getPostgresPool();
  if (!pool) throw new ZeroResourceSchemaError('ZERO RESOURCE GUARD: PostgreSQL nicht konfiguriert; Reservierung bleibt gesperrt.');
  return settleZeroResourceReservationWithPool(pool, input);
}

export async function getZeroResourceReservation(input: {
  principalId: string; reservationId: string;
}): Promise<ZeroResourceReservation | null> {
  await ensureZeroResourceSchema();
  const { getPostgresPool } = await import('./persistence.ts');
  const pool = getPostgresPool();
  if (!pool) throw new ZeroResourceSchemaError('ZERO RESOURCE GUARD: PostgreSQL nicht konfiguriert; Reservierung bleibt gesperrt.');
  return getZeroResourceReservationWithPool(pool, input);
}
