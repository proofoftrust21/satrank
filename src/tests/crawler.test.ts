// Observer Protocol crawler tests with mocked client
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { Crawler } from '../crawler/crawler';
import { sha256 } from '../utils/crypto';
import type { ObserverClient, ObserverHealthResponse, ObserverTransactionsResponse, ObserverEvent } from '../crawler/types';

function makeEvent(overrides: Partial<ObserverEvent> = {}): ObserverEvent {
  return {
    event_id: `evt-${Math.random().toString(36).slice(2, 10)}`,
    event_type: 'payment.executed',
    protocol: 'lightning',
    transaction_hash: `txhash-${Math.random().toString(36).slice(2, 14)}`,
    time_window: '2026-03-28',
    amount_bucket: 'small',
    amount_sats: 1000,
    direction: 'outbound',
    service_description: null,
    preimage: sha256('preimage'),
    counterparty_id: 'counterparty-bob',
    verified: true,
    created_at: '2026-03-28T12:00:00Z',
    agent_alias: 'alice-agent',
    ...overrides,
  };
}

// Mock Observer Protocol client
class MockObserverClient implements ObserverClient {
  healthResponse: ObserverHealthResponse = { status: 'ok' };
  transactionsResponse: ObserverTransactionsResponse = { transactions: [], events: [], total: 0 };
  healthCalls = 0;
  transactionsCalls = 0;
  shouldFailHealth = false;
  shouldFailTransactions = false;

  async fetchHealth(): Promise<ObserverHealthResponse> {
    this.healthCalls++;
    if (this.shouldFailHealth) throw new Error('Connection refused');
    return this.healthResponse;
  }

  async fetchTransactions(): Promise<ObserverTransactionsResponse> {
    this.transactionsCalls++;
    if (this.shouldFailTransactions) throw new Error('Server error');
    return this.transactionsResponse;
  }
}

