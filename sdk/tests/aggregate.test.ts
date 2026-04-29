// Phase 7.2 — federation aggregation : pure tests.
import { describe, it, expect } from 'vitest';
import {
  fetchOraclePeers,
  filterByCalibrationError,
  aggregateOracles,
  type OraclePeer,
} from '../src/aggregate';

const NOW = 1_700_000_000;

function makePeer(overrides: Partial<OraclePeer> = {}): OraclePeer {
  return {
    oracle_pubkey: 'a'.repeat(64),
    lnd_pubkey: '02' + 'b'.repeat(64),
    catalogue_size: 345,
    calibration_event_id: 'c'.repeat(64),
    last_assertion_event_id: 'd'.repeat(64),
    contact: null,
    onboarding_url: null,
    last_seen: NOW,
    first_seen: NOW - 30 * 86400,
    age_sec: 30 * 86400,
    stale_sec: 0,
    latest_announcement_event_id: 'e'.repeat(64),
    ...overrides,
  };
}

describe('filterByCalibrationError (Phase 7.2)', () => {
  it('passes a peer with all defaults met', () => {
    const peers = [makePeer()];
    const out = filterByCalibrationError(peers);
    expect(out).toHaveLength(1);
  });

  it('filters out peers stale beyond maxStaleSec', () => {
    const peers = [
      makePeer({ stale_sec: 1 * 86400 }),
      makePeer({ oracle_pubkey: 'b'.repeat(64), stale_sec: 30 * 86400 }),
    ];
    const out = filterByCalibrationError(peers, { maxStaleSec: 7 * 86400 });
    expect(out.map((p) => p.oracle_pubkey)).toEqual(['a'.repeat(64)]);
  });

  it('filters out peers below minCatalogueSize', () => {
    const peers = [
      makePeer({ catalogue_size: 30 }),
      makePeer({ oracle_pubkey: 'b'.repeat(64), catalogue_size: 100 }),
    ];
    const out = filterByCalibrationError(peers, { minCatalogueSize: 50 });
    expect(out).toHaveLength(1);
    expect(out[0].oracle_pubkey).toBe('b'.repeat(64));
  });

  it('filters out peers without calibration when requireCalibration=true', () => {
    const peers = [
      makePeer({ calibration_event_id: null }),
      makePeer({ oracle_pubkey: 'b'.repeat(64), calibration_event_id: 'c'.repeat(64) }),
    ];
    const out = filterByCalibrationError(peers); // default requireCalibration=true
    expect(out.map((p) => p.oracle_pubkey)).toEqual(['b'.repeat(64)]);
  });

  it('keeps peers without calibration when requireCalibration=false', () => {
    const peers = [
      makePeer({ calibration_event_id: null }),
      makePeer({ oracle_pubkey: 'b'.repeat(64), calibration_event_id: 'c'.repeat(64) }),
    ];
    const out = filterByCalibrationError(peers, { requireCalibration: false });
    expect(out).toHaveLength(2);
  });

  it('respects minAgeSec floor for Sybil minimal protection', () => {
    const peers = [
      makePeer({ age_sec: 100 }), // very young
      makePeer({ oracle_pubkey: 'b'.repeat(64), age_sec: 60 * 86400 }),
    ];
    const out = filterByCalibrationError(peers, { minAgeSec: 7 * 86400 });
    expect(out.map((p) => p.oracle_pubkey)).toEqual(['b'.repeat(64)]);
  });
});

describe('fetchOraclePeers (Phase 7.2)', () => {
  it('hits /api/oracle/peers and parses the response', async () => {
    const captured: Array<{ url: string }> = [];
    const fetchMock = (async (url: string) => {
      captured.push({ url: String(url) });
      return new Response(
        JSON.stringify({
          data: {
            peers: [makePeer(), makePeer({ oracle_pubkey: 'b'.repeat(64) })],
            count: 2,
            limit: 50,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const result = await fetchOraclePeers({
      baseUrl: 'https://test-oracle.com',
      limit: 50,
      fetchImpl: fetchMock,
    });
    expect(captured[0].url).toContain('https://test-oracle.com/api/oracle/peers');
    expect(captured[0].url).toContain('limit=50');
    expect(result.peers).toHaveLength(2);
    expect(result.count).toBe(2);
    expect(result.source_oracle).toBe('https://test-oracle.com');
  });

  it('throws on non-200 response', async () => {
    const fetchMock = (async () => new Response('Internal', { status: 500 })) as typeof fetch;
    await expect(
      fetchOraclePeers({ baseUrl: 'https://test', fetchImpl: fetchMock }),
    ).rejects.toThrow(/500/);
  });
});

describe('aggregateOracles (Phase 7.2)', () => {
  it('combines fetch + filter in one call', async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({
        data: {
          peers: [
            makePeer({ catalogue_size: 30 }), // filtered out
            makePeer({ oracle_pubkey: 'b'.repeat(64), catalogue_size: 100 }),
          ],
          count: 2,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const result = await aggregateOracles({
      baseUrl: 'https://test',
      minCatalogueSize: 50,
      fetchImpl: fetchMock,
    });
    expect(result.total_discovered).toBe(2);
    expect(result.trusted_count).toBe(1);
    expect(result.peers).toHaveLength(1);
    expect(result.peers[0].oracle_pubkey).toBe('b'.repeat(64));
  });
});
