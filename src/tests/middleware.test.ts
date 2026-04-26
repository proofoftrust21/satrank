// Middleware tests — timeout, error handler, auth
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Minimal mock helpers
function mockReq(overrides: Partial<Request> = {}): Request {
  return { requestId: 'test-req-id', headers: {}, ...overrides } as unknown as Request;
}

function mockRes(): Response & { _status: number; _body: unknown; headersSent: boolean } {
  const res = {
    _status: 0,
    _body: null as unknown,
    headersSent: false,
    _listeners: {} as Record<string, () => void>,
    status(code: number) { res._status = code; return res; },
    json(body: unknown) { res._body = body; res.headersSent = true; return res; },
    on(event: string, fn: () => void) { res._listeners[event] = fn; return res; },
    emit(event: string) { if (res._listeners[event]) res._listeners[event](); },
  };
  return res as unknown as Response & { _status: number; _body: unknown; headersSent: boolean };
}

describe('requestTimeout middleware', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('calls next immediately and does not fire before timeout', async () => {
    const { requestTimeout } = await import('../middleware/timeout');
    const next = vi.fn();
    const res = mockRes();
    const middleware = requestTimeout(30_000);

    middleware(mockReq(), res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
    // Advance 29s — should NOT have fired
    vi.advanceTimersByTime(29_000);
    expect(res._status).toBe(0);

    // Simulate response completing before timeout
    res.emit('close');

    // Advance past timeout — should NOT fire because response already closed
    vi.advanceTimersByTime(2_000);
    expect(res._status).toBe(0);

    vi.useRealTimers();
  });

  it('returns 504 when request exceeds timeout', async () => {
    const { requestTimeout } = await import('../middleware/timeout');
    const next = vi.fn();
    const res = mockRes();
    const middleware = requestTimeout(100);

    middleware(mockReq(), res as unknown as Response, next);

    vi.advanceTimersByTime(101);

    expect(res._status).toBe(504);
    expect(res._body).toEqual({
      error: { code: 'GATEWAY_TIMEOUT', message: 'Request timed out' },
      requestId: 'test-req-id',
    });

    vi.useRealTimers();
  });

  it('does not fire 504 if headers already sent', async () => {
    const { requestTimeout } = await import('../middleware/timeout');
    const next = vi.fn();
    const res = mockRes();
    res.headersSent = true;
    const middleware = requestTimeout(100);

    middleware(mockReq(), res as unknown as Response, next);

    vi.advanceTimersByTime(101);

    // Should not have changed status since headers were already sent
    expect(res._status).toBe(0);

    vi.useRealTimers();
  });
});

