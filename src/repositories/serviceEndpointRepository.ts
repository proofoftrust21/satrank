// Repository for HTTP service endpoint health tracking (pg async port, Phase 12B).
import type { Pool, PoolClient } from 'pg';
import { endpointHash } from '../utils/urlCanonical';

type Queryable = Pool | PoolClient;

export type ServiceSource = '402index' | 'l402directory' | 'self_registered' | 'ad_hoc';

/** Sources trusted enough to influence the 3D ranking composite.
 *  ad_hoc entries (observed from /api/decide serviceUrl) stay in DB for later
 *  validation but are filtered out of ranking and discovery queries.
 *  Vague 3 Phase 3: l402directory joins as a curated secondary source. */
export const TRUSTED_SOURCES: ServiceSource[] = ['402index', 'l402directory', 'self_registered'];

/** Vague 3 Phase 3 — trust ranking for the legacy `source` column when an
 *  endpoint accumulates multiple sources. Higher rank wins, so a row reaches
 *  the catalogue first via l402directory and later confirmed by 402index
 *  upgrades to source='402index' but keeps both attributions in `sources[]`. */
const SOURCE_TRUST_RANK: Record<ServiceSource, number> = {
  '402index': 4,
  'l402directory': 3,
  'self_registered': 2,
  'ad_hoc': 1,
};

export interface ServiceEndpoint {
  id: number;
  agent_hash: string | null;
  url: string;
  last_http_status: number | null;
  last_latency_ms: number | null;
  last_checked_at: number | null;
  check_count: number;
  success_count: number;
  created_at: number;
  service_price_sats: number | null;
  name: string | null;
  description: string | null;
  category: string | null;
  provider: string | null;
  source: ServiceSource;
  /** Axe 1 — epoch seconds, last time this endpoint was surfaced via
   *  /api/intent or /api/decide. NULL = never queried.
   *  Drives hot/warm/cold tiering in serviceHealthCrawler. */
  last_intent_query_at: number | null;
  /** Vague 1 G.2 — upstream quality signals copied from the registry source
   *  (currently 402index). Persisted at registry-crawl time and refreshed
   *  on every subsequent ingestion. NULL when the registry did not expose a
   *  field or the row predates schema v43. Drives the bayesian prior cascade
   *  in bayesianScoringService.resolveHierarchicalPrior. */
  upstream_health_status: string | null;
  upstream_uptime_30d: number | null;
  upstream_latency_p50_ms: number | null;
  upstream_reliability_score: number | null;
  upstream_last_checked: number | null;
  upstream_source: string | null;
  upstream_signals_updated_at: number | null;
  /** Vague 3 Phase 2.6 — set to true after consecutive_404_count crosses
   *  DEPRECATED_404_THRESHOLD, or any other deprecation reason. Excluded from
   *  the discovery surfaces (/api/intent, /api/intent/categories, /api/services)
   *  but kept in the DB so the row can come back to life automatically when the
   *  upstream provider responds non-404 again. */
  deprecated: boolean;
  deprecated_reason: string | null;
  consecutive_404_count: number;
  /** Vague 3 Phase 3 — every source that has attested this endpoint, deduped.
   *  The legacy scalar `source` carries the highest-trust attribution; `sources`
   *  is the full set, used by /api/health to surface diversification and by the
   *  l402DirectoryCrawler to skip re-probes when a URL is already known.
   *  Values are free-form strings but practical members today are
   *  '402index' | 'l402directory' | 'self_registered' | 'ad_hoc'. */
  sources: string[];
  consumption_type: string | null;
  provider_contact: string | null;
  /** Phase 5.10A — méthode HTTP attendue par l'endpoint, exposée par 402index
   *  (`http_method`) sur ~95% des entrées. Avant v48, ce signal était parsé
   *  par le crawler puis jeté ; toute la chaîne aval (intentService,
   *  decideService, SDK fulfill) défaut sur GET, ce qui fait échouer
   *  silencieusement les 444 entrées POST-only de llm402.ai et tous les
   *  endpoints qui requièrent POST. Persisté ici pour que /api/intent expose
   *  la méthode au candidat retourné — l'agent (et le SDK) l'utilise sans
   *  avoir à essayer-puis-fallback. Default 'GET' pour les rows pré-v48 et
   *  les endpoints sans signal upstream. */
  http_method: 'GET' | 'POST';
}

/** Vague 1 G.2 — payload accepted by upsertUpstreamSignals. Mirrors the
 *  402index API schema (subset). All fields nullable so partial signal sets
 *  are persisted without dropping known data. */
export interface UpstreamSignals {
  health_status?: string | null;
  uptime_30d?: number | null;
  latency_p50_ms?: number | null;
  reliability_score?: number | null;
  last_checked?: number | null;
  source?: string | null;
}

