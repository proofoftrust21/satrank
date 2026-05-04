// Phase 10 (2026-05-04) — Operator-side SDK self-registration tests.
//
// Validates the registration service shape gates + the DNS TXT verification
// cycle. Repository round-trip is exercised via the verification path.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import { OperatorEndpointRegistrationRepository } from '../repositories/operatorEndpointRegistrationRepository';
import {
  OperatorEndpointRegistrationService,
  InvalidRegistrationError,
} from '../services/operatorEndpointRegistrationService';
import { InvalidDomainError } from '../services/operatorAttestationService';

let testDb: TestDb;
let pool: Pool;

const NOW = 1_700_000_000;
const PUBKEY = 'a'.repeat(64);
const SIG = 'b'.repeat(80);

const VALID_INPUT = {
  endpoint_url: 'https://api.example.com/data',
  http_method: 'POST' as const,
  operator_pubkey: PUBKEY,
  domain: 'example.com',
  signature_b64: SIG,
};

describe('Phase 10 — OperatorEndpointRegistrationService.registerEndpoint', () => {
  let repo: OperatorEndpointRegistrationRepository;
  let svc: OperatorEndpointRegistrationService;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new OperatorEndpointRegistrationRepository(pool);
    svc = new OperatorEndpointRegistrationService({ repo, now: () => NOW });
  });
  afterAll(async () => { await teardownTestPool(testDb); });
  beforeEach(async () => {
    await pool.query('TRUNCATE operator_endpoint_registrations RESTART IDENTITY CASCADE');
  });

  it('happy path : pending row inserted with hash + signature', async () => {
    const reg = await svc.registerEndpoint(VALID_INPUT);
    expect(reg.state).toBe('pending');
    expect(reg.endpoint_url).toBe('https://api.example.com/data');
    expect(reg.signed_payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(reg.signature_b64).toBe(SIG);
    expect(reg.registered_at).toBe(NOW);
  });

  it('rejects bad domain shape (reserved TLD)', async () => {
    await expect(
      svc.registerEndpoint({ ...VALID_INPUT, domain: 'foo.local', endpoint_url: 'https://foo.local/' }),
    ).rejects.toBeInstanceOf(InvalidDomainError);
  });

  it('rejects URL host that does not match declared domain', async () => {
    await expect(
      svc.registerEndpoint({ ...VALID_INPUT, endpoint_url: 'https://attacker.example.org/data' }),
    ).rejects.toThrow(/must match or be a subdomain/i);
  });

  it('accepts subdomain of declared domain', async () => {
    const reg = await svc.registerEndpoint({
      ...VALID_INPUT,
      endpoint_url: 'https://api.sub.example.com/data',
    });
    expect(reg.state).toBe('pending');
  });

  it('rejects http (non-https) endpoint_url', async () => {
    await expect(
      svc.registerEndpoint({ ...VALID_INPUT, endpoint_url: 'http://api.example.com/data' }),
    ).rejects.toThrow(/must use https/i);
  });

  it('rejects openapi_json over 64 KB', async () => {
    const bigOpenapi = { paths: { '/x': 'a'.repeat(70_000) } };
    await expect(
      svc.registerEndpoint({ ...VALID_INPUT, openapi_json: bigOpenapi }),
    ).rejects.toBeInstanceOf(InvalidRegistrationError);
  });

  it('rejects price_min > price_max', async () => {
    await expect(
      svc.registerEndpoint({ ...VALID_INPUT, expected_price_sats_min: 100, expected_price_sats_max: 50 }),
    ).rejects.toThrow(/expected_price_sats_min must be/i);
  });

  it('upsert : second registration of same URL replaces the row + state goes back to pending', async () => {
    await svc.registerEndpoint(VALID_INPUT);
    const before = await repo.findByUrl(VALID_INPUT.endpoint_url);
    await repo.markVerified(before!.registration_id, NOW + 10);
    const verified = await repo.findByUrl(VALID_INPUT.endpoint_url);
    expect(verified!.state).toBe('verified');
    // Re-registering with a new openapi_json should reset state and persist the new payload
    await svc.registerEndpoint({ ...VALID_INPUT, openapi_json: { v: 2 } });
    const after = await repo.findByUrl(VALID_INPUT.endpoint_url);
    expect(after!.state).toBe('pending');
    expect(after!.openapi_json).toEqual({ v: 2 });
  });

  // Phase 11A.1 — capability schema acceptance + validation
  it('capability fields persist on registration', async () => {
    const reg = await svc.registerEndpoint({
      ...VALID_INPUT,
      input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      output_schema: { type: 'object', properties: { sentiment: { type: 'string' } } },
      modalities: ['text'],
      languages: ['en', 'fr'],
      freshness_sla_sec: 3600,
      deterministic: false,
    });
    expect(reg.input_schema).toEqual({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] });
    expect(reg.output_schema).toEqual({ type: 'object', properties: { sentiment: { type: 'string' } } });
    expect(reg.modalities).toEqual(['text']);
    expect(reg.languages).toEqual(['en', 'fr']);
    expect(reg.freshness_sla_sec).toBe(3600);
    expect(reg.deterministic).toBe(false);
  });

  it('capability hints without any schema or openapi_json is rejected', async () => {
    await expect(
      svc.registerEndpoint({
        ...VALID_INPUT,
        modalities: ['text'],
      }),
    ).rejects.toThrow(/capability hints .* require at least one of input_schema/i);
  });

  it('capability hints accepted when openapi_json supplies the contract', async () => {
    const reg = await svc.registerEndpoint({
      ...VALID_INPUT,
      openapi_json: { openapi: '3.0.0', paths: {} },
      modalities: ['text'],
    });
    expect(reg.modalities).toEqual(['text']);
  });

  it('rejects input_schema over 64 KB', async () => {
    const huge = { type: 'object', enum: 'x'.repeat(70_000) };
    await expect(
      svc.registerEndpoint({ ...VALID_INPUT, input_schema: huge }),
    ).rejects.toThrow(/input_schema exceeds/i);
  });

  it('rejects more than 8 modalities', async () => {
    await expect(
      svc.registerEndpoint({
        ...VALID_INPUT,
        input_schema: { type: 'object' },
        modalities: ['text', 'image', 'audio', 'video', 'code', 'embedding', 'a', 'b', 'c'],
      }),
    ).rejects.toThrow(/modalities max 8/i);
  });

  it('rejects negative freshness_sla_sec', async () => {
    await expect(
      svc.registerEndpoint({
        ...VALID_INPUT,
        input_schema: { type: 'object' },
        freshness_sla_sec: -1,
      }),
    ).rejects.toThrow(/freshness_sla_sec/i);
  });
});

