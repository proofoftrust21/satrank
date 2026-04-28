// Phase 5.11 — Stage 2 invoice validity. Validation structurelle d'une BOLT11
// extraite d'un challenge L402. Coût zéro sat (decode local uniquement, pas
// de queryroutes). Ne mesure pas la routabilité (= stage 3, paid probe).
import { parseBolt11, InvalidBolt11Error, type ParsedBolt11 } from './bolt11Parser';

export type InvoiceValidityOutcome =
  | 'valid'
  | 'decode_failed'
  | 'wrong_network'
  | 'no_payee'
  | 'amount_mismatch'
  | 'expired';

export interface InvoiceValidationResult {
  outcome: InvoiceValidityOutcome;
  /** Parsed BOLT11 quand le decode a réussi. null sur 'decode_failed'. */
  parsed: ParsedBolt11 | null;
  /** Détail textuel en cas d'échec. Loggé en warn, jamais exposé à l'API. */
  detail?: string;
}

/** Tolérance amount mismatch : on accepte que le BOLT11 amount diverge de
 *  ±50% du prix annoncé. Au-delà, on flag amount_mismatch.
 *  Justification : 402index publie price_sats au plus proche entier ; les
 *  endpoints peuvent arrondir vers le bas/haut. ±50% absorbe l'arrondi mais
 *  rejette les "promised 5 sats, charged 500". */
export const AMOUNT_MISMATCH_RATIO = 0.5;

/** Marge avant expiration considérée comme expirée. Une invoice expirant
 *  dans <60s n'est pas payable de façon fiable (latence routing + retry). */
export const EXPIRY_SAFETY_MARGIN_SEC = 60;

export interface ValidationContext {
  /** Prix annoncé par le catalogue (402index price_sats). null = non
   *  annoncé, donc on n'applique pas la check amount_mismatch. */
  advertisedPriceSats: number | null;
  /** Epoch seconds, temps courant. Injectable pour tests déterministes. */
  nowSec: number;
}

/** Valide une invoice BOLT11 d'un challenge L402. Pure function : pas de DB,
 *  pas d'I/O. Retourne le premier outcome qui échoue (court-circuit). */
export function validateInvoice(
  rawInvoice: string,
  ctx: ValidationContext,
): InvoiceValidationResult {
  let parsed: ParsedBolt11;
  try {
    parsed = parseBolt11(rawInvoice);
  } catch (err) {
    const detail = err instanceof InvalidBolt11Error ? err.message : String(err);
    return { outcome: 'decode_failed', parsed: null, detail };
  }

  // Réseau : SatRank opère sur mainnet uniquement. Une invoice testnet/signet
  // n'est pas payable depuis notre LND mainnet.
  if (parsed.network !== 'mainnet') {
    return {
      outcome: 'wrong_network',
      parsed,
      detail: `expected mainnet, got ${parsed.network}`,
    };
  }

  // Payee node key : sans destination, on ne peut ni vérifier la routabilité
  // ni attribuer le paiement à un opérateur. Le BOLT11 spec rend payee_node_key
  // optionnel (le routing peut le dériver de la signature) mais pour la
  // mesure on requiert qu'il soit explicite.
  if (!parsed.payeeNodeKey) {
    return { outcome: 'no_payee', parsed, detail: 'BOLT11 missing payee_node_key' };
  }

  // Expiration : timestamp + expiryTime > now + safety_margin.
  // expiryTime peut être null (= 1h défaut BOLT11). On n'a pas de garantie de
  // l'invoice timestamp non plus ; en cas d'absence on ne flag pas expired
  // (preuve d'un faux-positif > flag silencieux).
  if (parsed.timestamp != null && parsed.expiryTime != null) {
    const expiresAt = parsed.timestamp + parsed.expiryTime;
    if (expiresAt < ctx.nowSec + EXPIRY_SAFETY_MARGIN_SEC) {
      return {
        outcome: 'expired',
        parsed,
        detail: `expires at ${expiresAt}, now=${ctx.nowSec}, margin=${EXPIRY_SAFETY_MARGIN_SEC}`,
      };
    }
  }

  // Amount cohérent avec le prix annoncé. Skipped si le catalogue n'expose
  // pas le prix (dans ce cas on accepte le BOLT11 amount tel quel).
  if (
    ctx.advertisedPriceSats != null &&
    ctx.advertisedPriceSats > 0 &&
    parsed.amountSats != null
  ) {
    const ratio = parsed.amountSats / ctx.advertisedPriceSats;
    if (ratio < 1 - AMOUNT_MISMATCH_RATIO || ratio > 1 + AMOUNT_MISMATCH_RATIO) {
      return {
        outcome: 'amount_mismatch',
        parsed,
        detail: `advertised=${ctx.advertisedPriceSats}, BOLT11=${parsed.amountSats}, ratio=${ratio.toFixed(2)}`,
      };
    }
  }

  return { outcome: 'valid', parsed };
}
