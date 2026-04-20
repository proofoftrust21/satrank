// Phase 8 — C8 : NIP-09 deletion requests.
//
// Publie un event kind 5 (deletion request) qui référence un event_id
// préalablement publié par notre pubkey. Seuls les events qu'on trouve
// dans notre cache `nostr_published_events` peuvent être supprimés —
// on refuse de signer une deletion pour un event_id qu'on n'a pas émis
// (defense-in-depth : empêche un caller avec accès DB de nous faire
// retirer des events arbitraires).
//
// Flag `NOSTR_NIP09_ENABLED` : OFF par défaut. Les kinds 30382/30383/30384
// sont NIP-33 replaceable → les relais gardent automatiquement la version
// la plus récente, une deletion explicite est redondante dans 99% des cas.
// Ce module reste en réserve pour Phase 8bis ou pour un retrait massif
// (e.g. clé compromise → révoquer tout le backlog).
//
// Pas de cron associé : trigger manuel via `requestDeletion(entityType, entityId)`.
import type {
  NostrPublishedEventsRepository,
  PublishedEntityType,
  PublishedEventRow,
} from '../repositories/nostrPublishedEventsRepository';
import type { NostrMultiKindPublisher, PublishResult } from './nostrMultiKindPublisher';
import type { EventTemplate } from './eventBuilders';
import { logger } from '../logger';

export const KIND_DELETION_REQUEST = 5;

/** Raison optionnelle exposée dans le content de l'event kind 5.
 *  Les relais n'en font rien, mais les observateurs humains apprécient
 *  de savoir pourquoi un event est retiré. */
export interface DeletionReason {
  reason?: string;
}

export interface DeletionResult {
  /** L'event_id du kind 5 publié. null si la deletion a été skippée (flag OFF
   *  ou event inconnu). */
  deletionEventId: string | null;
  /** L'event_id qu'on a cherché à retirer. */
  targetEventId: string;
  /** Statut du publish : 'published', 'skipped_disabled', 'skipped_unknown',
   *  'publish_failed'. */
  status: 'published' | 'skipped_disabled' | 'skipped_unknown' | 'publish_failed';
  acks?: PublishResult['acks'];
}

/** Construit le template NIP-09 pour un event donné.
 *  `e` tag : event_id à retirer (NIP-01 reference).
 *  `k` tag : kind du target (nouvelle convention NIP-09 2024, aide les relais
 *  à filtrer par range). */
export function buildDeletionRequest(
  targetEventId: string,
  targetKind: number,
  createdAt: number,
  reason?: string,
): EventTemplate {
  const tags: string[][] = [
    ['e', targetEventId],
    ['k', String(targetKind)],
  ];
  return {
    kind: KIND_DELETION_REQUEST,
    created_at: createdAt,
    tags,
    content: reason ?? '',
  };
}

/** Service NIP-09 — broadcast une request de deletion.
 *  Injection de dépendances manuelle pour tester en isolation. */
export class NostrDeletionService {
  constructor(
    private publisher: NostrMultiKindPublisher,
    private publishedEvents: NostrPublishedEventsRepository,
    private enabled: boolean,
  ) {}

  /** Tente de retirer l'event cache pour une entité. No-op si flag OFF ou
   *  si l'event n'est pas connu du cache. Renvoie le statut pour que
   *  l'appelant puisse logger/alerter. */
  async requestDeletion(
    entityType: PublishedEntityType,
    entityId: string,
    nowSec: number,
    opts: DeletionReason = {},
  ): Promise<DeletionResult> {
    const row = this.publishedEvents.getLastPublished(entityType, entityId);
    if (!row) {
      return {
        deletionEventId: null,
        targetEventId: '',
        status: 'skipped_unknown',
      };
    }
    return this.requestDeletionByRow(row, nowSec, opts);
  }

  /** Variante par event_id direct — utile pour retirer un event spécifique
   *  (e.g. rollback d'un mis-publish). */
  async requestDeletionByEventId(
    eventId: string,
    nowSec: number,
    opts: DeletionReason = {},
  ): Promise<DeletionResult> {
    const row = this.publishedEvents.findByEventId(eventId);
    if (!row) {
      return {
        deletionEventId: null,
        targetEventId: eventId,
        status: 'skipped_unknown',
      };
    }
    return this.requestDeletionByRow(row, nowSec, opts);
  }

  private async requestDeletionByRow(
    row: PublishedEventRow,
    nowSec: number,
    opts: DeletionReason,
  ): Promise<DeletionResult> {
    if (!this.enabled) {
      logger.info(
        {
          entityType: row.entity_type,
          entityId: row.entity_id.slice(0, 12),
          targetEventId: row.event_id.slice(0, 12),
        },
        'nip09 deletion skipped: flag disabled',
      );
      return {
        deletionEventId: null,
        targetEventId: row.event_id,
        status: 'skipped_disabled',
      };
    }

    const template = buildDeletionRequest(row.event_id, row.event_kind, nowSec, opts.reason);
    try {
      const result = await this.publisher.publishTemplate(template);
      if (!result.anySuccess) {
        logger.warn(
          {
            entityType: row.entity_type,
            entityId: row.entity_id.slice(0, 12),
            targetEventId: row.event_id.slice(0, 12),
            acks: result.acks.length,
          },
          'nip09 deletion publish: no relay ack',
        );
        return {
          deletionEventId: result.eventId,
          targetEventId: row.event_id,
          status: 'publish_failed',
          acks: result.acks,
        };
      }

      // Après un publish réussi : purge la row cache pour que le prochain scan
      // réémette un endorsement frais si l'entité est toujours active.
      this.publishedEvents.delete(row.entity_type, row.entity_id);

      logger.info(
        {
          entityType: row.entity_type,
          entityId: row.entity_id.slice(0, 12),
          targetEventId: row.event_id.slice(0, 12),
          deletionEventId: result.eventId.slice(0, 12),
          reason: opts.reason ?? null,
        },
        'nip09 deletion published',
      );
      return {
        deletionEventId: result.eventId,
        targetEventId: row.event_id,
        status: 'published',
        acks: result.acks,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        {
          entityType: row.entity_type,
          entityId: row.entity_id.slice(0, 12),
          targetEventId: row.event_id.slice(0, 12),
          error: msg,
        },
        'nip09 deletion publish error',
      );
      return {
        deletionEventId: null,
        targetEventId: row.event_id,
        status: 'publish_failed',
      };
    }
  }
}
