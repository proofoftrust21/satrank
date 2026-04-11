// Nostr-indexed publisher — publishes NIP-85 kind 30382 events indexed by
// Nostr pubkey (d-tag = nostr pubkey), built from mined zap-receipt mappings.
//
// Extracted from scripts/nostr-publish-nostr-indexed.ts into a reusable
// class that accepts repository dependencies instead of opening the DB
// directly.

import { webcrypto } from 'node:crypto';
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto: unknown }).crypto = webcrypto;
}
import { existsSync, readFileSync, statSync } from 'node:fs';
import { hexToBytes } from '@noble/hashes/utils';
// @ts-expect-error — ESM subpath
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
// @ts-expect-error — ESM subpath
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WS = require('ws');
useWebSocketImplementation(WS);

import type { AgentRepository } from '../repositories/agentRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { Agent } from '../types';
import { logger } from '../logger';
import { VERDICT_SAFE_THRESHOLD } from '../config/scoring';

const KIND_TRUSTED_ASSERTION = 30382;

const CONNECT_TIMEOUT_MS = 10_000;
const PUBLISH_TIMEOUT_MS = 5_000;

// ─── Custodial alias patterns ────────────────────────────────────────
// Case-insensitive substring match. An alias matching any of these is
// almost certainly a custodial wallet / LSP / infrastructure node, not a
// personal self-hosted operator.
const CUSTODIAL_ALIAS_PATTERNS: RegExp[] = [
  /\bwallet of satoshi\b/i, /\bwos\b/i,
  /\balby\b/i, /\bgetalby/i,
  /\bstrike\b/i,
  /\.cash\b/i, /\bcashu\b/i, /\bmint\b/i, /\becash\b/i,
  /\bminibits\b/i,
  /\bzeus\b/i, /^zlnd\d*/i, /^lndus\d*/i, /^lndeu\d*/i, /^lndap\d*/i,
  /\bzaphq\b/i, /\bzap wallet\b/i,
  /\bolympus\b/i,
  /\bcoordinator\b/i, /\blsp\b/i,
  /\bphoenix\b/i, /\bbreez\b/i, /\bmuun\b/i,
  /\bprimal\b/i, /\bnwc\b/i,
  /\bfountain\b/i, /\bnostr wallet\b/i,
  /\bwavlake\b/i, /\bfedi\b/i,
  /\bfewsats\b/i, /\blightspark\b/i, /\bvoltage\b/i,
];

/** Returns true if the alias matches a known custodial / LSP pattern. */
export function looksCustodial(alias: string | null | undefined): boolean {
  if (!alias) return false;
  return CUSTODIAL_ALIAS_PATTERNS.some((rx) => rx.test(alias));
}

// ─── Mining JSON shape ───────────────────────────────────────────────

interface MiningOutput {
  generated_at: string;
  relays_used: string[];
  receipts_scanned: number;
  receipts_decodable: number;
  distinct_ln_pks: number;
  custodial_threshold: number;
  ln_pk_distribution: Record<string, number>;
  self_hosted_mappings: Array<{
    ln_pubkey: string;
    nostr_pubkeys: string[];
    zap_count: number;
  }>;
}

// ─── Options & result types ──────────────────────────────────────────

export interface NostrIndexedPublisherOptions {
  privateKeyHex: string;
  relays: string[];
  minScore?: number;           // default 30
  mappingsPath: string;        // path to nostr-mappings.json
  interEventDelayMs?: number;  // default 300
  allowSharedLnpk?: boolean;   // default false
}

export interface PublishResult {
  published: number;
  errors: number;
  dropped: Record<string, number>;
  skipped?: 'no_mappings' | 'stale_mappings';
}

// ─── Internal candidate shape ────────────────────────────────────────

interface PublishCandidate {
  nostrPubkey: string;
  lnPubkey: string;
  alias: string;
  score: number;
  components: { volume: number; reputation: number; seniority: number; regularity: number; diversity: number };
  zapCount: number;
}

// ─── Publisher class ─────────────────────────────────────────────────

export class NostrIndexedPublisher {
  private readonly skHex: string;
  private readonly relays: string[];
  private readonly minScore: number;
  private readonly mappingsPath: string;
  private readonly interEventDelayMs: number;
  private readonly allowSharedLnpk: boolean;

