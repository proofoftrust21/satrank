// Phase 7.0 — kind 30784 oracle announcement publisher.
//
// Cron 24h qui publie un événement Nostr signé annonçant la présence et
// l'état actuel de cette instance SatRank. Permet :
//   - aux clients de découvrir N oracles SatRank-compatible automatiquement
//   - aux autres oracles d'aggréger les calibrations cross-oracle
//   - le bootstrap auto-référentiel : SatRank lui-même apparaît comme peer
//     dans /api/oracle/peers de toute autre instance qui souscrit aux
//     mêmes relais.
//
// Schema kind 30784 (proposed parameterized replaceable, NIP-33) :
//   tags:
//     d=satrank-oracle-announcement       — addressable replaceable
//     oracle_pubkey=<32 bytes hex>
//     lnd_pubkey=<33 bytes hex>           — sovereign LN identity (optional)
//     catalogue_size=<int>                — endpoints actifs trusted
//     calibration_event_id=<id>           — pointer kind 30783 latest
//     last_assertion_event_id=<id>        — pointer kind 30782 latest
//     contact=<nostr_pubkey or email>     — optionnel
//     onboarding_url=<https URL>          — optionnel
//   content: JSON détail (about, version, capabilities[])
//
// Cadence 24h : suffisamment réactive pour que les operators voient les
// montées/descentes d'oracles, suffisamment lente pour ne pas spam les
// relais. NIP-33 replace les anciens events au passage.
import { logger } from '../logger';
import type { NostrMultiKindPublisher } from '../nostr/nostrMultiKindPublisher';
import type { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import type { CalibrationRepository } from '../repositories/calibrationRepository';
import type { OracleAnnouncementRepository } from '../repositories/oracleFederationRepository';

export const KIND_ORACLE_ANNOUNCEMENT = 30784;
export const ANNOUNCEMENT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SKIP_RECENT_SEC = 20 * 60 * 60; // skip si déjà publié < 20h

export interface OracleAnnouncementContent {
  about: string;
  version: string;
  capabilities: string[];
}

export interface OracleAnnouncementPublisherDeps {
  serviceEndpointRepo: ServiceEndpointRepository;
  calibrationRepo: CalibrationRepository;
  announcementRepo: OracleAnnouncementRepository;
  publisher: NostrMultiKindPublisher;
  oraclePubkey: string;
  /** LND pubkey (33 bytes hex) — annoncé en clair pour permettre aux
   *  clients de vérifier que l'oracle fait tourner son propre LND. */
  lndPubkey?: string;
  relays: string[];
  /** Métadonnées statiques injectées dans le content. */
  about?: string;
  version?: string;
  capabilities?: string[];
  contact?: string;
  onboardingUrl?: string;
  now?: () => number;
}

export interface AnnouncementPublishResult {
  event_id: string;
  catalogue_size: number;
  calibration_event_id: string | null;
  last_assertion_event_id: string | null;
}

export class OracleAnnouncementPublisher {
  private readonly now: () => number;

  constructor(private readonly deps: OracleAnnouncementPublisherDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Cycle cron : compute snapshot + publish kind 30784 + persist audit.
   *  Skip si déjà publié <20h pour éviter le double-publish au cas où la
   *  cron tick deux fois. */
  async publishCycle(): Promise<AnnouncementPublishResult | null> {
    const nowSec = this.now();

    const latest = await this.deps.announcementRepo.findLatest();
    if (latest && latest.published_at >= nowSec - SKIP_RECENT_SEC) {
      logger.info(
        { latest_at: latest.published_at, now: nowSec },
        'OracleAnnouncementPublisher: skipping — recent announcement < 20h',
      );
      return null;
    }

    // Snapshot : catalogue size + dernière calibration / assertion.
    const endpoints = await this.deps.serviceEndpointRepo.listActiveTrustedEndpoints(10000);
    const catalogueSize = endpoints.length;
    const latestCalibration = await this.deps.calibrationRepo.findLatestRun();
    const calibrationEventId = latestCalibration?.published_event_id ?? null;
    // Note : last_assertion_event_id reste null pour le moment — ferait
    // un cross-table query. Le client qui veut la latest assertion peut
    // toujours hit /api/oracle/assertion/:url_hash. Tag exposé pour
    // future evolution sans schema change.

    const template = buildAnnouncementTemplate({
      oraclePubkey: this.deps.oraclePubkey,
      lndPubkey: this.deps.lndPubkey,
      catalogueSize,
      calibrationEventId,
      lastAssertionEventId: null,
      about: this.deps.about ?? 'SatRank-compatible Lightning trust oracle. 5-stage L402 contract Bayesian posteriors with weekly published calibration history.',
      version: this.deps.version ?? '1.0',
      capabilities: this.deps.capabilities ?? [
        '5-stage-posterior',
        'kind-30782-trust-assertion',
        'kind-30783-calibration',
        'kind-30784-announcement',
        'dvm-intent-resolve',
        'mcp-server',
      ],
      contact: this.deps.contact,
      onboardingUrl: this.deps.onboardingUrl,
      createdAt: nowSec,
    });

    let eventId: string;
    try {
      const publishResult = await this.deps.publisher.publishTemplate(template);
      eventId = publishResult.eventId;
      if (!publishResult.anySuccess) {
        logger.warn(
          { eventId, acks: publishResult.acks },
          'OracleAnnouncementPublisher: no relay accepted',
        );
        return null;
      }
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'OracleAnnouncementPublisher: publish failed',
      );
      return null;
    }

    try {
      await this.deps.announcementRepo.insert({
        event_id: eventId,
        oracle_pubkey: this.deps.oraclePubkey,
        catalogue_size: catalogueSize,
        calibration_event_id: calibrationEventId,
        last_assertion_event_id: null,
        published_at: nowSec,
        relays: this.deps.relays,
      });
    } catch (err) {
      logger.warn(
        { eventId, error: err instanceof Error ? err.message : String(err) },
        'OracleAnnouncementPublisher: audit persist failed (event published)',
      );
    }

    logger.info(
      { eventId: eventId.slice(0, 12), catalogueSize, calibrationEventId },
      'OracleAnnouncementPublisher: kind 30784 published',
    );

    return {
      event_id: eventId,
      catalogue_size: catalogueSize,
      calibration_event_id: calibrationEventId,
      last_assertion_event_id: null,
    };
  }
}

interface BuilderInput {
  oraclePubkey: string;
  lndPubkey?: string;
  catalogueSize: number;
  calibrationEventId: string | null;
  lastAssertionEventId: string | null;
  about: string;
  version: string;
  capabilities: string[];
  contact?: string;
  onboardingUrl?: string;
  createdAt: number;
}

/** Pure builder testable en isolation. */
export function buildAnnouncementTemplate(input: BuilderInput): {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
} {
  const tags: string[][] = [
    ['d', 'satrank-oracle-announcement'],
    ['oracle_pubkey', input.oraclePubkey],
    ['catalogue_size', String(input.catalogueSize)],
  ];
  if (input.lndPubkey) tags.push(['lnd_pubkey', input.lndPubkey]);
  if (input.calibrationEventId) tags.push(['calibration_event_id', input.calibrationEventId]);
  if (input.lastAssertionEventId) tags.push(['last_assertion_event_id', input.lastAssertionEventId]);
  if (input.contact) tags.push(['contact', input.contact]);
  if (input.onboardingUrl) tags.push(['onboarding_url', input.onboardingUrl]);

  const content: OracleAnnouncementContent = {
    about: input.about,
    version: input.version,
    capabilities: input.capabilities,
  };

  return {
    kind: KIND_ORACLE_ANNOUNCEMENT,
    created_at: input.createdAt,
    tags,
    content: JSON.stringify(content),
  };
}
