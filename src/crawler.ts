// SatRank V3 — catalogue crawler.
//
// One file, three sources, one cron loop.
//   • l402.directory  — JSON catalog
//   • RSS index       — l402-index aggregation
//   • DNS TXT         — _l402.<host> records (operator self-publish)
//
// Each source returns Endpoint[]. The crawler upserts into service_endpoints
// and triggers a probe per new/stale entry.

import crypto from 'node:crypto';
import { promises as dnsPromises } from 'node:dns';
import { config } from './config.js';
import { logger } from './logger.js';
import { pool } from './db.js';
import { probeAndIngest } from './probe.js';
import { isHttpsUrl } from './ssrf.js';
import type { Endpoint } from './types.js';

const ALLOWED_METHODS: ReadonlyArray<Endpoint['http_method']> = ['GET', 'POST', 'PUT', 'DELETE'];

function urlHash(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex');
}

function safeMethod(raw: string | undefined): Endpoint['http_method'] {
  const upper = raw?.toUpperCase() as Endpoint['http_method'];
  return ALLOWED_METHODS.includes(upper) ? upper : 'GET';
}

async function fetchJson<T>(url: string, timeoutMs = 15_000): Promise<T | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.json() as T;
    } finally {
      clearTimeout(timer);
    }
  } catch (err: unknown) {
    logger.debug({ url, err: (err as Error).message }, 'crawler: fetchJson failed');
    return null;
  }
}

// --- Source 1: l402.directory v1.3 -----------------------------------------
//
// API shape (verified 2026-05-09):
//   GET /api/services → { services: [{
//     name, description, categories: string[], endpoints: [{
//       url, method, description, pricing: { amount, currency, model }, ...
//     }]
//   }] }
//
// Each `service` declares N `endpoints` ; we flatten to one V3 Endpoint per
// (service, endpoint) pair. URLs containing template placeholders (e.g.
// `?q={query}`) aren't directly probable — skip them.

interface L402DirectoryService {
  name?: string;
  description?: string;
  categories?: string[];
  endpoints?: Array<{
    url?: string;
    method?: string;
    description?: string;
    pricing?: { amount?: number };
  }>;
}

async function fromL402Directory(): Promise<Endpoint[]> {
  const data = await fetchJson<{ services?: L402DirectoryService[] }>(
    'https://l402.directory/api/services',
  );
  if (!data?.services) return [];
  const now = Math.floor(Date.now() / 1000);
  const out: Endpoint[] = [];
  for (const svc of data.services) {
    // Preserve every category the upstream lists. Sim 2 finding : taking
    // only categories[0] collapsed all 5 services into one bucket because
    // l402.directory tends to emit categories[0]='data' for everything.
    // Multi-tag indexing lets a finance/ai/video query each match their
    // share of the catalogue.
    const tags = (svc.categories ?? []).filter((c) => typeof c === 'string' && c.length > 0);
    const category_tags = tags.length > 0 ? tags : ['other'];
    const category = category_tags[0];
    for (const ep of svc.endpoints ?? []) {
      if (!ep.url || !isHttpsUrl(ep.url)) continue;
      // Template placeholders (e.g. {query}, :id) aren't probable as-is.
      if (ep.url.includes('{') || ep.url.includes('}')) continue;
      out.push({
        url: ep.url,
        url_hash: urlHash(ep.url),
        category,
        category_tags,
        name: svc.name ?? new URL(ep.url).hostname,
        description: ep.description ?? svc.description ?? '',
        http_method: safeMethod(ep.method),
        price_sats: ep.pricing?.amount ?? 0,
        source: 'l402_directory',
        added_at: now,
      });
    }
  }
  return out;
}

// --- Source 3: DNS TXT ------------------------------------------------------

const DNS_HOSTS_TO_PROBE = [
  // Seeds. Operators add themselves by publishing a `_l402.<host>` TXT record
  // with the URL as its value. Read-only — we never trust DNS for trust score,
  // only for catalogue inclusion. The probe is what scores it.
  'satrank.dev',
  'l402.directory',
];