describe('Crawler', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;
  let txRepo: TransactionRepository;
  let mockClient: MockObserverClient;
  let crawler: Crawler;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    agentRepo = new AgentRepository(db);
    txRepo = new TransactionRepository(db);
    mockClient = new MockObserverClient();
    crawler = new Crawler(mockClient, agentRepo, txRepo);
  });

  afterEach(() => {
    db.close();
  });

  it('cancels crawl if health check fails', async () => {
    mockClient.shouldFailHealth = true;

    const result = await crawler.run();

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Health check');
    expect(result.eventsFetched).toBe(0);
    expect(mockClient.transactionsCalls).toBe(0);
  });

  it('indexes events and creates agents from aliases', async () => {
    const ev1 = makeEvent({ transaction_hash: 'tx-001', agent_alias: 'alice', counterparty_id: 'bob', direction: 'outbound' });
    const ev2 = makeEvent({ transaction_hash: 'tx-002', agent_alias: 'alice', counterparty_id: 'charlie', direction: 'inbound' });

    mockClient.transactionsResponse = {
      transactions: [ev1, ev2],
      events: [],
      total: 2,
    };

    const result = await crawler.run();

    expect(result.eventsFetched).toBe(2);
    expect(result.newTransactions).toBe(2);
    expect(result.newAgents).toBe(3); // alice, bob, charlie

    // Alice agent has alias set, timestamps from created_at
    const alice = agentRepo.findByHash(sha256('alice'));
    expect(alice).toBeDefined();
    expect(alice!.alias).toBe('alice');
    expect(alice!.source).toBe('observer_protocol');
    expect(alice!.total_transactions).toBe(2);
    const expectedTs = Math.floor(new Date('2026-03-28T12:00:00Z').getTime() / 1000);
    expect(alice!.first_seen).toBe(expectedTs);
    expect(alice!.last_seen).toBe(expectedTs);

    // Bob agent (counterparty) has no alias
    const bob = agentRepo.findByHash(sha256('bob'));
    expect(bob).toBeDefined();
    expect(bob!.alias).toBeNull();

    // Transaction stored with correct sender/receiver
    const storedTx = txRepo.findById('tx-001');
    expect(storedTx).toBeDefined();
    expect(storedTx!.sender_hash).toBe(sha256('alice')); // outbound = alice is sender
    expect(storedTx!.receiver_hash).toBe(sha256('bob'));
    expect(storedTx!.status).toBe('verified');
  });

  it('maps direction correctly (inbound = agent is receiver)', async () => {
    const ev = makeEvent({
      transaction_hash: 'tx-inbound',
      agent_alias: 'alice',
      counterparty_id: 'bob',
      direction: 'inbound',
    });

    mockClient.transactionsResponse = { transactions: [ev], events: [], total: 1 };

    await crawler.run();

    const tx = txRepo.findById('tx-inbound');
    expect(tx!.sender_hash).toBe(sha256('bob'));      // bob sent
    expect(tx!.receiver_hash).toBe(sha256('alice'));   // alice received
  });

  it('deduplicates by transaction_hash', async () => {
    const ev = makeEvent({ transaction_hash: 'tx-dup', agent_alias: 'alice', counterparty_id: 'bob' });

    mockClient.transactionsResponse = { transactions: [ev], events: [], total: 1 };

    const first = await crawler.run();
    expect(first.newTransactions).toBe(1);

    // Second crawl with same transaction_hash
    const second = await crawler.run();
    expect(second.newTransactions).toBe(0);
    expect(second.eventsFetched).toBe(1);
  });

  it('deduplicates across transactions and events arrays', async () => {
    const ev = makeEvent({ transaction_hash: 'tx-both', agent_alias: 'alice', counterparty_id: 'bob' });

    // Same event in both arrays
    mockClient.transactionsResponse = {
      transactions: [ev],
      events: [{ ...ev, event_id: 'evt-different' }],
      total: 1,
    };

    const result = await crawler.run();
    expect(result.eventsFetched).toBe(1); // Deduped to 1
    expect(result.newTransactions).toBe(1);
  });

  it('does not recreate existing agents', async () => {
    const aliceHash = sha256('alice');

    agentRepo.insert({
      public_key_hash: aliceHash,
      public_key: null,
      alias: 'alice-custom',
      first_seen: 1000000,
      last_seen: 1000000,
      source: 'manual',
      total_transactions: 5,
      total_attestations_received: 0,
      avg_score: 42,
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

    const ev = makeEvent({ transaction_hash: 'tx-existing', agent_alias: 'alice', counterparty_id: 'dave' });
    mockClient.transactionsResponse = { transactions: [ev], events: [], total: 1 };

    const result = await crawler.run();

    expect(result.newAgents).toBe(1); // Only dave
    expect(result.newTransactions).toBe(1);

    const alice = agentRepo.findByHash(aliceHash);
    expect(alice!.alias).toBe('alice-custom'); // Keeps existing alias
    expect(alice!.source).toBe('manual');
    expect(alice!.total_transactions).toBe(6);
  });

  it('sets first_seen/last_seen from earliest/latest created_at', async () => {
    const early = makeEvent({
      transaction_hash: 'tx-early',
      agent_alias: 'alice',
      counterparty_id: 'bob',
      created_at: '2026-01-01T00:00:00Z',
    });
    const late = makeEvent({
      transaction_hash: 'tx-late',
      agent_alias: 'alice',
      counterparty_id: 'bob',
      created_at: '2026-06-15T00:00:00Z',
    });

    mockClient.transactionsResponse = { transactions: [late, early], events: [], total: 2 };

    await crawler.run();

    const alice = agentRepo.findByHash(sha256('alice'));
    expect(alice!.first_seen).toBe(Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000));
    expect(alice!.last_seen).toBe(Math.floor(new Date('2026-06-15T00:00:00Z').getTime() / 1000));
  });

  it('maps protocol values correctly', async () => {
    const tests: Array<{ protocol: string; expected: string }> = [
      { protocol: 'lightning', expected: 'bolt11' },
      { protocol: 'L402', expected: 'l402' },
      { protocol: 'x402', expected: 'l402' },
      { protocol: 'x402_stacks', expected: 'l402' },
      { protocol: 'x402_stripe', expected: 'l402' },
    ];

    for (const { protocol, expected } of tests) {
      const ev = makeEvent({
        transaction_hash: `tx-proto-${protocol}`,
        agent_alias: `agent-${protocol}`,
        counterparty_id: `cp-${protocol}`,
        protocol,
      });
      mockClient.transactionsResponse = { transactions: [ev], events: [], total: 1 };

      await crawler.run();

      const tx = txRepo.findById(`tx-proto-${protocol}`);
      expect(tx!.protocol).toBe(expected);
    }
  });

  it('maps verified boolean to status', async () => {
    const verified = makeEvent({ transaction_hash: 'tx-v', agent_alias: 'a1', counterparty_id: 'c1', verified: true });
    const pending = makeEvent({ transaction_hash: 'tx-p', agent_alias: 'a2', counterparty_id: 'c2', verified: false });

    mockClient.transactionsResponse = { transactions: [verified, pending], events: [], total: 2 };

    await crawler.run();

    expect(txRepo.findById('tx-v')!.status).toBe('verified');
    expect(txRepo.findById('tx-p')!.status).toBe('pending');
  });

  it('stops if fetchTransactions fails', async () => {
    mockClient.shouldFailTransactions = true;

    const result = await crawler.run();

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Fetch failed');
    expect(mockClient.transactionsCalls).toBe(1);
  });

  it('skips events without agent_alias', async () => {
    const noAlias = makeEvent({ transaction_hash: 'tx-no-alias', agent_alias: null, counterparty_id: 'bob' });
    const withAlias = makeEvent({ transaction_hash: 'tx-ok', agent_alias: 'alice', counterparty_id: 'bob' });

    mockClient.transactionsResponse = { transactions: [noAlias, withAlias], events: [], total: 2 };

    const result = await crawler.run();

    expect(result.newTransactions).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('Missing agent_alias');
  });
});
