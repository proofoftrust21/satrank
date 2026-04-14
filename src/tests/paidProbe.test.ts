import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import { ServiceProbeRepository } from '../repositories/serviceProbeRepository';

describe('ServiceProbeRepository', () => {
  let db: InstanceType<typeof Database>;
  let repo: ServiceProbeRepository;

  beforeAll(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    repo = new ServiceProbeRepository(db);
  });

  afterAll(() => db.close());

  it('inserts a probe result', () => {
    const now = Math.floor(Date.now() / 1000);
    repo.insert({
      url: 'https://test.example.com',
      agent_hash: 'abc123',
      probed_at: now,
      paid_sats: 1,
      payment_hash: 'deadbeef',
      http_status: 200,
      body_valid: 1,
      response_latency_ms: 100,
      error: null,
    });

    const latest = repo.findLatest('https://test.example.com');
    expect(latest).toBeDefined();
    expect(latest!.paid_sats).toBe(1);
    expect(latest!.body_valid).toBe(1);
    expect(latest!.http_status).toBe(200);
  });

  it('findLatest returns the most recent probe', () => {
    const now = Math.floor(Date.now() / 1000);
    repo.insert({
      url: 'https://multi.example.com',
      agent_hash: 'hash1',
      probed_at: now - 100,
      paid_sats: 1, payment_hash: null, http_status: 200,
      body_valid: 1, response_latency_ms: 50, error: null,
    });
    repo.insert({
      url: 'https://multi.example.com',
      agent_hash: 'hash1',
      probed_at: now,
      paid_sats: 1, payment_hash: null, http_status: 500,
      body_valid: 0, response_latency_ms: 200, error: 'server_error',
    });

    const latest = repo.findLatest('https://multi.example.com');
    expect(latest!.http_status).toBe(500); // most recent
    expect(latest!.body_valid).toBe(0);
  });

  it('countSince returns correct count', () => {
    const now = Math.floor(Date.now() / 1000);
    // Both inserts above + the first test = 3 total
    const count = repo.countSince(now - 86400);
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it('scam detection: paid but body_valid=0', () => {
    const now = Math.floor(Date.now() / 1000);
    repo.insert({
      url: 'https://scam.example.com',
      agent_hash: 'scammer',
      probed_at: now,
      paid_sats: 1,
      payment_hash: 'scam_hash',
      http_status: 200,
      body_valid: 0, // paid but empty/invalid body
      response_latency_ms: 50,
      error: null,
    });

    const latest = repo.findLatest('https://scam.example.com');
    expect(latest!.body_valid).toBe(0);
    expect(latest!.paid_sats).toBe(1);
    // This is a scam signal: paid but didn't deliver
  });

  it('verified: paid and body_valid=1', () => {
    const now = Math.floor(Date.now() / 1000);
    repo.insert({
      url: 'https://legit.example.com',
      agent_hash: 'legit',
      probed_at: now,
      paid_sats: 1,
      payment_hash: 'legit_hash',
      http_status: 200,
      body_valid: 1,
      response_latency_ms: 80,
      error: null,
    });

    const latest = repo.findLatest('https://legit.example.com');
    expect(latest!.body_valid).toBe(1);
    expect(latest!.paid_sats).toBe(1);
  });
});
