// Phase 8 — C3 : publisher multi-kind pour les endorsements Nostr.
//
// Responsabilités :
//   - signer un EventTemplate (30382 / 30383 / 30384) avec la clé canonique
//     SatRank via nostr-tools (import dynamique ESM)
//   - publier l'event signé sur tous les relais configurés en parallèle
//   - agréger les acks et reporter les échecs par relai, sans bloquer les
//     autres si un relai timeout ou rejette
//
// Ce module ne décide PAS quand publier — c'est la responsabilité du cron
// (C5) qui consulte shouldRepublish() puis délègue ici. Par conséquent :
//   - pas d'accès DB
//   - pas de dépendance au cache nostr_published_events
//   - testable en isolation en injectant un signer/publisher mock
//
// nostr-tools est ESM-only : import() dynamique (même pattern que publisher.ts).
import type {
  EventTemplate,
  NodeEndorsementState,
  EndpointEndorsementState,
  ServiceEndorsementState,
  VerdictFlashState,
} from './eventBuilders';
import {
  buildNodeEndorsement,
  buildEndpointEndorsement,
  buildServiceEndorsement,
  buildVerdictFlash,
} from './eventBuilders';
import { logger } from '../logger';
import {
  multiKindEventsPublishedTotal,
  multiKindRelayErrorsTotal,
  multiKindPublishDuration,
} from '../middleware/metrics';

const DEFAULT_PUBLISH_TIMEOUT_MS = 1_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export interface NostrMultiKindPublisherOptions {
  privateKeyHex: string;
  relays: string[];
  publishTimeoutMs?: number;
  connectTimeoutMs?: number;
}

export type RelayAckResult = 'success' | 'timeout' | 'error';

export interface RelayAck {
  relay: string;
  result: RelayAckResult;
  error?: string;
}

export interface PublishResult {
  eventId: string;
  kind: number;
  publishedAt: number;
  acks: RelayAck[];
  /** true si au moins un relai a confirmé (success). */
  anySuccess: boolean;
}

/** Interface interne à laquelle les tests peuvent injecter un mock. */
export interface NostrToolsBindings {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  finalizeEvent: (template: EventTemplate, sk: Uint8Array) => any;
  hexToBytes: (hex: string) => Uint8Array;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connectRelay: (url: string) => Promise<any>;
}

async function loadDefaultBindings(): Promise<NostrToolsBindings> {
  // @ts-expect-error — moduleResolution "node" can't resolve ESM subpath
  const pure = await import('nostr-tools/pure');
  // @ts-expect-error — moduleResolution "node" can't resolve ESM subpath
  const relay = await import('nostr-tools/relay');
  const utils = await import('@noble/hashes/utils');
  return {
    finalizeEvent: pure.finalizeEvent,
    hexToBytes: utils.hexToBytes,
    connectRelay: (url: string) => relay.Relay.connect(url),
  };
}

export class NostrMultiKindPublisher {
  private skHex: string;
  private relays: string[];
  private publishTimeoutMs: number;
  private connectTimeoutMs: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private connections: { relay: any; url: string }[] = [];
  private bindings: NostrToolsBindings | null;

  constructor(options: NostrMultiKindPublisherOptions, bindings?: NostrToolsBindings) {
    this.skHex = options.privateKeyHex;
    this.relays = options.relays;
    this.publishTimeoutMs = options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    // Si les bindings sont injectés (tests), on skip le chargement ESM.
    this.bindings = bindings ?? null;
  }

  private async ensureBindings(): Promise<NostrToolsBindings> {
    if (!this.bindings) this.bindings = await loadDefaultBindings();
    return this.bindings;
  }

