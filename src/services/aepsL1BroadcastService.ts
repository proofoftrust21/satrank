// AEPS §8 (Phase 12A — 2026-05-07) — L1 anchor broadcast service.
//
// Each daily Merkle root is committed to Bitcoin L1 in an OP_RETURN tx :
//
//     OP_RETURN <"AEPS1"> <op_pubkey[8]> <day[4]> <root[32]>   — 49 bytes
//
// The 49-byte payload is built by `dailyMerkleAnchorService.buildOpReturnPayload`
// per whitepaper §8.3. This service wraps the broadcast cycle :
//
//   1. fetch the recommended fee rate from a public mempool API
//   2. enforce the configured cap and a 1 sat/vB plancher
//   3. call LND `walletrpc.WalletKit/SendOutputs` over REST with the OP_RETURN
//      script and the chosen fee rate
//   4. compute the txid from the signed raw tx (Bitcoin double-SHA256)
//   5. persist (l1_txid, l1_op_return_hex, l1_broadcast_at) via repo
//
// Scaling property : the same 49 bytes anchor 1 receipt or 1 million —
// log(N) Merkle proofs let agents verify inclusion later without re-reading
// the chain. Cost is **constant** regardless of catalogue size.
//
// Failure model : LND outage, fee API outage, fee > cap → SKIP this cycle.
// The day's anchor row keeps `l1_txid IS NULL` and the cron retries at the
// next tick. Idempotency : a row with `l1_txid` already populated is never
// re-broadcast.
import { logger } from '../logger';
import { fetchSafeExternal } from '../utils/ssrf';
import { txidFromRawTx, buildOpReturnScript } from '../utils/btcTxidUtil';
import type { DailyMerkleAnchor, DailyMerkleAnchorRepository } from '../repositories/dailyMerkleAnchorRepository';

const FEE_API_TIMEOUT_MS = 5_000;
const LND_TIMEOUT_MS = 30_000;
const MIN_RELAY_SAT_VBYTE = 1;

export type BroadcastResult =
  | { status: 'ok'; txid: string; raw_tx_hex: string; sat_per_vbyte: number; broadcast_at: number }
  | { status: 'skipped_already'; existing_txid: string }
  | { status: 'skipped_no_receipts' }
  | { status: 'skipped_disabled' }
  | { status: 'skipped_no_macaroon' }
  | { status: 'skipped_cap'; market_sat_per_vbyte: number; cap: number }
  | { status: 'error'; reason: string };

export interface MempoolFeeResponse {
  /** sat/vB target for confirmation in next 1-2 blocks. */
  fastestFee: number;
  /** sat/vB target for ~30-min confirmation (3 blocks). */
  halfHourFee: number;
  /** sat/vB target for ~1h confirmation (6 blocks). */
  hourFee: number;
  /** sat/vB lower bound — relay-safe but may take days. */
  economyFee: number;
  /** Absolute floor below which a tx will not be relayed. */
  minimumFee: number;
}

