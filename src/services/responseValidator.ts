// Phase 3 (2026-05-01) — pluggable response validators.
//
// The Phase 1 fulfill orchestrator only used bodyQualityHeuristics — useful
// against garbage 2xx but blind to "right shape, wrong content" failures.
// Phase 3 adds pluggable validators chained together: a fulfill candidate's
// recall-stage 2xx response is fed through every validator in order, and
// the first failure marks the attempt as delivery_schema_violation
// (Tier 2 refund, disputable per Phase 2).
//
// Built-in validators:
//   - jsonSchemaValidator(schema) — JSON Schema draft-07 via ajv. The
//     orchestrator instantiates this when fulfill request carries
//     expected_schema_hash AND we have the schema in endpoint_schemas.
//   - minBytesValidator(min) — body length floor.
//   - contentTypeValidator(allowed[]) — Content-Type header match.
//
// Composition: AllOf returns the first failure; Any/Or-style is reserved
// for Phase 4 if real-world need surfaces (today every validator is
// strict-AND).
import Ajv from 'ajv';
import type { ErrorObject } from 'ajv';

export interface ValidationResult {
  passed: boolean;
  /** Short reason code — surfaced in attempts[].detail and refund ledger
   *  heuristic_reasons. Stable across versions for log grep. */
  reason?: string;
  /** Optional structured details for the dispute queue / agent reading. */
  details?: Record<string, unknown>;
}

export interface ValidatorContext {
  body: string;
  contentType: string | null;
  status: number;
}

export interface ResponseValidator {
  name: string;
  validate(ctx: ValidatorContext): ValidationResult;
}

/** Run every validator in order; return the first failure or a success. */
export function validateAll(
  validators: ResponseValidator[],
  ctx: ValidatorContext,
): ValidationResult {
  for (const v of validators) {
    const result = v.validate(ctx);
    if (!result.passed) {
      return {
        passed: false,
        reason: result.reason ?? `${v.name}_failed`,
        details: { ...(result.details ?? {}), validator: v.name },
      };
    }
  }
  return { passed: true };
}

/** Validator: body length >= min bytes. */
export function minBytesValidator(minBytes: number): ResponseValidator {
  return {
    name: 'min_bytes',
    validate(ctx): ValidationResult {
      const len = Buffer.byteLength(ctx.body, 'utf8');
      if (len >= minBytes) return { passed: true };
      return {
        passed: false,
        reason: 'body_too_small',
        details: { observed: len, min: minBytes },
      };
    },
  };
}

/** Validator: response Content-Type matches one of the allowed types
 *  (case-insensitive, charset-tolerant). Matches:
 *    - exact: allowed=application/json, actual=application/json
 *    - structured suffix per RFC 6838: allowed=application/json,
 *      actual=application/vnd.example+json (the +json suffix qualifies it
 *      as JSON-flavored)
 *  null/missing content-type fails. */
export function contentTypeValidator(allowedTypes: string[]): ResponseValidator {
  const normalized = allowedTypes.map(s => s.toLowerCase().split(';')[0].trim());
  return {
    name: 'content_type',
    validate(ctx): ValidationResult {
      const actual = (ctx.contentType ?? '').toLowerCase().split(';')[0].trim();
      if (!actual) {
        return {
          passed: false,
          reason: 'content_type_missing',
          details: { allowed: normalized },
        };
      }
      const ok = normalized.some(p => {
        if (actual === p) return true;
        // Structured suffix: actual must share the subtype after `+` with the
        // allowed type's subtype. allowed=application/json → suffix `+json`.
        const slashIdx = p.lastIndexOf('/');
        if (slashIdx < 0) return false;
        const subtype = p.slice(slashIdx + 1);
        return actual.endsWith(`+${subtype}`);
      });
      if (!ok) {
        return {
          passed: false,
          reason: 'content_type_mismatch',
          details: { observed: actual, allowed: normalized },
        };
      }
      return { passed: true };
    },
  };
}

/** Validator: parse body as JSON, validate against the schema. Compiled
 *  ajv validator is captured in closure so the same schema instance can
 *  be reused across many calls cheaply. Compilation errors at construction
 *  time throw — caller must catch when building the validator. */
