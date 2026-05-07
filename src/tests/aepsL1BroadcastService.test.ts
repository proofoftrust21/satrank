// Phase 12A — AEPS L1 broadcast service unit tests.
//
// We mock both the fee API and LND REST so the service can be exercised
// deterministically without an actual Bitcoin node. The tests cover :
//   - happy path : market < cap → broadcast → persist
//   - skipped_already, skipped_no_receipts, skipped_disabled, skipped_no_macaroon
//   - skipped_cap (market > cap)
//   - error paths : fee API down, LND error, repo persist failure
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AepsL1BroadcastService,
  type AepsL1BroadcastDeps,
} from '../services/aepsL1BroadcastService';
import type { DailyMerkleAnchor, DailyMerkleAnchorRepository } from '../repositories/dailyMerkleAnchorRepository';
import { txidFromRawTx } from '../utils/btcTxidUtil';

const FEE_URL = 'https://example.test/fees';
const LND_URL = 'https://lnd.example.test:8080';
const ONCHAIN_MAC = 'deadbeef'.repeat(16);

function makeAnchor(overrides: Partial<DailyMerkleAnchor> = {}): DailyMerkleAnchor {
  return {
    anchor_id: 1,
    day_utc: '2026-05-07',
    operator_pubkey: 'aa'.repeat(32),
    root_hex: 'bb'.repeat(32),
    receipt_count: 5,
    receipt_first_id: 1,
    receipt_last_id: 5,
    computed_at: 1_000_000,
    nostr_event_id: null,
    nostr_published_at: null,
    l1_txid: null,
    l1_op_return_hex: null,
    l1_block_height: null,
    l1_broadcast_at: null,
    ...overrides,
  };
}

const MINIMAL_LEGACY_TX_HEX =
  '01000000' +
  '01' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '00000000' +
  '00' +
  'ffffffff' +
  '01' +
  '0000000000000000' +
  '00' +
  '00000000';

