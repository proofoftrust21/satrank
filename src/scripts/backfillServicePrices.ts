#!/usr/bin/env tsx
// Phase 13D — backfillServicePrices : populate service_price_sats for rows left
// at NULL by the pre-fix registryCrawler (ordering bug: updatePrice() ran before
// upsert() created the row, so UPDATE affected 0 rows silently).
//
// Symptom in prod (2026-04-22): 172/172 rows in service_endpoints have
// service_price_sats=null → /api/intent returns NO_CANDIDATES as soon as a
// budget_sats is passed → sr.fulfill() unusable.
//
// This script re-probes each unpriced L402 endpoint, extracts the BOLT11 from
// the WWW-Authenticate header, decodes it via LND's readonly `decodepayreq`,
// and persists num_satoshis via serviceEndpointRepo.updatePrice.
//
// Runs IN-PROCESS inside an already-running container (e.g. satrank-crawler)
// via `docker exec`. Do NOT run via `docker compose run --rm` — the existing
// container has stable DB/LND/macaroon wiring; a fresh ephemeral container
// risks reconfiguration drift.
//
// Idempotent: re-running skips rows that already have a non-null price.
// Dry-run supported (BEGIN/ROLLBACK) — no state mutations on prod until removed.
// Rate-limited to 2 req/sec (500ms between probes) to stay friendly to the
// endpoints being queried.

import type { Pool } from 'pg';
import { getCrawlerPool, closePools } from '../database/connection';
import { runMigrations } from '../database/migrations';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import { HttpLndGraphClient, type LndGraphClient } from '../crawler/lndGraphClient';
import { config } from '../config';
import { fetchSafeExternal, SsrfBlockedError } from '../utils/ssrf';
import { HostRateLimiter } from '../utils/hostRateLimiter';
import { ProviderHealthTracker } from '../utils/providerHealthTracker';
import { logger } from '../logger';

export interface BackfillSummary {
  scanned: number;
  skippedNoInvoice: number;
  skippedNotL402: number;
  skippedSsrf: number;
  /** Malformed BOLT11 (LND rejected with "invalid index" or "checksum failed").
   *  Permanent — the provider is serving bad data, won't resolve by retry. */
  skippedInvoiceMalformed: number;
  /** BOLT11 for a different network (mainnet LND got a testnet/signet invoice). */
  skippedNetworkMismatch: number;
  /** LND circuit breaker was open when we attempted decode. Retriable — would
   *  succeed if breaker is closed. After the 2026-04-22 breaker carve-out for
   *  invoice parse errors, this should only fire when LND itself is unhealthy. */
  skippedBreakerOpen: number;
  /** Everything else (unexpected LND error, missing destination, etc.). */
  skippedDecodeFailed: number;
  skippedZeroPrice: number;
  skippedNetworkError: number;
  /** Provider returned 429 with Retry-After > RATE_LIMIT_LONG_THRESHOLD_SEC,
   *  or 429 without Retry-After. We don't block the backfill minutes for one
   *  URL — re-run the script later to retry. */
  skippedRateLimitedLong: number;
  priced: number;
}

export interface BackfillOptions {
  dryRun?: boolean;
  rateLimitMs?: number;
  fetchTimeoutMs?: number;
  /** Limit the number of rows processed (useful for smoke tests). */
  limit?: number;
  /** When true, emits an info-level structured log per skip (reason + url + raw
   *  context) so the 30 "skippedDecodeFailed" cases can be classified. Silent
   *  by default — the default log level hides skip debug lines. */
  verboseSkips?: boolean;
  /** Backoffs (ms) between retry attempts on transient fetch failures. Default
   *  [500, 2000]. Length also determines max retry count (2 here → 3 total
   *  attempts per URL). Tests set this to [0, 0] to run synchronously. */
  retryBackoffsMs?: number[];
  /** Optional override for the provider health tracker (tests inject a mock
   *  logger). Default: a fresh run-scoped ProviderHealthTracker with the
   *  default threshold of 10 consecutive failures per host. */
  healthTracker?: ProviderHealthTracker;
}

