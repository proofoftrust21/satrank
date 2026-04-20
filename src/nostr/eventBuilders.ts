// Phase 8 — builders d'events Nostr pour les trois kinds d'endorsement
// publiés par SatRank : 30382 (node), 30383 (endpoint), 30384 (service).
//
// Chaque builder est une fonction pure : prend un state canonique de l'entité
// et retourne un template d'event (kind, created_at, tags, content) prêt à
// signer via finalizeEvent(). Pas d'I/O, pas d'état mutable — facile à tester
// en isolation et réutilisable depuis le cron publisher et les tests.
//
// Le payload suit le brief Phase 8 : d-tag = identifiant primaire (pubkey /
// url_hash / service_hash), bloc bayésien (verdict, p_success, ci95_low/high,
// n_obs), bloc advisory (advisory_level, risk_score), metadata spécifique au
// kind (price_sats, median_latency_ms, endpoint_count, …), et operator_id
// optionnel (seulement émis si l'entité est rattachée à un operator verified).
//
// Les tags stringifient systématiquement : nostr-tools exige Array<Array<string>>.
import type { Verdict, AdvisoryLevel } from '../types/index';

export const KIND_NODE_ENDORSEMENT = 30382;
export const KIND_ENDPOINT_ENDORSEMENT = 30383;
export const KIND_SERVICE_ENDORSEMENT = 30384;
// Flash éphémère NIP-01 range 20000-29999. Broadcast-only, non persisté par
// les relais : signale un basculement de verdict significatif (e.g. SAFE → RISKY)
// pour que les abonnés réagissent sans attendre leur prochain fetch du 30383.
export const KIND_VERDICT_FLASH = 20900;

/** Source primaire d'un verdict publié — mirror de BayesianSource du core. */
export type EndorsementSource = 'probe' | 'report' | 'paid';

/** Template d'event Nostr prêt à signer. */
export interface EventTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/** Etat bayésien commun aux trois kinds. */
interface BayesianState {
  verdict: Verdict;
  p_success: number;
  ci95_low: number;
  ci95_high: number;
  n_obs: number;
  advisory_level: AdvisoryLevel;
  risk_score: number;
  source: EndorsementSource;
  time_constant_days: number;
  last_update: number;
  operator_id?: string | null;
}

export interface NodeEndorsementState extends BayesianState {
  node_pubkey: string;
}

export interface EndpointEndorsementState extends BayesianState {
  url_hash: string;
  url: string;
  price_sats?: number | null;
  median_latency_ms?: number | null;
  category?: string | null;
  service_name?: string | null;
}

export interface ServiceEndorsementState extends BayesianState {
  service_hash: string;
  name: string;
  endpoint_count: number;
}

// Arrondis cohérents avec publisher.ts : 4 décimales pour proba, 3 pour risk,
// entiers pour n_obs. Les relais stockent des strings — la stabilité des
// floats évite de faire flapper les fingerprints sur du bruit machine.
function fmtProba(x: number): string { return x.toFixed(4); }
function fmtRisk(x: number): string { return x.toFixed(3); }
function fmtInt(x: number): string { return String(Math.round(x)); }

function bayesianTags(state: BayesianState): string[][] {
  const tags: string[][] = [
    ['verdict', state.verdict],
    ['p_success', fmtProba(state.p_success)],
    ['ci95_low', fmtProba(state.ci95_low)],
    ['ci95_high', fmtProba(state.ci95_high)],
    ['n_obs', fmtInt(state.n_obs)],
    ['advisory_level', state.advisory_level],
    ['risk_score', fmtRisk(state.risk_score)],
    ['source', state.source],
    ['time_constant_days', fmtInt(state.time_constant_days)],
    ['last_update', fmtInt(state.last_update)],
  ];
  if (state.operator_id) tags.push(['operator_id', state.operator_id]);
  return tags;
}

/** Construit le template 30382 pour un node Lightning. */
export function buildNodeEndorsement(state: NodeEndorsementState, createdAt: number): EventTemplate {
  // `p` (NIP-01 pubkey ref) est en plus de `d` (addressable) : les clients
  // Nostr qui filtrent par `p` voient l'event même sans connaître la logique
  // d'addressable du NIP-33. Les deux pointent sur le même pubkey LN hex.
  const tags: string[][] = [
    ['d', state.node_pubkey],
    ['p', state.node_pubkey],
    ...bayesianTags(state),
  ];
  return {
    kind: KIND_NODE_ENDORSEMENT,
    created_at: createdAt,
    tags,
    content: '',
  };
}