describe('Phase 11A.3 — pubkey-only attestation (wellknown_pubkey)', () => {
  let repo: OperatorEndpointRegistrationRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new OperatorEndpointRegistrationRepository(pool);
  });
  afterAll(async () => { await teardownTestPool(testDb); });
  beforeEach(async () => {
    await pool.query('TRUNCATE operator_endpoint_registrations RESTART IDENTITY CASCADE');
  });

  it('registers with attestation_method=wellknown_pubkey and skips DNS subdomain check', async () => {
    const svc = new OperatorEndpointRegistrationService({ repo, now: () => NOW });
    // Heroku-style URL host that does NOT match the declared domain — would
    // be rejected under dns_txt but accepted under wellknown_pubkey.
    const reg = await svc.registerEndpoint({
      ...VALID_INPUT,
      endpoint_url: 'https://my-agent.herokuapp.com/api',
      attestation_method: 'wellknown_pubkey',
    });
    expect(reg.state).toBe('pending');
    expect(reg.attestation_method).toBe('wellknown_pubkey');
    expect(reg.endpoint_url).toBe('https://my-agent.herokuapp.com/api');
  });

  it('dns_txt mode still rejects mismatched URL host (back-compat)', async () => {
    const svc = new OperatorEndpointRegistrationService({ repo, now: () => NOW });
    await expect(
      svc.registerEndpoint({
        ...VALID_INPUT,
        endpoint_url: 'https://my-agent.herokuapp.com/api',
        attestation_method: 'dns_txt',
      }),
    ).rejects.toThrow(/must match or be a subdomain/i);
  });

  it('verifyOne calls wellknown fetcher and matches pubkey', async () => {
    const calls: string[] = [];
    const wellknownFetch = async (url: string): Promise<{ status: number; body: string }> => {
      calls.push(url);
      return { status: 200, body: PUBKEY };
    };
    const svc = new OperatorEndpointRegistrationService({ repo, wellknownFetch, now: () => NOW });
    const reg = await svc.registerEndpoint({
      ...VALID_INPUT,
      endpoint_url: 'https://my-agent.herokuapp.com/api',
      attestation_method: 'wellknown_pubkey',
    });
    const ok = await svc.verifyOne(reg);
    expect(ok).toBe(true);
    expect(calls).toEqual(['https://my-agent.herokuapp.com/.well-known/satrank-operator-pubkey']);
    const refreshed = await repo.findByUrl('https://my-agent.herokuapp.com/api');
    expect(refreshed!.state).toBe('verified');
  });

  it('verifyOne tolerates whitespace + case in the well-known body', async () => {
    const wellknownFetch = async (): Promise<{ status: number; body: string }> => ({
      status: 200,
      body: `\n  ${PUBKEY.toUpperCase()}\n`,
    });
    const svc = new OperatorEndpointRegistrationService({ repo, wellknownFetch, now: () => NOW });
    const reg = await svc.registerEndpoint({
      ...VALID_INPUT,
      endpoint_url: 'https://my-agent.herokuapp.com/api',
      attestation_method: 'wellknown_pubkey',
    });
    const ok = await svc.verifyOne(reg);
    expect(ok).toBe(true);
  });

  it('verifyOne marks failed when wellknown returns wrong pubkey', async () => {
    const wellknownFetch = async (): Promise<{ status: number; body: string }> => ({
      status: 200,
      body: 'd'.repeat(64),
    });
    const svc = new OperatorEndpointRegistrationService({ repo, wellknownFetch, now: () => NOW });
    const reg = await svc.registerEndpoint({
      ...VALID_INPUT,
      endpoint_url: 'https://my-agent.herokuapp.com/api',
      attestation_method: 'wellknown_pubkey',
    });
    const ok = await svc.verifyOne(reg);
    expect(ok).toBe(false);
    const refreshed = await repo.findByUrl('https://my-agent.herokuapp.com/api');
    expect(refreshed!.state).toBe('failed');
  });

  it('verifyOne marks failed when wellknown returns 404', async () => {
    const wellknownFetch = async (): Promise<{ status: number; body: string }> => ({
      status: 404,
      body: '',
    });
    const svc = new OperatorEndpointRegistrationService({ repo, wellknownFetch, now: () => NOW });
    const reg = await svc.registerEndpoint({
      ...VALID_INPUT,
      endpoint_url: 'https://my-agent.herokuapp.com/api',
      attestation_method: 'wellknown_pubkey',
    });
    const ok = await svc.verifyOne(reg);
    expect(ok).toBe(false);
  });

  it('verifyOne marks failed on wellknown fetch throw', async () => {
    const wellknownFetch = async (): Promise<{ status: number; body: string }> => {
      throw new Error('connection refused');
    };
    const svc = new OperatorEndpointRegistrationService({ repo, wellknownFetch, now: () => NOW });
    const reg = await svc.registerEndpoint({
      ...VALID_INPUT,
      endpoint_url: 'https://my-agent.herokuapp.com/api',
      attestation_method: 'wellknown_pubkey',
    });
    const ok = await svc.verifyOne(reg);
    expect(ok).toBe(false);
  });

  it('default attestation_method is dns_txt when omitted (back-compat)', async () => {
    const svc = new OperatorEndpointRegistrationService({ repo, now: () => NOW });
    const reg = await svc.registerEndpoint(VALID_INPUT);
    expect(reg.attestation_method).toBe('dns_txt');
  });
});

