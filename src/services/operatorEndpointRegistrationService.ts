// Phase 10 (2026-05-04) — Operator-side SDK service.
//
// Handles registration validation + verification cycle for operators
// self-publishing L402 endpoints. Two responsibilities :
//   1. registerEndpoint() — accept POST, validate domain shape, insert as
//      'pending'. Verification via DNS TXT happens async.
//   2. runVerificationCycle() — cron-fed. For each pending row, look up
//      DNS TXT _satrank-operator.<domain> and confirm it contains the
//      operator_pubkey. On match → 'verified', endpoint visible in /api/intent.
//
// Reuses Phase 8.4 OperatorAttestationService.validateOperatorDomain for
// the domain shape gate (rejects label injection, IPv4 literals, reserved
// TLDs, etc.). DNS TXT lookup is also reused via the same dnsResolveTxt.
import { promises as nodeDns } from 'node:dns';
import { createHash } from 'node:crypto';
import { logger } from '../logger';
import { validateOperatorDomain } from './operatorAttestationService';
import type {
  OperatorEndpointRegistrationRepository,
  OperatorEndpointRegistration,
  CreateRegistrationInput,
} from '../repositories/operatorEndpointRegistrationRepository';

const TXT_PREFIX = 'satrank-operator-pubkey=';
const REGISTRATION_OPENAPI_MAX_BYTES = 64 * 1024;
const REGISTRATION_RECALL_BODY_MAX_BYTES = 4 * 1024;

export class InvalidRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRegistrationError';
  }
}

export interface OperatorEndpointRegistrationServiceDeps {
  repo: OperatorEndpointRegistrationRepository;
  /** Optional override for tests — must satisfy dns.resolveTxt's signature. */
  dnsResolveTxt?: (host: string) => Promise<string[][]>;
  now?: () => number;
  /** Phase 11A.1 — when a registration verifies, the service writes its
   *  capability schema into the matching service_endpoints row so /api/intent
   *  and /api/services can surface it. Optional so tests don't have to mount
   *  a service-endpoint repo when they only exercise the registration path. */
  serviceEndpointRepo?: {
    updateCapability(
      url: string,
      cap: {
        input_schema: Record<string, unknown> | null;
        output_schema: Record<string, unknown> | null;
        modalities: string[] | null;
        languages: string[] | null;
        freshness_sla_sec: number | null;
        deterministic: boolean | null;
        provenance: 'operator_signed' | 'crawler_inferred' | 'unknown';
      },
    ): Promise<number>;
  };
}

export interface RegisterEndpointInput {
  endpoint_url: string;
  http_method: 'GET' | 'POST';
  operator_pubkey: string;
  domain: string;
  openapi_json?: unknown;
  recall_body_template?: string;
  recommended_validators?: string[];
  expected_price_sats_min?: number;
  expected_price_sats_max?: number;
  bond_id?: number;
  signature_b64: string;
  /** Phase 11A.1 — capability metadata. At least ONE of input_schema or
   *  output_schema is required for new registrations (autonomy audit
   *  L1 Discovery — capability vocabulary). */
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  modalities?: string[];
  languages?: string[];
  freshness_sla_sec?: number;
  deterministic?: boolean;
}

export class OperatorEndpointRegistrationService {
  private now: () => number;
  private dnsResolveTxt: (host: string) => Promise<string[][]>;

  constructor(private readonly deps: OperatorEndpointRegistrationServiceDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.dnsResolveTxt = deps.dnsResolveTxt ?? (host => nodeDns.resolveTxt(host));
  }

  async registerEndpoint(input: RegisterEndpointInput): Promise<OperatorEndpointRegistration> {
    // 1. Domain shape gate (reuses Phase 8.4 H2 validation).
    const safeDomain = validateOperatorDomain(input.domain);

    // 2. URL must belong to the declared domain.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(input.endpoint_url);
    } catch {
      throw new InvalidRegistrationError('endpoint_url is not a valid URL');
    }
    if (parsedUrl.protocol !== 'https:') {
      throw new InvalidRegistrationError('endpoint_url must use https');
    }
    const urlHost = parsedUrl.hostname.toLowerCase();
    if (urlHost !== safeDomain && !urlHost.endsWith(`.${safeDomain}`)) {
      throw new InvalidRegistrationError(
        `endpoint_url host "${urlHost}" must match or be a subdomain of declared domain "${safeDomain}"`,
      );
    }