const DEFAULT_RATE_LIMIT_MS = 500;
const DEFAULT_FETCH_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_BACKOFFS_MS = [500, 2000];
const RETRYABLE_ERROR_PATTERN = /ECONNRESET|ETIMEDOUT|timeout|aborted/i;
/** 429 with Retry-After above this threshold is skipped rather than awaited.
 *  Keeps a single URL from stalling the full backfill. */
const RATE_LIMIT_LONG_THRESHOLD_SEC = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse a Retry-After header (RFC 7231). We only handle the integer-seconds
 *  form — the HTTP-date form is rare in practice for rate limits. Returns null
 *  when absent or malformed so the caller falls through to the "long wait" skip. */
function parseRetryAfterSeconds(raw: string): number | null {
  if (!raw) return null;
  const n = parseInt(raw.trim(), 10);
  if (Number.isFinite(n) && n >= 0) return n;
  return null;
}

/** Re-probe every service_endpoint with service_price_sats=null and a trusted
 *  source. Mutates via repo.updatePrice unless dryRun (BEGIN/ROLLBACK). */
export async function backfillServicePrices(
  pool: Pool,
  lndClient: LndGraphClient,
  options: BackfillOptions = {},
): Promise<BackfillSummary> {
  const dryRun = options.dryRun ?? false;
  const rateLimitMs = options.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const limit = options.limit;
  const verboseSkips = options.verboseSkips ?? false;
  const retryBackoffsMs = options.retryBackoffsMs ?? DEFAULT_RETRY_BACKOFFS_MS;
  const healthTracker = options.healthTracker ?? new ProviderHealthTracker();

  function emitSkip(reason: string, details: Record<string, unknown>): void {
    if (!verboseSkips) return;
    logger.info({ skip: { reason, ...details } }, `backfillServicePrices: SKIP ${reason}`);
  }

  /** Fetch with inline retry on transient failures:
   *    - thrown errors matching ECONNRESET/ETIMEDOUT/timeout/aborted → retry
   *    - HTTP 5xx responses → retry
   *    - SSRF blocks, 4xx, and unmatched errors → no retry (deterministic)
   *  Retries use the backoffs from options (default [500ms, 2000ms] → 3 total attempts).
   *  Each attempt gets a fresh AbortSignal.timeout to avoid sharing a timer across retries. */
  async function fetchWithRetry(url: string): Promise<Response> {
    const maxAttempts = retryBackoffsMs.length + 1;
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const resp = await fetchSafeExternal(url, {
          method: 'GET',
          signal: AbortSignal.timeout(fetchTimeoutMs),
          headers: { 'User-Agent': 'SatRank-BackfillServicePrices/1.0' },
        });
        if (resp.status >= 500 && resp.status < 600 && attempt < maxAttempts - 1) {
          logger.debug({ url, status: resp.status, attempt: attempt + 1 }, 'backfillServicePrices: 5xx, retrying');
          await sleep(retryBackoffsMs[attempt]);
          continue;
        }
        return resp;
      } catch (err: unknown) {
        lastErr = err;
        if (err instanceof SsrfBlockedError) throw err;
        const errMsg = err instanceof Error ? err.message : String(err);
        if (!RETRYABLE_ERROR_PATTERN.test(errMsg)) throw err;
        if (attempt >= maxAttempts - 1) throw err;
        logger.debug({ url, error: errMsg, attempt: attempt + 1 }, 'backfillServicePrices: retryable error, retrying');
        await sleep(retryBackoffsMs[attempt]);
      }
    }
    throw lastErr;
  }

  const summary: BackfillSummary = {
    scanned: 0,
    skippedNoInvoice: 0,
    skippedNotL402: 0,
    skippedSsrf: 0,
    skippedInvoiceMalformed: 0,
    skippedNetworkMismatch: 0,
    skippedBreakerOpen: 0,
    skippedDecodeFailed: 0,
    skippedZeroPrice: 0,
    skippedNetworkError: 0,
    skippedRateLimitedLong: 0,
    priced: 0,
  };

  const hostLimiter = new HostRateLimiter(rateLimitMs);

  if (!lndClient.decodePayReq) {
    throw new Error('backfillServicePrices: LND decodePayReq is not available; macaroon misconfigured?');
  }

  const sql = `
    SELECT url FROM service_endpoints
    WHERE service_price_sats IS NULL
      AND source IN ('402index', 'self_registered')
    ORDER BY url
    ${limit ? 'LIMIT $1' : ''}
  `;
  const { rows } = await pool.query<{ url: string }>(sql, limit ? [limit] : []);
  summary.scanned = rows.length;

  logger.info({ candidates: rows.length, dryRun, rateLimitMs }, 'backfillServicePrices: starting');

  if (rows.length === 0) return summary;

  // Non-dryRun: autocommit each UPDATE via the pool directly. Holding one
  // transaction across the ~5-10 min loop collides with (a) the registry
  // crawler writing to service_endpoints concurrently (55P03 lock_timeout),
  // and (b) prod's idle_in_transaction_session_timeout. Partial progress is
  // safe — the initial SELECT filters service_price_sats IS NULL, so a retry
  // picks up rows that haven't been priced yet.
  const txClient = dryRun ? await pool.connect() : null;
  try {
    if (txClient) await txClient.query('BEGIN');
    const repo = new ServiceEndpointRepository(txClient ?? pool);

    for (const row of rows) {
      const { url } = row;

      await hostLimiter.wait(url);

      let resp: Response;
      try {
        resp = await fetchWithRetry(url);
      } catch (err: unknown) {
        if (err instanceof SsrfBlockedError) {
          summary.skippedSsrf += 1;
          logger.debug({ url, reason: err.message }, 'backfillServicePrices: SSRF blocked');
          emitSkip('ssrf_blocked', { url, errMsg: err.message });
        } else {
          summary.skippedNetworkError += 1;
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.warn({ url, error: errMsg }, 'backfillServicePrices: network error');
          emitSkip('network_error', { url, errMsg });
          healthTracker.recordFailure(url, 'network_error');
        }
        continue;
      }

      // 5xx persisted across all retries → infra/provider issue, not a "not L402" misconfig.
      if (resp.status >= 500 && resp.status < 600) {
        summary.skippedNetworkError += 1;
        const errMsg = `HTTP ${resp.status} after retries`;
        logger.warn({ url, status: resp.status }, 'backfillServicePrices: 5xx persisted after retries');
        emitSkip('network_error', { url, httpStatus: resp.status, errMsg });
        healthTracker.recordFailure(url, 'http_5xx_after_retry');
        continue;
      }

      // 429: honor Retry-After when ≤ threshold, else skip as "rate_limited_long".
      // Keeps one angry provider from stalling the whole backfill.
      if (resp.status === 429) {
        const retryAfterRaw = resp.headers.get('retry-after') ?? '';
        const retryAfterSec = parseRetryAfterSeconds(retryAfterRaw);
        if (retryAfterSec !== null && retryAfterSec > 0 && retryAfterSec <= RATE_LIMIT_LONG_THRESHOLD_SEC) {
          logger.debug({ url, retryAfterSec }, 'backfillServicePrices: 429, awaiting Retry-After then one retry');
          await sleep(retryAfterSec * 1000);
          try {
            resp = await fetchWithRetry(url);
          } catch (err: unknown) {
            summary.skippedNetworkError += 1;
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.warn({ url, error: errMsg }, 'backfillServicePrices: network error after 429 retry');
            emitSkip('network_error', { url, errMsg });
            healthTracker.recordFailure(url, 'network_error');
            continue;
          }
        }
        if (resp.status === 429) {
          summary.skippedRateLimitedLong += 1;
          logger.warn({ url, retryAfter: retryAfterRaw || '(absent)' }, 'backfillServicePrices: 429 rate limited, skipped');
          emitSkip('rate_limited_long', { url, retryAfter: retryAfterRaw || '(absent)' });
          continue;
        }
      }

      const wwwAuth = resp.headers.get('www-authenticate') ?? '';
      if (resp.status !== 402) {
        summary.skippedNotL402 += 1;
        logger.debug({ url, status: resp.status }, 'backfillServicePrices: non-402 response');
        emitSkip('not_l402', { url, httpStatus: resp.status, wwwAuth });
        continue;
      }

      const invoiceMatch = wwwAuth.match(/invoice="(lnbc[a-z0-9]+)"/i);
      if (!invoiceMatch) {
        summary.skippedNoInvoice += 1;
        logger.debug({ url }, 'backfillServicePrices: no BOLT11 invoice in header');
        emitSkip('no_invoice', { url, httpStatus: resp.status, wwwAuth });
        continue;
      }

      const invoice = invoiceMatch[1];
      let decoded: { destination: string; num_satoshis?: string };
      try {
        if (lndClient.decodePayReqStrict) {
          decoded = await lndClient.decodePayReqStrict(invoice);
        } else {
          const maybe = await lndClient.decodePayReq!(invoice);
          if (!maybe) throw new Error('decodePayReq returned null (legacy client)');
          decoded = maybe;
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const lower = errMsg.toLowerCase();
        let reason: string;
        if (/invalid index|checksum failed|failed converting data|invalid character not part of charset/i.test(errMsg)) {
          summary.skippedInvoiceMalformed += 1;
          reason = 'invoice_malformed';
          healthTracker.recordFailure(url, 'invoice_malformed');
        } else if (lower.includes('circuit breaker open')) {
          summary.skippedBreakerOpen += 1;
          reason = 'breaker_open';
        } else if (lower.includes('testnet') || lower.includes('signet') || lower.includes('wrong network')) {
          summary.skippedNetworkMismatch += 1;
          reason = 'network_mismatch';
        } else {
          summary.skippedDecodeFailed += 1;
          reason = 'decode_other';
          healthTracker.recordFailure(url, 'decode_failed');
        }
        logger.warn({ url, error: errMsg, reason }, 'backfillServicePrices: decodepayreq failed');
        emitSkip(reason, { url, httpStatus: resp.status, wwwAuth, invoice, lndError: errMsg });
        continue;
      }

      if (!decoded.num_satoshis) {
        summary.skippedDecodeFailed += 1;
        logger.debug({ url }, 'backfillServicePrices: decoded payload missing num_satoshis');
        emitSkip('decode_missing_num_satoshis', { url, invoice, decoded });
        healthTracker.recordFailure(url, 'decode_failed');
        continue;
      }

      const priceSats = parseInt(decoded.num_satoshis, 10);
      if (!Number.isFinite(priceSats) || priceSats <= 0) {
        summary.skippedZeroPrice += 1;
        logger.debug({ url, num_satoshis: decoded.num_satoshis }, 'backfillServicePrices: zero or invalid price');
        emitSkip('zero_price', { url, invoice, num_satoshis: decoded.num_satoshis });
        continue;
      }

      await repo.updatePrice(url, priceSats);
      summary.priced += 1;
      healthTracker.recordSuccess(url);
      logger.info({ url, priceSats }, 'backfillServicePrices: price updated');
    }

    if (txClient) {
      await txClient.query('ROLLBACK');
      logger.info({ ...summary, dryRun: true }, 'backfillServicePrices: dry-run complete — rolled back');
      return summary;
    }
  } catch (err) {
    if (txClient) {
      try {
        await txClient.query('ROLLBACK');
      } catch {
        // best-effort
      }
    }
    throw err;
  } finally {
    if (txClient) txClient.release();
  }

  logger.info({ ...summary }, 'backfillServicePrices: complete');
  return summary;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const verboseSkips = process.argv.includes('--verbose-skips');
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.slice('--limit='.length), 10) : undefined;

  logger.info({ dryRun, limit, verboseSkips }, 'backfillServicePrices: CLI invocation');

  const pool = getCrawlerPool();
  await runMigrations(pool);

  const lndClient = new HttpLndGraphClient({
    restUrl: config.LND_REST_URL,
    macaroonPath: config.LND_MACAROON_PATH,
    timeoutMs: config.LND_TIMEOUT_MS,
  });

  try {
    const summary = await backfillServicePrices(pool, lndClient, { dryRun, limit, verboseSkips });
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } finally {
    await closePools();
  }
}

const isMain =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;

if (isMain) {
  main().catch(async (err: unknown) => {
    logger.error({ err }, 'backfillServicePrices failed');
    await closePools();
    process.exit(1);
  });
}
