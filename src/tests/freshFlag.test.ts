// Pricing Mix A+D — unit tests for the `?fresh=true` flag detector.
// Conservative semantics: only the literal string "true" or boolean true
// counts. "1", "yes", anything else → false. Both the query string and the
// JSON body shapes are accepted.

import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { isFreshRequest } from '../utils/freshFlag';

function makeReq(opts: { query?: Record<string, unknown>; body?: unknown } = {}): Request {
  return {
    query: opts.query ?? {},
    body: opts.body ?? {},
  } as unknown as Request;
}

describe('isFreshRequest', () => {
  it('returns false on bare request (no query, empty body)', () => {
    expect(isFreshRequest(makeReq())).toBe(false);
  });

  it('returns true when query.fresh is the literal string "true"', () => {
    expect(isFreshRequest(makeReq({ query: { fresh: 'true' } }))).toBe(true);
  });

  it('returns true when body.fresh is the boolean true', () => {
    expect(isFreshRequest(makeReq({ body: { fresh: true } }))).toBe(true);
  });

  it('returns false when query.fresh is "1" — strings other than "true" do not count', () => {
    expect(isFreshRequest(makeReq({ query: { fresh: '1' } }))).toBe(false);
  });

  it('returns false when query.fresh is "yes"', () => {
    expect(isFreshRequest(makeReq({ query: { fresh: 'yes' } }))).toBe(false);
  });

  it('returns false when body.fresh is the string "true" (must be boolean in body)', () => {
    expect(isFreshRequest(makeReq({ body: { fresh: 'true' } }))).toBe(false);
  });

  it('returns false when body.fresh is 1 (number, not boolean)', () => {
    expect(isFreshRequest(makeReq({ body: { fresh: 1 } }))).toBe(false);
  });

  it('returns false when body is null', () => {
    expect(isFreshRequest(makeReq({ body: null }))).toBe(false);
  });

  it('returns false when body is a string (not an object)', () => {
    expect(isFreshRequest(makeReq({ body: 'fresh' }))).toBe(false);
  });

  it('honours query when both query and body present', () => {
    expect(
      isFreshRequest(makeReq({ query: { fresh: 'true' }, body: { fresh: false } })),
    ).toBe(true);
  });
});
