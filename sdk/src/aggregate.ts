// Phase 7.2 — federation aggregation primitive.
//
// L'agent SDK utilise cette utility pour découvrir les oracles SatRank-
// compatible et filtrer ceux dont la calibration history meet ses
// critères. Pure helper — pas wired dans fulfill() automatiquement (c'est
// l'agent qui choisit quand et comment fédérer).
//
// Usage typique :
//
//   import { fetchOraclePeers, filterByCalibrationError } from '@satrank/sdk/aggregate';
//
//   const peers = await fetchOraclePeers({ baseUrl: 'https://satrank.dev' });
//   const trusted = filterByCalibrationError(peers, {
//     maxStaleSec: 7 * 86400,
//     minCatalogueSize: 50,
//   });
//   // trusted = liste de OraclePeer ayant publié il y a < 7d et catalogue ≥ 50
//   // L'agent peut alors interroger chacun via /api/intent ou via leur DVM
//   // kind 5900 et aggréger les réponses (Bayesian model averaging — à
//   // implémenter quand on aura des kind 30783 calibrations cross-oracle).

export interface OraclePeer {
  oracle_pubkey: string;
  lnd_pubkey: string | null;
  catalogue_size: number;
  calibration_event_id: string | null;
  last_assertion_event_id: string | null;
  contact: string | null;
  onboarding_url: string | null;
  last_seen: number;
  first_seen: number;
  age_sec: number;
  stale_sec: number;
  latest_announcement_event_id: string | null;
}

export interface FetchOraclePeersOptions {
  /** Base URL d'un oracle SatRank-compatible. Default 'https://satrank.dev'. */
  baseUrl?: string;
  /** Limit max de peers à récupérer (server clamp à 200). */
  limit?: number;
  /** fetch impl injectable pour tests. */
  fetchImpl?: typeof fetch;
}

export interface FetchOraclePeersResult {
  peers: OraclePeer[];
  count: number;
  source_oracle: string;
}

/** Récupère la liste des peers découverts par un oracle SatRank donné via
 *  GET /api/oracle/peers. */
export async function fetchOraclePeers(opts: FetchOraclePeersOptions = {}): Promise<FetchOraclePeersResult> {
  const baseUrl = opts.baseUrl ?? 'https://satrank.dev';
  const limit = opts.limit ?? 50;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = new URL('/api/oracle/peers', baseUrl);
  url.searchParams.set('limit', String(limit));
  const resp = await fetchImpl(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(`fetchOraclePeers: ${resp.status} ${resp.statusText}`);
  }
  const body = await resp.json() as { data?: { peers?: OraclePeer[]; count?: number } };
  const peers = body.data?.peers ?? [];
  return {
    peers,
    count: body.data?.count ?? peers.length,
    source_oracle: baseUrl,
  };
}

export interface FilterPeersOptions {
  /** Rejeter les peers qui n'ont pas re-publié depuis > N secondes. Default 7 jours. */
  maxStaleSec?: number;
  /** Catalogue size minimum. Default 50. */
  minCatalogueSize?: number;
  /** Exiger un calibration_event_id présent (= peer publie son calibration history).
   *  Default true. */
  requireCalibration?: boolean;
  /** Age minimum du peer (first_seen). Pas de Sybil-resistance forte ici, juste
   *  un filter age basique. Default 0 (no lower bound). */
  minAgeSec?: number;
}

/** Filtre une liste de peers selon les critères trust de l'agent. Pure
 *  function. */
export function filterByCalibrationError(
  peers: OraclePeer[],
  opts: FilterPeersOptions = {},
): OraclePeer[] {
  const maxStale = opts.maxStaleSec ?? 7 * 86400;
  const minCat = opts.minCatalogueSize ?? 50;
  const requireCalib = opts.requireCalibration ?? true;
  const minAge = opts.minAgeSec ?? 0;
  return peers.filter((p) => {
    if (p.stale_sec > maxStale) return false;
    if (p.catalogue_size < minCat) return false;
    if (requireCalib && !p.calibration_event_id) return false;
    if (p.age_sec < minAge) return false;
    return true;
  });
}

export interface AggregateOraclesOptions extends FetchOraclePeersOptions, FilterPeersOptions {}

/** Helper combiné : fetch + filter + return liste utilisable pour
 *  cross-oracle queries. L'agent peut ensuite interroger chaque peer
 *  via /api/intent ou son DVM. */
export async function aggregateOracles(opts: AggregateOraclesOptions = {}): Promise<{
  peers: OraclePeer[];
  total_discovered: number;
  trusted_count: number;
  source_oracle: string;
}> {
  const fetched = await fetchOraclePeers(opts);
  const trusted = filterByCalibrationError(fetched.peers, opts);
  return {
    peers: trusted,
    total_discovered: fetched.count,
    trusted_count: trusted.length,
    source_oracle: fetched.source_oracle,
  };
}
