// Observer Protocol crawler tests with mocked client
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { Crawler } from '../crawler/crawler';
import type { ObserverClient, ObserverHealthResponse, ObserverTrendsResponse, ObserverTransaction } from '../crawler/types';

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

const NOW = Math.floor(Date.now() / 1000);

function makeObserverTx(id: string, sender: string, receiver: string): ObserverTransaction {
  return {
    transaction_id: id,
    timestamp: NOW - 3600,
    payment_rail: 'lightning',
    sender_public_key_hash: sender,
    receiver_public_key_hash: receiver,
    amount_bucket: 'small',
    settlement_reference: sha256(`preimage-${id}`),
    receipt_hash: sha256(`receipt-${id}`),
    signature: sha256(`sig-${id}`),
    status: 'VERIFIED',
  };
}

// Generate stable UUIDs by test name for tx_ids
const txIds: Record<string, string> = {};
function txId(name: string): string {
  if (!txIds[name]) txIds[name] = uuid();
  return txIds[name];
}

// Mock Observer Protocol client
class MockObserverClient implements ObserverClient {
  healthResponse: ObserverHealthResponse = { status: 'ok' };
  trendsPages: ObserverTrendsResponse[] = [];
  healthCalls = 0;
  trendsCalls = 0;
  shouldFailHealth = false;
  shouldFailTrends = false;

  async fetchHealth(): Promise<ObserverHealthResponse> {
    this.healthCalls++;
    if (this.shouldFailHealth) throw new Error('Connection refused');
    return this.healthResponse;
  }

