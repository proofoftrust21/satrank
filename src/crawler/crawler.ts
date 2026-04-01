// Orchestrates transaction indexing from Observer Protocol
// Pulls new transactions, creates unknown agents, avoids duplicates
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import type { AgentRepository } from '../repositories/agentRepository';
import type { TransactionRepository } from '../repositories/transactionRepository';
import type { ObserverClient, ObserverTransaction, CrawlResult } from './types';
import type { AmountBucket, TransactionStatus, PaymentProtocol } from '../types';
import { logger } from '../logger';

const HEX64 = /^[a-f0-9]{64}$/;

// Validate critical fields before database insertion
const observerTxSchema = z.object({
  transaction_id: z.string().uuid(),
  sender_public_key_hash: z.string().regex(HEX64, 'sender_hash must be a SHA256 hex (64 chars)'),
  receiver_public_key_hash: z.string().regex(HEX64, 'receiver_hash must be a SHA256 hex (64 chars)'),
  receipt_hash: z.string().regex(HEX64, 'receipt_hash must be a SHA256 hex (64 chars)'),
  settlement_reference: z.string().max(128).nullable(),
  timestamp: z.number().int().positive(),
  amount_bucket: z.string().min(1).max(20),
  status: z.string().min(1).max(20),
  payment_rail: z.string().min(1).max(50),
  signature: z.string().min(1).max(512),
});

const BATCH_SIZE = 100; // Transactions per page

export class Crawler {
  constructor(
    private client: ObserverClient,
    private agentRepo: AgentRepository,
    private txRepo: TransactionRepository,
  ) {}

  // Runs a complete crawl
  async run(): Promise<CrawlResult> {
    const startedAt = Math.floor(Date.now() / 1000);
    const result: CrawlResult = {
      startedAt,
      finishedAt: 0,
      transactionsFetched: 0,
      newTransactions: 0,
      newAgents: 0,
      errors: [],
    };

    // Check API availability
    try {
      const health = await this.client.fetchHealth();
      logger.info({ status: health.status }, 'Observer Protocol available');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Health check failed: ${msg}`);
      result.finishedAt = Math.floor(Date.now() / 1000);
      logger.error({ error: msg }, 'Observer Protocol unavailable, crawl cancelled');
      return result;
    }

    // Paginate transactions until exhaustion
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      try {
        const trends = await this.client.fetchTrends(page, BATCH_SIZE);
        result.transactionsFetched += trends.transactions.length;

        for (const observerTx of trends.transactions) {
          try {
            const indexed = this.indexTransaction(observerTx, startedAt);
            if (indexed.newTx) result.newTransactions++;
            result.newAgents += indexed.newAgents;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(`tx ${observerTx.transaction_id}: ${msg}`);
          }
        }

        hasMore = trends.has_more;
        page++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Page ${page}: ${msg}`);
        logger.error({ page, error: msg }, 'Error fetching trends');
        break; // Stop pagination on error
      }
    }

    result.finishedAt = Math.floor(Date.now() / 1000);
    logger.info({
      duration: result.finishedAt - result.startedAt,
      fetched: result.transactionsFetched,
      newTx: result.newTransactions,
      newAgents: result.newAgents,
      errors: result.errors.length,
    }, 'Crawl finished');

    return result;
  }

  // Indexes an Observer Protocol transaction into SatRank
  private indexTransaction(
    observerTx: ObserverTransaction,
    now: number,
  ): { newTx: boolean; newAgents: number } {
    // Validate field format before any insertion
    const validated = observerTxSchema.safeParse(observerTx);
    if (!validated.success) {
      throw new Error(`Invalid Observer data: ${validated.error.errors.map(e => e.message).join(', ')}`);
    }

    let newAgents = 0;

    const tx = validated.data;

    // Check if the transaction already exists (deduplication by tx_id)
    const existing = this.txRepo.findById(tx.transaction_id);
    if (existing) {
      return { newTx: false, newAgents: 0 };
    }

    // Create unknown agents
    newAgents += this.ensureAgent(tx.sender_public_key_hash, now);
    newAgents += this.ensureAgent(tx.receiver_public_key_hash, now);

    // Map and insert the transaction — uses Zod-validated data
    this.txRepo.insert({
      tx_id: tx.transaction_id,
      sender_hash: tx.sender_public_key_hash,
      receiver_hash: tx.receiver_public_key_hash,
      amount_bucket: this.mapAmountBucket(tx.amount_bucket),
      timestamp: tx.timestamp,
      payment_hash: tx.receipt_hash,
      preimage: tx.settlement_reference ?? null,
      status: this.mapStatus(tx.status),
      protocol: this.mapProtocol(tx.payment_rail),
    });

    // Update agents' last_seen and total_transactions
    this.updateAgentActivity(tx.sender_public_key_hash, tx.timestamp);
    this.updateAgentActivity(tx.receiver_public_key_hash, tx.timestamp);

    return { newTx: true, newAgents };
  }

  // Creates an agent if it doesn't exist yet — returns 1 if created, 0 otherwise
  private ensureAgent(publicKeyHash: string, now: number): number {
    const existing = this.agentRepo.findByHash(publicKeyHash);
    if (existing) return 0;

    this.agentRepo.insert({
      public_key_hash: publicKeyHash,
      alias: null,
      first_seen: now,
      last_seen: now,
      source: 'observer_protocol',
      total_transactions: 0,
      total_attestations_received: 0,
      avg_score: 0,
    });

    logger.debug({ publicKeyHash }, 'New agent created from Observer Protocol');
    return 1;
  }

  // Updates last_seen and increments total_transactions
  private updateAgentActivity(agentHash: string, timestamp: number): void {
    const agent = this.agentRepo.findByHash(agentHash);
    if (!agent) return;

    const newLastSeen = Math.max(agent.last_seen, timestamp);
    this.agentRepo.updateStats(
      agentHash,
      agent.total_transactions + 1,
      agent.total_attestations_received,
      agent.avg_score,
      newLastSeen,
    );
  }

  // Maps Observer amount_bucket -> SatRank
  private mapAmountBucket(bucket: string): AmountBucket {
    const normalized = bucket.toLowerCase();
    if (['micro', 'small', 'medium', 'large'].includes(normalized)) {
      return normalized as AmountBucket;
    }
    return 'small'; // Default if unknown format
  }

  // Maps Observer status -> SatRank
  private mapStatus(status: string): TransactionStatus {
    const map: Record<string, TransactionStatus> = {
      'VERIFIED': 'verified',
      'PENDING': 'pending',
      'FAILED': 'failed',
      'DISPUTED': 'disputed',
    };
    return map[status.toUpperCase()] ?? 'pending';
  }

  // Maps Observer payment_rail -> SatRank protocol
  private mapProtocol(rail: string): PaymentProtocol {
    const normalized = rail.toLowerCase();
    if (normalized.includes('l402')) return 'l402';
    if (normalized.includes('keysend')) return 'keysend';
    return 'bolt11'; // Lightning default
  }
}
