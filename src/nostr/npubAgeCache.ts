// Npub age cache for the Tier 2 report bonus gate.
//
// The bonus eligibility rule accepts EITHER:
//   (a) reporter has SatRank score >= REPORT_BONUS_MIN_REPORTER_SCORE, OR
//   (b) a valid NIP-98 signature from an npub that has been known on public
//       relays for >= REPORT_BONUS_MIN_NPUB_AGE_DAYS days.
//
// Rule (b) requires a source of truth for "when was this npub first seen".
// The Stream B zap-mining pipeline (src/nostr/zapMiner.ts) already scrapes
// zap-receipt events from a dozen relays and derives (ln_pubkey, nostr_pubkey)
// mappings. We piggy-back on that: a COMPANION file next to the existing
// `nostr-mappings.json` tracks the earliest-seen timestamp per npub.
//
// Failure mode (no companion file exists yet): the cache is initialized empty
// and every `isAgedNpub` query returns false. Tier 2 then falls back entirely
// to rule (a) — reporters with SatRank score >= 30. This is an intentional
// fail-closed design: we do not fabricate npub age data we do not have.
//
// When the companion file becomes populated (future Stream B enhancement),
// Tier 2 begins admitting NIP-98-signed reports from newly-onboarded users
// who do not yet have a SatRank score but have established Nostr identity.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { logger } from '../logger';

interface NpubAgeFile {
  generated_at?: string;
  /** Map from lowercase hex pubkey to unix timestamp of earliest-seen event. */
  pubkeys: Record<string, number>;
}

export class NpubAgeCache {
  private firstSeen = new Map<string, number>();
  private loadedFromMs = 0;
  private sourcePath: string;
  private autoReloadTimer: NodeJS.Timeout | null = null;

  constructor(sourcePath: string) {
    this.sourcePath = sourcePath;
  }

  /** Schedule periodic reload so Stream B updates (new npubs with older
   *  first-seen timestamps) surface without a process restart (audit M5).
   *  No-op when called twice; safe during tests via stopAutoReload(). */
  startAutoReload(intervalMs = 3600_000): void {
    if (this.autoReloadTimer) return;
    this.autoReloadTimer = setInterval(() => this.reload(), intervalMs);
    this.autoReloadTimer.unref?.();
  }

  /** Stop the background reload timer (for clean test teardown). */
  stopAutoReload(): void {
    if (this.autoReloadTimer) {
      clearInterval(this.autoReloadTimer);
      this.autoReloadTimer = null;
    }
  }

  /** Load (or reload) the companion file. Safe to call repeatedly — we
   *  rebuild the map from scratch so a shrunken input doesn't leave stale
   *  entries. Missing or malformed files are non-fatal: the cache stays empty. */
  reload(): void {
    if (!existsSync(this.sourcePath)) {
      // Expected while Tier 2 is off by default and the file hasn't been
      // produced yet. Do not log at warn — this would be noisy on every boot.
      this.firstSeen = new Map();
      this.loadedFromMs = 0;
      return;
    }
    try {
      const stat = statSync(this.sourcePath);
      if (stat.mtimeMs === this.loadedFromMs) return; // no change
      const raw = readFileSync(this.sourcePath, 'utf8');
      const parsed = JSON.parse(raw) as NpubAgeFile;
      const next = new Map<string, number>();
      if (parsed && typeof parsed === 'object' && parsed.pubkeys && typeof parsed.pubkeys === 'object') {
        for (const [pubkey, ts] of Object.entries(parsed.pubkeys)) {
          if (typeof pubkey === 'string' && /^[a-f0-9]{64}$/i.test(pubkey) && typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
            next.set(pubkey.toLowerCase(), ts);
          }
        }
      }
      this.firstSeen = next;
      this.loadedFromMs = stat.mtimeMs;
      logger.info({ path: this.sourcePath, count: next.size }, 'Npub age cache reloaded');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ path: this.sourcePath, error: msg }, 'Failed to load npub age cache — keeping current state');
    }
  }

  /** Returns true when we have seen this pubkey at least `minAgeDays` ago.
   *  Fails closed: unknown pubkeys and unparseable data return false. */
  isAgedNpub(pubkey: string, minAgeDays: number): boolean {
    const key = pubkey.toLowerCase();
    const firstSeen = this.firstSeen.get(key);
    if (!firstSeen) return false;
    const now = Math.floor(Date.now() / 1000);
    return (now - firstSeen) >= minAgeDays * 86400;
  }

  /** Exposed for /api/health-style introspection. */
  size(): number {
    return this.firstSeen.size;
  }
}