  constructor(
    private readonly agentRepo: AgentRepository,
    private readonly snapshotRepo: SnapshotRepository,
    options: NostrIndexedPublisherOptions,
  ) {
    this.skHex = options.privateKeyHex;
    this.relays = options.relays;
    this.minScore = options.minScore ?? 30;
    this.mappingsPath = options.mappingsPath;
    this.interEventDelayMs = options.interEventDelayMs ?? 300;
    this.allowSharedLnpk = options.allowSharedLnpk ?? false;
  }

  /**
   * Read the mining JSON, filter candidates through DB lookups, build
   * kind 30382 events, sign, and publish to relays.
   */
  async publishFromMiningJson(): Promise<PublishResult> {
    // ── 1. Validate mappings file ──────────────────────────────────
    if (!existsSync(this.mappingsPath)) {
      logger.error({ path: this.mappingsPath }, 'Mappings file not found');
      return { published: 0, errors: 0, dropped: {}, skipped: 'no_mappings' };
    }

    const fileStat = statSync(this.mappingsPath);
    const fileAgeMs = Date.now() - fileStat.mtimeMs;
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    if (fileAgeMs > THIRTY_DAYS_MS) {
      logger.error(
        { path: this.mappingsPath, ageMs: fileAgeMs },
        'Mappings file is older than 30 days — refusing to publish stale data',
      );
      return { published: 0, errors: 0, dropped: {}, skipped: 'stale_mappings' };
    }

    if (fileAgeMs > SEVEN_DAYS_MS) {
      logger.warn(
        { path: this.mappingsPath, ageMs: fileAgeMs },
        'Mappings file is older than 7 days — proceeding with caution',
      );
    }

    const mining: MiningOutput = JSON.parse(readFileSync(this.mappingsPath, 'utf8'));
    logger.info(
      { mappings: mining.self_hosted_mappings.length, generatedAt: mining.generated_at },
      'Loaded mining output',
    );

    // ── 2. Load agents from DB ─────────────────────────────────────
    const agents = this.agentRepo.findScoredAbove(this.minScore);
    const agentByPk = new Map<string, Agent>();
    for (const a of agents) {
      if (a.public_key) agentByPk.set(a.public_key, a);
    }
    logger.info({ agents: agentByPk.size, minScore: this.minScore }, 'Loaded scored agents from DB');

    // ── 3. Filter candidates ───────────────────────────────────────
    const candidates: PublishCandidate[] = [];
    const dropped: Record<string, number> = {
      not_in_db: 0,
      stale: 0,
      zero_score: 0,
      below_min: 0,
      no_snapshot: 0,
      custodial_alias: 0,
      shared_ln_pk: 0,
    };

    for (const mapping of mining.self_hosted_mappings) {
      const agent = agentByPk.get(mapping.ln_pubkey);
      if (!agent) { dropped.not_in_db++; continue; }
      if (agent.stale === 1) { dropped.stale++; continue; }
      if (agent.avg_score === 0) { dropped.zero_score++; continue; }
      if (agent.avg_score < this.minScore) { dropped.below_min++; continue; }

      const snap = this.snapshotRepo.findLatestByAgent(agent.public_key_hash);
      if (!snap) { dropped.no_snapshot++; continue; }
      if (looksCustodial(agent.alias)) { dropped.custodial_alias++; continue; }

      // Shared LN pubkey filter: default rejects >1 nostr pk per ln pk.
      // allowSharedLnpk relaxes to <=5 (the mining's self_hosted_mappings upper bound).
      if (!this.allowSharedLnpk && mapping.nostr_pubkeys.length > 1) { dropped.shared_ln_pk++; continue; }
      if (this.allowSharedLnpk && mapping.nostr_pubkeys.length > 5) { dropped.shared_ln_pk++; continue; }

      let components = { volume: 0, reputation: 0, seniority: 0, regularity: 0, diversity: 0 };
      try { components = JSON.parse(snap.components); } catch { /* keep defaults */ }

      for (const nostrPubkey of mapping.nostr_pubkeys) {
        candidates.push({
          nostrPubkey,
          lnPubkey: mapping.ln_pubkey,
          alias: agent.alias ?? mapping.ln_pubkey.slice(0, 16),
          score: Math.round(agent.avg_score),
          components,
          zapCount: mapping.zap_count,
        });
      }
    }

    logger.info(
      { candidates: candidates.length, dropped },
      'Candidate filtering complete',
    );

    if (candidates.length === 0) {
      logger.info('No candidates pass filters — nothing to publish');
      return { published: 0, errors: 0, dropped };
    }

    // ── 4. Build & sign events ─────────────────────────────────────
    const sk = hexToBytes(this.skHex);
    const signerPubkey = getPublicKey(sk);
    logger.info({ signerPubkey }, 'Signing events');

    interface SignedEvent {
      kind: number;
      created_at: number;
      tags: string[][];
      content: string;
      pubkey: string;
      id: string;
      sig: string;
    }

    const events: SignedEvent[] = [];
    for (const c of candidates) {
      const verdict =
        c.score >= VERDICT_SAFE_THRESHOLD ? 'SAFE' : c.score >= 30 ? 'UNKNOWN' : 'RISKY';
      const template = {
        kind: KIND_TRUSTED_ASSERTION,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', c.nostrPubkey],
          ['rank', String(c.score)],
          ['ln_pubkey', c.lnPubkey],
          ['subject_type', 'mined_mapping'],
          ['source', 'nip57_zap_receipt'],
          ['zap_count', String(c.zapCount)],
          ['alias', c.alias],
          ['score', String(c.score)],
          ['verdict', verdict],
          ['volume', String(c.components.volume)],
          ['reputation', String(c.components.reputation)],
          ['seniority', String(c.components.seniority)],
          ['regularity', String(c.components.regularity)],
          ['diversity', String(c.components.diversity)],
        ],
        content: '',
      };
      events.push(finalizeEvent(template, sk) as SignedEvent);
    }

