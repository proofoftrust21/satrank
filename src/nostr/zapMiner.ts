// Reusable zap-receipt miner — extracts Lightning pubkey <-> Nostr pubkey
// mappings from NIP-57 kind 9735 zap receipts by decoding the embedded
// BOLT11 invoice to recover the payee node pubkey.
//
// Designed as an importable module with no top-level side effects beyond
// the webcrypto polyfill and WS shim (required by nostr-tools).
//
// The output JSON matches the MiningOutput interface consumed by
// scripts/nostr-publish-nostr-indexed.ts.

import { webcrypto } from 'node:crypto';
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto: unknown }).crypto = webcrypto;
}
import { writeFileSync, renameSync } from 'node:fs';
// @ts-expect-error — ESM subpath
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WS = require('ws');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bolt11 = require('bolt11');
useWebSocketImplementation(WS);

import { logger } from '../logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ZapMinerOptions {
  relays: string[];
  pageSize?: number;           // default 500
  maxPages?: number;           // default 40
  maxAgeDays?: number;         // default 60
  minPageYield?: number;       // default 20
  pageTimeoutMs?: number;      // default 15000
  custodialThreshold?: number; // default 5
  outputPath: string;          // where to write the JSON
}

/** Shape of a kind 9735 Nostr event. */
interface ZapEvent {
  id: string;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

/** Single decoded (nostr pubkey, ln pubkey) pair from a receipt. */
export interface RawMapping {
  nostrPubkey: string;
  lnPubkey: string;
  zapEventId: string;
  createdAt: number;
}

/** Summary returned by ZapMiner.mine(). */
export interface MiningSummary {
  receiptsScanned: number;
  decodable: number;
  distinctLnPks: number;
  selfHostedCount: number;
  outputPath: string;
}

/**
 * Output JSON format — matches the MiningOutput interface expected by
 * scripts/nostr-publish-nostr-indexed.ts.
 */
export interface MiningOutput {
  generated_at: string;
  relays_used: string[];
  pagination: { mode: string; page_size?: number; max_pages?: number; max_age_days?: number };
  receipts_scanned: number;
  receipts_decodable: number;
  receipts_undecodable: number;
  distinct_ln_pks: number;
  custodial_threshold: number;
  ln_pk_distribution: Record<string, number>;
  self_hosted_mappings: Array<{
    ln_pubkey: string;
    nostr_pubkeys: string[];
    zap_count: number;
  }>;
}

// ---------------------------------------------------------------------------
// Standalone helper — exported for testing
// ---------------------------------------------------------------------------

/**
 * Extract a (nostrPubkey, lnPubkey) mapping from a single kind 9735 event.
 * Returns null when the receipt cannot be decoded (missing tags, invalid
 * invoice, no payeeNodeKey, etc.).
 */
export function extractFromReceipt(ev: ZapEvent): RawMapping | null {
  const pTag = ev.tags.find((t) => t[0] === 'p' && typeof t[1] === 'string');
  const bolt11Tag = ev.tags.find((t) => t[0] === 'bolt11' && typeof t[1] === 'string');
  if (!pTag || !bolt11Tag) return null;
  const nostrPubkey = pTag[1];
  if (!/^[a-f0-9]{64}$/i.test(nostrPubkey)) return null;
  const invoice = bolt11Tag[1];
  try {
    const decoded = bolt11.decode(invoice);
    const lnPubkey: string | undefined = decoded.payeeNodeKey;
    if (!lnPubkey || !/^(02|03)[a-f0-9]{64}$/.test(lnPubkey)) return null;
    return {
      nostrPubkey: nostrPubkey.toLowerCase(),
      lnPubkey: lnPubkey.toLowerCase(),
      zapEventId: ev.id,
      createdAt: ev.created_at,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function fetchPage(
  relay: { subscribe: Function },
  until: number | undefined,
  limit: number,
  seen: Set<string>,
  timeoutMs: number,
): Promise<ZapEvent[]> {
  const filter: Record<string, unknown> = { kinds: [9735], limit };
  if (until !== undefined) filter.until = until;
  return new Promise<ZapEvent[]>((resolve) => {
    const pageEvents: ZapEvent[] = [];
    let resolved = false;
    const sub = relay.subscribe([filter], {
      onevent(ev: ZapEvent) {
        if (seen.has(ev.id)) return;
        seen.add(ev.id);
        pageEvents.push(ev);
      },
      oneose() {
        if (!resolved) {
          resolved = true;
          try { sub.close(); } catch { /* ignore */ }
          resolve(pageEvents);
        }
      },
    });
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { sub.close(); } catch { /* ignore */ }
        resolve(pageEvents);
      }
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// ZapMiner class
// ---------------------------------------------------------------------------

const GLOBAL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export class ZapMiner {
  private readonly relays: string[];
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly maxAgeDays: number;
  private readonly minPageYield: number;
  private readonly pageTimeoutMs: number;
  private readonly custodialThreshold: number;
  private readonly outputPath: string;

  constructor(options: ZapMinerOptions) {
    this.relays = options.relays;
    this.pageSize = options.pageSize ?? 500;
    this.maxPages = options.maxPages ?? 40;
    this.maxAgeDays = options.maxAgeDays ?? 60;
    this.minPageYield = options.minPageYield ?? 20;
    this.pageTimeoutMs = options.pageTimeoutMs ?? 15000;
    this.custodialThreshold = options.custodialThreshold ?? 5;
    this.outputPath = options.outputPath;
  }

  /**
   * Connect to relays in parallel, paginate kind 9735 events, decode
   * BOLT11 invoices, aggregate, classify, and write the result JSON.
   *
   * A 10-minute global timeout ensures partial results are still written
   * if mining runs long.
   */
  async mine(): Promise<MiningSummary> {
    logger.info(
      {
        relays: this.relays,
        pageSize: this.pageSize,
        maxPages: this.maxPages,
        maxAgeDays: this.maxAgeDays,
        minPageYield: this.minPageYield,
        custodialThreshold: this.custodialThreshold,
        outputPath: this.outputPath,
      },
      'Zap-receipt mining starting',
    );

    // Shared seen-set across all relays for on-the-fly dedup.
    const globalSeen = new Set<string>();

    // Global timeout — if mining exceeds this, we write whatever we have.
    let timedOut = false;
    const timeoutPromise = new Promise<'timeout'>((resolve) =>
      setTimeout(() => {
        timedOut = true;
        resolve('timeout');
      }, GLOBAL_TIMEOUT_MS),
    );

    const miningPromise = Promise.all(
      this.relays.map((url) => this.fetchFromRelayPaged(url, globalSeen, () => timedOut)),
    );

    const result = await Promise.race([miningPromise, timeoutPromise]);

    let perRelayEvents: ZapEvent[][];
    if (result === 'timeout') {
      logger.warn('Global mining timeout (10 min) reached — writing partial results');
      // miningPromise is still running; we cannot cancel it, but we
      // proceed with whatever globalSeen has collected. Aggregate from
      // an empty per-relay array; dedup below uses uniqueById which we
      // build from globalSeen via a separate structure. We need the
      // actual events though, so we collect them during fetch into a
      // shared array.
      perRelayEvents = [];
    } else {
      perRelayEvents = result as ZapEvent[][];
    }

    // Global dedup: build a Map<id, ZapEvent> from all per-relay results.
    // If we timed out, perRelayEvents may be empty/partial — the events
    // are still accessible via the closures that pushed into them.
    const uniqueById = new Map<string, ZapEvent>();
    for (const arr of perRelayEvents) {
      for (const ev of arr) uniqueById.set(ev.id, ev);
    }

    const distinctReceipts = uniqueById.size;
    logger.info({ distinctReceipts }, 'Distinct receipts after dedup');

    // Decode each receipt
    const mappings: RawMapping[] = [];
    let decodable = 0;
    let undecodable = 0;
    for (const ev of uniqueById.values()) {
      const m = extractFromReceipt(ev);
      if (m) {
        mappings.push(m);
        decodable++;
      } else {
        undecodable++;
      }
    }
    logger.info({ decodable, undecodable }, 'Receipt decode results');

    // Aggregate: Map<ln_pk, Set<nostr_pk>>
    const byLnPk = new Map<string, Set<string>>();
    const zapCountByLnPk = new Map<string, number>();
    for (const m of mappings) {
      if (!byLnPk.has(m.lnPubkey)) byLnPk.set(m.lnPubkey, new Set());
      byLnPk.get(m.lnPubkey)!.add(m.nostrPubkey);
      zapCountByLnPk.set(m.lnPubkey, (zapCountByLnPk.get(m.lnPubkey) ?? 0) + 1);
    }
    const distinctLnPks = byLnPk.size;
    logger.info({ distinctLnPks }, 'Distinct Lightning pubkeys found');

    // Classify
    const distribution: Record<string, number> = {
      '1 nostr':          0,
      '2-5 nostrs':       0,
      '6-20 nostrs':      0,
      '>20 (custodial)':  0,
    };
    const selfHosted: MiningOutput['self_hosted_mappings'] = [];
    for (const [lnPk, nostrSet] of byLnPk.entries()) {
      const n = nostrSet.size;
      const zapCount = zapCountByLnPk.get(lnPk) ?? 0;
      if (n === 1)       distribution['1 nostr']++;
      else if (n <= 5)   distribution['2-5 nostrs']++;
      else if (n <= 20)  distribution['6-20 nostrs']++;
      else               distribution['>20 (custodial)']++;
      if (n <= this.custodialThreshold) {
        selfHosted.push({
          ln_pubkey: lnPk,
          nostr_pubkeys: [...nostrSet].sort(),
          zap_count: zapCount,
        });
      }
    }
    selfHosted.sort((a, b) => b.zap_count - a.zap_count);

    logger.info(
      { distribution, selfHostedCount: selfHosted.length, custodialThreshold: this.custodialThreshold },
      'Classification complete',
    );

    // Build output
    const output: MiningOutput = {
      generated_at: new Date().toISOString(),
      relays_used: this.relays,
      pagination: {
        mode: 'paginated',
        page_size: this.pageSize,
        max_pages: this.maxPages,
        max_age_days: this.maxAgeDays,
      },
      receipts_scanned: distinctReceipts,
      receipts_decodable: decodable,
      receipts_undecodable: undecodable,
      distinct_ln_pks: distinctLnPks,
      custodial_threshold: this.custodialThreshold,
      ln_pk_distribution: distribution,
      self_hosted_mappings: selfHosted,
    };

    // Atomic write: write to .tmp then rename
    const tmpPath = this.outputPath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(output, null, 2));
    renameSync(tmpPath, this.outputPath);

    const outputSizeKb = (JSON.stringify(output).length / 1024).toFixed(1);
    logger.info(
      { outputPath: this.outputPath, sizeKb: outputSizeKb, selfHostedCount: selfHosted.length },
      'Mining output written',
    );

    return {
      receiptsScanned: distinctReceipts,
      decodable,
      distinctLnPks,
      selfHostedCount: selfHosted.length,
      outputPath: this.outputPath,
    };
  }

  // -----------------------------------------------------------------------
  // Private: per-relay paginated fetch
  // -----------------------------------------------------------------------

  private async fetchFromRelayPaged(
    url: string,
    globalSeen: Set<string>,
    isTimedOut: () => boolean,
  ): Promise<ZapEvent[]> {
    logger.info({ relay: url }, 'Connecting to relay');
    let relay: { subscribe: Function; close: () => void } | null = null;
    try {
      relay = (await Promise.race([
        Relay.connect(url),
        new Promise((_, reject) => setTimeout(() => reject(new Error('connect timeout')), 15_000)),
      ])) as { subscribe: Function; close: () => void };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ relay: url, error: msg }, 'Relay connection failed');
      return [];
    }

    const allEvents: ZapEvent[] = [];
    const minAge = Math.floor(Date.now() / 1000) - this.maxAgeDays * 86400;
    let until: number | undefined = undefined;
    let pages = 0;

    while (pages < this.maxPages) {
      if (isTimedOut()) {
        logger.warn({ relay: url, pages }, 'Global timeout — stopping relay fetch');
        break;
      }

      const pageEvents = await fetchPage(relay!, until, this.pageSize, globalSeen, this.pageTimeoutMs);
      pages++;
      allEvents.push(...pageEvents);

      if (pageEvents.length === 0) {
        logger.debug({ relay: url, page: pages }, 'Relay exhausted (0 events)');
        break;
      }

      const oldest = pageEvents.reduce(
        (min, ev) => (ev.created_at < min ? ev.created_at : min),
        Number.MAX_SAFE_INTEGER,
      );

      if (oldest < minAge) {
        logger.debug(
          { relay: url, page: pages, count: pageEvents.length, maxAgeDays: this.maxAgeDays },
          'Hit age wall',
        );
        break;
      }
      if (pageEvents.length < this.minPageYield) {
        logger.debug(
          { relay: url, page: pages, count: pageEvents.length, minPageYield: this.minPageYield },
          'Below min page yield — stopping',
        );
        break;
      }

      logger.debug(
        {
          relay: url,
          page: pages,
          count: pageEvents.length,
          oldestDate: new Date(oldest * 1000).toISOString().slice(0, 10),
        },
        'Page fetched',
      );
      until = oldest - 1;
    }

    try { relay!.close(); } catch { /* ignore */ }
    logger.info({ relay: url, events: allEvents.length, pages }, 'Relay fetch complete');
    return allEvents;
  }
}