function makeFakeFetch(impl: {
  feeJson?: Record<string, number>;
  feeStatus?: number;
  lndRawTxBase64?: string;
  lndStatus?: number;
  lndError?: string;
}): typeof fetch {
  return ((url: string | URL, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.startsWith(FEE_URL)) {
      if (impl.feeStatus && impl.feeStatus !== 200) {
        return Promise.resolve(new Response('', { status: impl.feeStatus }));
      }
      return Promise.resolve(
        new Response(JSON.stringify(impl.feeJson ?? {}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    if (u.startsWith(LND_URL)) {
      // Body should be POST JSON ; basic sanity.
      expect(init?.method).toBe('POST');
      if (impl.lndStatus && impl.lndStatus !== 200) {
        return Promise.resolve(
          new Response(impl.lndError ?? 'lnd error', { status: impl.lndStatus }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ raw_tx: impl.lndRawTxBase64 ?? '' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    return Promise.reject(new Error(`unexpected fetch ${u}`));
  }) as typeof fetch;
}

function makeRepoMock(opts?: { recorded?: boolean }): DailyMerkleAnchorRepository {
  // Phase 12A audit fix HIGH-1 — recordL1Broadcast now returns
  // { recorded: boolean } so the service can detect concurrent broadcasts.
  return {
    recordL1Broadcast: vi.fn(async () => ({ recorded: opts?.recorded ?? true })),
  } as unknown as DailyMerkleAnchorRepository;
}

const PAYLOAD = Buffer.alloc(49, 0xab);

describe('AepsL1BroadcastService', () => {
  let repo: DailyMerkleAnchorRepository;

  beforeEach(() => {
    repo = makeRepoMock();
  });

  function buildService(over: Partial<AepsL1BroadcastDeps>): AepsL1BroadcastService {
    return new AepsL1BroadcastService({
      repo,
      lndRestUrl: LND_URL,
      onchainMacaroonHex: ONCHAIN_MAC,
      feeApiUrl: FEE_URL,
      maxFeeRateSatVByte: 5,
      enabled: true,
      now: () => 1_000_000,
      ...over,
    });
  }

  it('happy path : broadcasts when market ≤ cap, persists txid', async () => {
    const rawTxBase64 = Buffer.from(MINIMAL_LEGACY_TX_HEX, 'hex').toString('base64');
    const fetchImpl = makeFakeFetch({
      feeJson: { hourFee: 2, fastestFee: 5, halfHourFee: 3, economyFee: 1, minimumFee: 1 },
      lndRawTxBase64: rawTxBase64,
    });
    const svc = buildService({ fetchImpl });
    const result = await svc.broadcastIfReady(makeAnchor(), PAYLOAD);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.txid).toBe(txidFromRawTx(MINIMAL_LEGACY_TX_HEX));
    expect(result.sat_per_vbyte).toBe(2);
    expect(repo.recordL1Broadcast).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        l1_txid: result.txid,
        l1_op_return_hex: PAYLOAD.toString('hex'),
        l1_broadcast_at: 1_000_000,
        l1_block_height: null,
      }),
    );
  });

  it('plancher 1 sat/vB : market < 1 → use 1', async () => {
    const rawTxBase64 = Buffer.from(MINIMAL_LEGACY_TX_HEX, 'hex').toString('base64');
    const fetchImpl = makeFakeFetch({
      feeJson: { hourFee: 0, fastestFee: 0, halfHourFee: 0, economyFee: 0, minimumFee: 0 },
      lndRawTxBase64: rawTxBase64,
    });
    const svc = buildService({ fetchImpl });
    const result = await svc.broadcastIfReady(makeAnchor(), PAYLOAD);
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.sat_per_vbyte).toBe(1);
  });

  it('skipped_cap : market > cap → no broadcast, no persist', async () => {
    const fetchImpl = makeFakeFetch({
      feeJson: { hourFee: 50, fastestFee: 100, halfHourFee: 75, economyFee: 30, minimumFee: 1 },
    });
    const svc = buildService({ fetchImpl, maxFeeRateSatVByte: 5 });
    const result = await svc.broadcastIfReady(makeAnchor(), PAYLOAD);
    expect(result.status).toBe('skipped_cap');
    if (result.status !== 'skipped_cap') return;
    expect(result.market_sat_per_vbyte).toBe(50);
    expect(result.cap).toBe(5);
    expect(repo.recordL1Broadcast).not.toHaveBeenCalled();
  });

  it('skipped_already : anchor already has l1_txid', async () => {
    const fetchImpl = vi.fn(); // should never be called
    const svc = buildService({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const anchor = makeAnchor({ l1_txid: 'cafe'.repeat(16) });
    const result = await svc.broadcastIfReady(anchor, PAYLOAD);
    expect(result.status).toBe('skipped_already');
    if (result.status !== 'skipped_already') return;
    expect(result.existing_txid).toBe('cafe'.repeat(16));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(repo.recordL1Broadcast).not.toHaveBeenCalled();
  });

  it('skipped_no_receipts : anchor with receipt_count=0 not broadcast', async () => {
    const fetchImpl = vi.fn();
    const svc = buildService({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await svc.broadcastIfReady(makeAnchor({ receipt_count: 0 }), PAYLOAD);
    expect(result.status).toBe('skipped_no_receipts');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skipped_disabled : enabled=false short-circuits', async () => {
    const fetchImpl = vi.fn();
    const svc = buildService({ fetchImpl: fetchImpl as unknown as typeof fetch, enabled: false });
    const result = await svc.broadcastIfReady(makeAnchor(), PAYLOAD);
    expect(result.status).toBe('skipped_disabled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skipped_no_macaroon : enabled but macaroon empty', async () => {
    const fetchImpl = vi.fn();
    const svc = buildService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onchainMacaroonHex: '',
    });
    const result = await svc.broadcastIfReady(makeAnchor(), PAYLOAD);
    expect(result.status).toBe('skipped_no_macaroon');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('error : fee API down', async () => {
    const fetchImpl = makeFakeFetch({ feeStatus: 500 });
    const svc = buildService({ fetchImpl });
    const result = await svc.broadcastIfReady(makeAnchor(), PAYLOAD);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.reason).toContain('fee_api');
  });

  it('error : LND returns 4xx', async () => {
    const fetchImpl = makeFakeFetch({
      feeJson: { hourFee: 2, fastestFee: 3, halfHourFee: 2, economyFee: 1, minimumFee: 1 },
      lndStatus: 401,
      lndError: 'permission denied',
    });
    const svc = buildService({ fetchImpl });
    const result = await svc.broadcastIfReady(makeAnchor(), PAYLOAD);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.reason).toContain('lnd');
  });

  it('error : LND returns no raw_tx', async () => {
    const fetchImpl = makeFakeFetch({
      feeJson: { hourFee: 2, fastestFee: 3, halfHourFee: 2, economyFee: 1, minimumFee: 1 },
      lndRawTxBase64: '',
    });
    const svc = buildService({ fetchImpl });
    const result = await svc.broadcastIfReady(makeAnchor(), PAYLOAD);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.reason).toMatch(/missing raw_tx/);
  });
});
