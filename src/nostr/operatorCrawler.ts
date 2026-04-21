// Phase 7 — Nostr kind 30385 crawler : ingestion des self-declarations operator.
//
// ================================================================
// Proposition kind 30385 — Operator Self-Declaration (NIP-33)
// ================================================================
//
// Le kind 30385 n'existe pas dans les NIPs publiés. On propose ici sa
// structure. Parameterized replaceable event (range 30000-39999) : le
// dernier event publié par un pubkey pour un `d`-tag donné remplace les
// précédents. Ça permet à un operator de mettre à jour ses identités /
// ownerships sans polluer les relays avec l'historique complet.
//
// Schéma :
//
//   {
//     "kind": 30385,
//     "pubkey": "<author_pubkey_hex>",
//     "created_at": <unix_ts>,
//     "tags": [
//       ["d", "<operator_id>"],                           // obligatoire
//       ["identity", "ln_pubkey", "<hex>", "<sig_hex>"],  // preuve inline
//       ["identity", "nip05", "alice@example.com", ""],   // preuve fetch-live
//       ["identity", "dns", "example.com", ""],           // preuve DNS TXT
//       ["owns", "node", "<node_pubkey_hex>"],
//       ["owns", "endpoint", "<url_hash>"],
//       ["owns", "service", "<service_hash>"]
//     ],
//     "content": "",   // reservé — free-form description optionnelle
//     "sig": "<event_sig>"
//   }
//
// Semantique de trust :
//   - Signature Nostr (author_pubkey, sig) authentifie l'author — mais ne
//     prouve PAS l'ownership des identités listées. L'author peut être
//     n'importe qui ; le crawler revérifie chaque preuve.
//   - Les identity tags stockent la preuve en 4e position (sig hex pour
//     ln_pubkey, vide pour nip05/dns qui se vérifient live).
//   - Chaque ownership reste en status 'pending' ; le verify_at d'une
//     ownership est réservé à une future phase (ex. signature du node
//     sur l'operator_id).
//
// Anti-abuse : n'importe quel npub peut publier un event 30385 pour
// n'importe quel operator_id. Les relays n'ont pas à valider le
// contenu. Le crawler (ici) applique la règle 2/3 identity-verified
// pour passer status='verified'. Un event dont aucune identity ne
// vérifie crée un operator 'pending' inerte — filtré côté scoring.
// ================================================================
//
// nostr-tools est ESM-only : imports dynamiques pour cohabiter avec
// tsx (dev) et node CJS (prod), comme publisher.ts et dvm.ts.

import { logger } from '../logger';
import type { OperatorService } from '../services/operatorService';
import type { IdentityType } from '../repositories/operatorRepository';
import {
  verifyLnPubkeyOwnership,
  verifyNip05Ownership,
  verifyDnsOwnership,
  type NostrJsonFetcher,
  type DnsTxtResolver,
} from '../services/operatorVerificationService';

export const KIND_OPERATOR_DECLARATION = 30385;

/** Shape minimal d'un event Nostr kind 30385 tel qu'on l'attend depuis les
 *  relays. Superset de ce que SimplePool.onevent fournit. */
export interface OperatorNostrEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Identity extraite d'un tag `identity` du event 30385. */
export interface ParsedIdentity {
  type: IdentityType;
  value: string;
  /** Preuve inline (sig hex pour ln_pubkey, expected_pubkey hex pour nip05).
   *  `null` quand le tag ne porte pas de 4e position. */
  proof: string | null;
}

export interface ParsedOwnership {
  type: 'node' | 'endpoint' | 'service';
  id: string;
}

/** Résultat du parsing pur (pas de vérif crypto, pas d'écriture DB). */
export interface ParsedOperatorEvent {
  operatorId: string;
  identities: ParsedIdentity[];
  ownerships: ParsedOwnership[];
  /** Pubkey Nostr qui a signé l'event — utilisé comme context dans les logs. */
  authorPubkey: string;
  createdAt: number;
}

const IDENTITY_TYPES: ReadonlySet<IdentityType> = new Set(['ln_pubkey', 'nip05', 'dns']);
const OWNERSHIP_TYPES: ReadonlySet<'node' | 'endpoint' | 'service'> = new Set([
  'node',
  'endpoint',
  'service',
]);

