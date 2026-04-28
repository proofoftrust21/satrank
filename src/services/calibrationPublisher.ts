// Phase 5.15 — calibrationPublisher : build + publish kind 30783 Nostr event.
//
// LE MOAT. Cet event est l'évidence publique signée du delta predicted-vs-
// observed sur les 7 derniers jours. À chaque cycle hebdo, un nouvel event
// est publié sur les relais configurés (3 relais SatRank par défaut).
//
// Le content reste léger pour rester sous la limite des relais (~64KB) — on
// embarque les aggregate stats + un échantillon des per-endpoint deltas (top
// 20 ranked par delta DESC). Le détail complet vit dans
// oracle_calibration_runs (DB locale, queryable via /api/oracle/calibration
// future API).
//
// Schema kind 30783 (proposed, kind range NIP-33 addressable replaceable) :
//
//   {
//     kind: 30783,
//     tags: [
//       ['d', 'satrank-calibration'],
//       ['window_start', '<unix>'],
//       ['window_end', '<unix>'],
//       ['delta_mean', '0.0XXX'],
//       ['delta_median', '0.0XXX'],
//       ['delta_p95', '0.0XXX'],
//       ['n_endpoints', '<int>'],
//       ['n_outcomes', '<int>'],
//       ['oracle_pubkey', '<sha256 of LND pubkey>'],
//     ],
//     content: '<JSON: aggregates + top 20 per-endpoint deltas>',
//   }
import { logger } from '../logger';
import type { NostrMultiKindPublisher } from '../nostr/nostrMultiKindPublisher';
import type {
  CalibrationResult,
  CalibrationService,
  CalibrationServiceOptions,
} from './calibrationService';
import type { CalibrationRepository } from '../repositories/calibrationRepository';

export const KIND_ORACLE_CALIBRATION = 30783;

export interface CalibrationPublisherDeps {
  service: CalibrationService;
  repo: CalibrationRepository;
  /** Optional — if absent (e.g. tests sans Nostr), on persiste localement
   *  mais on ne publie pas à l'extérieur. La calibration est calculée et
   *  loggée quand même. */
  publisher?: NostrMultiKindPublisher;
  /** Pubkey publique de l'oracle (= identité Nostr de SatRank). Embarqué
   *  comme tag pour que les agents fédèrent par pubkey. */
  oraclePubkey: string;
  now?: () => number;
}

export interface CalibrationPublishResult {
  /** ID de l'event Nostr publié, null quand publisher absent. */
  eventId: string | null;
  /** Détail aggrégé pour les callers (logs, /api/oracle/calibration). */
  result: CalibrationResult;
  /** ID local en DB. */
  runId: number;
}

export class CalibrationPublisher {
  private readonly now: () => number;

  constructor(private readonly deps: CalibrationPublisherDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Cycle hebdo : compute → publish kind 30783 → persist run record.
   *  Idempotent au niveau-fenêtre : si une run existe déjà avec le même
   *  window_end, on ne re-publie pas (skipsParam). */
  async publishCycle(
    options: CalibrationServiceOptions = {},
  ): Promise<CalibrationPublishResult | null> {
    const result = await this.deps.service.computeCalibration(this.now(), options);

    // Idempotence : skip si un run récent (≥ il y a 6 jours) existe déjà.
    const latest = await this.deps.repo.findLatestRun();
    if (latest && latest.window_end >= result.window_end - 6 * 86400) {
      logger.info(
        { latest_window_end: latest.window_end, target_window_end: result.window_end },
        'CalibrationPublisher: skipping — recent run exists',
      );
      return null;
    }

    let eventId: string | null = null;
    if (this.deps.publisher) {
      try {
        const template = buildCalibrationTemplate(result, this.deps.oraclePubkey, this.now());
        const publishResult = await this.deps.publisher.publishTemplate(template);
        eventId = publishResult.eventId;
        logger.info(
          {
            eventId: eventId.slice(0, 12),
            anySuccess: publishResult.anySuccess,
            n_endpoints: result.n_endpoints,
            delta_mean: result.delta_mean,
          },
          'CalibrationPublisher: kind 30783 published',
        );
      } catch (err) {
        logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          'CalibrationPublisher: publish failed (run still persisted locally)',
        );
      }
    } else {
      logger.info(
        { n_endpoints: result.n_endpoints, delta_mean: result.delta_mean },
        'CalibrationPublisher: no publisher wired — local-only',
      );
    }

    const runId = await this.deps.repo.insertCalibrationRun({
      window_start: result.window_start,
      window_end: result.window_end,
      delta_mean: result.delta_mean,
      delta_median: result.delta_median,
      delta_p95: result.delta_p95,
      n_endpoints: result.n_endpoints,
      n_outcomes: result.n_outcomes,
      published_event_id: eventId,
      created_at: this.now(),
    });

    return { eventId, result, runId };
  }
}

/** Construit le template kind 30783 prêt à signer + publier. Pure function,
 *  testable en isolation. */
export function buildCalibrationTemplate(
  result: CalibrationResult,
  oraclePubkey: string,
  createdAt: number,
): { kind: number; created_at: number; tags: string[][]; content: string } {
  const fmt = (x: number | null) => (x == null ? 'null' : x.toFixed(4));
  const tags: string[][] = [
    ['d', 'satrank-calibration'],
    ['window_start', String(result.window_start)],
    ['window_end', String(result.window_end)],
    ['delta_mean', fmt(result.delta_mean)],
    ['delta_median', fmt(result.delta_median)],
    ['delta_p95', fmt(result.delta_p95)],
    ['n_endpoints', String(result.n_endpoints)],
    ['n_outcomes', String(result.n_outcomes)],
    ['oracle_pubkey', oraclePubkey],
  ];

  // Top 20 per-endpoint deltas, ranked DESC. Permet aux agents et autres
  // oracles de voir où l'oracle se trompe le plus, sans exploser la taille
  // du payload sur les relais.
  const top = [...result.per_endpoint]
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 20)
    .map((e) => ({
      endpoint_url_hash: e.endpoint_url_hash,
      stage: e.stage,
      n_obs: e.n_obs,
      p_predicted: Number(e.p_predicted.toFixed(4)),
      p_observed: Number(e.p_observed.toFixed(4)),
      delta: Number(e.delta.toFixed(4)),
    }));

  const content = JSON.stringify({
    schema_version: 1,
    window_start: result.window_start,
    window_end: result.window_end,
    aggregate: {
      delta_mean: result.delta_mean,
      delta_median: result.delta_median,
      delta_p95: result.delta_p95,
      n_endpoints: result.n_endpoints,
      n_outcomes: result.n_outcomes,
    },
    top_deltas: top,
    note:
      result.n_endpoints === 0
        ? 'Bootstrap run — no qualifying endpoints yet. Calibration history begins now.'
        : undefined,
  });

  return {
    kind: KIND_ORACLE_CALIBRATION,
    created_at: createdAt,
    tags,
    content,
  };
}
