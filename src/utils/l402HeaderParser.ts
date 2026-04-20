// L402 challenge parser — extracts macaroon + invoice from a WWW-Authenticate
// header returned by a 402-gated endpoint.
//
// Target formats (per L402 spec — RFC-ish, as implemented by Aperture and
// common L402 servers):
//   WWW-Authenticate: L402 macaroon="<base64>", invoice="<bolt11>"
//   WWW-Authenticate: LSAT macaroon="<base64>", invoice="<bolt11>"   (legacy)
//
// Real-world servers have shipped with varying quirks:
//   - single vs. double quotes
//   - tab/newline whitespace between key=value pairs
//   - upper/lower case scheme name (L402 vs l402 vs LSAT)
//   - "token=" prefix instead of "macaroon=" (non-standard; not supported)
//
// We accept the first three quirks and reject the fourth — the spec is
// "macaroon=" and we prefer a clean error over silent compatibility drift.

export interface L402Challenge {
  /** macaroon base64 (exactly as returned by the server, no re-encoding). */
  macaroon: string;
  /** BOLT11 invoice — validate separately with bolt11Parser. */
  invoice: string;
}

/** Parses a WWW-Authenticate header value into its L402 components.
 *  Returns null when the header is not an L402 challenge. Never throws —
 *  callers should treat null as "endpoint did not offer an L402 challenge" */
export function parseL402Challenge(headerValue: string | undefined | null): L402Challenge | null {
  if (!headerValue) return null;

  // Strip a leading scheme name (L402 / LSAT). Case-insensitive, allow any
  // whitespace after. If no scheme prefix is found, bail — we don't want
  // to accidentally parse a Bearer or Basic challenge.
  const schemeMatch = /^\s*(L402|LSAT)\b\s*/i.exec(headerValue);
  if (!schemeMatch) return null;
  const body = headerValue.slice(schemeMatch[0].length);

  const macaroon = extractKey(body, 'macaroon');
  const invoice = extractKey(body, 'invoice');
  if (!macaroon || !invoice) return null;
  return { macaroon, invoice };
}

/** Pulls the value of `key=...` from the header body. Accepts both double
 *  and single quotes, or a bare (unquoted) token that terminates at the
 *  next comma or whitespace boundary. */
function extractKey(body: string, key: string): string | null {
  // Double-quoted
  const dq = new RegExp(`${key}="([^"]+)"`, 'i').exec(body);
  if (dq) return dq[1];
  // Single-quoted
  const sq = new RegExp(`${key}='([^']+)'`, 'i').exec(body);
  if (sq) return sq[1];
  // Bare — stops at comma, whitespace, or end of string
  const bare = new RegExp(`${key}=([^,\\s]+)`, 'i').exec(body);
  if (bare) return bare[1];
  return null;
}
