// Auto-indexation service tests — rate limiting, concurrency, dedup
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AutoIndexService } from '../services/autoIndexService';

// Mock LndGraphCrawler
function mockCrawler(indexDelay = 10) {
  return {
    indexSingleNode: vi.fn().mockImplementation(() =>
      new Promise(resolve => setTimeout(() => resolve('created'), indexDelay))
    ),
    run: vi.fn(),
  };
}

// Mock AgentRepository
function mockAgentRepo() {
  return {
    findByHash: vi.fn().mockReturnValue(undefined),
  } as any;
}

// Mock ScoringService
function mockScoring() {
  return {
    computeScore: vi.fn(),
  } as any;
}

const VALID_PUBKEY = '02a1633cafcc01ebfb6d78e39f687a1f0995c62fc95f51ead10a02ee0be551b5dc';
const VALID_PUBKEY_2 = '03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad';

describe('AutoIndexService', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('validates Lightning pubkey format', () => {
    expect(AutoIndexService.isLightningPubkey(VALID_PUBKEY)).toBe(true);
    expect(AutoIndexService.isLightningPubkey('abcdef1234')).toBe(false);
    expect(AutoIndexService.isLightningPubkey('04' + 'a'.repeat(64))).toBe(false);
  });

  it('returns false when no crawler configured', () => {
    const service = new AutoIndexService(null, mockAgentRepo(), mockScoring(), 10);
    expect(service.tryAutoIndex(VALID_PUBKEY)).toBe(false);
  });

  it('returns false for invalid pubkey', () => {
    const service = new AutoIndexService(mockCrawler() as any, mockAgentRepo(), mockScoring(), 10);
    expect(service.tryAutoIndex('invalid')).toBe(false);
  });

  it('rate limits to maxPerMinute', () => {
    const crawler = mockCrawler();
    const service = new AutoIndexService(crawler as any, mockAgentRepo(), mockScoring(), 3);

    // First 3 should succeed
    expect(service.tryAutoIndex(VALID_PUBKEY)).toBe(true);
    // Generate unique pubkeys for separate indexing
    const pk2 = '02' + 'b'.repeat(64);
    const pk3 = '02' + 'c'.repeat(64);
    expect(service.tryAutoIndex(pk2)).toBe(true);
    expect(service.tryAutoIndex(pk3)).toBe(true);

    // 4th should be rate limited
    const pk4 = '02' + 'd'.repeat(64);
    expect(service.tryAutoIndex(pk4)).toBe(false);
  });

  it('rate limit resets after 1 minute', () => {
    const crawler = mockCrawler();
    const service = new AutoIndexService(crawler as any, mockAgentRepo(), mockScoring(), 2);

    expect(service.tryAutoIndex(VALID_PUBKEY)).toBe(true);
    expect(service.tryAutoIndex(VALID_PUBKEY_2)).toBe(true);
    const pk3 = '02' + 'e'.repeat(64);
    expect(service.tryAutoIndex(pk3)).toBe(false);

    // Advance 61 seconds
    vi.advanceTimersByTime(61_000);

    const pk4 = '02' + 'f'.repeat(64);
    expect(service.tryAutoIndex(pk4)).toBe(true);
  });

  it('deduplicates pending keys', () => {
    const crawler = mockCrawler(1000);
    const service = new AutoIndexService(crawler as any, mockAgentRepo(), mockScoring(), 10);

    expect(service.tryAutoIndex(VALID_PUBKEY)).toBe(true);
    // Same key again — should return true (already pending) without consuming another rate slot
    expect(service.tryAutoIndex(VALID_PUBKEY)).toBe(true);
    expect(service.isPending(VALID_PUBKEY)).toBe(true);

    // Crawler should only be called once
    expect(crawler.indexSingleNode).toHaveBeenCalledTimes(1);
  });

  it('clears pending key after indexing completes', async () => {
    const crawler = mockCrawler(10);
    const service = new AutoIndexService(crawler as any, mockAgentRepo(), mockScoring(), 10);

    service.tryAutoIndex(VALID_PUBKEY);
    expect(service.isPending(VALID_PUBKEY)).toBe(true);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(50);
    expect(service.isPending(VALID_PUBKEY)).toBe(false);
  });

  it('clears pending key even on error', async () => {
    const crawler = {
      indexSingleNode: vi.fn().mockRejectedValue(new Error('LND down')),
      run: vi.fn(),
    };
    const service = new AutoIndexService(crawler as any, mockAgentRepo(), mockScoring(), 10);

    service.tryAutoIndex(VALID_PUBKEY);
    expect(service.isPending(VALID_PUBKEY)).toBe(true);

    await vi.advanceTimersByTimeAsync(50);
    expect(service.isPending(VALID_PUBKEY)).toBe(false);
  });
});
