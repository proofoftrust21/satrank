// Orchestrates transaction indexing from Observer Protocol
// Pulls events, creates agents from aliases, avoids duplicates
import { z } from 'zod';
import type { AgentRepository } from '../repositories/agentRepository';
import type { DualWriteMode, TransactionRepository } from '../repositories/transactionRepository';
import type { BayesianScoringService } from '../services/bayesianScoringService';
import type { ObserverClient, ObserverEvent, CrawlResult } from './types';
import type { AmountBucket, TransactionStatus, PaymentProtocol } from '../types';
import { sha256 } from '../utils/crypto';
import { logger } from '../logger';
import { windowBucket, type DualWriteLogger } from '../utils/dualWriteLogger';

// Validate critical fields before processing
const observerEventSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  protocol: z.string().min(1),
  transaction_hash: z.string().min(1),
  time_window: z.string().min(1),
  amount_bucket: z.string().min(1),
  amount_sats: z.number().nonnegative(),
  direction: z.enum(['inbound', 'outbound']),
  service_description: z.string().nullable(),
  preimage: z.string().nullable(),
  counterparty_id: z.string().nullable(),
  verified: z.boolean(),
  created_at: z.string().min(1),
  agent_alias: z.string().nullable(),
});

export class Crawler {
  constructor(
    private client: ObserverClient,
    private agentRepo: AgentRepository,
    private txRepo: TransactionRepository,
    /** Phase 1 rollout knob. Defaults to `off` so existing test fixtures that
     *  construct `new Crawler(client, agents, txs)` keep the legacy INSERT
     *  path without wiring logger plumbing. Flip to `dry_run`/`active` in
     *  prod by reading TRANSACTIONS_DUAL_WRITE_MODE from config. */
    private dualWriteMode: DualWriteMode = 'off',
    private dualWriteLogger?: DualWriteLogger,
    /** Phase 3 C8 : quand fourni, chaque event ingère une observation dans les
     *  daily_buckets bayesiens avec source='observer'. Le CHECK SQL sur
     *  streaming_posteriors rejette observer — pas de contamination du signal
     *  de verdict, mais l'activité reste visible dans recent_activity + risk_profile
     *  (display only). Optionnel pour rétro-compat avec les tests qui n'ont
     *  pas besoin du pipeline bayésien. */
    private bayesian?: BayesianScoringService,
  ) {}

