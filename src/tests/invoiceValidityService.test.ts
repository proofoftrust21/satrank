// Phase 5.11 — InvoiceValidityService : valide + persiste à stage_posteriors stage=2.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { encode, sign } from 'bolt11';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import {
  EndpointStagePosteriorsRepository,
  STAGE_INVOICE,
} from '../repositories/endpointStagePosteriorsRepository';
import { InvoiceValidityService } from '../services/invoiceValidityService';

let testDb: TestDb;

const PRIV = Buffer.from('a'.repeat(64), 'hex');

function makeMainnetInvoice(amountSats: number, timestampOffsetSec = 0): string {
  const data: Record<string, unknown> = {
    coinType: 'bitcoin',
    timestamp: Math.floor(Date.now() / 1000) + timestampOffsetSec,
    satoshis: amountSats,
    tags: [
      { tagName: 'payment_hash', data: 'b'.repeat(64) },
      { tagName: 'description', data: 'unit test' },
      { tagName: 'expire_time', data: 3600 },
    ],
  };
  const encoded = encode(data as Parameters<typeof encode>[0]);
  const signed = sign(encoded, PRIV) as { paymentRequest: string };
  return signed.paymentRequest;
}

describe('InvoiceValidityService', () => {
  let pool: Pool;
  let stagesRepo: EndpointStagePosteriorsRepository;
  let service: InvoiceValidityService;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    stagesRepo = new EndpointStagePosteriorsRepository(pool);
    service = new InvoiceValidityService(stagesRepo);
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  it('valid invoice → stage 2 success observed', async () => {
    const url = 'https://valid-invoice.example/api';
    const invoice = makeMainnetInvoice(5);
    const result = await service.observe({
      endpoint_url: url,
      invoice,
      advertisedPriceSats: 5,
    });
    expect(result.outcome).toBe('valid');
    const stages = await stagesRepo.findAllStages(url);
    const stage2 = stages.get(STAGE_INVOICE);
    expect(stage2).toBeDefined();
    expect(stage2!.alpha).toBeGreaterThan(stage2!.beta); // success > failure
  });

  it('decode_failed invoice → stage 2 failure observed', async () => {
    const url = 'https://garbage-invoice.example/api';
    const result = await service.observe({
      endpoint_url: url,
      invoice: 'this-is-not-a-bolt11',
      advertisedPriceSats: 5,
    });
    expect(result.outcome).toBe('decode_failed');
    const stages = await stagesRepo.findAllStages(url);
    const stage2 = stages.get(STAGE_INVOICE);
    expect(stage2).toBeDefined();
    expect(stage2!.beta).toBeGreaterThan(stage2!.alpha); // failure > success
  });

  it('amount_mismatch → stage 2 failure observed even though decode succeeds', async () => {
    const url = 'https://mismatch.example/api';
    // Annoncé 5, BOLT11 = 100 (ratio 20).
    const invoice = makeMainnetInvoice(100);
    const result = await service.observe({
      endpoint_url: url,
      invoice,
      advertisedPriceSats: 5,
    });
    expect(result.outcome).toBe('amount_mismatch');
    const stages = await stagesRepo.findAllStages(url);
    const stage2 = stages.get(STAGE_INVOICE);
    expect(stage2!.beta).toBeGreaterThan(stage2!.alpha);
  });

  it('persistence is idempotent and accumulates across calls', async () => {
    const url = 'https://accumulate.example/api';
    const invoice = makeMainnetInvoice(10);
    // 5 valid observations
    for (let i = 0; i < 5; i++) {
      await service.observe({
        endpoint_url: url,
        invoice,
        advertisedPriceSats: 10,
      });
    }
    const stages = await stagesRepo.findAllStages(url);
    const stage2 = stages.get(STAGE_INVOICE)!;
    // α devrait être proche de prior 1.5 + 5 = 6.5 (avec un peu de decay)
    expect(stage2.alpha).toBeGreaterThan(5);
    expect(stage2.n_obs_effective).toBeGreaterThan(3);
  });
});