/** Parse un event kind 30385 → structure exploitable.
 *
 *  Retourne `null` si :
 *   - kind ≠ 30385
 *   - `d` tag manquant ou vide
 *   - aucun identity ou ownership tag valide (event vide inutile à ingérer)
 *
 *  Tolère les tags mal formés : les identity/ownership invalides sont
 *  filtrés silencieusement ; l'event global reste valide si au moins un
 *  tag significatif reste. */
export function parseOperatorEvent(event: OperatorNostrEvent): ParsedOperatorEvent | null {
  if (event.kind !== KIND_OPERATOR_DECLARATION) return null;

  const dTag = event.tags.find((t) => t[0] === 'd');
  const operatorId = dTag?.[1];
  if (operatorId === undefined || operatorId === '' || operatorId.length > 128) {
    return null;
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(operatorId)) return null;

  const identities: ParsedIdentity[] = [];
  const ownerships: ParsedOwnership[] = [];

  for (const tag of event.tags) {
    if (tag[0] === 'identity') {
      const type = tag[1];
      const value = tag[2];
      const proof = tag[3] ?? null;
      if (typeof type !== 'string' || typeof value !== 'string') continue;
      if (!IDENTITY_TYPES.has(type as IdentityType)) continue;
      if (value.length === 0 || value.length > 256) continue;
      identities.push({
        type: type as IdentityType,
        value,
        proof: typeof proof === 'string' && proof.length > 0 ? proof : null,
      });
    } else if (tag[0] === 'owns') {
      const type = tag[1];
      const id = tag[2];
      if (typeof type !== 'string' || typeof id !== 'string') continue;
      if (!OWNERSHIP_TYPES.has(type as 'node' | 'endpoint' | 'service')) continue;
      if (id.length === 0 || id.length > 256) continue;
      ownerships.push({
        type: type as 'node' | 'endpoint' | 'service',
        id,
      });
    }
  }

  if (identities.length === 0 && ownerships.length === 0) return null;

  return {
    operatorId,
    identities,
    ownerships,
    authorPubkey: event.pubkey,
    createdAt: event.created_at,
  };
}

export interface IngestResult {
  operatorId: string;
  identitiesClaimed: number;
  identitiesVerified: number;
  ownershipsClaimed: number;
  /** Détail par identity, exploitable pour un diagnostic — miroir des
   *  VerificationReport du POST /register. */
  verifications: Array<{ type: IdentityType; value: string; valid: boolean; reason?: string }>;
}

export interface IngestOptions {
  /** Fetcher NIP-05 (injection pour tests). */
  nostrJsonFetcher?: NostrJsonFetcher;
  /** Resolver DNS TXT (injection pour tests). */
  dnsTxtResolver?: DnsTxtResolver;
  /** Timestamp d'ingestion. Défaut : now. */
  now?: number;
}

/** Applique un event 30385 parsé à l'OperatorService : upsert + claims +
 *  vérifications inline + markVerified. Idempotent sur re-ingestion du même
 *  event (les repos sont ON CONFLICT DO NOTHING). */
export async function ingestOperatorEvent(
  parsed: ParsedOperatorEvent,
  service: OperatorService,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  await service.upsertOperator(parsed.operatorId, Math.min(now, parsed.createdAt));

  const result: IngestResult = {
    operatorId: parsed.operatorId,
    identitiesClaimed: 0,
    identitiesVerified: 0,
    ownershipsClaimed: 0,
    verifications: [],
  };

  for (const identity of parsed.identities) {
    await service.claimIdentity(parsed.operatorId, identity.type, identity.value);
    result.identitiesClaimed += 1;

    const verified = await verifySingleIdentity(parsed.operatorId, identity, opts);
    result.verifications.push({
      type: identity.type,
      value: identity.value,
      valid: verified.valid,
      reason: verified.detail,
    });
    if (verified.valid) {
      await service.markIdentityVerified(
        parsed.operatorId,
        identity.type,
        identity.value,
        buildProofBlob(identity),
        now,
      );
      result.identitiesVerified += 1;
    }
  }

  for (const ownership of parsed.ownerships) {
    await service.claimOwnership(parsed.operatorId, ownership.type, ownership.id, now);
    result.ownershipsClaimed += 1;
  }

  return result;
}

