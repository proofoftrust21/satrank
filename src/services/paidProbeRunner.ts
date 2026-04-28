// Phase 5.12 — paid probe runner pour Stage 3 (payment fulfillment) et
// Stage 4 (data delivery).
//
// Pour chaque endpoint sélectionné, exécute le cycle L402 complet :
//   1. GET → 402 + WWW-Authenticate
//   2. Decode BOLT11
//   3. Pay invoice via LND (lndClient.payInvoice)
//   4. GET avec L402 token (= preimage) → recall response
//
// Outcomes Stage 3 (paiement) :
//   pay_ok               — preimage retourné, ajoute 1 succès au stage 3
//   pay_routing_failed   — LND no_route / liquidity, ajoute 1 échec au stage 3
//   pay_other_failure    — autre erreur LND, ajoute 1 échec au stage 3
//   skipped_no_lnd       — LND pas wiré (test ou config invalide), pas d'obs
//   skipped_over_cap     — invoice price > maxPerProbeSats, pas d'obs
//   skipped_total_cap    — total spent + price > totalBudgetSats, pas d'obs
//
// Outcomes Stage 4 (delivery, après pay_ok) :
//   delivery_ok          — recall HTTP 2xx + body > 0, ajoute 1 succès stage 4
//   delivery_4xx         — recall 4xx, ajoute 1 échec stage 4
//   delivery_5xx         — recall 5xx, ajoute 1 échec stage 4
//   delivery_empty_body  — 2xx mais body vide, ajoute 1 échec stage 4
//
// Cost guards (en cascade, premier trigger gagne) :
//   maxPerProbeSats : jamais payer plus de N sats sur une seule probe
//   totalBudgetSats : ne pas dépasser ce total sur une cycle
//   maxProbesPerCycle : nombre max d'endpoints à prober (rate-limit)
//
// Aucun cron interne — caller (script, controller manuel) appelle runOnce().
import { logger } from '../logger';
import { fetchSafeExternal, SsrfBlockedError } from '../utils/ssrf';
import { parseL402Challenge } from '../utils/l402HeaderParser';
import { parseBolt11, InvalidBolt11Error } from '../utils/bolt11Parser';
import {
  EndpointStagePosteriorsRepository,
  STAGE_PAYMENT,
  STAGE_DELIVERY,
} from '../repositories/endpointStagePosteriorsRepository';
import type { LndGraphClient } from '../crawler/lndGraphClient';

const PAY_TIMEOUT_DEFAULT_SEC = 20;
const FETCH_TIMEOUT_MS = 8000;

export type PaidProbeOutcome =
  | 'pay_ok'
  | 'pay_routing_failed'
  | 'pay_other_failure'
  | 'skipped_no_lnd'
  | 'skipped_over_cap'
  | 'skipped_total_cap'
  | 'skipped_no_invoice'
  | 'skipped_invoice_decode_failed'
  | 'skipped_self_pay'
  | 'probe_no_response'
  | 'probe_not_402';

export type DeliveryOutcome =
  | 'delivery_ok'
  | 'delivery_4xx'
  | 'delivery_5xx'
  | 'delivery_empty_body'
  | 'delivery_other'
  | 'delivery_skipped'; // payment failed → no delivery to test

export interface PaidProbeResult {
  endpoint_url: string;
  payment: PaidProbeOutcome;
  delivery: DeliveryOutcome;
  sats_spent: number;
  /** Détail textuel ; jamais exposé via API publique. */
  detail?: string;
}

export interface PaidProbeRunOptions {
  endpoint_urls: string[];
  /** Cap absolu par probe. Une invoice > N sats est skipped (jamais payée). */
  maxPerProbeSats: number;
  /** Cap absolu sur l'ensemble du cycle. La probe N+1 est skipped si
   *  totalSpent + invoice_price > totalBudgetSats. */
  totalBudgetSats: number;
  /** Cap sur le nombre d'endpoints à prober dans cette cycle. */
  maxProbesPerCycle?: number;
  /** Pubkey LN du nœud SatRank lui-même, pour skip self-pay. Mainnet
   *  pubkey 66 chars hex. */
  selfPubkey: string;
  /** Fee limit passé à payInvoice. Default 10 sats. */
  feeLimitSats?: number;
}