/** Axe 1 — probe tier classification.
 *  hot  : queried < 2h ago — needs sub-hourly freshness for live agents.
 *  warm : queried < 24h ago — daily-active services, 6h freshness fits.
 *  cold : queried >= 24h ago or never — long-tail/catalog scan, daily.
 */
export type ProbeTier = 'hot' | 'warm' | 'cold';

const TIER_BOUNDARIES = {
  HOT_INTENT_MAX_AGE_SEC: 2 * 3600,
  WARM_INTENT_MAX_AGE_SEC: 24 * 3600,
  HOT_PROBE_MAX_AGE_SEC: 1 * 3600,
  WARM_PROBE_MAX_AGE_SEC: 6 * 3600,
  COLD_PROBE_MAX_AGE_SEC: 24 * 3600,
} as const;

export interface ServiceMetadata {
  name: string | null;
  description: string | null;
  category: string | null;
  provider: string | null;
}

export interface ServiceSearchFilters {
  q?: string;
  category?: string;
  minUptime?: number;
  /** SQL-level sort axis. `activity` is the default (ORDER BY check_count DESC).
   *  `p_success` sort is delegated to the controller (requires per-row agent
   *  lookup, so it's a post-filter re-sort in JS).
   *
   *  Phase 5.8 — added `latency`, `reliability`, `cost` to power the new
   *  /api/intent and /api/services `optimize=` parameter. Each axis maps to
   *  a deterministic ORDER BY against an existing column (no composite
   *  weighting — preserves the Bayesian probabilistic oracle thesis as
   *  the default). The strategic review showed these axes carry real
   *  per-endpoint variance (latency: 122x range; reliability: stddev 19.5)
   *  that p_success-only ranking ignored. */
  sort?: 'p_success' | 'activity' | 'price' | 'uptime' | 'latency' | 'reliability' | 'cost';
  limit?: number;
  offset?: number;
}

export class ServiceEndpointRepository {
  constructor(private db: Queryable) {}

