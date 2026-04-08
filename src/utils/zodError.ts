// Format a Zod validation failure into a user-facing message that names the
// offending field, the expected format, and a brief description of what was
// actually received. Used at every controller-level safeParse site so API
// clients get actionable errors instead of a generic "Invalid request".
import { z } from 'zod';

export interface FormatZodErrorOptions {
  /** Name used when the failing input is a scalar (e.g. a single req.params
   *  value), because Zod reports an empty path in that case. */
  fallbackField?: string;
}

/** Produces messages like:
 *    "caller must be a 64-char SHA256 hash or 66-char Lightning pubkey (02/03 prefix), got 11 chars"
 *    "amountSats must be >= 1, got 0"
 *    "target is required (expected string)"
 *    "outcome must be one of: \"success\", \"failure\", \"timeout\", got \"ok\""
 *
 *  Only the first issue is surfaced — the API returns 400 on the first
 *  violation, the client fixes it, and resubmits. Showing every issue at once
 *  leads to wall-of-text responses that most clients ignore anyway.
 */
export function formatZodError(
  error: z.ZodError,
  input: unknown,
  opts: FormatZodErrorOptions = {},
): string {
  const issue = error.errors[0];
  if (!issue) return 'Invalid request';

  const field = issue.path.length > 0 ? issue.path.join('.') : (opts.fallbackField ?? 'input');
  const value = getByPath(input, issue.path);

  switch (issue.code) {
    case z.ZodIssueCode.invalid_type: {
      if (issue.received === 'undefined') {
        return `${field} is required (expected ${issue.expected})`;
      }
      return `${field} must be a ${issue.expected}, ${describeGot(value)}`;
    }

    case z.ZodIssueCode.invalid_string: {
      if (issue.validation === 'regex') {
        // Schema messages typically start with "Expected " — rephrase to "must be ..."
        // so the final sentence reads naturally.
        const hint = reshapeExpectedHint(issue.message);
        return `${field} must be ${hint}, ${describeGot(value)}`;
      }
      if (issue.validation === 'uuid') {
        return `${field} must be a UUID, ${describeGot(value)}`;
      }
      if (issue.validation === 'email') {
        return `${field} must be a valid email, ${describeGot(value)}`;
      }
      return `${field}: ${issue.message} (${describeGot(value)})`;
    }

    case z.ZodIssueCode.invalid_enum_value: {
      const valid = issue.options.map(o => JSON.stringify(o)).join(', ');
      return `${field} must be one of: ${valid}, got ${JSON.stringify(issue.received)}`;
    }

    case z.ZodIssueCode.too_small: {
      if (issue.type === 'string') {
        return `${field} must be at least ${issue.minimum} characters, ${describeGot(value)}`;
      }
      if (issue.type === 'number') {
        const bound = issue.inclusive ? '>=' : '>';
        return `${field} must be ${bound} ${issue.minimum}, got ${value}`;
      }
      if (issue.type === 'array') {
        const got = Array.isArray(value) ? value.length : 0;
        return `${field} must contain at least ${issue.minimum} items, got ${got}`;
      }
      return `${field}: ${issue.message}`;
    }

    case z.ZodIssueCode.too_big: {
      if (issue.type === 'string') {
        return `${field} must be at most ${issue.maximum} characters, ${describeGot(value)}`;
      }
      if (issue.type === 'number') {
        const bound = issue.inclusive ? '<=' : '<';
        return `${field} must be ${bound} ${issue.maximum}, got ${value}`;
      }
      if (issue.type === 'array') {
        const got = Array.isArray(value) ? value.length : 0;
        return `${field} must contain at most ${issue.maximum} items, got ${got}`;
      }
      return `${field}: ${issue.message}`;
    }

    case z.ZodIssueCode.custom: {
      return `${field}: ${issue.message}`;
    }

    default: {
      // Fall back to the raw message, prefixed with the field path for context
      return `${field}: ${issue.message}`;
    }
  }
}

/** Describes a value briefly for inclusion in an error message. */
function describeGot(value: unknown): string {
  if (value === undefined) return 'got undefined';
  if (value === null) return 'got null';
  if (typeof value === 'string') {
    if (value.length === 0) return 'got empty string';
    return `got ${value.length} chars`;
  }
  if (Array.isArray(value)) return `got array of ${value.length} items`;
  if (typeof value === 'object') return 'got object';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `got ${String(value)}`;
  }
  return `got ${typeof value}`;
}

/** "Expected 64-char SHA256 hash..." → "a 64-char SHA256 hash..."
 *  Keeps the rest of the schema-provided message verbatim. */
function reshapeExpectedHint(msg: string): string {
  const trimmed = msg.trim();
  if (trimmed.startsWith('Expected ')) return 'a ' + trimmed.slice('Expected '.length);
  return trimmed;
}

/** Walks the Zod path to retrieve the actual received value from the raw input.
 *  Returns undefined if the path doesn't resolve (e.g. when the input is a
 *  scalar and the path is empty, the caller passes the scalar as `input`). */
function getByPath(obj: unknown, path: (string | number)[]): unknown {
  if (path.length === 0) return obj;
  let cur: unknown = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[key as string | number];
  }
  return cur;
}
