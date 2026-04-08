// Unit tests for the zodError formatter — ensures validation messages surface
// the field name, expected format, and received value.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { formatZodError } from '../utils/zodError';
import { decideSchema, agentIdentifierSchema, reportSchema, batchVerdictsSchema, topQuerySchema } from '../middleware/validation';

function runAndFormat<T>(schema: z.ZodType<T>, input: unknown, opts?: { fallbackField?: string }): string {
  const result = schema.safeParse(input);
  if (result.success) throw new Error('expected parse to fail');
  return formatZodError(result.error, input, opts);
}

describe('formatZodError — decide schema', () => {
  it('identifies an 11-char caller as the offending field (Romain’s example)', () => {
    const msg = runAndFormat(decideSchema, {
      target: '02' + 'a'.repeat(64), // valid
      caller: 'shortstring',          // 11 chars, invalid
    });
    expect(msg).toContain('caller');
    expect(msg).toContain('64-char SHA256 hash');
    expect(msg).toContain('66-char Lightning pubkey');
    expect(msg).toContain('got 11 chars');
  });

  it('identifies a missing caller field as required', () => {
    const msg = runAndFormat(decideSchema, {
      target: '02' + 'a'.repeat(64),
    });
    expect(msg).toBe('caller is required (expected string)');
  });

  it('identifies a missing target field as required', () => {
    const msg = runAndFormat(decideSchema, {
      caller: '02' + 'a'.repeat(64),
    });
    expect(msg).toBe('target is required (expected string)');
  });

  it('reports the first invalid field when multiple are invalid', () => {
    const msg = runAndFormat(decideSchema, {
      target: 'too-short',
      caller: 'also-short',
    });
    // Zod reports in declaration order — target is declared first
    expect(msg).toContain('target');
    expect(msg).toContain('got 9 chars');
  });

  it('reports an empty-string caller specifically', () => {
    const msg = runAndFormat(decideSchema, {
      target: '02' + 'b'.repeat(64),
      caller: '',
    });
    expect(msg).toContain('caller');
    expect(msg).toContain('got empty string');
  });

  it('reports a non-string caller', () => {
    const msg = runAndFormat(decideSchema, {
      target: '02' + 'b'.repeat(64),
      caller: 12345,
    });
    expect(msg).toContain('caller');
    expect(msg).toContain('must be a string');
  });

  it('reports amountSats range violations', () => {
    const msg = runAndFormat(decideSchema, {
      target: '02' + 'a'.repeat(64),
      caller: '03' + 'b'.repeat(64),
      amountSats: 0,
    });
    expect(msg).toContain('amountSats');
    expect(msg).toContain('> 0');
    expect(msg).toContain('got 0');
  });
});

describe('formatZodError — report schema', () => {
  it('rejects an invalid outcome with the list of valid values', () => {
    const msg = runAndFormat(reportSchema, {
      target: '02' + 'a'.repeat(64),
      reporter: '03' + 'b'.repeat(64),
      outcome: 'ok',
    });
    expect(msg).toContain('outcome');
    expect(msg).toContain('"success"');
    expect(msg).toContain('"failure"');
    expect(msg).toContain('"timeout"');
    expect(msg).toContain('got "ok"');
  });

  it('reports an invalid paymentHash format', () => {
    const msg = runAndFormat(reportSchema, {
      target: '02' + 'a'.repeat(64),
      reporter: '03' + 'b'.repeat(64),
      outcome: 'success',
      paymentHash: 'not-a-hex-hash',
    });
    expect(msg).toContain('paymentHash');
    expect(msg).toContain('got 14 chars');
  });

  it('reports the custom preimage-requires-paymentHash refinement', () => {
    const msg = runAndFormat(reportSchema, {
      target: '02' + 'a'.repeat(64),
      reporter: '03' + 'b'.repeat(64),
      outcome: 'success',
      preimage: 'a'.repeat(64),
    });
    expect(msg).toContain('preimage');
    expect(msg).toContain('requires paymentHash');
  });
});

describe('formatZodError — scalar inputs (params)', () => {
  it('uses the fallback field when the path is empty', () => {
    const msg = runAndFormat(agentIdentifierSchema, 'short', { fallbackField: 'publicKeyHash' });
    expect(msg).toContain('publicKeyHash');
    expect(msg).toContain('got 5 chars');
  });

  it('defaults to "input" when no fallback field is provided', () => {
    const msg = runAndFormat(agentIdentifierSchema, 'short');
    expect(msg).toContain('input');
    expect(msg).toContain('got 5 chars');
  });

  it('reports the 66-char requirement for pubkey-shaped values without the 02/03 prefix', () => {
    const msg = runAndFormat(agentIdentifierSchema, '99' + 'a'.repeat(64), { fallbackField: 'target' });
    expect(msg).toContain('target');
    expect(msg).toContain('64-char SHA256 hash');
    expect(msg).toContain('got 66 chars');
  });
});

describe('formatZodError — array and query schemas', () => {
  it('reports an empty hashes array in batchVerdicts', () => {
    const msg = runAndFormat(batchVerdictsSchema, { hashes: [] });
    expect(msg).toContain('hashes');
    expect(msg).toContain('at least 1');
    expect(msg).toContain('got 0');
  });

  it('reports an oversized hashes array', () => {
    const hashes = new Array(101).fill('02' + 'a'.repeat(64));
    const msg = runAndFormat(batchVerdictsSchema, { hashes });
    expect(msg).toContain('hashes');
    expect(msg).toContain('at most 100');
    expect(msg).toContain('got 101');
  });

  it('reports a single invalid hash inside the array with its index in the path', () => {
    const msg = runAndFormat(batchVerdictsSchema, {
      hashes: ['02' + 'a'.repeat(64), 'invalid'],
    });
    expect(msg).toContain('hashes.1');
    expect(msg).toContain('got 7 chars');
  });

  it('reports a topQuery sort_by enum mismatch', () => {
    const msg = runAndFormat(topQuerySchema, { sort_by: 'popularity' });
    expect(msg).toContain('sort_by');
    expect(msg).toContain('"score"');
    expect(msg).toContain('"reputation"');
    expect(msg).toContain('got "popularity"');
  });

  it('reports a topQuery limit out of range', () => {
    const msg = runAndFormat(topQuerySchema, { limit: 500 });
    expect(msg).toContain('limit');
    expect(msg).toContain('<= 100');
    expect(msg).toContain('got 500');
  });
});

describe('formatZodError — edge cases', () => {
  it('handles a null value at the path', () => {
    const schema = z.object({ caller: z.string() });
    const msg = runAndFormat(schema, { caller: null });
    expect(msg).toContain('caller');
    // Zod reports this as invalid_type received=null
    expect(msg).toMatch(/got null|must be a string/);
  });

  it('handles nested paths', () => {
    const schema = z.object({
      payload: z.object({
        inner: z.string().min(5),
      }),
    });
    const msg = runAndFormat(schema, { payload: { inner: 'ab' } });
    expect(msg).toContain('payload.inner');
    expect(msg).toContain('at least 5 characters');
    expect(msg).toContain('got 2 chars');
  });

  it('gracefully handles a ZodError with zero issues', () => {
    const error = new z.ZodError([]);
    expect(formatZodError(error, {})).toBe('Invalid request');
  });
});