  async upsert(agentHash: string | null, url: string, httpStatus: number, latencyMs: number, source: ServiceSource = 'ad_hoc'): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const isSuccess = (httpStatus >= 200 && httpStatus < 400) || httpStatus === 402;
    // Trust hierarchy resolved client-side via SOURCE_TRUST_RANK so the SQL
    // doesn't have to special-case every new value. Vague 3 Phase 3 expanded
    // this from 3 → 4 sources.
    const incomingRank = SOURCE_TRUST_RANK[source];
    await this.db.query(
      `
      INSERT INTO service_endpoints (agent_hash, url, last_http_status, last_latency_ms, last_checked_at, check_count, success_count, created_at, source, sources)
      VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, ARRAY[$8::text])
      ON CONFLICT (url) DO UPDATE SET
        agent_hash = COALESCE(EXCLUDED.agent_hash, service_endpoints.agent_hash),
        last_http_status = EXCLUDED.last_http_status,
        last_latency_ms = EXCLUDED.last_latency_ms,
        last_checked_at = EXCLUDED.last_checked_at,
        check_count = service_endpoints.check_count + 1,
        success_count = service_endpoints.success_count + EXCLUDED.success_count,
        source = CASE WHEN $9 > COALESCE((
          CASE service_endpoints.source
            WHEN '402index' THEN 4
            WHEN 'l402directory' THEN 3
            WHEN 'self_registered' THEN 2
            WHEN 'ad_hoc' THEN 1
            ELSE 0
          END
        ), 0) THEN EXCLUDED.source ELSE service_endpoints.source END,
        sources = (
          SELECT ARRAY(SELECT DISTINCT unnest(service_endpoints.sources || EXCLUDED.sources))
        )
      `,
      [agentHash, url, httpStatus, latencyMs, now, isSuccess ? 1 : 0, now, source, incomingRank],
    );
  }

  /** Vague 3 Phase 3 — append a source attribution to an already-known URL
   *  without touching the probe counters. Used by the l402DirectoryCrawler
   *  when a candidate URL is already in the catalogue via 402index: we only
   *  want to record that l402.directory also lists it, not increment the
   *  health counters as if a probe just happened. Optionally fills in
   *  consumption_type / provider_contact if currently NULL — never overwrites
   *  existing data so 402index attribution wins on conflicting metadata.
   *
   *  Returns:
   *    found = true if the URL existed in service_endpoints
   *    added = true if the source was newly appended (false if already present) */
  async attachSource(
    url: string,
    source: ServiceSource,
    fillIfNull?: { consumption_type?: string | null; provider_contact?: string | null },
  ): Promise<{ found: boolean; added: boolean }> {
    const incomingRank = SOURCE_TRUST_RANK[source];
    // CTE captures previous sources so RETURNING can answer "was the source
    // already there?" — the post-UPDATE row always contains the new source,
    // so we must read pre-update state through the CTE.
    const { rows } = await this.db.query<{ already_present: boolean }>(
      `
      WITH before AS (
        SELECT url, sources AS prev_sources FROM service_endpoints WHERE url = $1
      ),
      upd AS (
        UPDATE service_endpoints
        SET
          sources = (
            SELECT ARRAY(SELECT DISTINCT unnest(sources || ARRAY[$2::text]))
          ),
          source = CASE WHEN $3 > COALESCE((
            CASE source
              WHEN '402index' THEN 4
              WHEN 'l402directory' THEN 3
              WHEN 'self_registered' THEN 2
              WHEN 'ad_hoc' THEN 1
              ELSE 0
            END
          ), 0) THEN $2 ELSE source END,
          consumption_type = COALESCE(consumption_type, $4),
          provider_contact = COALESCE(provider_contact, $5)
        WHERE url = $1
        RETURNING url
      )
      SELECT (prev_sources @> ARRAY[$2::text]) AS already_present
      FROM before
      `,
      [url, source, incomingRank, fillIfNull?.consumption_type ?? null, fillIfNull?.provider_contact ?? null],
    );
    if (rows.length === 0) return { found: false, added: false };
    return { found: true, added: !rows[0].already_present };
  }

  /** Vague 3 Phase 3 — distribution of (multi-)source attribution. Used by
   *  /api/health and the post-deploy verification check to confirm dedup is
   *  working: when l402directory ingestion completes, the count of
   *  ['402index','l402directory'] must equal the cross-source overlap
   *  computed from the upstream catalogues. */
  async countBySources(): Promise<Array<{ sources: string[]; count: number }>> {
    const { rows } = await this.db.query<{ sources: string[]; c: string }>(
      `SELECT sources, COUNT(*)::text AS c
       FROM service_endpoints
       WHERE deprecated = FALSE
       GROUP BY sources
       ORDER BY 2 DESC`,
    );
    return rows.map((r) => ({ sources: r.sources, count: Number(r.c) }));
  }

  /** Distribution of entries per source — used by /api/health for observability. */
  async countBySource(): Promise<Record<ServiceSource, number>> {
    const { rows } = await this.db.query<{ source: ServiceSource; c: string }>(
      'SELECT source, COUNT(*)::text as c FROM service_endpoints GROUP BY source',
    );
    const out: Record<ServiceSource, number> = { '402index': 0, 'l402directory': 0, 'self_registered': 0, 'ad_hoc': 0 };
    for (const r of rows) out[r.source] = Number(r.c);
    return out;
  }

  async findByUrl(url: string): Promise<ServiceEndpoint | undefined> {
    const { rows } = await this.db.query<ServiceEndpoint>(
      'SELECT * FROM service_endpoints WHERE url = $1',
      [url],
    );
    return rows[0];
  }

  /** Best-effort metadata lookup by url_hash (sha256 of canonicalized URL).
   *  Postgres has no native sha256 helper matching our canonicalization, and
   *  `service_endpoints` stores only the literal URL, so we scan trusted rows
   *  and compare hashes in-process. The table is small (low thousands at most
   *  today) so the O(N) scan is fine for a detail view. A dedicated column /
   *  index can be added in a later migration if this endpoint ever gets hot. */
  async findByUrlHash(urlHash: string): Promise<ServiceEndpoint | undefined> {
    const { rows } = await this.db.query<ServiceEndpoint>(
      "SELECT * FROM service_endpoints WHERE source IN ('402index', 'self_registered')",
    );
    for (const row of rows) {
      try {
        if (endpointHash(row.url) === urlHash) return row;
      } catch {
        // Malformed URL in DB — skip, do not abort the lookup.
      }
    }
    return undefined;
  }

  async findByAgent(agentHash: string): Promise<ServiceEndpoint[]> {
    // findByAgent excludes ad_hoc entries by default — these aren't trusted enough
    // to influence ranking or discovery (URL→agent binding may be incorrect).
    const { rows } = await this.db.query<ServiceEndpoint>(
      "SELECT * FROM service_endpoints WHERE agent_hash = $1 AND source IN ('402index', 'self_registered') ORDER BY last_checked_at DESC",
      [agentHash],
    );
    return rows;
  }

  /** Phase 6.2 — endpoints actifs trusted (non-deprecated, source dans
   *  TRUSTED_SOURCES). Utilisé par TrustAssertionPublisher pour itérer
   *  le catalogue à publier en kind 30782. Tri par last_checked_at DESC
   *  pour prioritiser les endpoints récemment probés (= meilleur signal). */
  async listActiveTrustedEndpoints(limit: number): Promise<ServiceEndpoint[]> {
    const { rows } = await this.db.query<ServiceEndpoint>(
      `
      SELECT * FROM service_endpoints
      WHERE NOT deprecated
        AND source = ANY($1::text[])
      ORDER BY last_checked_at DESC NULLS LAST
      LIMIT $2
      `,
      [TRUSTED_SOURCES, limit],
    );
    return rows;
  }

  async findStale(minCheckCount: number, maxAgeSec: number, limit: number): Promise<ServiceEndpoint[]> {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
    const { rows } = await this.db.query<ServiceEndpoint>(
      `
      SELECT * FROM service_endpoints
      WHERE check_count >= $1 AND (last_checked_at IS NULL OR last_checked_at < $2)
      ORDER BY last_checked_at ASC LIMIT $3
      `,
      [minCheckCount, cutoff, limit],
    );
    return rows;
  }

  /** Axe 1 — endpoints due for probing within a given tier.
   *  Filters by recent intent activity AND staleness of the last HTTP probe.
   *  Bootstrap-friendly: requires ≥1 historical check (not 3) so newly
   *  registered endpoints can ramp into the rotation.
   *
   *  Tier definitions (tied to TIER_BOUNDARIES above):
   *    hot  : last_intent_query_at within 2h, last_checked_at older than 1h
   *    warm : last_intent_query_at in [2h, 24h], probed older than 6h
   *    cold : last_intent_query_at older than 24h or never, probed older than 24h
   */
  async findStaleByTier(tier: ProbeTier, limit: number): Promise<ServiceEndpoint[]> {
    const now = Math.floor(Date.now() / 1000);
    let where: string;
    const params: number[] = [];

    if (tier === 'hot') {
      const intentCutoff = now - TIER_BOUNDARIES.HOT_INTENT_MAX_AGE_SEC;
      const probeCutoff = now - TIER_BOUNDARIES.HOT_PROBE_MAX_AGE_SEC;
      where = `last_intent_query_at IS NOT NULL
               AND last_intent_query_at >= $1
               AND (last_checked_at IS NULL OR last_checked_at < $2)`;
      params.push(intentCutoff, probeCutoff);
    } else if (tier === 'warm') {
      const intentMaxCutoff = now - TIER_BOUNDARIES.HOT_INTENT_MAX_AGE_SEC;
      const intentMinCutoff = now - TIER_BOUNDARIES.WARM_INTENT_MAX_AGE_SEC;
      const probeCutoff = now - TIER_BOUNDARIES.WARM_PROBE_MAX_AGE_SEC;
      where = `last_intent_query_at IS NOT NULL
               AND last_intent_query_at >= $1
               AND last_intent_query_at < $2
               AND (last_checked_at IS NULL OR last_checked_at < $3)`;
      params.push(intentMinCutoff, intentMaxCutoff, probeCutoff);
    } else {
      const intentCutoff = now - TIER_BOUNDARIES.WARM_INTENT_MAX_AGE_SEC;
      const probeCutoff = now - TIER_BOUNDARIES.COLD_PROBE_MAX_AGE_SEC;
      where = `(last_intent_query_at IS NULL OR last_intent_query_at < $1)
               AND (last_checked_at IS NULL OR last_checked_at < $2)`;
      params.push(intentCutoff, probeCutoff);
    }

    params.push(limit);
    const { rows } = await this.db.query<ServiceEndpoint>(
      `
      SELECT * FROM service_endpoints
      WHERE check_count >= 1 AND deprecated = FALSE AND ${where}
      ORDER BY last_checked_at ASC NULLS FIRST
      LIMIT $${params.length}
      `,
      params,
    );
    return rows;
  }

  /** Vague 3 Phase 2.6 — counts of endpoints per host. Used by registryCrawler
   *  to enforce ABSOLUTE_HOST_CAP_TOTAL: a single host (e.g. llm402.ai) cannot
   *  exceed N endpoints in the catalogue, regardless of how many cycles run.
   *  Returns only NON-deprecated rows so a host that was capped, then had
   *  fossiles deprecated, can recover ingestion budget. */
  async countActiveByHost(): Promise<Map<string, number>> {
    const { rows } = await this.db.query<{ host: string; ct: string }>(
      `SELECT
         SUBSTRING(url FROM 'https?://([^/:?]+)') AS host,
         COUNT(*)::text AS ct
       FROM service_endpoints
       WHERE deprecated = FALSE
       GROUP BY host`,
    );
    const m = new Map<string, number>();
    for (const r of rows) {
      if (r.host) m.set(r.host, Number(r.ct));
    }
    return m;
  }

  /** Vague 3 Phase 2.6 — bump consecutive_404_count and flag deprecated when
   *  the threshold is reached. Returns the updated row so the caller can log
   *  the transition. */
  async record404(url: string, threshold: number): Promise<{ count: number; deprecated: boolean }> {
    const { rows } = await this.db.query<{ consecutive_404_count: number; deprecated: boolean }>(
      `UPDATE service_endpoints
         SET consecutive_404_count = consecutive_404_count + 1,
             deprecated = (consecutive_404_count + 1 >= $2),
             deprecated_reason = CASE
               WHEN consecutive_404_count + 1 >= $2 THEN '404_persistent'
               ELSE deprecated_reason
             END
       WHERE url = $1
       RETURNING consecutive_404_count, deprecated`,
      [url, threshold],
    );
    if (rows.length === 0) return { count: 0, deprecated: false };
    return { count: rows[0].consecutive_404_count, deprecated: rows[0].deprecated };
  }

  /** Vague 3 Phase 2.6 — reset the 404 streak and clear deprecated when the
   *  endpoint comes back online. Reversible by design: a provider recovering
   *  from a misconfigured route auto-rejoins the catalog at the next probe. */
  async clear404Streak(url: string): Promise<void> {
    await this.db.query(
      `UPDATE service_endpoints
         SET consecutive_404_count = 0,
             deprecated = CASE WHEN deprecated_reason = '404_persistent' THEN FALSE ELSE deprecated END,
             deprecated_reason = CASE WHEN deprecated_reason = '404_persistent' THEN NULL ELSE deprecated_reason END
       WHERE url = $1
         AND consecutive_404_count > 0`,
      [url],
    );
  }

  /** Phase 5.6 — bump `last_checked_at` for an endpoint that was just probed.
   *  serviceHealthCrawler.probeBatch already does this via `upsert(...)`, but
   *  ad-hoc tools (the accelerateProbeSweep script, future operator-driven
   *  probes, etc.) write streaming posteriors without touching the
   *  service_endpoints row. Without this method, `intentService.formatCandidate`
   *  computes `lastProbeAgeSec` from a stale `last_checked_at`, the freshness
   *  gate fails, and `is_meaningful=false` even when n_obs is high.
   *
   *  Idempotent and tiny — a single column UPDATE. The clock argument lets
   *  tests pin the value; defaults to "now" in production. */
  async markProbed(url: string, nowSec?: number): Promise<void> {
    const ts = nowSec ?? Math.floor(Date.now() / 1000);
    await this.db.query(
      'UPDATE service_endpoints SET last_checked_at = $1 WHERE url = $2',
      [ts, url],
    );
  }

  /** Axe 1 — record that one or more endpoints were just surfaced to a caller.
   *  Called from /api/intent (batch) and /api/decide (single URL).
   *  No-op when `urls` is empty. */
  async markIntentQuery(urls: string[]): Promise<void> {
    if (urls.length === 0) return;
    const now = Math.floor(Date.now() / 1000);
    await this.db.query(
      'UPDATE service_endpoints SET last_intent_query_at = $1 WHERE url = ANY($2::text[])',
      [now, urls],
    );
  }

  async updatePrice(url: string, priceSats: number): Promise<void> {
    await this.db.query('UPDATE service_endpoints SET service_price_sats = $1 WHERE url = $2', [priceSats, url]);
  }

  async updateMetadata(url: string, meta: ServiceMetadata): Promise<void> {
    await this.db.query(
      'UPDATE service_endpoints SET name = $1, description = $2, category = $3, provider = $4 WHERE url = $5',
      [meta.name, meta.description, meta.category, meta.provider, url],
    );
  }

  /** Vague 1 G.2 — persist upstream registry quality signals. Idempotent:
   *  every registry-crawl pass refreshes the columns. NULL fields in the
   *  payload overwrite previous values on purpose so a regressed registry
   *  entry is reflected. The caller (RegistryCrawler) passes the raw fields
   *  it observed from 402index (or future sources).
   *
   *  Vague 2 fix: 402index returns latency_p50_ms and reliability_score as
   *  floats (e.g. "88.8"), but the columns upstream_latency_p50_ms and
   *  upstream_reliability_score are INTEGER. Round at the boundary instead
   *  of widening the schema, because both values are conceptually integer
   *  metrics (latency in whole milliseconds, reliability on a 0..100 scale)
   *  and the upstream's decimal precision is noise we do not preserve.
   *  Without this cast the v43 registry crawl logged 20 errors of the form
   *  "invalid input syntax for type integer: \"88.8\"" and silently dropped
   *  20/220 rows from upstream coverage. */
  async upsertUpstreamSignals(url: string, signals: UpstreamSignals): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const toInt = (n: number | null | undefined): number | null =>
      typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null;
    await this.db.query(
      `UPDATE service_endpoints
         SET upstream_health_status = $1,
             upstream_uptime_30d = $2,
             upstream_latency_p50_ms = $3,
             upstream_reliability_score = $4,
             upstream_last_checked = $5,
             upstream_source = $6,
             upstream_signals_updated_at = $7
       WHERE url = $8`,
      [
        signals.health_status ?? null,
        signals.uptime_30d ?? null,
        toInt(signals.latency_p50_ms),
        toInt(signals.reliability_score),
        signals.last_checked ?? null,
        signals.source ?? '402index',
        now,
        url,
      ],
    );
  }

  /** Phase 5.10A — set http_method on an endpoint, called from the registry
   *  crawler after each ingestion / update path. Idempotent : updating to the
   *  same value is a no-op write. Constraint enforced at the schema level
   *  (CHECK http_method IN ('GET', 'POST')) so an upstream serving 'PUT' or
   *  'DELETE' would surface a Postgres CheckViolation rather than silently
   *  storing an unsupported value — caller catches and falls back to GET. */
  async setHttpMethod(url: string, method: 'GET' | 'POST'): Promise<void> {
    await this.db.query(
      `UPDATE service_endpoints SET http_method = $1 WHERE url = $2`,
      [method, url],
    );
  }

  /** Vague 1 G.2 — fetch upstream signals for a known endpoint, used by
   *  bayesianScoringService.resolveHierarchicalPrior to seed the prior when
   *  endpoint observations are insufficient. Returns null when the row is
   *  unknown or has no upstream signal recorded. */
  async findUpstreamSignals(url: string): Promise<UpstreamSignals | null> {
    const { rows } = await this.db.query<{
      upstream_health_status: string | null;
      upstream_uptime_30d: number | null;
      upstream_latency_p50_ms: number | null;
      upstream_reliability_score: number | null;
      upstream_last_checked: number | null;
      upstream_source: string | null;
    }>(
      `SELECT upstream_health_status, upstream_uptime_30d, upstream_latency_p50_ms,
              upstream_reliability_score, upstream_last_checked, upstream_source
         FROM service_endpoints
        WHERE url = $1`,
      [url],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    if (
      r.upstream_health_status == null &&
      r.upstream_uptime_30d == null &&
      r.upstream_latency_p50_ms == null &&
      r.upstream_reliability_score == null
    ) {
      return null;
    }
    return {
      health_status: r.upstream_health_status,
      uptime_30d: r.upstream_uptime_30d,
      latency_p50_ms: r.upstream_latency_p50_ms,
      reliability_score: r.upstream_reliability_score,
      last_checked: r.upstream_last_checked,
      source: r.upstream_source,
    };
  }

  /** Vague 1 G.2 — same as findUpstreamSignals but keyed by url_hash, the
   *  shape carried in the bayesian scoring path. The table only stores the
   *  literal URL, so we reuse the existing in-process scan from
   *  findByUrlHash to avoid adding a hash column for now. */
  async findUpstreamSignalsByUrlHash(urlHash: string): Promise<UpstreamSignals | null> {
    const ep = await this.findByUrlHash(urlHash);
    if (!ep) return null;
    if (
      ep.upstream_health_status == null &&
      ep.upstream_uptime_30d == null &&
      ep.upstream_latency_p50_ms == null &&
      ep.upstream_reliability_score == null
    ) {
      return null;
    }
    return {
      health_status: ep.upstream_health_status,
      uptime_30d: ep.upstream_uptime_30d,
      latency_p50_ms: ep.upstream_latency_p50_ms,
      reliability_score: ep.upstream_reliability_score,
      last_checked: ep.upstream_last_checked,
      source: ep.upstream_source,
    };
  }

  async findServices(filters: ServiceSearchFilters): Promise<{ services: ServiceEndpoint[]; total: number }> {
    // Only trusted sources appear in discovery — ad_hoc URLs may have wrong URL→agent bindings
    // Vague 3 Phase 2.6 — also filter out deprecated rows (e.g. 404-persistent fossiles)
    const conditions: string[] = ["se.agent_hash IS NOT NULL", "se.source IN ('402index', 'self_registered')", "se.deprecated = FALSE"];
    const params: unknown[] = [];
    let idx = 1;

    if (filters.q) {
      const like = `%${filters.q}%`;
      conditions.push(`(se.name LIKE $${idx} OR se.description LIKE $${idx + 1} OR se.category LIKE $${idx + 2} OR se.provider LIKE $${idx + 3})`);
      params.push(like, like, like, like);
      idx += 4;
    }

    if (filters.category) {
      conditions.push(`se.category = $${idx}`);
      params.push(filters.category.toLowerCase());
      idx += 1;
    }

    if (filters.minUptime !== undefined) {
      conditions.push(`se.check_count >= 3 AND (CAST(se.success_count AS DOUBLE PRECISION) / se.check_count) >= $${idx}`);
      params.push(filters.minUptime);
      idx += 1;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows: countRows } = await this.db.query<{ c: string }>(
      `SELECT COUNT(*)::text as c FROM service_endpoints se ${where}`,
      params,
    );
    const total = Number(countRows[0]?.c ?? 0);

    // Explicit whitelist for ORDER BY column — defense in depth so a future
    // refactor that widens `filters.sort`'s type can't accidentally route user
    // input into the SQL string. Unknown values fall back to the default.
    //
    // Phase 5.6 — `p_success` was a no-op alias for `activity` because the
    // intentService re-sorted in JS after enrichment. That worked when
    // MAX_POOL_SCAN was big enough to pull everything in any category, but
    // it left other consumers (services search, controllers that don't
    // re-sort) ranking by raw `check_count` instead of the actual Bayesian
    // score. We now LEFT JOIN endpoint_streaming_posteriors and rank by
    // posterior_alpha / (posterior_alpha + posterior_beta), with deterministic
    // tiebreakers on observation count, upstream reliability, and freshness.
    // Endpoints with no streaming row (rare post-Phase-5 backfill) sort last
    // because their computed p_success defaults to 0 via COALESCE.
    const SORT_SQL: Record<string, string> = {
      price: 'se.service_price_sats ASC',
      uptime: '(CAST(se.success_count AS DOUBLE PRECISION) / GREATEST(se.check_count, 1)) DESC',
      activity: 'se.check_count DESC',
      p_success: `
        COALESCE(esp.posterior_alpha / NULLIF(esp.posterior_alpha + esp.posterior_beta, 0), 0) DESC,
        COALESCE(esp.total_ingestions, 0) DESC,
        COALESCE(se.upstream_reliability_score, 0) DESC,
        COALESCE(se.last_checked_at, 0) DESC
      `,
      // Phase 5.8 — three explicit dimension axes feed the `optimize=` parameter.
      // Each is a deterministic ORDER BY against existing columns; no
      // composite weighting. Tiebreakers chosen so a deterministic order
      // emerges even when the primary signal is missing.
      // `latency`: lowest median (or last) HTTP latency wins. NULLS LAST
      // so endpoints we've never timed sort below the slowest known one.
      latency: `
        COALESCE(se.last_latency_ms, 99999) ASC,
        COALESCE(se.upstream_reliability_score, 0) DESC,
        COALESCE(se.last_checked_at, 0) DESC
      `,
      // `reliability`: highest 402index reliability_score wins. Stddev 19.5
      // across 24 distinct values per the audit; meaningful agent signal.
      reliability: `
        COALESCE(se.upstream_reliability_score, 0) DESC,
        COALESCE(se.upstream_uptime_30d, 0) DESC,
        COALESCE(esp.posterior_alpha / NULLIF(esp.posterior_alpha + esp.posterior_beta, 0), 0) DESC
      `,
      // `cost`: cheapest first. Tied prices broken by Bayesian posterior so
      // among free or equally priced endpoints, the more reliable one wins.
      cost: `
        COALESCE(se.service_price_sats, 99999999) ASC,
        COALESCE(esp.posterior_alpha / NULLIF(esp.posterior_alpha + esp.posterior_beta, 0), 0) DESC
      `,
    };
    const sortKey = typeof filters.sort === 'string' && Object.prototype.hasOwnProperty.call(SORT_SQL, filters.sort)
      ? filters.sort
      : 'activity';
    const sortCol = SORT_SQL[sortKey];
    // Only attach the streaming posteriors LEFT JOIN when the sort actually
    // needs it. price/uptime/activity/latency don't reference `esp.*` so they
    // run without the join. p_success/reliability/cost reference the streaming
    // posterior in their tiebreakers, so they need it.
    const needsPosteriorJoin = ['p_success', 'reliability', 'cost'].includes(sortKey);
    const joinSql = needsPosteriorJoin
      ? `LEFT JOIN endpoint_streaming_posteriors esp
           ON esp.url_hash = encode(digest(se.url, 'sha256'), 'hex')
           AND esp.source = 'probe'`
      : '';

    const limit = Math.min(filters.limit ?? 20, 100);
    const offset = filters.offset ?? 0;

    const { rows } = await this.db.query<ServiceEndpoint>(
      `SELECT se.* FROM service_endpoints se ${joinSql} ${where} ORDER BY ${sortCol} LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    );

    return { services: rows, total };
  }

  async findCategories(): Promise<Array<{ category: string; count: number }>> {
    const { rows } = await this.db.query<{ category: string; count: string }>(
      "SELECT category, COUNT(*)::text as count FROM service_endpoints WHERE category IS NOT NULL AND agent_hash IS NOT NULL AND source IN ('402index', 'self_registered') GROUP BY category ORDER BY count DESC",
    );
    return rows.map((r) => ({ category: r.category, count: Number(r.count) }));
  }

  /** Résumé par catégorie pour /api/intent/categories : total + nombre
   *  d'endpoints actifs (≥3 probes ET uptime ≥ 50% ET probé dans les 7 derniers
   *  jours). Sans le gate de fraîcheur, des fossiles avec un vieil historique
   *  vert remontaient comme actifs ; on aligne le critère sur la fenêtre 7j
   *  utilisée par le posterior bayésien. `last_checked_at` est stocké en
   *  epoch seconds (BIGINT), donc on compare à un cutoff calculé côté TS.
   *  L'écart total/active signale aux agents quelles catégories sont saines
   *  vs. fossiles. */
  async findCategoriesWithActive(): Promise<Array<{ category: string; endpoint_count: number; active_count: number }>> {
    const freshCutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
    const { rows } = await this.db.query<{ category: string; endpoint_count: string; active_count: string }>(
      `
      SELECT
        category,
        COUNT(*)::text AS endpoint_count,
        SUM(CASE
          WHEN check_count >= 3
            AND (CAST(success_count AS DOUBLE PRECISION) / check_count) >= 0.5
            AND last_checked_at IS NOT NULL
            AND last_checked_at > $1
          THEN 1 ELSE 0
        END)::text AS active_count
      FROM service_endpoints
      WHERE category IS NOT NULL
        AND agent_hash IS NOT NULL
        AND source IN ('402index', 'self_registered')
        AND deprecated = FALSE
      GROUP BY category
      ORDER BY endpoint_count DESC
      `,
      [freshCutoff],
    );
    return rows.map((r) => ({
      category: r.category,
      endpoint_count: Number(r.endpoint_count),
      active_count: Number(r.active_count),
    }));
  }

  /** Médiane de response_latency_ms sur `service_probes` dans la fenêtre 7j.
   *  Retourne `null` si moins de `minSample` probes (défaut 3) — les agents
   *  n'ont pas à traiter une "médiane" sur 1 point comme un signal.
   *  Postgres n'expose pas toujours MEDIAN natif (percentile_cont fonctionne
   *  aussi) ; on extrait tous les points triés puis on prend celui du milieu
   *  côté TS pour garder la sémantique identique au code SQLite. Fenêtre 7j
   *  en secondes, cohérente avec τ du bayésien et la reachability.
   *
   *  Phase 5 — fallback to `service_endpoints.last_latency_ms` when
   *  `service_probes` has no data (Sim 3 surfaced this: median was null on
   *  every /api/intent candidate because service_probes is unused in
   *  production despite the data existing on `service_endpoints` itself).
   *  Using the most recent observed latency as a single-sample proxy is
   *  honest: callers see a number, downstream code that conditioned on
   *  null still gets a falsy when the endpoint has never been probed. */
  async medianHttpLatency7d(url: string, minSample = 3): Promise<number | null> {
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
    const { rows } = await this.db.query<{ latency: number }>(
      `
      SELECT response_latency_ms AS latency
      FROM service_probes
      WHERE url = $1
        AND probed_at >= $2
        AND response_latency_ms IS NOT NULL
      ORDER BY response_latency_ms ASC
      `,
      [url, cutoff],
    );
    if (rows.length < minSample) {
      const { rows: fallback } = await this.db.query<{ last_latency_ms: number | null }>(
        'SELECT last_latency_ms FROM service_endpoints WHERE url = $1',
        [url],
      );
      const single = fallback[0]?.last_latency_ms ?? null;
      return single != null && single > 0 ? single : null;
    }
    const mid = Math.floor(rows.length / 2);
    return rows.length % 2 === 1
      ? rows[mid].latency
      : Math.round((rows[mid - 1].latency + rows[mid].latency) / 2);
  }

  /** Scan live des URLs pour matcher un url_hash → category. La table n'a pas
   *  de colonne `url_hash` stockée ; pour ~100 endpoints le coût est
   *  négligeable (microsecondes). Ne trust que les sources trusted (pas ad_hoc). */
  async findCategoryByUrlHash(targetHash: string): Promise<string | null> {
    const { rows } = await this.db.query<{ url: string; category: string }>(
      "SELECT url, category FROM service_endpoints WHERE category IS NOT NULL AND source IN ('402index', 'self_registered')",
    );
    for (const r of rows) {
      if (endpointHash(r.url) === targetHash) return r.category;
    }
    return null;
  }

  /** Retourne tous les url_hash appartenant à une catégorie. Utilisé par le
   *  bayesian verdict service pour alimenter le niveau `category` du prior
   *  hiérarchique (somme des streaming posteriors des siblings). */
  async listUrlHashesByCategory(category: string): Promise<string[]> {
    const { rows } = await this.db.query<{ url: string }>(
      "SELECT url FROM service_endpoints WHERE category = $1 AND source IN ('402index', 'self_registered')",
      [category],
    );
    return rows.map((r) => endpointHash(r.url));
  }
}
