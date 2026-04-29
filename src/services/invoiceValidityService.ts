// Phase 5.11 — Stage 2 invoice validity service.
//
// Wrapper autour de invoiceValidator qui fait la persistance dans
// endpoint_stage_posteriors stage=2. Appelable par n'importe quel caller qui
// a déjà extrait le BOLT11 d'un challenge L402 (serviceHealthCrawler,
// freshProbeService, registryCrawler).
//
// Le coût est zéro sat : on ne paye pas l'invoice, on la décode + valide
// localement. Mesure mesurée par la BOLT11 lib + des règles structurelles.
import { logger } from '../logger';
import {
  EndpointStagePosteriorsRepository,
  STAGE_INVOICE,
} from '../repositories/endpointStagePosteriorsRepository';
import {
  validateInvoice,
  type InvoiceValidationResult,
  type ValidationContext,
} from '../utils/invoiceValidator';

export interface InvoiceObservation {
  endpoint_url: string;
  invoice: string;
  advertisedPriceSats: number | null;
  /** Epoch seconds. Permet aux tests d'injecter un now déterministe. */
  nowSec?: number;
}

export class InvoiceValidityService {
  constructor(private readonly stagesRepo: EndpointStagePosteriorsRepository) {}

  /** Phase 5.11 — valide + persiste. Pas d'I/O réseau : la validation est
   *  purement locale (decode BOLT11 + checks structurels). Retourne le
   *  résultat brut pour que le caller puisse logger / décider de la suite
   *  (un BOLT11 invalide annule la suite du paid probe stage 3). */
  async observe(obs: InvoiceObservation): Promise<InvoiceValidationResult> {
    const nowSec = obs.nowSec ?? Math.floor(Date.now() / 1000);
    const ctx: ValidationContext = {
      advertisedPriceSats: obs.advertisedPriceSats,
      nowSec,
    };
    const result = validateInvoice(obs.invoice, ctx);
    const success = result.outcome === 'valid';

    try {
      await this.stagesRepo.observe(
        {
          endpoint_url: obs.endpoint_url,
          stage: STAGE_INVOICE,
          success,
        },
        nowSec,
      );
    } catch (err) {
      logger.warn(
        {
          url: obs.endpoint_url,
          outcome: result.outcome,
          error: err instanceof Error ? err.message : String(err),
        },
        'Invoice validity observation persist failed',
      );
    }

    if (!success) {
      logger.info(
        {
          url: obs.endpoint_url,
          outcome: result.outcome,
          detail: result.detail,
        },
        'Stage 2 — invoice validity check failed',
      );
    }

    return result;
  }
}
