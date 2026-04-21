// Phase 12B B6.1 — boot-time warmup probe.
//
// A5 observed that /api/intent cold p95 hits 2 279 ms on the very first call
// because (a) the pg connection pool is empty, (b) the category resolver has
// never been loaded, (c) the service_endpoints scan has never been JIT-compiled.
// Warm p95 drops to 37.9 ms at 10 rps. Running a tiny probe synchronously
// before `app.listen()` trades a few hundred ms of extra boot time against a
// single user paying the cold-cost.
//
// Never throws: the API must boot even if the warmup query fails (empty DB,
// transient pg hiccup, etc.). Failures are logged and the process continues.

import type { Pool } from 'pg';
import { logger } from './logger';
import { ServiceEndpointRepository } from './repositories/serviceEndpointRepository';

export interface WarmupResult {
  ok: boolean;
  durationMs: number;
  categoriesLoaded: number;
  firstCategory: string | null;
  error?: string;
}

/** Light, read-only probe touching the main cold paths. Designed to complete
 *  in well under 1s on a warm pg server with the target schema. */
export async function runWarmup(pool: Pool): Promise<WarmupResult> {
  const started = Date.now();
  try {
    const serviceEndpointRepo = new ServiceEndpointRepository(pool);

    const categories = await serviceEndpointRepo.findCategoriesWithActive();
    const first = categories[0]?.category ?? null;

    if (first) {
      // Touch the hottest scan path so the planner caches the plan and the
      // pg shared buffers are primed for the first real /api/intent.
      await serviceEndpointRepo.findServices({
        category: first,
        sort: 'uptime',
        limit: 5,
        offset: 0,
      });
    }

    const durationMs = Date.now() - started;
    logger.info(
      { durationMs, categoriesLoaded: categories.length, firstCategory: first },
      'Warmup probe completed',
    );
    return { ok: true, durationMs, categoriesLoaded: categories.length, firstCategory: first };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - started;
    // Never fatal — the API must boot even when the warmup hits a snag.
    logger.warn({ error: msg, durationMs }, 'Warmup probe failed — continuing boot');
    return { ok: false, durationMs, categoriesLoaded: 0, firstCategory: null, error: msg };
  }
}
