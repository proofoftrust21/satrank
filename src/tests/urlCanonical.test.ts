// Tests for RFC 3986 URL canonicalization. Covers all 8 rules plus the
// composite case (all rules applied to a single pathological input) and
// the `endpointHash` stability contract (variants collapse to one hash).
import { describe, it, expect } from 'vitest';
import { canonicalizeUrl, endpointHash } from '../utils/urlCanonical';

describe('canonicalizeUrl', () => {
  // Rule 1: scheme → lowercase
  it('lowercases the scheme', () => {
    expect(canonicalizeUrl('HTTP://example.com/api')).toBe('http://example.com/api');
    expect(canonicalizeUrl('HTTPS://example.com/api')).toBe('https://example.com/api');
  });

  // Rule 2: host → lowercase
  it('lowercases the host', () => {
    expect(canonicalizeUrl('http://Example.COM/api')).toBe('http://example.com/api');
    expect(canonicalizeUrl('http://API.SATRANK.DEV/v1')).toBe('http://api.satrank.dev/v1');
  });

  // Rule 3: default port stripped
  it('strips default port 80 for http', () => {
    expect(canonicalizeUrl('http://example.com:80/api')).toBe('http://example.com/api');
  });

  it('strips default port 443 for https', () => {
    expect(canonicalizeUrl('https://example.com:443/api')).toBe('https://example.com/api');
  });

  it('preserves non-default port', () => {
    expect(canonicalizeUrl('http://example.com:8080/api')).toBe('http://example.com:8080/api');
    expect(canonicalizeUrl('https://example.com:8443/api')).toBe('https://example.com:8443/api');
  });

  // Rule 4: trailing slash removed (except root)
  it('removes trailing slash from non-root path', () => {
    expect(canonicalizeUrl('http://example.com/api/')).toBe('http://example.com/api');
    expect(canonicalizeUrl('http://example.com/api/v1/')).toBe('http://example.com/api/v1');
  });

  it('preserves trailing slash on root path', () => {
    expect(canonicalizeUrl('http://example.com/')).toBe('http://example.com/');
    // Input without explicit path — WHATWG URL adds '/', which we keep as root.
    expect(canonicalizeUrl('http://example.com')).toBe('http://example.com/');
  });

  // Rule 5: query removed
  it('removes the query string entirely', () => {
    expect(canonicalizeUrl('http://example.com/api?a=1&b=2')).toBe('http://example.com/api');
    expect(canonicalizeUrl('http://example.com/api?nocache=xyz')).toBe('http://example.com/api');
  });

  // Rule 6: fragment removed
  it('removes the fragment entirely', () => {
    expect(canonicalizeUrl('http://example.com/api#section')).toBe('http://example.com/api');
  });

  // Rule 7: userinfo removed
  it('removes userinfo (user:pass@)', () => {
    expect(canonicalizeUrl('http://user:pass@example.com/api')).toBe('http://example.com/api');
    expect(canonicalizeUrl('http://someone@example.com/api')).toBe('http://example.com/api');
  });

  // Rule 2 (IDN): Punycode via WHATWG URL parser
  it('converts IDN host to Punycode (lowercase)', () => {
    // WHATWG URL parser applies toASCII(Punycode) to `hostname` automatically;
    // canonicalize ensures the result is also lowercased.
    const out = canonicalizeUrl('http://ümlaut.example/api');
    expect(out).toBe('http://xn--mlaut-jva.example/api');
  });

  // Rule 8: percent-encoding — uppercase triplets
  it('uppercases percent-encoding triplets', () => {
    expect(canonicalizeUrl('http://example.com/a%2fb')).toBe('http://example.com/a%2Fb');
    expect(canonicalizeUrl('http://example.com/x%c3%a9')).toBe('http://example.com/x%C3%A9');
  });

  // Rule 8: percent-encoding — decode unreserved chars
  it('decodes percent-encoded unreserved characters', () => {
    // %7E = '~' (unreserved, must be decoded)
    expect(canonicalizeUrl('http://example.com/%7Euser')).toBe('http://example.com/~user');
    // %41 = 'A', %30 = '0', %2D = '-', %2E = '.', %5F = '_', %7E = '~' — all unreserved
    expect(canonicalizeUrl('http://example.com/%41%30%2D%2E%5F%7E')).toBe('http://example.com/A0-._~');
  });

  // Non-standard scheme with authority
  it('handles non-special schemes with authority', () => {
    expect(canonicalizeUrl('WS://Echo.Example.COM/chat/')).toBe('ws://echo.example.com/chat');
    expect(canonicalizeUrl('wss://secure.example.com:443/stream')).toBe('wss://secure.example.com/stream');
  });

  // Empty path → WHATWG adds '/', which is the root case
  it('treats empty path as root', () => {
    expect(canonicalizeUrl('http://example.com')).toBe('http://example.com/');
    expect(canonicalizeUrl('HTTPS://Example.COM')).toBe('https://example.com/');
  });

  // Malformed URL → throws
  it('throws on malformed input', () => {
    expect(() => canonicalizeUrl('not-a-url')).toThrow(/malformed URL/);
    expect(() => canonicalizeUrl('')).toThrow(/non-empty string/);
    expect(() => canonicalizeUrl('http://')).toThrow();
  });

  // Composite: a single URL that exercises all 8 rules at once.
  it('applies all 8 rules together', () => {
    const raw = 'HTTPS://User:Pass@Example.COM:443/API/v1/%7Eendpoint/?q=1&b=2#frag';
    expect(canonicalizeUrl(raw)).toBe('https://example.com/API/v1/~endpoint');
  });
});

describe('endpointHash', () => {
  it('returns the same hash for equivalent URLs', () => {
    const a = endpointHash('HTTPS://Example.COM/api/');
    const b = endpointHash('https://example.com:443/api');
    const c = endpointHash('https://user:pass@example.com/api?cache=1#frag');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('returns different hashes for distinct canonical URLs', () => {
    const a = endpointHash('https://example.com/api/v1');
    const b = endpointHash('https://example.com/api/v2');
    expect(a).not.toBe(b);
  });

  it('returns a 64-character hex digest (sha256)', () => {
    const hash = endpointHash('https://example.com/api');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