export function jsonSchemaValidator(schema: object): ResponseValidator {
  const ajv = new Ajv({ allErrors: false, strict: false });
  const compiled = ajv.compile(schema);
  return {
    name: 'json_schema',
    validate(ctx): ValidationResult {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ctx.body);
      } catch (err) {
        return {
          passed: false,
          reason: 'json_parse_failed',
          details: { error: err instanceof Error ? err.message : String(err) },
        };
      }
      const ok = compiled(parsed);
      if (ok) return { passed: true };
      const firstError = (compiled.errors ?? [])[0] as ErrorObject | undefined;
      return {
        passed: false,
        reason: 'json_schema_violation',
        details: firstError
          ? {
              path: firstError.instancePath,
              keyword: firstError.keyword,
              message: firstError.message,
            }
          : { message: 'unknown' },
      };
    },
  };
}

/** Convenience: build a validator chain from a config blob. The schema
 *  is optional (omitted when no expected_schema_hash provided in the
 *  fulfill request). minBytes / contentType are always layered when
 *  configured — they're cheap and catch the obvious broken cases. */
export interface BuildValidatorChainInput {
  schema?: object;
  minBytes?: number;
  contentTypes?: string[];
  /** Phase 7.4 — agent-supplied validator DSL strings. Format examples:
   *    'min_bytes:500', 'content_type:application/json',
   *    'has_field:text', 'has_field:data.results',
   *    'contains:meme'. Unrecognised entries are skipped silently. */
  validators?: string[];
}

/** Phase 7.4 — validator returning failure if the JSON body lacks a given
 *  field (dot-notation path). For non-JSON bodies, fails. */
export function hasFieldValidator(fieldPath: string): ResponseValidator {
  return {
    name: `has_field:${fieldPath}`,
    validate: ({ body }) => {
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch {
        return { passed: false, reason: `body is not JSON; cannot check field '${fieldPath}'` };
      }
      const parts = fieldPath.split('.');
      let cursor: unknown = parsed;
      for (const p of parts) {
        if (cursor && typeof cursor === 'object' && p in (cursor as Record<string, unknown>)) {
          cursor = (cursor as Record<string, unknown>)[p];
        } else {
          return { passed: false, reason: `body missing field '${fieldPath}' (failed at '${p}')` };
        }
      }
      return { passed: true };
    },
  };
}

/** Phase 7.4 — validator that fails if the body does not contain a substring. */
export function containsValidator(needle: string): ResponseValidator {
  return {
    name: `contains:${needle}`,
    validate: ({ body }) => body.includes(needle)
      ? { passed: true }
      : { passed: false, reason: `body does not contain '${needle}'` },
  };
}

/** Parse the agent-supplied validator DSL into ResponseValidators. */
export function parseValidatorDsl(entries: string[]): ResponseValidator[] {
  const out: ResponseValidator[] = [];
  for (const entry of entries) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1) continue;
    const op = entry.slice(0, colonIdx).trim().toLowerCase();
    const arg = entry.slice(colonIdx + 1).trim();
    if (!arg) continue;
    if (op === 'min_bytes') {
      const n = Number.parseInt(arg, 10);
      if (Number.isFinite(n) && n > 0) out.push(minBytesValidator(n));
    } else if (op === 'content_type') {
      out.push(contentTypeValidator([arg]));
    } else if (op === 'has_field') {
      out.push(hasFieldValidator(arg));
    } else if (op === 'contains') {
      out.push(containsValidator(arg));
    }
    // Unknown ops silently skipped — agent gets no validation but no error
    // (so an SDK hint typo doesn't break the fulfill).
  }
  return out;
}

export function buildValidatorChain(input: BuildValidatorChainInput): ResponseValidator[] {
  const chain: ResponseValidator[] = [];
  if (input.minBytes !== undefined && input.minBytes > 0) {
    chain.push(minBytesValidator(input.minBytes));
  }
  if (input.contentTypes && input.contentTypes.length > 0) {
    chain.push(contentTypeValidator(input.contentTypes));
  }
  if (input.schema) {
    chain.push(jsonSchemaValidator(input.schema));
  }
  if (input.validators && input.validators.length > 0) {
    chain.push(...parseValidatorDsl(input.validators));
  }
  return chain;
}
