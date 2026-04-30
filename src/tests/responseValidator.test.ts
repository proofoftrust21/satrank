// Phase 3 (2026-05-01) — ResponseValidator framework tests.
//
// Pure unit tests — no DB, no network. Cover the 3 built-in validators
// (minBytes, contentType, jsonSchema), composition via validateAll, and
// failure surface (reason + details).
import { describe, it, expect } from 'vitest';
import {
  buildValidatorChain,
  contentTypeValidator,
  jsonSchemaValidator,
  minBytesValidator,
  validateAll,
} from '../services/responseValidator';

describe('minBytesValidator', () => {
  it('passes when body length >= min', () => {
    const v = minBytesValidator(5);
    expect(v.validate({ body: 'hello world', contentType: null, status: 200 }).passed).toBe(true);
  });
  it('fails when body length < min, with observed/min details', () => {
    const v = minBytesValidator(50);
    const r = v.validate({ body: 'tiny', contentType: null, status: 200 });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('body_too_small');
    expect(r.details).toMatchObject({ observed: 4, min: 50 });
  });
});

describe('contentTypeValidator', () => {
  it('matches exact type', () => {
    const v = contentTypeValidator(['application/json']);
    expect(v.validate({ body: '{}', contentType: 'application/json', status: 200 }).passed).toBe(true);
  });
  it('matches with charset suffix', () => {
    const v = contentTypeValidator(['application/json']);
    expect(v.validate({ body: '{}', contentType: 'application/json; charset=utf-8', status: 200 }).passed).toBe(true);
  });
  it('matches structured suffix (application/something+json)', () => {
    const v = contentTypeValidator(['application/json']);
    expect(v.validate({ body: '{}', contentType: 'application/vnd.api+json', status: 200 }).passed).toBe(true);
  });
  it('fails on missing content-type', () => {
    const v = contentTypeValidator(['application/json']);
    const r = v.validate({ body: '{}', contentType: null, status: 200 });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('content_type_missing');
  });
  it('fails on mismatched type', () => {
    const v = contentTypeValidator(['application/json']);
    const r = v.validate({ body: '<xml/>', contentType: 'text/xml', status: 200 });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('content_type_mismatch');
    expect(r.details).toMatchObject({ observed: 'text/xml', allowed: ['application/json'] });
  });
});

describe('jsonSchemaValidator', () => {
  const schema = {
    type: 'object',
    required: ['price', 'currency'],
    properties: {
      price: { type: 'number' },
      currency: { type: 'string', enum: ['USD', 'EUR', 'BTC'] },
    },
    additionalProperties: false,
  };

  it('passes a conforming JSON body', () => {
    const v = jsonSchemaValidator(schema);
    const r = v.validate({
      body: JSON.stringify({ price: 1234.56, currency: 'USD' }),
      contentType: 'application/json',
      status: 200,
    });
    expect(r.passed).toBe(true);
  });

  it('fails missing required field with structured details', () => {
    const v = jsonSchemaValidator(schema);
    const r = v.validate({
      body: JSON.stringify({ price: 1234.56 }),
      contentType: 'application/json',
      status: 200,
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('json_schema_violation');
    expect(r.details?.keyword).toBe('required');
  });

  it('fails wrong enum value', () => {
    const v = jsonSchemaValidator(schema);
    const r = v.validate({
      body: JSON.stringify({ price: 1, currency: 'XRP' }),
      contentType: 'application/json',
      status: 200,
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('json_schema_violation');
  });

  it('fails on JSON parse error with structured detail', () => {
    const v = jsonSchemaValidator(schema);
    const r = v.validate({ body: 'not json', contentType: 'application/json', status: 200 });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('json_parse_failed');
  });

  it('throws at construction on a bad schema', () => {
    expect(() => jsonSchemaValidator({ type: 'not-a-real-type' } as object)).toThrow();
  });
});

describe('validateAll composition', () => {
  it('returns first failure with validator name appended', () => {
    const chain = [
      minBytesValidator(2),
      contentTypeValidator(['application/json']),
    ];
    const r = validateAll(chain, { body: '{}', contentType: 'text/xml', status: 200 });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('content_type_mismatch');
    expect(r.details?.validator).toBe('content_type');
  });

  it('returns success when every validator passes', () => {
    const chain = [
      minBytesValidator(1),
      contentTypeValidator(['application/json']),
    ];
    const r = validateAll(chain, { body: '{}', contentType: 'application/json', status: 200 });
    expect(r.passed).toBe(true);
  });
});

describe('buildValidatorChain', () => {
  it('omits sections when not configured', () => {
    expect(buildValidatorChain({}).length).toBe(0);
  });

  it('layers minBytes + contentType + schema in order', () => {
    const chain = buildValidatorChain({
      minBytes: 10,
      contentTypes: ['application/json'],
      schema: { type: 'object' },
    });
    expect(chain.length).toBe(3);
    expect(chain[0].name).toBe('min_bytes');
    expect(chain[1].name).toBe('content_type');
    expect(chain[2].name).toBe('json_schema');
  });
});
