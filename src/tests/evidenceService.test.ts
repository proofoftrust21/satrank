// Phase 8.3 — EvidenceService integration test against Postgres.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { FulfillJobRepository } from '../repositories/fulfillJobRepository';
import { EvidenceReceiptRepository } from '../repositories/evidenceReceiptRepository';
import { EvidenceService } from '../services/evidenceService';
import { SignerService, generateSigningKeypair } from '../services/signerService';

let testDb: TestDb;
let pool: Pool;
let fulfillRepo: FulfillJobRepository;
let receiptRepo: EvidenceReceiptRepository;
let signer: SignerService;
let service: EvidenceService;

const AGENT = 'agent-pubkey-test';
const NOW = 1_700_000_000;

describe('EvidenceService (Phase 8.3)', () => {
  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    fulfillRepo = new FulfillJobRepository(pool);
    receiptRepo = new EvidenceReceiptRepository(pool);
    const kp = generateSigningKeypair();
    signer = new SignerService({ privateKeyHex: kp.privateKeyHex, publicKeyHex: kp.publicKeyHex });
    service = new EvidenceService({
      fulfillJobRepo: fulfillRepo, receiptRepo, signer, now: () => NOW,
    });
  });

  afterAll(async () => { await teardownTestPool(testDb); });

  beforeEach(async () => {
    await pool.query('TRUNCATE evidence_receipts, fulfill_jobs RESTART IDENTITY CASCADE');
  });

  async function seedSuccessJob(): Promise<string> {
    const jobId = '11111111-1111-1111-1111-111111111111';
    await pool.query(
      `INSERT INTO fulfill_jobs
        (job_id, agent_pubkey, intent_hash, max_sats, max_latency_ms, status, attempts,
         sats_spent, sats_refunded, premium_sats, preimage, result_body_sha256, created_at, settled_at, mode)
       VALUES ($1, $2, 'intentH', 100, 8000, 'success', $3::jsonb, 10, 0, 1, 'pre', 'bodyH', $4, $4, 'deposit')`,
      [
        jobId, AGENT,
        JSON.stringify([{
          candidate_url: 'https://x.example/api', rank: 1, ts_started: NOW, ts_finished: NOW,
          payment_outcome: 'pay_ok', delivery_outcome: 'delivery_ok', http_status: 200,
          sats_paid: 10, preimage: 'pre', operator_pubkey: 'op-pk',
        }]),
        NOW,
      ],
    );
    return jobId;
  }

  it('issues a signed receipt for a successful job', async () => {
    const jobId = await seedSuccessJob();
    const r = await service.issue(jobId, 0, AGENT);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.receipt.satrank_pubkey).toBe(signer.publicKeyHex());
    expect(r.receipt.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.receipt.signature_b64).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(signer.verify(r.receipt.payload_canonical_json, r.receipt.signature_b64)).toBe(true);
  });

  it('idempotent — second call returns cached receipt with same signature', async () => {
    const jobId = await seedSuccessJob();
    const a = await service.issue(jobId, 0, AGENT);
    const b = await service.issue(jobId, 0, AGENT);
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    if (a.status !== 'ok' || b.status !== 'ok') return;
    expect(a.receipt.signature_b64).toBe(b.receipt.signature_b64);
    expect(a.receipt.receipt_id).toBe(b.receipt.receipt_id);
  });

  it('agent_mismatch — different pubkey is refused', async () => {
    const jobId = await seedSuccessJob();
    const r = await service.issue(jobId, 0, 'wrong-agent');
    expect(r.status).toBe('agent_mismatch');
  });

  it('attempt_not_delivery_ok — refuses receipt for failed attempts', async () => {
    const jobId = '22222222-2222-2222-2222-222222222222';
    await pool.query(
      `INSERT INTO fulfill_jobs
        (job_id, agent_pubkey, intent_hash, max_sats, max_latency_ms, status, attempts,
         sats_spent, sats_refunded, premium_sats, preimage, result_body_sha256, created_at, settled_at, mode)
       VALUES ($1, $2, 'h', 100, 8000, 'success', $3::jsonb, 10, 0, 1, '', '', $4, $4, 'deposit')`,
      [
        jobId, AGENT,
        JSON.stringify([{
          candidate_url: 'https://x.example/api', rank: 1, ts_started: NOW, ts_finished: NOW,
          payment_outcome: 'pay_ok', delivery_outcome: 'delivery_5xx', http_status: 502,
          sats_paid: 10,
        }]),
        NOW,
      ],
    );
    const r = await service.issue(jobId, 0, AGENT);
    expect(r.status).toBe('attempt_not_delivery_ok');
  });

  it('signing_disabled — service without signer returns 503-equivalent', async () => {
    const blank = new SignerService({});
    const svc = new EvidenceService({
      fulfillJobRepo: fulfillRepo, receiptRepo, signer: blank, now: () => NOW,
    });
    const jobId = await seedSuccessJob();
    const r = await svc.issue(jobId, 0, AGENT);
    expect(r.status).toBe('signing_disabled');
  });

  it('payload_canonical_json is byte-identical across runs (canonical sort)', async () => {
    const jobId = await seedSuccessJob();
    const r = await service.issue(jobId, 0, AGENT);
    if (r.status !== 'ok') throw new Error('expected ok');
    const decoded = JSON.parse(r.receipt.payload_canonical_json);
    expect(decoded.job_id).toBe(jobId);
    expect(decoded.body_sha256).toBe('bodyH');
    // Phase 12A audit fix MED-3 — preimage no longer leaks into the
    // signed payload. See evidenceService.ts comment for rationale.
    expect(decoded.preimage).toBeUndefined();
    expect(decoded.satrank_version).toBe('phase12a');
    expect(decoded.operator_pubkey).toBe('op-pk');
    // Verify the canonical JSON is sorted (keys alphabetical).
    const keys = Object.keys(decoded);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });
});
