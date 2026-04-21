// Phase 12B — PostgreSQL 16 connection pools
// Two singleton pools so API and crawler can be tuned/observed independently.
// API max=30, crawler max=20 (per Romain's A5 saturation findings).
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { config } from '../config';
import { logger } from '../logger';

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

  logger.info({ pool: name, max }, 'pg pool created');
  return pool;
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