async function fromDns(): Promise<Endpoint[]> {
  const now = Math.floor(Date.now() / 1000);
  const out: Endpoint[] = [];
  for (const host of DNS_HOSTS_TO_PROBE) {
    try {
      const records = await dnsPromises.resolveTxt(`_l402.${host}`);
      for (const r of records) {
        const url = r.join('');
        if (!url.startsWith('https://')) continue;
        out.push({
          url, url_hash: urlHash(url), category: 'other', category_tags: ['other'],
          name: host, description: `DNS TXT _l402.${host}`,
          http_method: 'GET', price_sats: 0, source: 'dns', added_at: now,
        });
      }
    } catch {
      // No TXT record. Silent skip.
    }
  }
  return out;
}

// --- Pipeline ---------------------------------------------------------------

/** Upsert one endpoint. Returns true when the row is new. */
async function upsert(e: Endpoint): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO service_endpoints
       (url_hash, url, category, category_tags, name, description, http_method, price_sats, source, added_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (url_hash) DO UPDATE SET
       category = EXCLUDED.category,
       category_tags = EXCLUDED.category_tags,
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       http_method = EXCLUDED.http_method,
       price_sats = EXCLUDED.price_sats,
       source = EXCLUDED.source`,
    [e.url_hash, e.url, e.category, e.category_tags, e.name, e.description, e.http_method, e.price_sats, e.source, e.added_at],
  );
  return rowCount === 1;
}

export interface CrawlReport {
  fetched: number;
  inserted: number;
  probed: number;
  errors: number;
}

/** Single crawl tick. Pulls every source, upserts the catalogue, probes
 *  each endpoint that's stale (or new) once. */
export async function crawl(): Promise<CrawlReport> {
  const report: CrawlReport = { fetched: 0, inserted: 0, probed: 0, errors: 0 };
  const all = (await Promise.all([fromL402Directory(), fromDns()])).flat();
  // Dedup by url (cross-source). Keep the first source seen.
  const dedup = new Map<string, Endpoint>();
  for (const e of all) {
    if (!dedup.has(e.url)) dedup.set(e.url, e);
  }
  report.fetched = dedup.size;

  for (const e of dedup.values()) {
    try {
      const isNew = await upsert(e);
      if (isNew) report.inserted++;
    } catch (err: unknown) {
      report.errors++;
      logger.warn({ url: e.url, err: (err as Error).message }, 'crawler: upsert failed');
    }
  }

  // Probe every endpoint that hasn't been probed within the crawler
  // interval (so 15-min cadence at default settings probes every endpoint
  // every tick when catalogue ≤ 200). Cap at 200/tick to keep ticks short.
  const cutoff = Math.floor(Date.now() / 1000) - config.CRAWLER_INTERVAL_SEC;
  const { rows } = await pool.query<{ url: string; http_method: 'GET' | 'POST' }>(
    `SELECT url, http_method FROM service_endpoints
       WHERE last_probe_at IS NULL OR last_probe_at < $1
       ORDER BY last_probe_at NULLS FIRST
       LIMIT 200`,
    [cutoff],
  );
  for (const r of rows) {
    try {
      await probeAndIngest(r.url, r.http_method);
      report.probed++;
    } catch (err: unknown) {
      report.errors++;
      logger.warn({ url: r.url, err: (err as Error).message }, 'crawler: probe failed');
    }
  }

  logger.info(report, 'crawler: tick complete');
  return report;
}

/** Schedule the crawler at a fixed interval. Returns the timer so
 *  callers can clear it on shutdown. */
export function scheduleCrawler(): NodeJS.Timeout {
  // Fire once at boot, then on the configured interval.
  setImmediate(() => crawl().catch((err) => logger.error({ err: (err as Error).message }, 'crawler: tick threw')));
  const intervalMs = config.CRAWLER_INTERVAL_SEC * 1000;
  return setInterval(
    () => crawl().catch((err) => logger.error({ err: (err as Error).message }, 'crawler: tick threw')),
    intervalMs,
  );
}
