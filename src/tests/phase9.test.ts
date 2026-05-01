// Phase 9.1-9.4 — focused tests for credit line + cache + capability tokens.
// Speculative probe is integration-tested implicitly via the live smoke ;
// adding a unit test here would require a multi-fetch mock and isn't worth
// the maintenance.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { AgentCreditRepository } from '../repositories/agentCreditRepository';
import { IntentResultCacheRepository } from '../repositories/intentResultCacheRepository';
import { CapabilityTokenService } from '../services/capabilityTokenService';

let testDb: TestDb;
let pool: Pool;

const NOW = 1_700_000_000;

describe('Phase 9.4 — AgentCreditRepository', () => {
  let repo: AgentCreditRepository;
  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new AgentCreditRepository(pool);
  });
  afterAll(async () => { await teardownTestPool(testDb); });
  beforeEach(async () => {
    await pool.query('TRUNCATE agent_credits RESTART IDENTITY');
  });

  it('incrementOnSuccess creates row at 1, then increments', async () => {
    await repo.incrementOnSuccess('agent-A', NOW);
    const a = await repo.find('agent-A');
    expect(a?.accumulated_sats).toBe(1);
    expect(a?.borrowed_sats).toBe(0);
    await repo.incrementOnSuccess('agent-A', NOW + 1);
    const b = await repo.find('agent-A');
    expect(b?.accumulated_sats).toBe(2);
  });

  it('borrow + repay against accumulated reputation', async () => {
    for (let i = 0; i < 10; i++) await repo.incrementOnSuccess('agent-B', NOW);
    expect(await repo.borrow('agent-B', 5, NOW)).toBe(true);
    expect(await repo.borrow('agent-B', 6, NOW)).toBe(false);  // 5+6 > 10
    expect(await repo.borrow('agent-B', 5, NOW)).toBe(true);   // 5+5 = 10 OK
    expect(await repo.availableCredit('agent-B')).toBe(0);
    await repo.repay('agent-B', 4, NOW);
    expect(await repo.availableCredit('agent-B')).toBe(4);
  });

  it('borrow on unknown agent fails (no row to update)', async () => {
    expect(await repo.borrow('agent-Unknown', 1, NOW)).toBe(false);
  });
});

describe('Phase 9.3 — IntentResultCacheRepository', () => {
  let repo: IntentResultCacheRepository;
  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new IntentResultCacheRepository(pool);
  });
  afterAll(async () => { await teardownTestPool(testDb); });
  beforeEach(async () => {
    await pool.query('TRUNCATE intent_result_cache, fulfill_jobs RESTART IDENTITY CASCADE');
    // Seed a fulfill_jobs row so FK is satisfied.
    await pool.query(
      `INSERT INTO fulfill_jobs (job_id, agent_pubkey, intent_hash, max_sats, max_latency_ms, status, attempts, sats_spent, sats_refunded, premium_sats, created_at, mode)
       VALUES ('11111111-1111-1111-1111-111111111111', 'src-agent', 'h', 100, 8000, 'success', '[]'::jsonb, 0, 0, 0, $1, 'deposit')`,
      [NOW],
    );
  });

  it('lookup returns null when no fresh entry', async () => {
    expect(await repo.lookup('h-not-cached', NOW)).toBeNull();
  });

  it('create + lookup round-trip + expiry', async () => {
    await repo.create({
      intent_hash: 'h-cached',
      body: 'cached-body',
      body_sha256: 'sha-1',
      source_job_id: '11111111-1111-1111-1111-111111111111',
      source_attempt_index: 0,
      source_candidate_url: 'https://x.example/api',
      source_operator_pubkey: 'op-pk',
      source_preimage: 'pre',
      source_sats_paid: 10,
      source_agent_pubkey: 'src-agent',
      created_at: NOW,
      expires_at: NOW + 60,
    });
    const hit = await repo.lookup('h-cached', NOW + 30);
    expect(hit?.body).toBe('cached-body');
    expect(await repo.lookup('h-cached', NOW + 100)).toBeNull();  // expired
  });

  it('incrementHit + pruneExpired', async () => {
    await repo.create({
      intent_hash: 'h2', body: 'b', body_sha256: 's',
      source_job_id: '11111111-1111-1111-1111-111111111111',
      source_attempt_index: 0, source_candidate_url: 'https://x.example/api',
      source_operator_pubkey: null, source_preimage: 'pre', source_sats_paid: 10,
      source_agent_pubkey: 'src-agent', created_at: NOW, expires_at: NOW - 1,  // expired
    });
    await repo.create({
      intent_hash: 'h3', body: 'b', body_sha256: 's',
      source_job_id: '11111111-1111-1111-1111-111111111111',
      source_attempt_index: 1, source_candidate_url: 'https://x.example/api',
      source_operator_pubkey: null, source_preimage: 'pre', source_sats_paid: 10,
      source_agent_pubkey: 'src-agent', created_at: NOW, expires_at: NOW + 60,
    });
    const hit = await repo.lookup('h3', NOW);
    expect(hit).not.toBeNull();
    if (hit) {
      await repo.incrementHit(hit.cache_id);
      const after = await repo.lookup('h3', NOW);
      expect(after?.hit_count).toBe(1);
    }
    const pruned = await repo.pruneExpired(NOW);
    expect(pruned).toBe(1);
  });
});