describe('Phase 11A.1 — capability propagation to service_endpoints on verify', () => {
  let repo: OperatorEndpointRegistrationRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new OperatorEndpointRegistrationRepository(pool);
  });
  afterAll(async () => { await teardownTestPool(testDb); });
  beforeEach(async () => {
    await pool.query('TRUNCATE operator_endpoint_registrations RESTART IDENTITY CASCADE');
  });

  it('verifyOne writes capability into service_endpoints when row exists', async () => {
    const calls: Array<{ url: string; cap: { provenance: string; modalities: string[] | null } }> = [];
    const stubServiceEndpointRepo = {
      async updateCapability(url: string, cap: { provenance: string; modalities: string[] | null } & Record<string, unknown>): Promise<number> {
        calls.push({ url, cap: { provenance: cap.provenance, modalities: cap.modalities } });
        return 1;
      },
    };
    const dns = async (): Promise<string[][]> => [[`satrank-operator-pubkey=${PUBKEY}`]];
    const svc = new OperatorEndpointRegistrationService({
      repo,
      dnsResolveTxt: dns,
      now: () => NOW,
      serviceEndpointRepo: stubServiceEndpointRepo,
    });
    const reg = await svc.registerEndpoint({
      ...VALID_INPUT,
      input_schema: { type: 'object' },
      modalities: ['text'],
      languages: ['en'],
    });
    await svc.verifyOne(reg);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(VALID_INPUT.endpoint_url);
    expect(calls[0].cap.provenance).toBe('operator_signed');
    expect(calls[0].cap.modalities).toEqual(['text']);
  });

  it('verifyOne does NOT call updateCapability when registration has no capability data', async () => {
    let calls = 0;
    const stubServiceEndpointRepo = {
      async updateCapability(): Promise<number> { calls += 1; return 0; },
    };
    const dns = async (): Promise<string[][]> => [[`satrank-operator-pubkey=${PUBKEY}`]];
    const svc = new OperatorEndpointRegistrationService({
      repo,
      dnsResolveTxt: dns,
      now: () => NOW,
      serviceEndpointRepo: stubServiceEndpointRepo,
    });
    const reg = await svc.registerEndpoint(VALID_INPUT);
    await svc.verifyOne(reg);
    expect(calls).toBe(0);
  });
});

