// Phase 9.0 — consolidation cron de crowd_outcome_reports vers
// endpoint_stage_posteriors.
//
// Le pipeline web-of-trust complet :
//   agent → publishes kind 7402 outcome event with PoW + preimage
//   ↓
//   subscriber → CrowdOutcomeIngestor → crowd_outcome_reports (avec weight)
//   ↓ (1h delay anti-spam)
//   crowdConsolidationCron → reads pending reports
//   ↓
//   for each : stagePosteriorsRepo.observeByUrlHash(weight effectif)
//   ↓
//   crowd_outcome_reports.consolidated_at = now (idempotence)
//   ↓
//   les posteriors stages 3+4+5 sont alimentés par les outcomes crowd
//   ↓
//   /api/intent + kind 30782 reflètent ces nouveaux observations
//
// Le délai 1h post-observed permet :
//   1. anomaly detection rétroactive (futur — pas implémenté yet)
//   2. fenêtre pour invalider un report si signal de fraude apparaît
//   3. déduplication tardive en cas d'arrivée late via un relai
//
// Le seuil minWeight (default 0.3 = BASE) filtre rien par défaut puisque
// la formule Sybil multiplie par >= 1.0 toujours. Configurable via
// CONSOLIDATION_MIN_WEIGHT env si Romain veut hausser plus tard.
import { logger } from '../logger';
import type { CrowdOutcomeRepository } from '../repositories/crowdOutcomeRepository';
import type {
  EndpointStagePosteriorsRepository,
  Stage,
} from '../repositories/endpointStagePosteriorsRepository';
import { BASE_WEIGHT } from '../utils/sybilWeighting';

export const DEFAULT_CONSOLIDATION_DELAY_SEC = 3600;
export const DEFAULT_CONSOLIDATION_MIN_WEIGHT = BASE_WEIGHT; // 0.3
export const DEFAULT_CONSOLIDATION_MAX_PER_CYCLE = 1000;

export interface CrowdConsolidationCronDeps {
  crowdRepo: CrowdOutcomeRepository;
  stagePosteriorsRepo: EndpointStagePosteriorsRepository;
  now?: () => number;
}

export interface CrowdConsolidationOptions {
  delaySec?: number;
  minWeight?: number;
  maxPerCycle?: number;
}

export interface CrowdConsolidationResult {
  consolidated: number;
  errors: number;
  cutoff_observed_at: number;
  cycle_started_at: number;
  cycle_finished_at: number;
}

export class CrowdConsolidationCron {
  private readonly now: () => number;

  constructor(private readonly deps: CrowdConsolidationCronDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async runOnce(opts: CrowdConsolidationOptions = {}): Promise<CrowdConsolidationResult> {
    const startedAt = this.now();
    const delaySec = opts.delaySec ?? DEFAULT_CONSOLIDATION_DELAY_SEC;
    const minWeight = opts.minWeight ?? DEFAULT_CONSOLIDATION_MIN_WEIGHT;
    const maxPerCycle = opts.maxPerCycle ?? DEFAULT_CONSOLIDATION_MAX_PER_CYCLE;
    const cutoff = startedAt - delaySec;

    const pending = await this.deps.crowdRepo.findPendingConsolidation(
      cutoff,
      minWeight,
      maxPerCycle,
    );

    let consolidated = 0;
    let errors = 0;

    for (const report of pending) {
      try {
        await this.deps.stagePosteriorsRepo.observeByUrlHash(
          report.endpoint_url_hash,
          report.stage as Stage,
          report.success,
          report.effective_weight,
          `crowd:${report.outcome}`,
          report.observed_at,
        );
        await this.deps.crowdRepo.markConsolidated(report.event_id, this.now());
        consolidated += 1;
      } catch (err) {
        errors += 1;
        logger.warn(
          {
            eventId: report.event_id.slice(0, 12),
            error: err instanceof Error ? err.message : String(err),
          },
          'CrowdConsolidationCron: report consolidation failed (skipping)',
        );
      }
    }

    const finishedAt = this.now();
    if (consolidated > 0 || errors > 0) {
      logger.info(
        {
          consolidated,
          errors,
          pending_total: pending.length,
          cutoff,
          duration_sec: finishedAt - startedAt,
        },
        'CrowdConsolidationCron: cycle complete',
      );
    }

    return {
      consolidated,
      errors,
      cutoff_observed_at: cutoff,
      cycle_started_at: startedAt,
      cycle_finished_at: finishedAt,
    };
  }
}
