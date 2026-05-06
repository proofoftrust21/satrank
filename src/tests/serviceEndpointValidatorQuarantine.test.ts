// Phase 12.8 (2026-05-06) — validator-violation quarantine tests.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';

let testDb: TestDb;
let pool: Pool;

const URL = 'https://stuck-validator.example/api';
const URL_2 = 'https://other.example/api';

async function seed(repo: ServiceEndpointRepository, url: string): Promise<void> {
  await repo.upsert(null, url, 200, 100);
}

describe('Phase 12.8 — recordValidatorViolation / clearValidatorViolationStreak', () => {
  let repo: ServiceEndpointRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new ServiceEndpointRepository(pool);
  });
  afterAll(async () => { await teardownTestPool(testDb); });
  beforeEach(async () => {
    await pool.query('TRUNCATE service_endpoints CASCADE');
  });

  it('increments below threshold without deprecating', async () => {
    await seed(repo, URL);
    const r1 = await repo.recordValidatorViolation(URL, 3);
    expect(r1.count).toBe(1);
    expect(r1.deprecated).toBe(false);
    const r2 = await repo.recordValidatorViolation(URL, 3);
    expect(r2.count).toBe(2);
    expect(r2.deprecated).toBe(false);
  });

  it('flips deprecated at threshold with reason="validator_violation_persistent"', async () => {
    await seed(repo, URL);
    await repo.recordValidatorViolation(URL, 3);
    await repo.recordValidatorViolation(URL, 3);
    const r3 = await repo.recordValidatorViolation(URL, 3);
    expect(r3.count).toBe(3);
    expect(r3.deprecated).toBe(true);
    const row = await repo.findByUrl(URL);
    expect(row!.deprecated).toBe(true);
    expect(row!.deprecated_reason).toBe('validator_violation_persistent');
    expect(row!.consecutive_validator_violation_count).toBe(3);
  });

  it('clearValidatorViolationStreak resets counter + clears deprecated when reason matches', async () => {
    await seed(repo, URL);
    await repo.recordValidatorViolation(URL, 3);
    await repo.recordValidatorViolation(URL, 3);
    await repo.recordValidatorViolation(URL, 3); // deprecated
    await repo.clearValidatorViolationStreak(URL);
    const row = await repo.findByUrl(URL);
    expect(row!.consecutive_validator_violation_count).toBe(0);
    expect(row!.deprecated).toBe(false);
    expect(row!.deprecated_reason).toBeNull();
  });

  it('clearValidatorViolationStreak does NOT clear deprecated when reason was 5xx_persistent', async () => {
    await seed(repo, URL);
    // Force 5xx-deprecated state.
    await repo.record5xx(URL, 3);
    await repo.record5xx(URL, 3);
    await repo.record5xx(URL, 3);
    let row = await repo.findByUrl(URL);
    expect(row!.deprecated).toBe(true);
    expect(row!.deprecated_reason).toBe('5xx_persistent');
    // A subsequent validator violation + clear must NOT lift the 5xx deprecation.
    await repo.recordValidatorViolation(URL, 3);
    await repo.clearValidatorViolationStreak(URL);
    row = await repo.findByUrl(URL);
    expect(row!.deprecated).toBe(true);
    expect(row!.deprecated_reason).toBe('5xx_persistent');
  });

  it('clearValidatorViolationStreak does NOT clear deprecated when reason was 404_persistent', async () => {
    await seed(repo, URL);
    await repo.record404(URL, 3);
    await repo.record404(URL, 3);
    await repo.record404(URL, 3);
    await repo.recordValidatorViolation(URL, 3);
    await repo.clearValidatorViolationStreak(URL);
    const row = await repo.findByUrl(URL);
    expect(row!.deprecated).toBe(true);
    expect(row!.deprecated_reason).toBe('404_persistent');
  });

  it('recordValidatorViolation on already-5xx-deprecated row does not flip reason', async () => {
    await seed(repo, URL);
    await repo.record5xx(URL, 3);
    await repo.record5xx(URL, 3);
    await repo.record5xx(URL, 3); // 5xx_persistent
    const r = await repo.recordValidatorViolation(URL, 3);
    // Counter still increments
    expect(r.count).toBe(1);
    // Deprecated stays true (was already)
    expect(r.deprecated).toBe(true);
    const row = await repo.findByUrl(URL);
    // Reason stays '5xx_persistent' even after we hit threshold on validator
    await repo.recordValidatorViolation(URL, 3);
    await repo.recordValidatorViolation(URL, 3);
    const final = await repo.findByUrl(URL);
    expect(final!.consecutive_validator_violation_count).toBe(3);
    expect(final!.deprecated_reason).toBe('5xx_persistent');
    // Also verify clearValidatorViolationStreak still won't lift the 5xx deprecation
    await repo.clearValidatorViolationStreak(URL);
    const after = await repo.findByUrl(URL);
    expect(after!.deprecated).toBe(true);
    expect(after!.deprecated_reason).toBe('5xx_persistent');
  });

  it('clearValidatorViolationStreak is no-op when count was 0', async () => {
    await seed(repo, URL);
    await repo.clearValidatorViolationStreak(URL);
    const row = await repo.findByUrl(URL);
    expect(row!.consecutive_validator_violation_count).toBe(0);
    expect(row!.deprecated).toBe(false);
  });

  it('recordValidatorViolation unknown URL returns count=0 deprecated=false', async () => {
    const r = await repo.recordValidatorViolation('https://unknown.example/api', 3);
    expect(r.count).toBe(0);
    expect(r.deprecated).toBe(false);
  });

  it('counters across endpoints are independent', async () => {
    await seed(repo, URL);
    await seed(repo, URL_2);
    await repo.recordValidatorViolation(URL, 3);
    await repo.record5xx(URL_2, 3);
    const a = await repo.findByUrl(URL);
    const b = await repo.findByUrl(URL_2);
    expect(a!.consecutive_validator_violation_count).toBe(1);
    expect(a!.consecutive_5xx_count).toBe(0);
    expect(b!.consecutive_validator_violation_count).toBe(0);
    expect(b!.consecutive_5xx_count).toBe(1);
  });
});