    // 3. Caps on heavy fields.
    if (input.openapi_json !== undefined) {
      const sizeOpenapi = Buffer.byteLength(JSON.stringify(input.openapi_json), 'utf8');
      if (sizeOpenapi > REGISTRATION_OPENAPI_MAX_BYTES) {
        throw new InvalidRegistrationError(
          `openapi_json exceeds ${REGISTRATION_OPENAPI_MAX_BYTES} bytes (got ${sizeOpenapi})`,
        );
      }
    }
    if (input.recall_body_template !== undefined) {
      const sizeBody = Buffer.byteLength(input.recall_body_template, 'utf8');
      if (sizeBody > REGISTRATION_RECALL_BODY_MAX_BYTES) {
        throw new InvalidRegistrationError(
          `recall_body_template exceeds ${REGISTRATION_RECALL_BODY_MAX_BYTES} bytes (got ${sizeBody})`,
        );
      }
    }
    if (
      input.expected_price_sats_min !== undefined &&
      input.expected_price_sats_max !== undefined &&
      input.expected_price_sats_min > input.expected_price_sats_max
    ) {
      throw new InvalidRegistrationError('expected_price_sats_min must be ≤ expected_price_sats_max');
    }
    if (input.recommended_validators && input.recommended_validators.length > 10) {
      throw new InvalidRegistrationError('recommended_validators max 10 entries');
    }

    // 3.1 Phase 11A.1 — capability schema requirement. At least one of
    // input_schema / output_schema is required so /api/intent surfaces
    // machine-readable I/O metadata to autonomous agents. The audit's
    // sev-5 gap "no-capability-vocabulary" is the reason. Backwards-compat
    // keepswith older v68 callers : if the caller supplies neither AND has
    // no openapi_json (legacy path), we still allow the row through with
    // capability_provenance NULL — those become 'crawler_inferred'-eligible
    // backfill targets. The strict requirement only applies when the caller
    // supplies *some* capability fields (modalities, languages, etc.) but
    // forgets the schemas — likely a bug.
    const suppliedCapabilityHints =
      input.modalities !== undefined ||
      input.languages !== undefined ||
      input.freshness_sla_sec !== undefined ||
      input.deterministic !== undefined;
    const hasSchema = input.input_schema !== undefined || input.output_schema !== undefined;
    if (suppliedCapabilityHints && !hasSchema && input.openapi_json === undefined) {
      throw new InvalidRegistrationError(
        'capability hints (modalities/languages/freshness_sla_sec/deterministic) require at least one of input_schema, output_schema, or openapi_json',
      );
    }
    if (input.input_schema !== undefined) {
      const sz = Buffer.byteLength(JSON.stringify(input.input_schema), 'utf8');
      if (sz > REGISTRATION_OPENAPI_MAX_BYTES) {
        throw new InvalidRegistrationError(`input_schema exceeds ${REGISTRATION_OPENAPI_MAX_BYTES} bytes (got ${sz})`);
      }
    }
    if (input.output_schema !== undefined) {
      const sz = Buffer.byteLength(JSON.stringify(input.output_schema), 'utf8');
      if (sz > REGISTRATION_OPENAPI_MAX_BYTES) {
        throw new InvalidRegistrationError(`output_schema exceeds ${REGISTRATION_OPENAPI_MAX_BYTES} bytes (got ${sz})`);
      }
    }
    if (input.modalities !== undefined && input.modalities.length > 8) {
      throw new InvalidRegistrationError('modalities max 8 entries');
    }
    if (input.languages !== undefined && input.languages.length > 32) {
      throw new InvalidRegistrationError('languages max 32 entries');
    }
    if (input.freshness_sla_sec !== undefined && (input.freshness_sla_sec < 0 || input.freshness_sla_sec > 365 * 86400)) {
      throw new InvalidRegistrationError('freshness_sla_sec must be in [0, 365 days]');
    }

    // 4. Compute payload digest for tamper-resistance audit. Repository
    //    persists this alongside the signature so we can re-verify later.
    const canonical = JSON.stringify({
      endpoint_url: input.endpoint_url,
      http_method: input.http_method,
      operator_pubkey: input.operator_pubkey,
      domain: safeDomain,
      openapi_json: input.openapi_json ?? null,
      recall_body_template: input.recall_body_template ?? null,
      recommended_validators: input.recommended_validators ?? null,
      expected_price_sats_min: input.expected_price_sats_min ?? null,
      expected_price_sats_max: input.expected_price_sats_max ?? null,
      bond_id: input.bond_id ?? null,
      input_schema: input.input_schema ?? null,
      output_schema: input.output_schema ?? null,
      modalities: input.modalities ?? null,
      languages: input.languages ?? null,
      freshness_sla_sec: input.freshness_sla_sec ?? null,
      deterministic: input.deterministic ?? null,
    });
    const payloadHash = createHash('sha256').update(canonical, 'utf8').digest('hex');