describe('Phase 10 — verification cycle (DNS TXT mock)', () => {
  let repo: OperatorEndpointRegistrationRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new OperatorEndpointRegistrationRepository(pool);
  });
  afterAll(async () => { await teardownTestPool(testDb); });
  beforeEach(async () => {
    await pool.query('TRUNCATE operator_endpoint_registrations RESTART IDENTITY CASCADE');
  });

  it('marks verified when DNS TXT contains matching pubkey', async () => {
    const dns = async (host: string): Promise<string[][]> => {
      expect(host).toBe('_satrank-operator.example.com');
      return [[`satrank-operator-pubkey=${PUBKEY}`]];
    };
    const svc = new OperatorEndpointRegistrationService({ repo, dnsResolveTxt: dns, now: () => NOW });
    const reg = await svc.registerEndpoint(VALID_INPUT);
    const ok = await svc.verifyOne(reg);
    expect(ok).toBe(true);
    const refreshed = await repo.findByUrl(VALID_INPUT.endpoint_url);
    expect(refreshed!.state).toBe('verified');
    expect(refreshed!.verified_at).toBe(NOW);
  });

  it('marks failed when DNS TXT mismatches pubkey', async () => {
    const dns = async (): Promise<string[][]> =>
      [[`satrank-operator-pubkey=${'c'.repeat(64)}`]];
    const svc = new OperatorEndpointRegistrationService({ repo, dnsResolveTxt: dns, now: () => NOW });
    const reg = await svc.registerEndpoint(VALID_INPUT);
    const ok = await svc.verifyOne(reg);
    expect(ok).toBe(false);
    const refreshed = await repo.findByUrl(VALID_INPUT.endpoint_url);
    expect(refreshed!.state).toBe('failed');
  });

  it('marks failed on DNS lookup error', async () => {
    const dns = async (): Promise<string[][]> => { throw new Error('NXDOMAIN'); };
    const svc = new OperatorEndpointRegistrationService({ repo, dnsResolveTxt: dns, now: () => NOW });
    const reg = await svc.registerEndpoint(VALID_INPUT);
    const ok = await svc.verifyOne(reg);
    expect(ok).toBe(false);
    const refreshed = await repo.findByUrl(VALID_INPUT.endpoint_url);
    expect(refreshed!.state).toBe('failed');
  });

  it('runVerificationCycle processes pending batch', async () => {
    const dns = async (): Promise<string[][]> => [[`satrank-operator-pubkey=${PUBKEY}`]];
    const svc = new OperatorEndpointRegistrationService({ repo, dnsResolveTxt: dns, now: () => NOW });
    await svc.registerEndpoint(VALID_INPUT);
    await svc.registerEndpoint({ ...VALID_INPUT, endpoint_url: 'https://api.example.com/data2' });
    const result = await svc.runVerificationCycle();
    expect(result.verified).toBe(2);
    expect(result.failed).toBe(0);
  });
});

