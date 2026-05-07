// SDK 1.6.0 — AEPS §10 dispute methods + typed errors.
import { describe, it, expect } from 'vitest';
import { ApiClient } from '../src/client/apiClient';
import { SatRank } from '../src/SatRank';
import {
  AepsDisputeNotFoundError,
  AepsDisputeNotOpenError,
  AepsOracleNotInSetError,
  AepsSignatureInvalidError,
} from '../src/errors';

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((url: string, init: RequestInit = {}) =>
    Promise.resolve(handler(url, init))) as unknown as typeof fetch;
}

describe('SDK 1.6 — AEPS §10 dispute methods', () => {
  describe('postAepsDispute', () => {
    it('POSTs to /api/aeps/dispute with custom Authorization + body', async () => {
      const fetchMock = mockFetch((url, init) => {
        expect(url).toBe('https://api.example/api/aeps/dispute');
        expect(init.method).toBe('POST');
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Nostr ZmFrZQ==');
        const body = JSON.parse(init.body as string);
        expect(body.respondent_pubkey).toBe('b'.repeat(64));
        expect(body.dispute_type).toBe('content_correctness');
        expect(body.oracle_threshold).toBe(2);
        return new Response(
          JSON.stringify({
            data: {
              dispute_id: 'dis_' + 'a'.repeat(32),
              state: 'open',
              multiplier: 5,
              oracle_pubkeys: ['c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)],
              oracle_threshold: 2,
              expires_at: 1700000000,
              outcome_messages: {
                disputant_wins: { canonical: '{"x":1}', hash_hex: '11'.repeat(32) },
                respondent_wins: { canonical: '{"y":1}', hash_hex: '22'.repeat(32) },
              },
            },
          }),
          { status: 201 },
        );
      });
      const api = new ApiClient({
        apiBase: 'https://api.example',
        fetch: fetchMock,
        request_timeout_ms: 1000,
      });
      const res = await api.postAepsDispute(
        {
          respondent_pubkey: 'b'.repeat(64),
          dispute_type: 'content_correctness',
          oracle_pubkeys: ['c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)],
          oracle_threshold: 2,
        },
        'Nostr ZmFrZQ==',
      );
      expect(res.dispute_id).toBe('dis_' + 'a'.repeat(32));
      expect(res.multiplier).toBe(5);
      expect(res.outcome_messages.disputant_wins.hash_hex).toBe('11'.repeat(32));
    });

    it('strips undefined fields from body', async () => {
      const fetchMock = mockFetch((_url, init) => {
        const body = JSON.parse(init.body as string);
        // receipt_id + fork_event_id + dispute_reason were undefined → not sent
        expect(body).not.toHaveProperty('receipt_id');
        expect(body).not.toHaveProperty('fork_event_id');
        expect(body).not.toHaveProperty('dispute_reason');
        return new Response(
          JSON.stringify({
            data: {
              dispute_id: 'dis_' + 'a'.repeat(32),
              state: 'open',
              multiplier: 1,
              oracle_pubkeys: ['c'.repeat(64)],
              oracle_threshold: 1,
              expires_at: 1700000000,
              outcome_messages: {
                disputant_wins: { canonical: '{}', hash_hex: '00'.repeat(32) },
                respondent_wins: { canonical: '{}', hash_hex: '00'.repeat(32) },
              },
            },
          }),
          { status: 201 },
        );
      });
      const api = new ApiClient({
        apiBase: 'https://api.example',
        fetch: fetchMock,
        request_timeout_ms: 1000,
      });
      await api.postAepsDispute(
        {
          respondent_pubkey: 'b'.repeat(64),
          dispute_type: 'non_payment',
          oracle_pubkeys: ['c'.repeat(64)],
          oracle_threshold: 1,
        },
        'Nostr fake',
      );
    });
  });

  describe('postAepsAttestation', () => {
    it('POSTs to /api/aeps/dispute/:id/attestation', async () => {
      const fetchMock = mockFetch((url, init) => {
        expect(url).toBe('https://api.example/api/aeps/dispute/dis_abc/attestation');
        expect(init.method).toBe('POST');
        const body = JSON.parse(init.body as string);
        expect(body.outcome).toBe('disputant_wins');
        expect(body.signature_hex).toBe('aa'.repeat(64));
        return new Response(
          JSON.stringify({
            data: { dispute_id: 'dis_abc', attestation_id: 7, dispute_state: 'resolved_disputant' },
          }),
          { status: 200 },
        );
      });
      const api = new ApiClient({
        apiBase: 'https://api.example',
        fetch: fetchMock,
        request_timeout_ms: 1000,
      });
      const res = await api.postAepsAttestation(
        'dis_abc',
        { outcome: 'disputant_wins', signature_hex: 'aa'.repeat(64) },
        'Nostr fake',
      );
      expect(res.dispute_state).toBe('resolved_disputant');
      expect(res.attestation_id).toBe(7);
    });

    it('throws AepsDisputeNotFoundError on 404', async () => {
      const fetchMock = mockFetch(() =>
        new Response(
          JSON.stringify({ error: 'dispute_not_found', message: 'unknown' }),
          { status: 404 },
        ),
      );
      const api = new ApiClient({
        apiBase: 'https://api.example',
        fetch: fetchMock,
        request_timeout_ms: 1000,
      });
      await expect(
        api.postAepsAttestation(
          'dis_unknown',
          { outcome: 'disputant_wins', signature_hex: 'aa'.repeat(64) },
          'Nostr fake',
        ),
      ).rejects.toBeInstanceOf(AepsDisputeNotFoundError);
    });

    it('throws AepsDisputeNotOpenError on 409 dispute_not_open', async () => {
      const fetchMock = mockFetch(() =>
        new Response(
          JSON.stringify({ error: 'dispute_not_open', message: 'already resolved' }),
          { status: 409 },
        ),
      );
      const api = new ApiClient({
        apiBase: 'https://api.example',
        fetch: fetchMock,
        request_timeout_ms: 1000,
      });
      await expect(
        api.postAepsAttestation(
          'dis_abc',
          { outcome: 'disputant_wins', signature_hex: 'aa'.repeat(64) },
          'Nostr fake',
        ),
      ).rejects.toBeInstanceOf(AepsDisputeNotOpenError);
    });

    it('throws AepsOracleNotInSetError on 403', async () => {
      const fetchMock = mockFetch(() =>
        new Response(
          JSON.stringify({ error: 'oracle_not_in_set', message: 'forbidden' }),
          { status: 403 },
        ),
      );
      const api = new ApiClient({
        apiBase: 'https://api.example',
        fetch: fetchMock,
        request_timeout_ms: 1000,
      });
      await expect(
        api.postAepsAttestation(
          'dis_abc',
          { outcome: 'disputant_wins', signature_hex: 'aa'.repeat(64) },
          'Nostr fake',
        ),
      ).rejects.toBeInstanceOf(AepsOracleNotInSetError);
    });

    it('throws AepsSignatureInvalidError on 400 signature_invalid', async () => {
      const fetchMock = mockFetch(() =>
        new Response(
          JSON.stringify({ error: 'signature_invalid', message: 'bad sig' }),
          { status: 400 },
        ),
      );
      const api = new ApiClient({
        apiBase: 'https://api.example',
        fetch: fetchMock,
        request_timeout_ms: 1000,
      });
      await expect(
        api.postAepsAttestation(
          'dis_abc',
          { outcome: 'disputant_wins', signature_hex: 'aa'.repeat(64) },
          'Nostr fake',
        ),
      ).rejects.toBeInstanceOf(AepsSignatureInvalidError);
    });
  });

  describe('getAepsDispute', () => {
    it('GETs the public dispute endpoint without auth', async () => {
      const fetchMock = mockFetch((url, init) => {
        expect(url).toBe('https://api.example/api/aeps/dispute/dis_xyz');
        expect(init.method).toBe('GET');
        const headers = init.headers as Record<string, string>;
        // No Authorization header on a public GET
        expect(headers.Authorization).toBeUndefined();
        return new Response(
          JSON.stringify({
            data: {
              dispute_id: 'dis_xyz',
              disputant_pubkey: 'a'.repeat(64),
              respondent_pubkey: 'b'.repeat(64),
              dispute_type: 'sla_breach',
              multiplier: 3,
              oracle_pubkeys: ['c'.repeat(64), 'd'.repeat(64)],
              oracle_threshold: 2,
              state: 'open',
              expires_at: 1700000000,
              created_at: 1699000000,
              resolved_at: null,
              claim_id: null,
              attestation_counts: { disputant_wins: 1, respondent_wins: 0 },
              attestations: [
                {
                  oracle_pubkey: 'c'.repeat(64),
                  outcome: 'disputant_wins',
                  signed_at: 1699500000,
                },
              ],
            },
          }),
          { status: 200 },
        );
      });
      const api = new ApiClient({
        apiBase: 'https://api.example',
        fetch: fetchMock,
        request_timeout_ms: 1000,
      });
      const res = await api.getAepsDispute('dis_xyz');
      expect(res.state).toBe('open');
      expect(res.attestation_counts.disputant_wins).toBe(1);
      expect(res.attestations[0].outcome).toBe('disputant_wins');
    });

    it('throws AepsDisputeNotFoundError on 404 dispute_not_found', async () => {
      const fetchMock = mockFetch(() =>
        new Response(
          JSON.stringify({ error: 'dispute_not_found', message: 'unknown' }),
          { status: 404 },
        ),
      );
      const api = new ApiClient({
        apiBase: 'https://api.example',
        fetch: fetchMock,
        request_timeout_ms: 1000,
      });
      await expect(api.getAepsDispute('dis_unknown')).rejects.toBeInstanceOf(
        AepsDisputeNotFoundError,
      );
    });
  });

  describe('SatRank.openDispute / submitAttestation / getDispute', () => {
    it('public methods delegate to ApiClient', async () => {
      const fetchMock = mockFetch((url) => {
        if (url.endsWith('/api/aeps/dispute')) {
          return new Response(
            JSON.stringify({
              data: {
                dispute_id: 'dis_abc',
                state: 'open',
                multiplier: 5,
                oracle_pubkeys: ['c'.repeat(64)],
                oracle_threshold: 1,
                expires_at: 1700000000,
                outcome_messages: {
                  disputant_wins: { canonical: '{}', hash_hex: '11'.repeat(32) },
                  respondent_wins: { canonical: '{}', hash_hex: '22'.repeat(32) },
                },
              },
            }),
            { status: 201 },
          );
        }
        return new Response(JSON.stringify({ error: 'not_routed' }), { status: 500 });
      });
      const sr = new SatRank({ apiBase: 'https://api.example', fetch: fetchMock });
      const res = await sr.openDispute(
        {
          respondent_pubkey: 'b'.repeat(64),
          dispute_type: 'fork',
          oracle_pubkeys: ['c'.repeat(64)],
          oracle_threshold: 1,
        },
        'Nostr fake',
      );
      expect(res.dispute_id).toBe('dis_abc');
    });

    it('disputeEndpoint() returns canonical URL for NIP-98 signing', () => {
      const sr = new SatRank({
        apiBase: 'https://api.example',
        fetch: globalThis.fetch ?? mockFetch(() => new Response()),
      });
      expect(sr.disputeEndpoint()).toBe('https://api.example/api/aeps/dispute');
    });

    it('attestationEndpoint() encodes dispute_id', () => {
      const sr = new SatRank({
        apiBase: 'https://api.example',
        fetch: globalThis.fetch ?? mockFetch(() => new Response()),
      });
      expect(sr.attestationEndpoint('dis_abc')).toBe(
        'https://api.example/api/aeps/dispute/dis_abc/attestation',
      );
    });
  });
});