    // 5. Insert as 'pending'. Verification cron flips state.
    const created: CreateRegistrationInput = {
      endpoint_url: input.endpoint_url,
      http_method: input.http_method,
      operator_pubkey: input.operator_pubkey,
      domain: safeDomain,
      openapi_json: input.openapi_json,
      recall_body_template: input.recall_body_template,
      recommended_validators: input.recommended_validators,
      expected_price_sats_min: input.expected_price_sats_min,
      expected_price_sats_max: input.expected_price_sats_max,
      bond_id: input.bond_id,
      signed_payload_sha256: payloadHash,
      signature_b64: input.signature_b64,
      registered_at: this.now(),
      input_schema: input.input_schema,
      output_schema: input.output_schema,
      modalities: input.modalities,
      languages: input.languages,
      freshness_sla_sec: input.freshness_sla_sec,
      deterministic: input.deterministic,
    };
    return this.deps.repo.create(created);
  }

  async runVerificationCycle(): Promise<{ verified: number; failed: number }> {
    const pending = await this.deps.repo.findPending();
    let verified = 0;
    let failed = 0;
    for (const reg of pending) {
      const ok = await this.verifyOne(reg);
      if (ok) verified += 1; else failed += 1;
    }
    if (verified + failed > 0) {
      logger.info(
        { verified, failed, total: pending.length },
        'OperatorEndpointRegistrationService: verification cycle complete',
      );
    }
    return { verified, failed };
  }

  async verifyOne(reg: OperatorEndpointRegistration): Promise<boolean> {
    const host = `_satrank-operator.${reg.domain}`;
    let records: string[][];
    try {
      records = await this.dnsResolveTxt(host);
    } catch (err) {
      logger.info(
        { domain: reg.domain, error: err instanceof Error ? err.message : String(err) },
        'OperatorEndpointRegistrationService: DNS lookup failed',
      );
      await this.deps.repo.markFailed(reg.registration_id, this.now());
      return false;
    }
    const flat = records.map(parts => parts.join('')).filter(s => s.startsWith(TXT_PREFIX));
    const matched = flat.some(s =>
      s.slice(TXT_PREFIX.length).toLowerCase() === reg.operator_pubkey.toLowerCase(),
    );
    if (!matched) {
      await this.deps.repo.markFailed(reg.registration_id, this.now());
      return false;
    }
    await this.deps.repo.markVerified(reg.registration_id, this.now());

    // Phase 11A.1 — propagate capability schema to service_endpoints so the
    // operator-signed metadata surfaces in /api/intent + /api/services. Best
    // effort : a missing service_endpoints row (registered URL not yet in the
    // catalogue) is logged at info level and not retried. The capability
    // sticks in operator_endpoint_registrations and a future crawler pass
    // will re-converge once service_endpoints catches up.
    if (this.deps.serviceEndpointRepo) {
      const hasAnyCapability =
        reg.input_schema != null ||
        reg.output_schema != null ||
        (reg.modalities && reg.modalities.length > 0) ||
        (reg.languages && reg.languages.length > 0) ||
        reg.freshness_sla_sec != null ||
        reg.deterministic != null;
      if (hasAnyCapability) {
        try {
          const updated = await this.deps.serviceEndpointRepo.updateCapability(reg.endpoint_url, {
            input_schema: reg.input_schema,
            output_schema: reg.output_schema,
            modalities: reg.modalities,
            languages: reg.languages,
            freshness_sla_sec: reg.freshness_sla_sec,
            deterministic: reg.deterministic,
            provenance: 'operator_signed',
          });
          if (updated === 0) {
            logger.info(
              { endpoint_url: reg.endpoint_url },
              'OperatorEndpointRegistrationService: capability not propagated — endpoint not yet in service_endpoints',
            );
          }
        } catch (err) {
          logger.warn(
            { endpoint_url: reg.endpoint_url, error: err instanceof Error ? err.message : String(err) },
            'OperatorEndpointRegistrationService: capability propagation failed',
          );
        }
      }
    }
    return true;
  }
}