describe('Phase 10 — repository : findVerifiedTemplate + dashboardStats', () => {
  let repo: OperatorEndpointRegistrationRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    repo = new OperatorEndpointRegistrationRepository(pool);
  });
  afterAll(async () => { await teardownTestPool(testDb); });
  beforeEach(async () => {
    await pool.query('TRUNCATE operator_endpoint_registrations RESTART IDENTITY CASCADE');
  });

  it('findVerifiedTemplate returns null when state is pending', async () => {
    await repo.create({
      ...VALID_INPUT,
      signed_payload_sha256: 'h'.repeat(64),
      registered_at: NOW,
      recall_body_template: '{"text":"hello"}',
    });
    const tpl = await repo.findVerifiedTemplate(VALID_INPUT.endpoint_url);
    expect(tpl).toBeNull();
  });

  it('findVerifiedTemplate returns template when state is verified', async () => {
    const reg = await repo.create({
      ...VALID_INPUT,
      signed_payload_sha256: 'h'.repeat(64),
      registered_at: NOW,
      recall_body_template: '{"text":"hello"}',
      recommended_validators: ['min_bytes:100'],
    });
    await repo.markVerified(reg.registration_id, NOW + 10);
    const tpl = await repo.findVerifiedTemplate(VALID_INPUT.endpoint_url);
    expect(tpl?.recall_body_template).toBe('{"text":"hello"}');
    expect(tpl?.recommended_validators).toEqual(['min_bytes:100']);
  });

  it('dashboardStats aggregates counts + success rate', async () => {
    await repo.create({
      ...VALID_INPUT,
      signed_payload_sha256: 'h'.repeat(64),
      registered_at: NOW,
    });
    await repo.create({
      ...VALID_INPUT,
      endpoint_url: 'https://api.example.com/v2',
      signed_payload_sha256: 'i'.repeat(64),
      registered_at: NOW,
    });
    const stats = await repo.dashboardStats(PUBKEY);
    expect(stats.registrations_total).toBe(2);
    expect(stats.registrations_pending).toBe(2);
    expect(stats.registrations_verified).toBe(0);
    expect(stats.fulfill_success_rate).toBeNull();
  });
});