  /** Ouvre les connexions aux relais. Les échecs sont logués mais non-fatals
   *  tant qu'au moins un relai répond. Idempotent : rappeler ne rouvre pas
   *  les connexions déjà établies. */
  async connect(): Promise<void> {
    if (this.connections.length > 0) return;
    const bindings = await this.ensureBindings();
    for (const url of this.relays) {
      try {
        const relay = await Promise.race([
          bindings.connectRelay(url),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Connection timeout')), this.connectTimeoutMs),
          ),
        ]);
        this.connections.push({ relay, url });
        logger.info({ relay: url }, 'nostr multi-kind relay connected');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ relay: url, error: msg }, 'nostr multi-kind relay connection failed — skipping');
      }
    }
  }

  /** Ferme les connexions. Idempotent. */
  async close(): Promise<void> {
    for (const { relay, url } of this.connections) {
      try { relay.close(); } catch { logger.warn({ relay: url }, 'nostr multi-kind relay close failed'); }
    }
    this.connections = [];
  }

  /** Nombre de relais actuellement connectés. Exposé pour les tests + métriques. */
  get connectedRelayCount(): number {
    return this.connections.length;
  }

  /** Signe et publie un template arbitraire. Exposé pour les flashes kind
   *  20900 (C6) qui partagent la plomberie mais pas le schema Endorsement. */
  async publishTemplate(template: EventTemplate): Promise<PublishResult> {
    if (this.connections.length === 0) await this.connect();
    const bindings = await this.ensureBindings();
    const sk = bindings.hexToBytes(this.skHex);
    const signed = bindings.finalizeEvent(template, sk) as { id: string };
    const startNs = process.hrtime.bigint();
    const kindLabel = String(template.kind);

    const acks: RelayAck[] = await Promise.all(
      this.connections.map(async ({ relay, url }) => {
        try {
          await Promise.race([
            relay.publish(signed),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Publish timeout')), this.publishTimeoutMs),
            ),
          ]);
          return { relay: url, result: 'success' as const };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          const result: RelayAckResult = msg === 'Publish timeout' ? 'timeout' : 'error';
          multiKindRelayErrorsTotal.inc({ relay: url, result });
          return { relay: url, result, error: msg };
        }
      }),
    );

    const durationSec = Number(process.hrtime.bigint() - startNs) / 1e9;
    multiKindPublishDuration.observe({ kind: kindLabel }, durationSec);

    const anySuccess = acks.some((a) => a.result === 'success');
    multiKindEventsPublishedTotal.inc({
      kind: kindLabel,
      result: anySuccess ? 'success' : 'no_ack',
    });

    // Log structuré par publish : kind, eventId, latency, per-relay outcome.
    // Les observateurs humains lisent ça dans Loki pour un post-mortem rapide.
    logger.info(
      {
        kind: template.kind,
        eventId: signed.id.slice(0, 12),
        latencyMs: Math.round(durationSec * 1000),
        relays: acks.map((a) => ({ relay: a.relay, result: a.result })),
        anySuccess,
      },
      'nostr multi-kind publish complete',
    );

    return {
      eventId: signed.id,
      kind: template.kind,
      publishedAt: template.created_at,
      acks,
      anySuccess,
    };
  }

  /** Kind 30382 — endorsement d'un node Lightning. */
  async publishNodeEndorsement(state: NodeEndorsementState, createdAt?: number): Promise<PublishResult> {
    const template = buildNodeEndorsement(state, createdAt ?? nowUnix());
    return this.publishTemplate(template);
  }

  /** Kind 30383 — endorsement d'un endpoint HTTP (L402 ou public). */
  async publishEndpointEndorsement(state: EndpointEndorsementState, createdAt?: number): Promise<PublishResult> {
    const template = buildEndpointEndorsement(state, createdAt ?? nowUnix());
    return this.publishTemplate(template);
  }

  /** Kind 30384 — endorsement d'un service logique (regroupe N endpoints). */
  async publishServiceEndorsement(state: ServiceEndorsementState, createdAt?: number): Promise<PublishResult> {
    const template = buildServiceEndorsement(state, createdAt ?? nowUnix());
    return this.publishTemplate(template);
  }

  /** Kind 20900 — flash éphémère signalant un basculement de verdict.
   *  À appeler *en plus* de publishNode/Endpoint/ServiceEndorsement quand
   *  le verdict a changé (détection faite par le scheduler). */
  async publishVerdictFlash(state: VerdictFlashState, createdAt?: number): Promise<PublishResult> {
    const template = buildVerdictFlash(state, createdAt ?? nowUnix());
    return this.publishTemplate(template);
  }
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}