async function verifySingleIdentity(
  operatorId: string,
  identity: ParsedIdentity,
  opts: IngestOptions,
): Promise<{ valid: boolean; detail?: string }> {
  if (identity.type === 'ln_pubkey') {
    if (identity.proof === null) return { valid: false, detail: 'signature_missing' };
    return verifyLnPubkeyOwnership(identity.value, operatorId, identity.proof);
  }
  if (identity.type === 'nip05') {
    if (identity.proof === null) return { valid: false, detail: 'expected_pubkey_missing' };
    return await verifyNip05Ownership(identity.value, identity.proof, opts.nostrJsonFetcher);
  }
  return await verifyDnsOwnership(identity.value, operatorId, opts.dnsTxtResolver);
}

function buildProofBlob(identity: ParsedIdentity): string {
  if (identity.type === 'ln_pubkey') return `ecdsa:${identity.proof ?? ''}`;
  if (identity.type === 'nip05') return `nip05:${identity.proof ?? ''}`;
  return `dns:satrank-operator=${identity.value}`;
}

// ---------------------------------------------------------------------------
// Live crawler — subscribe aux relays, buffer, ingestion à l'oneose.
// ---------------------------------------------------------------------------

export interface OperatorCrawlerOptions {
  relays: string[];
  /** Timeout global en ms pour la collecte (défaut 30s). */
  subscribeTimeoutMs?: number;
  /** Inject pour tests : NIP-05 fetcher. */
  nostrJsonFetcher?: NostrJsonFetcher;
  /** Inject pour tests : DNS TXT resolver. */
  dnsTxtResolver?: DnsTxtResolver;
  /** Inject pour tests : fonction qui ouvre un relay (défaut nostr-tools).
   *  Signature minimale : `subscribe(filters, handlers)` retourne `{close}`,
   *  plus `close()` pour teardown. */
  relayFactory?: (url: string) => Promise<RelayHandle>;
  /** Inject pour tests : verifyEvent (nostr-tools). Défaut : import dynamique.
   *  Laisser `undefined` en tests = skip la vérif sig (nécessaire pour injecter
   *  des events synthétiques sans signer). */
  verifyEvent?: (event: OperatorNostrEvent) => boolean;
}

export interface RelayHandle {
  subscribe(
    filters: unknown[],
    handlers: {
      onevent: (ev: OperatorNostrEvent) => void;
      oneose?: () => void;
      onclose?: (reason?: string) => void;
    },
  ): { close: () => void };
  close(): void;
}

export interface CrawlSummary {
  relaysQueried: number;
  eventsReceived: number;
  eventsParsed: number;
  eventsIngested: number;
  operatorsTouched: Set<string>;
  identitiesVerified: number;
  ownershipsClaimed: number;
}

/** Crawler des events kind 30385. Connecte les relays fournis, subscribe
 *  sans filtre d'auteur (n'importe qui peut publier), dedup sur event.id,
 *  et ingère chaque event via `ingestOperatorEvent`.
 *
 *  Le hot path de production doit tourner en cron (15-60 min) — pas en
 *  live subscription. Un relay hostile peut inonder kind 30385 ; le
 *  rate-limit est côté crawler (global timeout). */
export class OperatorCrawler {
  private readonly relays: string[];
  private readonly subscribeTimeoutMs: number;
  private readonly nostrJsonFetcher?: NostrJsonFetcher;
  private readonly dnsTxtResolver?: DnsTxtResolver;
  private readonly relayFactory?: (url: string) => Promise<RelayHandle>;
  private readonly verifyEvent?: (event: OperatorNostrEvent) => boolean;

  constructor(
    private readonly service: OperatorService,
    options: OperatorCrawlerOptions,
  ) {
    this.relays = options.relays;
    this.subscribeTimeoutMs = options.subscribeTimeoutMs ?? 30_000;
    this.nostrJsonFetcher = options.nostrJsonFetcher;
    this.dnsTxtResolver = options.dnsTxtResolver;
    this.relayFactory = options.relayFactory;
    this.verifyEvent = options.verifyEvent;
  }