    logger.info({ events: events.length }, 'Built signed kind 30382 events');

    // ── 5. Connect to relays ───────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connections: { relay: any; url: string }[] = [];
    for (const url of this.relays) {
      try {
        const relay = await Promise.race([
          Relay.connect(url),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Connection timeout')), CONNECT_TIMEOUT_MS),
          ),
        ]);
        connections.push({ relay, url });
        logger.info({ relay: url }, 'Nostr relay connected');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ relay: url, error: msg }, 'Nostr relay connection failed — skipping');
      }
    }

    if (connections.length === 0) {
      logger.error('No Nostr relays connected — aborting publish');
      return { published: 0, errors: events.length, dropped };
    }

    logger.info(
      { connected: connections.length, total: this.relays.length },
      'Nostr relay connections established',
    );

    // ── 6. Publish with throttle ───────────────────────────────────
    let published = 0;
    let errors = 0;
    const cycleStartMs = Date.now();

    for (const ev of events) {
      try {
        // Publish to all connected relays in parallel with timeout
        const results = await Promise.allSettled(
          connections.map(async ({ url, relay }) => {
            try {
              await Promise.race([
                relay.publish(ev),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('publish timeout')), PUBLISH_TIMEOUT_MS),
                ),
              ]);
              return { url, ok: true };
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              return { url, ok: false, error: msg };
            }
          }),
        );

        const okCount = results.filter(
          (r) => r.status === 'fulfilled' && (r.value as { ok: boolean }).ok,
        ).length;

        if (okCount > 0) {
          published++;
        } else {
          errors++;
          if (errors <= 5) {
            logger.warn(
              { dTag: ev.tags.find((t) => t[0] === 'd')?.[1]?.slice(0, 16) },
              'Failed to publish event to any relay',
            );
          }
        }

        // Sustained inter-event delay (skip after last event)
        if (published + errors < events.length && this.interEventDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.interEventDelayMs));
        }

        // Progress log every 500 events
        if ((published + errors) % 500 === 0 && (published + errors) > 0) {
          const elapsedSec = (Date.now() - cycleStartMs) / 1000;
          const rate = (published + errors) / Math.max(elapsedSec, 0.001);
          logger.info(
            { published, errors, total: events.length, elapsedSec: Math.round(elapsedSec), eventsPerSec: rate.toFixed(2) },
            'Nostr indexed publish progress',
          );
        }
      } catch (err: unknown) {
        errors++;
        if (errors <= 5) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ error: msg }, 'Failed to sign/publish Nostr indexed event');
        }
      }
    }

    // ── 7. Close connections ───────────────────────────────────────
    for (const { relay, url } of connections) {
      try { relay.close(); } catch { logger.warn({ relay: url }, 'Failed to close relay connection'); }
    }

    logger.info(
      { published, errors, dropped, relays: connections.length },
      'Nostr indexed publish complete',
    );

    return { published, errors, dropped };
  }
}
