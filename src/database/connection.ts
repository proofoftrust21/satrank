// Phase 12B — PostgreSQL 16 connection pools
// Two singleton pools so API and crawler can be tuned/observed independently.
// API max=30, crawler max=20 (per Romain's A5 saturation findings).
import { Pool, types, type PoolClient, type PoolConfig } from 'pg';
import { config } from '../config';
import { logger } from '../logger';
import { pgPoolQueryDuration, pgPoolQueryErrors } from '../middleware/metrics';

// BIGINT (OID 20) → parse as JS number. Safe for SatRank: max value capacity_sats
// 21M BTC × 1e8 sats = 2.1e15, well under 2^53 (9.0e15). Counters are far smaller.
// Without this, node-pg returns bigint as string → test failures + API contract drift.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// NUMERIC (OID 1700) → parse as JS number. Used by AVG(), ROUND(), and aggregate
// queries returning decimals. Otherwise returned as string and breaks assertions
// that expect numeric equality.
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

type PoolName = 'api' | 'crawler';

const pools = new Map<PoolName, Pool>();

function buildPool(name: PoolName, max: number): Pool {
  const options: PoolConfig = {
    connectionString: config.DATABASE_URL,
    max,
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    query_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    idleTimeoutMillis: config.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: config.DB_CONNECTION_TIMEOUT_MS,
    application_name: `satrank-${name}`,
  };
  const pool = new Pool(options);

  pool.on('error', (err) => {
    logger.error({ err, pool: name }, 'pg pool idle-client error');
  });

  instrumentPool(pool, name);

  logger.info({ pool: name, max }, 'pg pool created');
  return pool;
}

// Phase 12B B6.3 : wrap pool.query so every call lands in
// pgPoolQueryDuration and pgPoolQueryErrors without requiring repositories
// to opt in (the existing `satrank_db_query_duration_seconds` is opt-in per
// repo method — this one closes the blind spot by covering raw pool.query
// too). pg exposes multiple query overloads (string, QueryConfig, callbacks),
// so the wrapper stays overload-agnostic by forwarding `arguments` through.
function instrumentPool(pool: Pool, name: PoolName): void {
  const original = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  const wrapped = function instrumentedQuery(...args: unknown[]): unknown {
    const endTimer = pgPoolQueryDuration.startTimer({ pool: name });
    let result: unknown;
    try {
      result = original(...args);
    } catch (err: unknown) {
      endTimer();
      pgPoolQueryErrors.inc({ pool: name });
      throw err;
    }
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      return (result as Promise<unknown>).then(
        (r) => {
          endTimer();
          return r;
        },
        (err: unknown) => {
          endTimer();
          pgPoolQueryErrors.inc({ pool: name });
          throw err;
        },
      );
    }
    endTimer();
    return result;
  };
  (pool as unknown as { query: typeof pool.query }).query = wrapped as typeof pool.query;
}

/** Default pool for API/request handling (max=30). */
export function getPool(): Pool {
  let p = pools.get('api');
  if (!p) {
    p = buildPool('api', config.DB_POOL_MAX_API);
    pools.set('api', p);
  }
  return p;
}

/** Dedicated pool for long-running crawler work (max=20).
 *  Kept separate so a crawler spike cannot starve the API pool. */
export function getCrawlerPool(): Pool {
  let p = pools.get('crawler');
  if (!p) {
    p = buildPool('crawler', config.DB_POOL_MAX_CRAWLER);
    pools.set('crawler', p);
  }
  return p;
}

/** Closes all open pools. Safe to call multiple times. */
export async function closePools(): Promise<void> {
  const entries = Array.from(pools.entries());
  pools.clear();
  await Promise.all(
    entries.map(async ([name, pool]) => {
      try {
        await pool.end();
        logger.info({ pool: name }, 'pg pool closed');
      } catch (err) {
        logger.error({ err, pool: name }, 'pg pool close failed');
      }
    }),
  );
}

export type { Pool, PoolClient };