export interface PaidProbeCycleSummary {
  results: PaidProbeResult[];
  totalSpent: number;
  outcomes: Record<PaidProbeOutcome, number>;
  deliveryOutcomes: Record<DeliveryOutcome, number>;
}

export interface PaidProbeRunnerDeps {
  stagesRepo: EndpointStagePosteriorsRepository;
  lndClient: LndGraphClient;
  /** fetch injectable pour tests. Default global fetch via fetchSafeExternal. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class PaidProbeRunner {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly deps: PaidProbeRunnerDeps) {
    this.fetchImpl = deps.fetchImpl ?? ((url, init) => fetchSafeExternal(url as string, init));
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async runOnce(opts: PaidProbeRunOptions): Promise<PaidProbeCycleSummary> {
    const summary: PaidProbeCycleSummary = {
      results: [],
      totalSpent: 0,
      outcomes: {
        pay_ok: 0,
        pay_routing_failed: 0,
        pay_other_failure: 0,
        skipped_no_lnd: 0,
        skipped_over_cap: 0,
        skipped_total_cap: 0,
        skipped_no_invoice: 0,
        skipped_invoice_decode_failed: 0,
        skipped_self_pay: 0,
        probe_no_response: 0,
        probe_not_402: 0,
      },
      deliveryOutcomes: {
        delivery_ok: 0,
        delivery_4xx: 0,
        delivery_5xx: 0,
        delivery_empty_body: 0,
        delivery_other: 0,
        delivery_skipped: 0,
      },
    };
    const limit = opts.maxProbesPerCycle ?? opts.endpoint_urls.length;
    const urls = opts.endpoint_urls.slice(0, limit);

    if (!this.deps.lndClient.payInvoice) {
      // Pas de wiring LND — on retourne tout en skipped_no_lnd.
      for (const url of urls) {
        const result: PaidProbeResult = {
          endpoint_url: url,
          payment: 'skipped_no_lnd',
          delivery: 'delivery_skipped',
          sats_spent: 0,
        };
        summary.results.push(result);
        summary.outcomes.skipped_no_lnd += 1;
        summary.deliveryOutcomes.delivery_skipped += 1;
      }
      return summary;
    }

    for (const url of urls) {
      const result = await this.probeOne(url, opts, summary.totalSpent);
      summary.results.push(result);
      summary.totalSpent += result.sats_spent;
      summary.outcomes[result.payment] += 1;
      summary.deliveryOutcomes[result.delivery] += 1;

      // Persister stage 3 (payment) — succès quand pay_ok, sinon échec.
      // skipped_* ne contribue PAS au stage 3 (l'endpoint n'a pas eu sa
      // chance, l'incrémenter pénaliserait à tort).
      if (
        result.payment === 'pay_ok' ||
        result.payment === 'pay_routing_failed' ||
        result.payment === 'pay_other_failure'
      ) {
        await this.deps.stagesRepo.observe(
          {
            endpoint_url: url,
            stage: STAGE_PAYMENT,
            success: result.payment === 'pay_ok',
            weight: 2, // WEIGHT_PAID_PROBE = 2.0 (paid > sovereign probe)
          },
          this.now(),
        );
      }

      // Persister stage 4 (delivery) — seulement quand on a effectivement
      // eu une recall (delivery != skipped).
      if (result.delivery !== 'delivery_skipped') {
        await this.deps.stagesRepo.observe(
          {
            endpoint_url: url,
            stage: STAGE_DELIVERY,
            success: result.delivery === 'delivery_ok',
            weight: 2,
          },
          this.now(),
        );
      }
    }

    return summary;
  }

  private async probeOne(
    url: string,
    opts: PaidProbeRunOptions,
    spentSoFar: number,
  ): Promise<PaidProbeResult> {
    // Step 1 — GET 402 challenge.
    let firstResp: Response;
    try {
      firstResp = await this.fetchImpl(url, {
        method: 'GET',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'SatRank-PaidProbe/1.0' },
      });
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        logger.debug({ url, reason: err.message }, 'PaidProbe SSRF block');
      }
      return {
        endpoint_url: url,
        payment: 'probe_no_response',
        delivery: 'delivery_skipped',
        sats_spent: 0,
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    if (firstResp.status !== 402) {
      return {
        endpoint_url: url,
        payment: 'probe_not_402',
        delivery: 'delivery_skipped',
        sats_spent: 0,
        detail: `status=${firstResp.status}`,
      };
    }

    const wwwAuth = firstResp.headers.get('www-authenticate');
    const challenge = parseL402Challenge(wwwAuth);
    if (!challenge) {
      return {
        endpoint_url: url,
        payment: 'skipped_no_invoice',
        delivery: 'delivery_skipped',
        sats_spent: 0,
        detail: 'no L402 challenge in response',
      };
    }

    // Step 2 — decode invoice.
    let amountSats = 0;
    let payeeNodeKey: string | null = null;
    try {
      const parsed = parseBolt11(challenge.invoice);
      amountSats = parsed.amountSats ?? 0;
      payeeNodeKey = parsed.payeeNodeKey;
    } catch (err) {
      return {
        endpoint_url: url,
        payment: 'skipped_invoice_decode_failed',
        delivery: 'delivery_skipped',
        sats_spent: 0,
        detail: err instanceof InvalidBolt11Error ? err.message : String(err),
      };
    }

    // Step 2b — self-pay guard.
    if (payeeNodeKey === opts.selfPubkey) {
      return {
        endpoint_url: url,
        payment: 'skipped_self_pay',
        delivery: 'delivery_skipped',
        sats_spent: 0,
        detail: 'destination is satrank own LND',
      };
    }

    // Step 2c — cost guards.
    if (amountSats > opts.maxPerProbeSats) {
      return {
        endpoint_url: url,
        payment: 'skipped_over_cap',
        delivery: 'delivery_skipped',
        sats_spent: 0,
        detail: `amount=${amountSats} > cap=${opts.maxPerProbeSats}`,
      };
    }
    if (spentSoFar + amountSats > opts.totalBudgetSats) {
      return {
        endpoint_url: url,
        payment: 'skipped_total_cap',
        delivery: 'delivery_skipped',
        sats_spent: 0,
        detail: `spent=${spentSoFar} + ${amountSats} > total=${opts.totalBudgetSats}`,
      };
    }

    // Step 3 — pay invoice.
    const feeLimit = opts.feeLimitSats ?? 10;
    const pay = this.deps.lndClient.payInvoice
      ? await this.deps.lndClient.payInvoice(challenge.invoice, feeLimit)
      : { paymentPreimage: '', paymentHash: '', paymentError: 'no payInvoice' };

    if (pay.paymentError || !pay.paymentPreimage) {
      const detail = pay.paymentError ?? 'no preimage returned';
      const isRouting = /no.?route|no_route|FAILURE_REASON_NO_ROUTE|insufficient/i.test(detail);
      return {
        endpoint_url: url,
        payment: isRouting ? 'pay_routing_failed' : 'pay_other_failure',
        delivery: 'delivery_skipped',
        sats_spent: 0, // paiement n'a pas settled
        detail,
      };
    }

    // Step 4 — recall avec L402 token.
    const token = `L402 ${challenge.macaroon}:${pay.paymentPreimage}`;
    let recallResp: Response;
    try {
      recallResp = await this.fetchImpl(url, {
        method: 'GET',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'User-Agent': 'SatRank-PaidProbe/1.0',
          Authorization: token,
        },
      });
    } catch {
      return {
        endpoint_url: url,
        payment: 'pay_ok',
        delivery: 'delivery_other',
        sats_spent: amountSats,
        detail: 'recall fetch failed',
      };
    }

    const status = recallResp.status;
    const body = await safeText(recallResp);
    const bodySize = body.length;

    let delivery: DeliveryOutcome;
    if (status >= 200 && status < 300) {
      delivery = bodySize >= 10 ? 'delivery_ok' : 'delivery_empty_body';
    } else if (status >= 400 && status < 500) {
      delivery = 'delivery_4xx';
    } else if (status >= 500 && status < 600) {
      delivery = 'delivery_5xx';
    } else {
      delivery = 'delivery_other';
    }

    return {
      endpoint_url: url,
      payment: 'pay_ok',
      delivery,
      sats_spent: amountSats,
      detail: `recall_status=${status} body_size=${bodySize}`,
    };
  }
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}