describe('Phase 9.2 — CapabilityTokenService', () => {
  it('issue + consume round-trip', () => {
    const svc = new CapabilityTokenService();
    const cap = svc.issue({ agent_pubkey: 'agent-X', ttl_sec: 60, max_calls: 3, now_sec: NOW });
    expect(cap.token).toMatch(/^[0-9a-f]{64}$/);
    expect(cap.expires_at).toBe(NOW + 60);
    expect(cap.max_calls).toBe(3);
    const c1 = svc.consume(cap.token, NOW);
    expect(c1?.agent_pubkey).toBe('agent-X');
    expect(c1?.remaining_calls).toBe(2);
  });

  it('exhausted token returns null on next consume', () => {
    const svc = new CapabilityTokenService();
    const cap = svc.issue({ agent_pubkey: 'agent-Y', ttl_sec: 60, max_calls: 1, now_sec: NOW });
    expect(svc.consume(cap.token, NOW)).not.toBeNull();
    expect(svc.consume(cap.token, NOW)).toBeNull();
  });

  it('expired token returns null', () => {
    const svc = new CapabilityTokenService();
    const cap = svc.issue({ agent_pubkey: 'agent-Z', ttl_sec: 60, max_calls: 10, now_sec: NOW });
    expect(svc.consume(cap.token, NOW + 61)).toBeNull();
  });

  it('unknown token returns null', () => {
    const svc = new CapabilityTokenService();
    expect(svc.consume('a'.repeat(64), NOW)).toBeNull();
  });

  it('TTL hard-capped at 30 min, max_calls at 500', () => {
    const svc = new CapabilityTokenService();
    const cap = svc.issue({ agent_pubkey: 'a', ttl_sec: 100_000, max_calls: 100_000, now_sec: NOW });
    expect(cap.expires_at - NOW).toBeLessThanOrEqual(1800);
    expect(cap.max_calls).toBeLessThanOrEqual(500);
  });

  it('pruneExpired removes expired + exhausted', () => {
    const svc = new CapabilityTokenService();
    const c1 = svc.issue({ agent_pubkey: 'a', ttl_sec: 60, max_calls: 1, now_sec: NOW });
    svc.consume(c1.token, NOW);  // exhausted
    svc.issue({ agent_pubkey: 'b', ttl_sec: 60, max_calls: 5, now_sec: NOW });
    const dropped = svc.pruneExpired(NOW + 100);  // both expired now
    expect(dropped).toBe(2);
    expect(svc.size()).toBe(0);
  });
});