  async crawl(since?: number): Promise<CrawlSummary> {
    const summary: CrawlSummary = {
      relaysQueried: 0,
      eventsReceived: 0,
      eventsParsed: 0,
      eventsIngested: 0,
      operatorsTouched: new Set<string>(),
      identitiesVerified: 0,
      ownershipsClaimed: 0,
    };

    const seen = new Set<string>();
    const factory = this.relayFactory ?? defaultRelayFactory;

    const collected: OperatorNostrEvent[] = [];

    await Promise.all(
      this.relays.map(async (url) => {
        let relay: RelayHandle | null = null;
        try {
          relay = await factory(url);
          summary.relaysQueried += 1;
          await this.subscribeOnce(relay, since, (ev) => {
            if (seen.has(ev.id)) return;
            seen.add(ev.id);
            if (this.verifyEvent && !this.verifyEvent(ev)) {
              logger.debug({ eventId: ev.id, relay: url }, 'kind 30385 event signature invalid — skipping');
              return;
            }
            summary.eventsReceived += 1;
            collected.push(ev);
          });
        } catch (err: unknown) {
          logger.warn({ relay: url, error: errorMessage(err) }, 'operator crawler relay failed');
        } finally {
          try { relay?.close(); } catch { /* ignore */ }
        }
      }),
    );

    for (const event of collected) {
      const parsed = parseOperatorEvent(event);
      if (parsed === null) continue;
      summary.eventsParsed += 1;
      try {
        const result = await ingestOperatorEvent(parsed, this.service, {
          nostrJsonFetcher: this.nostrJsonFetcher,
          dnsTxtResolver: this.dnsTxtResolver,
        });
        summary.eventsIngested += 1;
        summary.operatorsTouched.add(result.operatorId);
        summary.identitiesVerified += result.identitiesVerified;
        summary.ownershipsClaimed += result.ownershipsClaimed;
      } catch (err: unknown) {
        logger.warn(
          { operatorId: parsed.operatorId, error: errorMessage(err) },
          'operator event ingestion failed',
        );
      }
    }

    logger.info(
      {
        relays: summary.relaysQueried,
        received: summary.eventsReceived,
        parsed: summary.eventsParsed,
        ingested: summary.eventsIngested,
        operators: summary.operatorsTouched.size,
      },
      'operator crawler cycle complete',
    );

    return summary;
  }

  private subscribeOnce(
    relay: RelayHandle,
    since: number | undefined,
    onEvent: (ev: OperatorNostrEvent) => void,
  ): Promise<void> {
    const filter: Record<string, unknown> = { kinds: [KIND_OPERATOR_DECLARATION] };
    if (since !== undefined) filter.since = since;

    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        try { sub.close(); } catch { /* ignore */ }
        resolve();
      };
      const sub = relay.subscribe([filter], {
        onevent: (ev) => onEvent(ev),
        oneose: () => finish(),
        onclose: () => finish(),
      });
      setTimeout(() => finish(), this.subscribeTimeoutMs);
    });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Factory par défaut : connecte un relay via nostr-tools. Import dynamique
 *  pour rester compatible tsx (dev) + node CJS (prod). */
async function defaultRelayFactory(url: string): Promise<RelayHandle> {
  // @ts-expect-error — moduleResolution "node" can't resolve ESM subpath, works at runtime
  const { Relay } = await import('nostr-tools/relay');
  const relay = await Relay.connect(url);
  return {
    subscribe(filters, handlers) {
      const sub = relay.subscribe(
        filters as Parameters<typeof relay.subscribe>[0],
        {
          onevent: (ev: unknown) => handlers.onevent(ev as OperatorNostrEvent),
          oneose: () => handlers.oneose?.(),
          onclose: (reason?: string) => handlers.onclose?.(reason),
        },
      );
      return { close: () => sub.close() };
    },
    close() {
      try { relay.close(); } catch { /* ignore */ }
    },
  };
}
