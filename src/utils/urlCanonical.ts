// RFC 3986 canonicalization for endpoint URLs. Two URLs that resolve to the
// same service must produce identical `endpointHash` values so that Phase 3
// Bayesian aggregates (endpoint_hash, window_bucket) bucket observations
// correctly regardless of the exact form the crawler / reporter recorded.
//
// 8 rules applied in order:
//   1. Scheme → lowercase
//   2. Host → lowercase (IDN: toASCII via Punycode before lowercasing)
//   3. Default port stripped (:80 for http, :443 for https)
//   4. Trailing slash removed (except on root path '/')
//   5. Query string removed entirely
//   6. Fragment removed entirely
//   7. Userinfo (user:pass@) removed
//   8. Percent-encoding: triplets uppercased (%2f → %2F); unreserved
//      characters (A-Z a-z 0-9 - . _ ~) percent-decoded
import { sha256 } from './crypto';

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

function normalizePercentEncoding(pathname: string): string {
  let out = '';
  for (let i = 0; i < pathname.length; i++) {
    const ch = pathname[i];
    if (ch === '%' && i + 2 < pathname.length) {
      const hex = pathname.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        const decoded = String.fromCharCode(parseInt(hex, 16));
        if (UNRESERVED.test(decoded)) {
          out += decoded;
        } else {
          out += '%' + hex.toUpperCase();
        }
        i += 2;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/** Canonicalize a URL per the 8 rules above. Throws on malformed input.
 *  Accepts http/https/ws/wss and other schemes with authority; rejects input
 *  the WHATWG URL parser can't handle (no scheme, no host, etc). */
export function canonicalizeUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('canonicalizeUrl: input must be a non-empty string');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`canonicalizeUrl: malformed URL: ${raw}`);
  }
  if (!parsed.host) {
    throw new Error(`canonicalizeUrl: URL has no host: ${raw}`);
  }

  const scheme = parsed.protocol.toLowerCase().replace(/:$/, '');
  // WHATWG URL already applies Punycode to `hostname`; ensure lowercase.
  const host = parsed.hostname.toLowerCase();

  let portPart = '';
  if (parsed.port) {
    const defaults: Record<string, string> = { http: '80', https: '443', ws: '80', wss: '443' };
    if (parsed.port !== defaults[scheme]) {
      portPart = `:${parsed.port}`;
    }
  }

  let path = parsed.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) {
    path = path.replace(/\/+$/, '');
  }
  path = normalizePercentEncoding(path);

  return `${scheme}://${host}${portPart}${path}`;
}

/** Stable sha256 hex of the canonical URL. Used for `endpoint_hash` column. */
export function endpointHash(raw: string): string {
  return sha256(canonicalizeUrl(raw));
}