export interface AepsL1BroadcastDeps {
  repo: DailyMerkleAnchorRepository;
  /** LND REST base URL, e.g. https://localhost:8080. Trailing slash trimmed. */
  lndRestUrl: string;
  /** Hex-encoded macaroon with onchain:write permission. Empty disables broadcast. */
  onchainMacaroonHex: string;
  /** Mempool fee API URL ; default mempool.space. */
  feeApiUrl: string;
  /** Hard cap. Tx skipped (and retried tomorrow) if `hourFee > cap`. */
  maxFeeRateSatVByte: number;
  /** Master switch ; when false the service short-circuits every call. */
  enabled: boolean;
  /** Injection point for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class AepsL1BroadcastService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly deps: AepsL1BroadcastDeps) {
    this.fetchImpl =
      deps.fetchImpl ??
      ((url, init) => fetchSafeExternal(typeof url === 'string' ? url : url.toString(), init));
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** One-shot broadcast for a single anchor. Idempotent ; returns
   *  `skipped_already` when the row already has an l1_txid. The 49-byte
   *  `opReturnPayload` is built by the caller via
   *  `dailyMerkleAnchorService.buildOpReturnPayload(...)`. */
  async broadcastIfReady(
    anchor: DailyMerkleAnchor,
    opReturnPayload: Buffer,
  ): Promise<BroadcastResult> {
    if (!this.deps.enabled) {
      return { status: 'skipped_disabled' };
    }
    if (anchor.l1_txid) {
      return { status: 'skipped_already', existing_txid: anchor.l1_txid };
    }
    if (anchor.receipt_count === 0) {
      // Empty days produce an all-zeros root and no real evidence to commit ;
      // skip broadcasting and save the fee. Re-attempts on subsequent days
      // pick up real receipts and resume normal operation.
      return { status: 'skipped_no_receipts' };
    }
    if (!this.deps.onchainMacaroonHex || this.deps.onchainMacaroonHex.length === 0) {
      logger.warn(
        { day_utc: anchor.day_utc, anchor_id: anchor.anchor_id },
        'AEPS L1 broadcast: enabled but onchain macaroon not loaded — skipped',
      );
      return { status: 'skipped_no_macaroon' };
    }

    // Step 1 — query market fee.
    let market: number;
    try {
      market = await this.fetchHourFee();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(
        { day_utc: anchor.day_utc, error: reason },
        'AEPS L1 broadcast: fee API query failed — skipped',
      );
      return { status: 'error', reason: `fee_api: ${reason}` };
    }

    if (market > this.deps.maxFeeRateSatVByte) {
      logger.info(
        {
          day_utc: anchor.day_utc,
          market_sat_per_vbyte: market,
          cap: this.deps.maxFeeRateSatVByte,
        },
        'AEPS L1 broadcast: market fee exceeds cap — skipped, retry next cycle',
      );
      return {
        status: 'skipped_cap',
        market_sat_per_vbyte: market,
        cap: this.deps.maxFeeRateSatVByte,
      };
    }

    // Plancher 1 sat/vB pour fiabilité de propagation.
    const satPerVByte = Math.max(MIN_RELAY_SAT_VBYTE, market);

    // Step 2 — build OP_RETURN script.
    const script = buildOpReturnScript(opReturnPayload);

    // Step 3 — call LND SendOutputs.
    let rawTxHex: string;
    try {
      rawTxHex = await this.callLndSendOutputs(script, satPerVByte, anchor.day_utc);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(
        { day_utc: anchor.day_utc, error: reason, sat_per_vbyte: satPerVByte },
        'AEPS L1 broadcast: LND SendOutputs failed',
      );
      return { status: 'error', reason: `lnd: ${reason}` };
    }

    // Step 4 — compute txid.
    let txid: string;
    try {
      txid = txidFromRawTx(rawTxHex);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(
        { day_utc: anchor.day_utc, error: reason, raw_tx_first16: rawTxHex.slice(0, 16) },
        'AEPS L1 broadcast: txid computation failed — tx may have broadcast but DB will not record',
      );
      return { status: 'error', reason: `txid_compute: ${reason}` };
    }

    // Step 5 — persist.
    const broadcastAt = this.now();
    try {
      await this.deps.repo.recordL1Broadcast(anchor.anchor_id, {
        l1_txid: txid,
        l1_op_return_hex: opReturnPayload.toString('hex'),
        l1_broadcast_at: broadcastAt,
        l1_block_height: null, // filled later by confirmation watcher
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(
        {
          day_utc: anchor.day_utc,
          txid,
          anchor_id: anchor.anchor_id,
          error: reason,
        },
        'AEPS L1 broadcast: tx broadcast OK but recordL1Broadcast failed — manual reconciliation required',
      );
      return { status: 'error', reason: `repo_persist: ${reason}` };
    }

    logger.info(
      {
        day_utc: anchor.day_utc,
        txid_first8: txid.slice(0, 8),
        sat_per_vbyte: satPerVByte,
        market_sat_per_vbyte: market,
        receipt_count: anchor.receipt_count,
      },
      'AEPS §8: L1 anchor broadcast complete',
    );

    return {
      status: 'ok',
      txid,
      raw_tx_hex: rawTxHex,
      sat_per_vbyte: satPerVByte,
      broadcast_at: broadcastAt,
    };
  }

  /** Query the public fee API. Returns hourFee (priorité moyenne). Throws on
   *  any failure ; caller catches + logs + skips. */
  private async fetchHourFee(): Promise<number> {
    const resp = await this.fetchImpl(this.deps.feeApiUrl, {
      signal: AbortSignal.timeout(FEE_API_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      throw new Error(`fee API status ${resp.status}`);
    }
    const raw = (await resp.json()) as Partial<MempoolFeeResponse>;
    if (typeof raw.hourFee !== 'number' || raw.hourFee < 0) {
      throw new Error(`fee API returned invalid hourFee: ${JSON.stringify(raw)}`);
    }
    return Math.round(raw.hourFee);
  }

  /** Call LND `/v2/wallet/sendoutputs` with a single OP_RETURN output.
   *  Returns the raw tx hex of the broadcast tx. Throws on any failure. */
  private async callLndSendOutputs(
    script: Buffer,
    satPerVByte: number,
    dayUtc: string,
  ): Promise<string> {
    const url = `${this.deps.lndRestUrl.replace(/\/$/, '')}/v2/wallet/sendoutputs`;
    const body = JSON.stringify({
      // OP_RETURN value is 0 sats. LND's WalletKit covers the fee from a
      // change output it computes itself.
      outputs: [
        {
          value: '0',
          pk_script: script.toString('base64'),
        },
      ],
      sat_per_vbyte: String(satPerVByte),
      label: `aeps-anchor-${dayUtc}`,
      // spend_unconfirmed left default (false) — we don't want to chain
      // anchor txs off unconfirmed inputs.
    });
    const resp = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Grpc-Metadata-macaroon': this.deps.onchainMacaroonHex,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(LND_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`LND ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = (await resp.json()) as { raw_tx?: string; error?: string };
    if (data.error) {
      throw new Error(data.error);
    }
    if (!data.raw_tx || typeof data.raw_tx !== 'string') {
      throw new Error('LND response missing raw_tx');
    }
    // LND REST encodes proto bytes as base64.
    const rawBytes = Buffer.from(data.raw_tx, 'base64');
    return rawBytes.toString('hex');
  }
}
