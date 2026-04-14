import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import { RegistryCrawler } from '../crawler/registryCrawler';
import { sha256 } from '../utils/crypto';

describe('RegistryCrawler', () => {
  let db: InstanceType<typeof Database>;
  let repo: ServiceEndpointRepository;

  beforeAll(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    repo = new ServiceEndpointRepository(db);
  });

  afterAll(() => db.close());

  it('constructor accepts a BOLT11 decoder function', () => {
    const mockDecoder = async (_invoice: string) => ({ destination: '03' + 'a'.repeat(64) });
    const crawler = new RegistryCrawler(repo, mockDecoder);
    expect(crawler).toBeDefined();
  });

  it('sha256 of a pubkey produces a valid agent hash', () => {
    const pubkey = '03' + 'a'.repeat(64);
    const hash = sha256(pubkey);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('upsert from registry correctly populates service_endpoints', () => {
    const pubkey = '03' + 'b'.repeat(64);
    const agentHash = sha256(pubkey);
    repo.upsert(agentHash, 'https://registry-test.example.com', 0, 0);

    const entry = repo.findByUrl('https://registry-test.example.com');
    expect(entry).toBeDefined();
    expect(entry!.agent_hash).toBe(agentHash);
    expect(entry!.last_http_status).toBe(0); // not health-checked yet
  });

  it('URL that changes node updates agent_hash on re-upsert', () => {
    const pubkey1 = '03' + 'c'.repeat(64);
    const pubkey2 = '03' + 'd'.repeat(64);
    const hash1 = sha256(pubkey1);
    const hash2 = sha256(pubkey2);

    repo.upsert(hash1, 'https://migrating-service.example.com', 0, 0);
    expect(repo.findByUrl('https://migrating-service.example.com')!.agent_hash).toBe(hash1);

    repo.upsert(hash2, 'https://migrating-service.example.com', 0, 0);
    expect(repo.findByUrl('https://migrating-service.example.com')!.agent_hash).toBe(hash2);
  });
});