describe('errorHandler', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns generic fallback for unknown AppError code in production', async () => {
    vi.doMock('../config', () => ({
      config: { NODE_ENV: 'production' },
    }));
    vi.doMock('../logger', () => ({
      logger: { error: vi.fn() },
    }));

    // Simulate an AppError with an unmapped code
    const { errorHandler } = await import('../middleware/errorHandler');
    const { AppError } = await import('../errors');
    const res = mockRes();

    errorHandler(
      new AppError('Sensitive internal detail', 500, 'UNKNOWN_CODE'),
      mockReq(),
      res as unknown as Response,
      vi.fn() as unknown as NextFunction,
    );

    expect(res._status).toBe(500);
    const body = res._body as { error: { code: string; message: string } };
    // Must NOT expose the real message — should fall back to generic
    expect(body.error.message).toBe('An error occurred');
    expect(body.error.message).not.toContain('Sensitive');
  });

  it('returns generic message for non-AppError in production', async () => {
    vi.doMock('../config', () => ({
      config: { NODE_ENV: 'production' },
    }));
    vi.doMock('../logger', () => ({
      logger: { error: vi.fn() },
    }));

    const { errorHandler } = await import('../middleware/errorHandler');
    const res = mockRes();

    errorHandler(
      new TypeError('Cannot read property x of undefined'),
      mockReq(),
      res as unknown as Response,
      vi.fn() as unknown as NextFunction,
    );

    expect(res._status).toBe(500);
    const body = res._body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('Internal server error');
    expect(body.error.message).not.toContain('Cannot read property');
  });

  it('returns real message for non-AppError in development', async () => {
    vi.doMock('../config', () => ({
      config: { NODE_ENV: 'development' },
    }));
    vi.doMock('../logger', () => ({
      logger: { error: vi.fn() },
    }));

    const { errorHandler } = await import('../middleware/errorHandler');
    const res = mockRes();

    errorHandler(
      new Error('Detailed dev error info'),
      mockReq(),
      res as unknown as Response,
      vi.fn() as unknown as NextFunction,
    );

    expect(res._status).toBe(500);
    const body = res._body as { error: { code: string; message: string } };
    expect(body.error.message).toBe('Detailed dev error info');
  });

  it('propagates the real VALIDATION_ERROR message in production', async () => {
    // VALIDATION_ERROR is on the pass-through allow-list: messages come from
    // formatZodError and are explicitly written for the client, so the
    // generic "Invalid request" must NOT mask them in production.
    vi.doMock('../config', () => ({
      config: { NODE_ENV: 'production' },
    }));
    vi.doMock('../logger', () => ({
      logger: { error: vi.fn() },
    }));

    const { errorHandler } = await import('../middleware/errorHandler');
    const { ValidationError } = await import('../errors');
    const res = mockRes();

    errorHandler(
      new ValidationError('caller must be a 64-char SHA256 hash or 66-char Lightning pubkey (02/03 prefix), got 11 chars'),
      mockReq(),
      res as unknown as Response,
      vi.fn() as unknown as NextFunction,
    );

    expect(res._status).toBe(400);
    const body = res._body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('caller');
    expect(body.error.message).toContain('got 11 chars');
    expect(body.error.message).not.toBe('Invalid request');
  });

  it('still masks NOT_FOUND messages in production', async () => {
    // Spot-check that the generic-messages behavior still applies to codes
    // NOT on the pass-through list, so the pass-through doesn't leak to
    // other error types.
    vi.doMock('../config', () => ({
      config: { NODE_ENV: 'production' },
    }));
    vi.doMock('../logger', () => ({
      logger: { error: vi.fn() },
    }));

    const { errorHandler } = await import('../middleware/errorHandler');
    const { NotFoundError } = await import('../errors');
    const res = mockRes();

    errorHandler(
      new NotFoundError('SecretInternalResource', 'hidden-id'),
      mockReq(),
      res as unknown as Response,
      vi.fn() as unknown as NextFunction,
    );

    expect(res._status).toBe(404);
    const body = res._body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Resource not found');
    expect(body.error.message).not.toContain('SecretInternal');
  });

  it('returns 400 MALFORMED_REQUEST for body-parser JSON SyntaxError', async () => {
    // express.json() throws a SyntaxError with `status: 400` and
    // `type: 'entity.parse.failed'` when the body is malformed JSON.
    // The error handler must surface this as 400, not swallow it as 500.
    vi.doMock('../config', () => ({
      config: { NODE_ENV: 'production' },
    }));
    vi.doMock('../logger', () => ({
      logger: { error: vi.fn() },
    }));

    const { errorHandler } = await import('../middleware/errorHandler');
    const res = mockRes();

    // Simulate exactly what body-parser throws on malformed JSON.
    const parseErr = new SyntaxError('Unexpected token n in JSON at position 0') as Error & {
      type: string;
      status: number;
      statusCode: number;
    };
    parseErr.type = 'entity.parse.failed';
    parseErr.status = 400;
    parseErr.statusCode = 400;

    errorHandler(
      parseErr,
      mockReq(),
      res as unknown as Response,
      vi.fn() as unknown as NextFunction,
    );

    expect(res._status).toBe(400);
    const body = res._body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('MALFORMED_REQUEST');
    expect(body.error.message).toBe('Malformed request body');
    // Must not expose the raw SyntaxError message in prod
    expect(body.error.message).not.toContain('Unexpected token');
  });

  it('returns 413 PAYLOAD_TOO_LARGE for body-parser payload-too-large error', async () => {
    vi.doMock('../config', () => ({
      config: { NODE_ENV: 'production' },
    }));
    vi.doMock('../logger', () => ({
      logger: { error: vi.fn() },
    }));

    const { errorHandler } = await import('../middleware/errorHandler');
    const res = mockRes();

    const sizeErr = new Error('request entity too large') as Error & {
      type: string;
      status: number;
      statusCode: number;
    };
    sizeErr.type = 'entity.too.large';
    sizeErr.status = 413;
    sizeErr.statusCode = 413;

    errorHandler(
      sizeErr,
      mockReq(),
      res as unknown as Response,
      vi.fn() as unknown as NextFunction,
    );

    expect(res._status).toBe(413);
    const body = res._body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(body.error.message).toBe('Payload too large');
  });
});

describe('OpenAPI spec auth alignment', () => {
  it('does not require L402 on /agents/top and /agents/search', async () => {
    const { openapiSpec } = await import('../openapi');
    const topOp = openapiSpec.paths['/agents/top'].get;
    const searchOp = openapiSpec.paths['/agents/search'].get;

    // These endpoints are free — no security requirement
    expect(topOp).not.toHaveProperty('security');
    expect(searchOp).not.toHaveProperty('security');
  });

  it('does not require L402 on individual agent endpoints (Mix A+D free directory)', async () => {
    const { openapiSpec } = await import('../openapi');

    const agentOp = openapiSpec.paths['/agent/{publicKeyHash}'].get;
    const verdictOp = openapiSpec.paths['/agent/{publicKeyHash}/verdict'].get;
    const historyOp = openapiSpec.paths['/agent/{publicKeyHash}/history'].get;
    const attestOp = openapiSpec.paths['/agent/{publicKeyHash}/attestations'].get;

    expect(agentOp).not.toHaveProperty('security');
    expect(verdictOp).not.toHaveProperty('security');
    expect(historyOp).not.toHaveProperty('security');
    expect(attestOp).not.toHaveProperty('security');
  });
});