  async fetchTrends(page: number, _limit: number): Promise<ObserverTrendsResponse> {
    this.trendsCalls++;
    if (this.shouldFailTrends) throw new Error('Server error');
    return this.trendsPages[page - 1] ?? { transactions: [], total: 0, page, has_more: false };
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
    expect(result.transactionsFetched).toBe(0);
    expect(mockClient.trendsCalls).toBe(0);
  });

  it('indexes new transactions and creates agents', async () => {
    const sender = sha256('sender-1');
    const receiver = sha256('receiver-1');
    const id1 = txId('tx-001');
    const id2 = txId('tx-002');

    mockClient.trendsPages = [{
      transactions: [
        makeObserverTx(id1, sender, receiver),
        makeObserverTx(id2, sender, receiver),
      ],
      total: 2,
      page: 1,
      has_more: false,
    }];

    const result = await crawler.run();

    expect(result.transactionsFetched).toBe(2);
    expect(result.newTransactions).toBe(2);
    expect(result.newAgents).toBe(2); // sender + receiver created

    // Verify agents exist in database
    const senderAgent = agentRepo.findByHash(sender);
    expect(senderAgent).toBeDefined();
    expect(senderAgent!.source).toBe('observer_protocol');
    expect(senderAgent!.total_transactions).toBe(2);

    const receiverAgent = agentRepo.findByHash(receiver);
    expect(receiverAgent).toBeDefined();
    expect(receiverAgent!.total_transactions).toBe(2);

    // Verify the transaction in database
    const tx = txRepo.findById(id1);
    expect(tx).toBeDefined();
    expect(tx!.status).toBe('verified');
    expect(tx!.sender_hash).toBe(sender);
  });

  it('avoids duplicates via tx_id', async () => {
    const sender = sha256('dup-sender');
    const receiver = sha256('dup-receiver');
    const dupId = txId('tx-dup');

    mockClient.trendsPages = [{
      transactions: [makeObserverTx(dupId, sender, receiver)],
      total: 1,
      page: 1,
      has_more: false,
    }];

    // First crawl
    const first = await crawler.run();
    expect(first.newTransactions).toBe(1);

    // Second crawl with the same transaction
    mockClient.healthCalls = 0;
    mockClient.trendsCalls = 0;
    const second = await crawler.run();
    expect(second.newTransactions).toBe(0);
    expect(second.transactionsFetched).toBe(1); // Fetched but not inserted
  });

  it('does not recreate existing agents', async () => {
    const sender = sha256('existing-sender');
    const receiver = sha256('existing-receiver');
    const existId = txId('tx-existing');

    // Pre-insert an agent
    agentRepo.insert({
      public_key_hash: sender,
      alias: 'already-here',
      first_seen: NOW - 86400,
      last_seen: NOW - 86400,
      source: 'manual',
      total_transactions: 5,
      total_attestations_received: 0,
      avg_score: 0,
    });

    mockClient.trendsPages = [{
      transactions: [makeObserverTx(existId, sender, receiver)],
      total: 1,
      page: 1,
      has_more: false,
    }];

    const result = await crawler.run();

    expect(result.newAgents).toBe(1); // Only receiver created
    expect(result.newTransactions).toBe(1);

    // Existing agent keeps its alias and source
    const agent = agentRepo.findByHash(sender);
    expect(agent!.alias).toBe('already-here');
    expect(agent!.source).toBe('manual');
    // But total_transactions is incremented
    expect(agent!.total_transactions).toBe(6);
  });

  it('handles multi-page pagination', async () => {
    const s1 = sha256('page-sender-1');
    const r1 = sha256('page-receiver-1');
    const s2 = sha256('page-sender-2');
    const r2 = sha256('page-receiver-2');
    const p1Id = txId('tx-p1');
    const p2Id = txId('tx-p2');

    mockClient.trendsPages = [
      {
        transactions: [makeObserverTx(p1Id, s1, r1)],
        total: 2,
        page: 1,
        has_more: true,
      },
      {
        transactions: [makeObserverTx(p2Id, s2, r2)],
        total: 2,
        page: 2,
        has_more: false,
      },
    ];

    const result = await crawler.run();

    expect(result.transactionsFetched).toBe(2);
    expect(result.newTransactions).toBe(2);
    expect(result.newAgents).toBe(4);
    expect(mockClient.trendsCalls).toBe(2);
  });

  it('correctly maps Observer statuses to SatRank', async () => {
    const sender = sha256('status-sender');
    const receiver = sha256('status-receiver');
    const statusId = txId('tx-status');

    const tx = makeObserverTx(statusId, sender, receiver);
    tx.status = 'PENDING';
    tx.payment_rail = 'l402';
    tx.amount_bucket = 'large';

    mockClient.trendsPages = [{
      transactions: [tx],
      total: 1,
      page: 1,
      has_more: false,
    }];

    await crawler.run();

    const stored = txRepo.findById(statusId);
    expect(stored!.status).toBe('pending');
    expect(stored!.protocol).toBe('l402');
    expect(stored!.amount_bucket).toBe('large');
  });

  it('continues despite an error on an individual transaction', async () => {
    const sender = sha256('error-sender');
    const receiver = sha256('error-receiver');
    const goodSender = sha256('good-sender');
    const conflictId = txId('tx-conflict');
    const goodId = txId('tx-good');

    // First tx = duplicate tx_id with the second (triggers SQLite error)
    // We manually insert first to force the conflict
    agentRepo.insert({
      public_key_hash: sender,
      alias: null,
      first_seen: NOW,
      last_seen: NOW,
      source: 'observer_protocol',
      total_transactions: 0,
      total_attestations_received: 0,
      avg_score: 0,
    });
    agentRepo.insert({
      public_key_hash: receiver,
      alias: null,
      first_seen: NOW,
      last_seen: NOW,
      source: 'observer_protocol',
      total_transactions: 0,
      total_attestations_received: 0,
      avg_score: 0,
    });
    // Manually insert a tx so the same tx_id triggers an error
    txRepo.insert({
      tx_id: conflictId,
      sender_hash: sender,
      receiver_hash: receiver,
      amount_bucket: 'small',
      timestamp: NOW,
      payment_hash: sha256('ph'),
      preimage: null,
      status: 'verified',
      protocol: 'bolt11',
    });

    // The crawler will: 1) skip tx-conflict (duplicate detected), 2) index tx-good
    const goodTx = makeObserverTx(goodId, goodSender, receiver);

    mockClient.trendsPages = [{
      transactions: [
        makeObserverTx(conflictId, sender, receiver), // sera skipé (doublon)
        goodTx,
      ],
      total: 2,
      page: 1,
      has_more: false,
    }];

    const result = await crawler.run();

    expect(result.newTransactions).toBe(1); // Only tx-good
    expect(result.transactionsFetched).toBe(2);
    expect(result.errors.length).toBe(0); // No error, just a skip
  });

  it('stops pagination if fetchTrends fails', async () => {
    mockClient.shouldFailTrends = true;

    const result = await crawler.run();

    expect(result.errors.length).toBeGreaterThan(0);
    expect(mockClient.trendsCalls).toBe(1); // Single attempt
  });
});
