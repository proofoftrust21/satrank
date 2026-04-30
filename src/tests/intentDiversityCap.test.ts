// Audit Tier 4M (2026-04-30) — pure-function test of the diversity cap
// applied to /api/intent results. No DB needed; the helper takes already-
// enriched candidates and returns a re-ordered subset.
import { describe, it, expect } from 'vitest';
import { applyDiversityCap } from '../services/intentService';
import type { ServiceEndpoint } from '../repositories/serviceEndpointRepository';

// Lightweight fixture builder. Only the fields applyDiversityCap reads
// (svc.url and operatorPubkey) are populated; the rest is loose-typed.
function fixture(rank: number, url: string, operatorPubkey: string | null): { svc: ServiceEndpoint; operatorPubkey: string | null } {
  return {
    svc: { url } as ServiceEndpoint,
    operatorPubkey,
  };
}

// Cast to the helper's input shape — applyDiversityCap is exported but
// EnrichedCandidate is not, so we pass a structurally-compatible object.
function cap<T extends { svc: ServiceEndpoint; operatorPubkey: string | null }>(items: T[], limit: number): T[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return applyDiversityCap(items as any, limit) as T[];
}

const OP_A = '02' + 'a'.repeat(64);
const OP_B = '02' + 'b'.repeat(64);
const OP_C = '02' + 'c'.repeat(64);

describe('applyDiversityCap (Tier 4M)', () => {
  it('caps at 2 endpoints per operator when pool is dominated', () => {
    // 5 candidates all from OP_A on the same host
    const sorted = [
      fixture(1, 'https://acme.test/a', OP_A),
      fixture(2, 'https://acme.test/b', OP_A),
      fixture(3, 'https://acme.test/c', OP_A),
      fixture(4, 'https://acme.test/d', OP_A),
      fixture(5, 'https://acme.test/e', OP_A),
    ];
    const out = cap(sorted, 5);
    // limit=5 means we still return 5 (best-effort cap), but rank 1-2 are
    // diversity-allowed and the rest fall back to overflow ordering.
    expect(out.length).toBe(5);
    expect(out[0].svc.url).toBe('https://acme.test/a');
    expect(out[1].svc.url).toBe('https://acme.test/b');
    // 3-5 came from overflow because cap was exhausted on the cap-pass,
    // but they still appear since otherwise we'd return < limit.
  });

  it('respects host cap independently of operator cap', () => {
    // 4 candidates on the same host but DIFFERENT operators
    const sorted = [
      fixture(1, 'https://shared.test/x', OP_A),
      fixture(2, 'https://shared.test/y', OP_B),
      fixture(3, 'https://shared.test/z', OP_C),
      fixture(4, 'https://other.test/w', OP_A),
    ];
    const out = cap(sorted, 4);
    expect(out.length).toBe(4);
    // First two are admitted; third is host-capped → overflow
    expect(out[0].svc.url).toBe('https://shared.test/x');
    expect(out[1].svc.url).toBe('https://shared.test/y');
    // The other.test/w slot fills before the overflow because it's diverse
    expect(out[2].svc.url).toBe('https://other.test/w');
    expect(out[3].svc.url).toBe('https://shared.test/z');
  });

  it('null operatorPubkey does not count toward the operator cap', () => {
    // 5 candidates from "unknown operator" on different hosts
    const sorted = [
      fixture(1, 'https://h1.test/', null),
      fixture(2, 'https://h2.test/', null),
      fixture(3, 'https://h3.test/', null),
      fixture(4, 'https://h4.test/', null),
      fixture(5, 'https://h5.test/', null),
    ];
    const out = cap(sorted, 5);
    expect(out.length).toBe(5);
    expect(out.map(c => c.svc.url)).toEqual([
      'https://h1.test/', 'https://h2.test/', 'https://h3.test/',
      'https://h4.test/', 'https://h5.test/',
    ]);
  });

  it('mixed pool: 1 dominant operator + 1 niche operator → niche surfaces in top', () => {
    // 4 from OP_A + 1 from OP_B at rank 5 — without cap, OP_B never appears
    // in top-3.
    const sorted = [
      fixture(1, 'https://acme.test/1', OP_A),
      fixture(2, 'https://acme.test/2', OP_A),
      fixture(3, 'https://acme.test/3', OP_A),
      fixture(4, 'https://acme.test/4', OP_A),
      fixture(5, 'https://niche.test/n', OP_B),
    ];
    const out = cap(sorted, 3);
    expect(out.length).toBe(3);
    // Top-3: 2 OP_A + the niche OP_B (admitted thanks to operator cap)
    const operators = out.map(c => c.operatorPubkey);
    expect(operators.filter(o => o === OP_A).length).toBe(2);
    expect(operators.filter(o => o === OP_B).length).toBe(1);
  });

  it('returns empty array for empty input or non-positive limit', () => {
    expect(cap([], 5)).toEqual([]);
    expect(cap([fixture(1, 'https://a.test/', null)], 0)).toEqual([]);
    expect(cap([fixture(1, 'https://a.test/', null)], -1)).toEqual([]);
  });
});
