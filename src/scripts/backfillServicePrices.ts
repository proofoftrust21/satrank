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
}

const DEFAULT_RATE_LIMIT_MS = 500;
const DEFAULT_FETCH_TIMEOUT_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  function emitSkip(reason: string, details: Record<string, unknown>): void {
    if (!verboseSkips) return;
    logger.info({ skip: { reason, ...details } }, `backfillServicePrices: SKIP ${reason}`);
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
    priced: 0,
  };

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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const repo = new ServiceEndpointRepository(client);

    for (const row of rows) {
      const { url } = row;

      let resp: Response;
      try {
        resp = await fetchSafeExternal(url, {
          method: 'GET',
          signal: AbortSignal.timeout(fetchTimeoutMs),
          headers: { 'User-Agent': 'SatRank-BackfillServicePrices/1.0' },
        });
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
        }
        await sleep(rateLimitMs);
        continue;
      }

      const wwwAuth = resp.headers.get('www-authenticate') ?? '';
      if (resp.status !== 402) {
        summary.skippedNotL402 += 1;
        logger.debug({ url, status: resp.status }, 'backfillServicePrices: non-402 response');
        emitSkip('not_l402', { url, httpStatus: resp.status, wwwAuth });
        await sleep(rateLimitMs);
        continue;
      }

      const invoiceMatch = wwwAuth.match(/invoice="(lnbc[a-z0-9]+)"/i);
      if (!invoiceMatch) {
        summary.skippedNoInvoice += 1;
        logger.debug({ url }, 'backfillServicePrices: no BOLT11 invoice in header');
        emitSkip('no_invoice', { url, httpStatus: resp.status, wwwAuth });
        await sleep(rateLimitMs);
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
        } else if (lower.includes('circuit breaker open')) {
          summary.skippedBreakerOpen += 1;
          reason = 'breaker_open';
        } else if (lower.includes('testnet') || lower.includes('signet') || lower.includes('wrong network')) {
          summary.skippedNetworkMismatch += 1;
          reason = 'network_mismatch';
        } else {
          summary.skippedDecodeFailed += 1;
          reason = 'decode_other';
        }
        logger.warn({ url, error: errMsg, reason }, 'backfillServicePrices: decodepayreq failed');
        emitSkip(reason, { url, httpStatus: resp.status, wwwAuth, invoice, lndError: errMsg });
        await sleep(rateLimitMs);
        continue;
      }

      if (!decoded.num_satoshis) {
        summary.skippedDecodeFailed += 1;
        logger.debug({ url }, 'backfillServicePrices: decoded payload missing num_satoshis');
        emitSkip('decode_missing_num_satoshis', { url, invoice, decoded });
        await sleep(rateLimitMs);
        continue;
      }

      const priceSats = parseInt(decoded.num_satoshis, 10);
      if (!Number.isFinite(priceSats) || priceSats <= 0) {
        summary.skippedZeroPrice += 1;
        logger.debug({ url, num_satoshis: decoded.num_satoshis }, 'backfillServicePrices: zero or invalid price');
        emitSkip('zero_price', { url, invoice, num_satoshis: decoded.num_satoshis });
        await sleep(rateLimitMs);
        continue;
      }

      await repo.updatePrice(url, priceSats);
      summary.priced += 1;
      logger.info({ url, priceSats }, 'backfillServicePrices: price updated');

      await sleep(rateLimitMs);
    }

    if (dryRun) {
      await client.query('ROLLBACK');
      logger.info({ ...summary, dryRun: true }, 'backfillServicePrices: dry-run complete — rolled back');
      return summary;
    }

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // best-effort
    }
    throw err;
  } finally {
    client.release();
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
