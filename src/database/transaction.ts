// Phase 12B — pg transaction helper.
// Mirrors the shape of the old better-sqlite3 `db.transaction(fn)` wrapper
// so services can be ported by swapping `db.transaction(...)()` for
// `withTransaction(pool, async (client) => ...)`.
import type { Pool, PoolClient } from 'pg';
import { logger } from '../logger';

/** Executes fn inside a BEGIN/COMMIT transaction. On throw, ROLLBACK and re-raise.
 *  The PoolClient is released in `finally` so a broken transaction does not leak a connection. */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'ROLLBACK failed after transaction error');
    }
    throw err;
  } finally {
    client.release();
  }
}
