// Phase 5.13 — Stage 5b body heuristics : tests purs.
import { describe, it, expect } from 'vitest';
import { evaluateBodyQuality } from '../utils/bodyQualityHeuristics';

describe('evaluateBodyQuality', () => {
  it('passes a structured JSON body with content', () => {
    const result = evaluateBodyQuality({
      body: '{"price":42500,"currency":"USD","timestamp":1700000000}',
      contentType: 'application/json',
      status: 200,
    });
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
  });

  it('fails on empty body', () => {
    const result = evaluateBodyQuality({
      body: '',
      contentType: 'application/json',
      status: 200,
    });
    expect(result.passed).toBe(false);
    expect(result.checks.non_empty).toBe(false);
  });

  it('fails on trivial body "{}"', () => {
    const result = evaluateBodyQuality({
      body: '{}',
      contentType: 'application/json',
      status: 200,
    });
    expect(result.passed).toBe(false);
    expect(result.checks.non_trivial).toBe(false);
  });

  it('fails on JSON with empty object structure', () => {
    const result = evaluateBodyQuality({
      body: '{"data": null, "meta": {}}',
      contentType: 'application/json',
      status: 200,
    });
    expect(result.checks.structured_when_json).toBe(false);
  });

  it('fails on body containing common error patterns', () => {
    const result = evaluateBodyQuality({
      body: '{"error":"Rate limit exceeded","retry_after":60}',
      contentType: 'application/json',
      status: 200,
    });
    expect(result.checks.no_error_pattern).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('fails on placeholder content', () => {
    const result = evaluateBodyQuality({
      body: 'Lorem ipsum dolor sit amet. Coming soon.',
      contentType: 'text/plain',
      status: 200,
    });
    expect(result.checks.no_placeholder).toBe(false);
  });

  it('passes plain text response when not JSON content-type', () => {
    const result = evaluateBodyQuality({
      body: 'BTC: $42,500\nETH: $2,800\nLast updated: 2026-04-28T12:34:56Z',
      contentType: 'text/plain',
      status: 200,
    });
    expect(result.passed).toBe(true);
  });

  it('returns score=0 and passed=false on non-2xx status', () => {
    const result = evaluateBodyQuality({
      body: 'whatever',
      contentType: 'application/json',
      status: 500,
    });
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
  });

  it('passes a JSON array with content', () => {
    const result = evaluateBodyQuality({
      body: '[{"id":1,"name":"a"},{"id":2,"name":"b"}]',
      contentType: 'application/json',
      status: 200,
    });
    expect(result.passed).toBe(true);
    expect(result.checks.structured_when_json).toBe(true);
  });

  it('fails on JSON with unparseable body', () => {
    const result = evaluateBodyQuality({
      body: '{not valid json at all',
      contentType: 'application/json',
      status: 200,
    });
    expect(result.checks.structured_when_json).toBe(false);
  });
});