  async run(): Promise<CrawlResult> {
    const startedAt = Math.floor(Date.now() / 1000);
    const result: CrawlResult = {
      startedAt,
      finishedAt: 0,
      eventsFetched: 0,
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

    try {
      const response = await this.client.fetchTransactions();

      // Combine transactions + events arrays, dedup by transaction_hash
      const allEvents = [...response.transactions, ...response.events];
      const seen = new Set<string>();
      const dedupedEvents: ObserverEvent[] = [];
      for (const ev of allEvents) {
        if (!seen.has(ev.transaction_hash)) {
          seen.add(ev.transaction_hash);
          dedupedEvents.push(ev);
        }
      }

      result.eventsFetched = dedupedEvents.length;

      for (const event of dedupedEvents) {
        try {
          const indexed = await this.indexEvent(event);
          if (indexed.newTx) result.newTransactions++;
          result.newAgents += indexed.newAgents;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`event ${event.event_id}: ${msg}`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Fetch failed: ${msg}`);
      logger.error({ error: msg }, 'Error fetching transactions');
    }

    result.finishedAt = Math.floor(Date.now() / 1000);
    logger.info({
      duration: result.finishedAt - result.startedAt,
      fetched: result.eventsFetched,
      newTx: result.newTransactions,
      newAgents: result.newAgents,
      errors: result.errors.length,
    }, 'Crawl finished');

    return result;
  }

  private async indexEvent(
    event: ObserverEvent,
  ): Promise<{ newTx: boolean; newAgents: number }> {
    const validated = observerEventSchema.safeParse(event);
    if (!validated.success) {
      throw new Error(`Invalid Observer data: ${validated.error.errors.map(e => e.message).join(', ')}`);
    }

    const ev = validated.data;

    // Must have agent_alias to identify the agent
    if (!ev.agent_alias) {
      throw new Error('Missing agent_alias');
    }

    // Deduplicate by transaction_hash (our tx_id)
    const existing = await this.txRepo.findById(ev.transaction_hash);
    if (existing) {
      return { newTx: false, newAgents: 0 };
    }

    // Parse timestamp from created_at (ISO datetime) — used for first_seen/last_seen
    const timestamp = Math.floor(new Date(ev.created_at).getTime() / 1000);

    let newAgents = 0;

    // Derive agent hash from alias
    const agentHash = sha256(ev.agent_alias);
    newAgents += await this.ensureAgent(agentHash, ev.agent_alias, timestamp);

    // Derive counterparty hash
    const counterpartyHash = ev.counterparty_id
      ? sha256(ev.counterparty_id)
      : sha256(`unknown-${ev.transaction_hash}`);
    newAgents += await this.ensureAgent(counterpartyHash, null, timestamp);

    // Direction determines sender/receiver
    const senderHash = ev.direction === 'outbound' ? agentHash : counterpartyHash;
    const receiverHash = ev.direction === 'outbound' ? counterpartyHash : agentHash;

    // Observer-origin rows: the crawler never sees the L402 endpoint URL nor
    // the operator pubkey, so those two columns are NULL by contract. Source
    // tag distinguishes Observer-ingested rows from probe/report/intent so the
    // Phase 3 aggregator can weight them. window_bucket is UTC YYYY-MM-DD.
    await this.txRepo.insertWithDualWrite(
      {
        tx_id: ev.transaction_hash,
        sender_hash: senderHash,
        receiver_hash: receiverHash,
        amount_bucket: this.mapAmountBucket(ev.amount_bucket),
        timestamp,
        payment_hash: sha256(ev.transaction_hash),
        preimage: ev.preimage,
        status: ev.verified ? 'verified' : 'pending',
        protocol: this.mapProtocol(ev.protocol),
      },
      {
        endpoint_hash: null,
        operator_id: null,
        source: 'observer',
        window_bucket: windowBucket(timestamp),
      },
      this.dualWriteMode,
      'crawler',
      this.dualWriteLogger,
    );

    // Phase 3 streaming path (C8). Observer bump UNIQUEMENT les daily_buckets
    // (le CHECK SQL sur streaming_posteriors rejette observer). success=verified :
    // un tx preimage-confirmé compte comme succès, les tx 'pending' comme
    // observations de non-succès. Les deux comptent dans n_obs → recent_activity
    // remonte la vraie densité d'échanges autour d'un agent. La pubkey ou URL
    // n'est pas disponible côté Observer, on bump sur le receiver_hash comme
    // proxy d'activité — cohérent avec le modèle agent-centric d'Observer.
    if (this.bayesian) {
      await this.bayesian.ingestStreaming({
        success: ev.verified,
        timestamp,
        source: 'observer',
        nodePubkey: receiverHash,
      });
    }

    await this.updateAgentActivity(senderHash, timestamp);
    await this.updateAgentActivity(receiverHash, timestamp);

    return { newTx: true, newAgents };
  }

  private async ensureAgent(publicKeyHash: string, alias: string | null, eventTimestamp: number): Promise<number> {
    // TOCTOU fix: pre-check before idempotent INSERT. agentRepo.insert uses
    // ON CONFLICT DO NOTHING so parallel crawlers never raise. First-sighting
    // side effects (newAgents counter, debug log) gated on the pre-check result.
    const existing = await this.agentRepo.findByHash(publicKeyHash);
    if (existing) {
      // Update alias if we now have one and the agent didn't before
      if (alias && !existing.alias) {
        await this.agentRepo.updateAlias(publicKeyHash, alias);
      }
      return 0;
    }

    await this.agentRepo.insert({
      public_key_hash: publicKeyHash,
      public_key: null,
      alias,
      first_seen: eventTimestamp,
      last_seen: eventTimestamp,
      source: 'observer_protocol',
      total_transactions: 0,
      total_attestations_received: 0,
      avg_score: 0,
      capacity_sats: null,
      positive_ratings: 0,
      negative_ratings: 0,
      lnplus_rank: 0,
      hubness_rank: 0,
      betweenness_rank: 0,
      hopness_rank: 0,
      unique_peers: null,
      last_queried_at: null,
      query_count: 0,
    });

    logger.debug({ publicKeyHash, alias }, 'New agent created from Observer Protocol');
    return 1;
  }

  private async updateAgentActivity(agentHash: string, timestamp: number): Promise<void> {
    const agent = await this.agentRepo.findByHash(agentHash);
    if (!agent) return;

    const newFirstSeen = Math.min(agent.first_seen, timestamp);
    const newLastSeen = Math.max(agent.last_seen, timestamp);
    await this.agentRepo.updateStats(
      agentHash,
      agent.total_transactions + 1,
      agent.total_attestations_received,
      agent.avg_score,
      newFirstSeen,
      newLastSeen,
    );
  }

  private mapAmountBucket(bucket: string): AmountBucket {
    const normalized = bucket.toLowerCase();
    if (['micro', 'small', 'medium', 'large'].includes(normalized)) {
      return normalized as AmountBucket;
    }
    return 'small';
  }

  private mapProtocol(protocol: string): PaymentProtocol {
    const normalized = protocol.toLowerCase();
    if (normalized === 'lightning') return 'bolt11';
    if (normalized.includes('l402') || normalized.includes('x402')) return 'l402';
    if (normalized.includes('keysend')) return 'keysend';
    return 'bolt11';
  }
}
