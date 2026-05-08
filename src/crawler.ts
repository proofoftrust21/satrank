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

// --- Source 1: l402.directory ----------------------------------------------

interface L402DirectoryEntry {
  url: string;
  category?: string;
  name?: string;
  description?: string;
  http_method?: string;
  price_sats?: number;
}

async function fromL402Directory(): Promise<Endpoint[]> {
  const data = await fetchJson<{ entries?: L402DirectoryEntry[] }>(
    'https://l402.directory/api/list',
  );
  if (!data?.entries) return [];
  const now = Math.floor(Date.now() / 1000);
  // Reject anything that isn't a syntactically valid https:// URL up front ;
  // the runtime SSRF guard runs again at probe time on the resolved IP.
  return data.entries.filter((e) => isHttpsUrl(e.url)).map((e) => ({
    url: e.url,
    url_hash: urlHash(e.url),
    category: e.category ?? 'other',
    name: e.name ?? new URL(e.url).hostname,
    description: e.description ?? '',
    http_method: safeMethod(e.http_method),
    price_sats: e.price_sats ?? 0,
    source: 'l402_directory',
    added_at: now,
  }));
}

// --- Source 2: l402-index RSS ----------------------------------------------

async function fromL402Rss(): Promise<Endpoint[]> {
  // Best-effort RSS scrape. The format is intentionally simple : <link> tags
  // contain the L402 endpoint URL ; <category> tags carry the category.
  // No xml2js dependency — a quick regex pass is enough for this feed.
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch('https://l402.directory/index.rss', { signal: ctrl.signal });
      if (!res.ok) return [];
      const xml = await res.text();
      const items = xml.match(/<item>([\s\S]*?)<\/item>/g) ?? [];
      const now = Math.floor(Date.now() / 1000);
      return items.flatMap((item) => {
        const raw = item.match(/<link>([^<]+)<\/link>/)?.[1]?.trim();
        if (!raw || !isHttpsUrl(raw)) return [];
        const url = raw;
        const title = item.match(/<title>([^<]+)<\/title>/)?.[1] ?? new URL(url).hostname;
        const category = item.match(/<category>([^<]+)<\/category>/)?.[1] ?? 'other';
        return [{
          url, url_hash: urlHash(url), category, name: title, description: '',
          http_method: 'GET' as const, price_sats: 0, source: 'rss', added_at: now,
        }];
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err: unknown) {
    logger.debug({ err: (err as Error).message }, 'crawler: rss failed');
    return [];
  }
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
          url, url_hash: urlHash(url), category: 'other',
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
       (url_hash, url, category, name, description, http_method, price_sats, source, added_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (url_hash) DO UPDATE SET
       category = EXCLUDED.category,
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       http_method = EXCLUDED.http_method,
       price_sats = EXCLUDED.price_sats,
       source = EXCLUDED.source`,
    [e.url_hash, e.url, e.category, e.name, e.description, e.http_method, e.price_sats, e.source, e.added_at],
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
  const all = (await Promise.all([fromL402Directory(), fromL402Rss(), fromDns()])).flat();
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

  // Probe every endpoint that's been silent for >1h. Cap at 50/tick to keep
  // crawler ticks short.
  const cutoff = Math.floor(Date.now() / 1000) - 3600;
  const { rows } = await pool.query<{ url: string; http_method: 'GET' | 'POST' }>(
    `SELECT url, http_method FROM service_endpoints
       WHERE last_probe_at IS NULL OR last_probe_at < $1
       ORDER BY last_probe_at NULLS FIRST
       LIMIT 50`,
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