/** Construit le template 30383 pour un endpoint HTTP (service L402 ou public). */
export function buildEndpointEndorsement(state: EndpointEndorsementState, createdAt: number): EventTemplate {
  const tags: string[][] = [
    ['d', state.url_hash],
    ['url', state.url],
    ...bayesianTags(state),
  ];
  if (state.price_sats != null) tags.push(['price_sats', fmtInt(state.price_sats)]);
  if (state.median_latency_ms != null) tags.push(['median_latency_ms', fmtInt(state.median_latency_ms)]);
  if (state.category) tags.push(['category', state.category]);
  if (state.service_name) tags.push(['service_name', state.service_name]);
  return {
    kind: KIND_ENDPOINT_ENDORSEMENT,
    created_at: createdAt,
    tags,
    content: '',
  };
}

/** Construit le template 30384 pour un service logique (regroupe plusieurs endpoints). */
export function buildServiceEndorsement(state: ServiceEndorsementState, createdAt: number): EventTemplate {
  const tags: string[][] = [
    ['d', state.service_hash],
    ['name', state.name],
    ...bayesianTags(state),
    ['endpoint_count', fmtInt(state.endpoint_count)],
  ];
  return {
    kind: KIND_SERVICE_ENDORSEMENT,
    created_at: createdAt,
    tags,
    content: '',
  };
}

/** Flash éphémère signalant un basculement de verdict pour une entité.
 *
 *  Règles :
 *   - kind 20900 : ephemeral (NIP-01 range), les relais broadcast sans persister.
 *   - pas de `d` tag (pas d'addressable) : chaque flash est distinct.
 *   - `e_type` identifie quel kind replaceable l'event accompagne (30382/30383/30384).
 *   - `e_id` pointe sur l'identifiant primaire (pubkey ou url_hash).
 *   - `from_verdict` / `to_verdict` : la transition qui déclenche l'événement.
 *   - bloc bayésien copié de l'endorsement principal (cohérence snapshot).
 *   - `last_update` déjà présent dans bayesianTags donne la fraîcheur.
 *
 *  Le builder ne décide PAS s'il faut émettre un flash — c'est au scheduler
 *  de vérifier que from_verdict !== to_verdict avant d'appeler le builder.
 */
export interface VerdictFlashState {
  entity_type: 'node' | 'endpoint' | 'service';
  entity_id: string;
  from_verdict: Verdict | null;
  to_verdict: Verdict;
  p_success: number;
  ci95_low: number;
  ci95_high: number;
  n_obs: number;
  advisory_level: AdvisoryLevel;
  risk_score: number;
  source: EndorsementSource;
  time_constant_days: number;
  last_update: number;
  operator_id?: string | null;
}

export function buildVerdictFlash(state: VerdictFlashState, createdAt: number): EventTemplate {
  const tags: string[][] = [
    ['e_type', state.entity_type],
    ['e_id', state.entity_id],
    ['from_verdict', state.from_verdict ?? 'NONE'],
    ['to_verdict', state.to_verdict],
    ['p_success', fmtProba(state.p_success)],
    ['ci95_low', fmtProba(state.ci95_low)],
    ['ci95_high', fmtProba(state.ci95_high)],
    ['n_obs', fmtInt(state.n_obs)],
    ['advisory_level', state.advisory_level],
    ['risk_score', fmtRisk(state.risk_score)],
    ['source', state.source],
    ['time_constant_days', fmtInt(state.time_constant_days)],
    ['last_update', fmtInt(state.last_update)],
  ];
  if (state.operator_id) tags.push(['operator_id', state.operator_id]);
  // Tag NIP-01 `p` quand l'entité est un node — permet aux clients qui filtrent
  // par pubkey de recevoir le flash sans avoir à filtrer par `e_type`.
  if (state.entity_type === 'node') tags.push(['p', state.entity_id]);
  return {
    kind: KIND_VERDICT_FLASH,
    created_at: createdAt,
    tags,
    content: '',
  };
}

/** Hash stable d'un payload — utilisé par le cache nostr_published_events
 *  pour détecter un changement avant de republier. Indépendant de created_at
 *  (qui bouge à chaque cycle) pour qu'une republication identique ne trigger
 *  pas un diff artificiel. */
export function payloadHash(template: EventTemplate): string {
  // tri lexical des tags + JSON canonique : deux events de même kind/contenu
  // hash à la même valeur, quel que soit l'ordre d'insertion.
  const sorted = [...template.tags].map((t) => [...t]).sort((a, b) => {
    const ja = JSON.stringify(a);
    const jb = JSON.stringify(b);
    return ja < jb ? -1 : ja > jb ? 1 : 0;
  });
  const payload = JSON.stringify({ kind: template.kind, tags: sorted, content: template.content });
  // crypto-js free : utilise createHash pour éviter d'ajouter une dep. Node
  // buildin — available dans tous les environments d'exécution SatRank.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
