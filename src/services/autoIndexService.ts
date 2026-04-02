// Auto-indexation service — background-index unknown Lightning pubkeys on demand
// Rate limited to prevent abuse (default: 10 per minute)
import type { LndGraphCrawler } from '../crawler/lndGraphCrawler';
import type { AgentRepository } from '../repositories/agentRepository';
import type { ScoringService } from './scoringService';
import { sha256 } from '../utils/crypto';
import { logger } from '../logger';

const LIGHTNING_PUBKEY_RE = /^(02|03)[a-f0-9]{64}$/;

export class AutoIndexService {
  private recentRequests: number[] = [];
  private pendingKeys = new Set<string>();

  constructor(
    private lndGraphCrawler: LndGraphCrawler | null,
    private agentRepo: AgentRepository,
    private scoringService: ScoringService,
    private maxPerMinute: number,
  ) {}

  static isLightningPubkey(value: string): boolean {
    return LIGHTNING_PUBKEY_RE.test(value);
  }

  isPending(pubkey: string): boolean {
    return this.pendingKeys.has(pubkey);
  }

  // Consume a rate slot atomically: returns true if allowed, false if rate limited.
  private consumeRateSlot(): boolean {
    const now = Date.now();
    this.recentRequests = this.recentRequests.filter(t => now - t < 60_000);
    if (this.recentRequests.length >= this.maxPerMinute) return false;
    this.recentRequests.push(now);
    return true;
  }

  // Attempt to auto-index a Lightning pubkey. Returns true if indexing was started.
  // Caller must pass a validated 66-char compressed Lightning pubkey.
  tryAutoIndex(pubkey: string): boolean {
    if (!this.lndGraphCrawler) return false;
    if (!LIGHTNING_PUBKEY_RE.test(pubkey)) return false;
    if (this.pendingKeys.has(pubkey)) return true; // already in progress
    if (!this.consumeRateSlot()) {
      logger.warn({ pubkey: pubkey.slice(0, 16) }, 'Auto-indexation rate limited');
      return false;
    }

    this.pendingKeys.add(pubkey);

    // Fire and forget — index in background
    this.indexInBackground(pubkey).catch(err => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ pubkey: pubkey.slice(0, 16), error: msg }, 'Auto-indexation failed');
    }).finally(() => {
      this.pendingKeys.delete(pubkey);
    });

    return true;
  }

  private async indexInBackground(pubkey: string): Promise<void> {
    if (!this.lndGraphCrawler) return;

    logger.info({ pubkey: pubkey.slice(0, 16) }, 'Auto-indexation started');

    const result = await this.lndGraphCrawler.indexSingleNode(pubkey);

    if (result === 'not_found') {
      logger.info({ pubkey: pubkey.slice(0, 16) }, 'Auto-indexation: node not found in LND graph');
      return;
    }

    // Compute initial score
    const hash = sha256(pubkey);
    this.scoringService.computeScore(hash);

    logger.info({ pubkey: pubkey.slice(0, 16), result }, 'Auto-indexation completed');
  }
}
