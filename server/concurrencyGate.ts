import type { Pool } from 'pg';
import type { RequestHandler } from 'express';

export type ConcurrencyGate = {
  middleware: RequestHandler;
  activeCount: () => number;
};

/**
 * Process-local gate retained for isolated unit tests and non-production tools.
 */
export function createConcurrencyGate(maxConcurrent: number, retryAfterSeconds = 5): ConcurrencyGate {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error('maxConcurrent must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
    throw new Error('retryAfterSeconds must be a positive safe integer.');
  }

  let active = 0;
  const middleware: RequestHandler = (_req, res, next) => {
    if (active >= maxConcurrent) {
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        error: 'Zu viele gleichzeitige ZIP-Operationen. Bitte später erneut versuchen.',
        code: 'ZIP_CONCURRENCY_LIMIT',
      });
      return;
    }

    active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active--;
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  };

  return { middleware, activeCount: () => active };
}

/**
 * Cross-process ZIP gate backed by PostgreSQL session advisory locks.
 * A checked-out connection owns one slot until BOTH the async handler has
 * settled and the HTTP response has ended or the client has disconnected.
 * PostgreSQL releases the lock automatically if the process/connection dies.
 */
export function createPostgresConcurrencyGate(
  database: Pool,
  maxConcurrent: number,
  retryAfterSeconds = 5
): ConcurrencyGate {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 2) {
    throw new Error('PostgreSQL ZIP gate supports between one and two slots.');
  }
  if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
    throw new Error('retryAfterSeconds must be a positive safe integer.');
  }

  let active = 0;
  const middleware: RequestHandler = (req, res, next) => {
    void (async () => {
      const client = await database.connect();
      let lockId: number | null = null;
      try {
        for (let slot = 0; slot < maxConcurrent; slot++) {
          const candidate = 3 + slot;
          const result = await client.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock(1514480207, $1) AS locked',
            [candidate]
          );
          if (result.rows[0]?.locked === true) {
            lockId = candidate;
            break;
          }
        }

        if (lockId === null) {
          client.release();
          res.setHeader('Retry-After', String(retryAfterSeconds));
          res.status(429).json({
            error: 'Zu viele gleichzeitige ZIP-Operationen. Bitte später erneut versuchen.',
            code: 'ZIP_CONCURRENCY_LIMIT',
          });
          return;
        }

        active++;
        let handlerSettled = false;
        let responseEnded = false;
        let released = false;
        let releasePromise: Promise<void> | null = null;
        const releaseIfReady = (): Promise<void> => {
          if (!handlerSettled || !responseEnded || released) return Promise.resolve();
          if (!releasePromise) {
            releasePromise = (async () => {
              let destroy = false;
              try {
                const result = await client.query<{ unlocked: boolean }>(
                  'SELECT pg_advisory_unlock(1514480207, $1) AS unlocked',
                  [lockId]
                );
                if (result.rows[0]?.unlocked !== true) {
                  destroy = true;
                  throw new Error('PostgreSQL ZIP concurrency lock could not be confirmed as released.');
                }
                released = true;
                active--;
              } catch (error) {
                destroy = true;
                throw error;
              } finally {
                if (!released) {
                  released = true;
                  active--;
                }
                client.release(destroy);
              }
            })();
          }
          return releasePromise;
        };

        res.once('finish', () => {
          responseEnded = true;
          void releaseIfReady().catch((error) => console.error('[ZERO ZIP gate] Release failed:', error));
        });
        res.once('close', () => {
          responseEnded = true;
          void releaseIfReady().catch((error) => console.error('[ZERO ZIP gate] Release failed:', error));
        });
        res.locals.zeroConcurrencyHandlerSettled = () => {
          handlerSettled = true;
          return releaseIfReady();
        };
        next();
      } catch (error) {
        // A failed lock query has an ambiguous outcome: PostgreSQL may have
        // acquired the session lock even if the client never received its row.
        // Destroy the connection so an uncertain advisory lock cannot return
        // to the pool and strand one of the global ZIP slots.
        client.release(true);
        next(error);
      }
    })();
  };

  return { middleware, activeCount: () => active };
}
