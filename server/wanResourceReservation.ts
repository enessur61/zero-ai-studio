import type { Pool } from 'pg';
import { settleZeroResourceReservationWithPool } from './zeroResourceGuard.ts';

export async function ensureWanJobReservationSchemaWithPool(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let transactionOpen = true;
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(1514480207, 75)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS zero_wan_job_reservations (
        worker_job_id UUID PRIMARY KEY,
        reservation_id TEXT NOT NULL UNIQUE,
        principal_id TEXT NOT NULL CHECK (length(btrim(principal_id)) BETWEEN 1 AND 128),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        settled_at TIMESTAMPTZ
      )
    `);
    await client.query('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch { destroyClient = true; }
    }
    throw error;
  } finally {
    client.release(destroyClient);
  }
}

export async function linkWanJobReservationWithPool(
  pool: Pool,
  input: { workerJobId: string; reservationId: string; principalId: string },
): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(input.workerJobId) ||
      !/^[0-9a-f-]{36}$/i.test(input.reservationId) ||
      !input.principalId.trim() || input.principalId.length > 128) {
    throw new Error('Invalid Wan job reservation link.');
  }
  const result = await pool.query(
    `INSERT INTO zero_wan_job_reservations (worker_job_id, reservation_id, principal_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (worker_job_id) DO UPDATE
       SET reservation_id = EXCLUDED.reservation_id
       WHERE zero_wan_job_reservations.reservation_id = EXCLUDED.reservation_id
         AND zero_wan_job_reservations.principal_id = EXCLUDED.principal_id
     RETURNING worker_job_id`,
    [input.workerJobId, input.reservationId, input.principalId],
  );
  if (result.rowCount !== 1) {
    throw new Error('Wan job is already linked to a different resource reservation.');
  }
}

export async function settleWanJobReservationWithPool(
  pool: Pool,
  input: { workerJobId: string; principalId: string },
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(input.workerJobId) || !input.principalId.trim()) {
    throw new Error('Invalid Wan job settlement identity.');
  }
  const link = await pool.query<{ reservation_id: string }>(
    `SELECT reservation_id FROM zero_wan_job_reservations
     WHERE worker_job_id = $1 AND principal_id = $2`,
    [input.workerJobId, input.principalId],
  );
  const reservationId = link.rows[0]?.reservation_id;
  if (!reservationId) return false;
  const settled = await settleZeroResourceReservationWithPool(pool, {
    principalId: input.principalId,
    reservationId,
    outcome: 'completed',
  });
  await pool.query(
    `UPDATE zero_wan_job_reservations SET settled_at = COALESCE(settled_at, NOW())
     WHERE worker_job_id = $1 AND principal_id = $2`,
    [input.workerJobId, input.principalId],
  );
  return settled;
}
