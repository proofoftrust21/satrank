// Shared SSRF protection for all outbound HTTP requests.
// RFC1918 private ranges + loopback + link-local + **CGN** (RFC6598, 100.64/10).
// Audit H4 noted CGN was missing — an attacker-controlled hostname resolving
// into a CGN range could target ISP infrastructure we don't operate.
import { Agent as UndiciAgent } from 'undici';
import * as dns from 'node:dns';

const PRIVATE_IPV4_RE = /^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|0\.0\.0\.0|169\.254\.\d+\.\d+|22[4-9]\.\d+\.\d+\.\d+|2[3-5]\d\.\d+\.\d+\.\d+|255\.255\.255\.255)$/;
// Optional self-block: set SERVER_IP=<our public IPv4> in .env so the SSRF guard
// also rejects our own ingress. Required in production (checked in config.ts).
// Phase 11ter F-05: no hardcoded default — source must never embed the server IP.
const SERVER_IP = process.env.SERVER_IP ?? '';

export function isPrivateIp(ip: string): boolean {
  // IPv4
  if (PRIVATE_IPV4_RE.test(ip)) return true;
  if (SERVER_IP && ip === SERVER_IP) return true;
  // IPv6 loopback
  if (ip === '::1' || ip === '::') return true;
  // IPv6-mapped IPv4 (::ffff:127.0.0.1)
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped && PRIVATE_IPV4_RE.test(mapped[1])) return true;
  // IPv6 unique local (fc00::/7) and link-local (fe80::/10)
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;  // fc00::/7
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;   // fe80::/10
  return false;
}

export function isSafeUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    // Block URLs with embedded credentials (http://user:pass@host)
    if (u.username || u.password) return false;
    if (/^(localhost|\[::1?\])$/i.test(u.hostname)) return false;
    if (isPrivateIp(u.hostname)) return false;
    // IPv6-mapped IPv4 in bracket notation
    const mapped = u.hostname.match(/^\[::ffff:([\d.]+)\]$/i);
    if (mapped && isPrivateIp(mapped[1])) return false;
    return true;
  } catch { return false; }
}

const BLOCKED_HOSTNAMES = /^(localhost|\[::1?\]|\[::ffff:.+\])$/i;

function isIpBlocked(ip: string): boolean {
  return isPrivateIp(ip) || ip === '0.0.0.0';
}

export function isUrlBlocked(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    if (!['http:', 'https:'].includes(u.protocol)) return true;
    if (u.username || u.password) return true;
    if (BLOCKED_HOSTNAMES.test(u.hostname)) return true;
    if (isIpBlocked(u.hostname)) return true;
    const mapped = u.hostname.match(/^\[::ffff:([\d.]+)\]$/i);
    if (mapped && isIpBlocked(mapped[1])) return true;
    return false;
  } catch { return true; }
}

/** Resolve hostname to IP, verify it's not private, return the resolved IP.
 *  Returns null if blocked, or the original hostname if it's a raw IP.
 *  Resolves A+AAAA in parallel to defeat AAAA-based bypass on dual-stack. */
export async function resolveAndPin(urlStr: string): Promise<string | null> {
  if (isUrlBlocked(urlStr)) return null;
  try {
    const hostname = new URL(urlStr).hostname;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return hostname;
    const { resolve4, resolve6 } = await import('dns/promises');
    const [ipv4, ipv6] = await Promise.all([
      resolve4(hostname).catch(() => [] as string[]),
      resolve6(hostname).catch(() => [] as string[]),
    ]);
    const allIps = [...ipv4, ...ipv6];
    if (allIps.length === 0) return null;
    if (allIps.some(ip => isIpBlocked(ip))) return null;
    return ipv4[0] ?? ipv6[0];
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// fetchSafeExternal — SSRF-hardened fetch
// ---------------------------------------------------------------------------
//
// Phase 11bis F-01/F-02/F-03 remediation. One DNS resolution per connect,
// validated inline inside the undici Agent lookup hook: no TOCTOU between
// a pre-check and the real fetch. Dual-stack safe (family:0 asks for both
// A and AAAA); all returned IPs are validated, not just the first. Default
// redirect: 'manual' — callers must re-validate 3xx Location themselves.

export class SsrfBlockedError extends Error {
  readonly code = 'URL_NOT_ALLOWED';
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;

function safeLookup(hostname: string, opts: unknown, cb: LookupCb): void {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return cb(err, '', 0);
    const list = Array.isArray(addresses) ? addresses : [];
    if (list.length === 0) {
      const e = new Error('SSRF: DNS returned no addresses') as NodeJS.ErrnoException;
      e.code = 'ENOTFOUND';
      return cb(e, '', 0);
    }
    for (const a of list) {
      if (isIpBlocked(a.address)) {
        const e = new Error(`URL_NOT_ALLOWED: resolved IP ${a.address} is blocked`) as NodeJS.ErrnoException;
        e.code = 'URL_NOT_ALLOWED';
        return cb(e, '', 0);
      }
    }
    const pick = list[0];
    cb(null, pick.address, pick.family);
  });
}

let _safeDispatcher: UndiciAgent | null = null;
function getSafeDispatcher(): UndiciAgent {
  if (_safeDispatcher === null) {
    _safeDispatcher = new UndiciAgent({
      connect: { lookup: safeLookup as never },
    });
  }
  return _safeDispatcher;
}

/** Fetch an external URL with SSRF protection.
 *  - Static URL check (isUrlBlocked) rejects literal loopback/private/userinfo.
 *  - DNS lookup validated at connect time (no TOCTOU).
 *  - Default redirect: 'manual' so a 3xx Location to 127.0.0.1 is never followed
 *    automatically. Callers that wish to follow 3xx MUST re-validate with this
 *    helper.
 *
 *  Throws SsrfBlockedError for blocked URLs/IPs. Other failures (timeout,
 *  connection refused) bubble up unchanged.
 */
export async function fetchSafeExternal(
  urlStr: string,
  init: RequestInit = {},
): Promise<Response> {
  if (isUrlBlocked(urlStr)) {
    throw new SsrfBlockedError(`URL_NOT_ALLOWED: ${urlStr}`);
  }
  const finalInit = {
    redirect: 'manual' as const,
    ...init,
    dispatcher: getSafeDispatcher(),
  } as RequestInit & { dispatcher: UndiciAgent };
  try {
    return await fetch(urlStr, finalInit as RequestInit);
  } catch (err: unknown) {
    // Node wraps lookup errors under TypeError("fetch failed") with .cause.
    const direct = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (direct === 'URL_NOT_ALLOWED') {
      throw new SsrfBlockedError((err as Error).message);
    }
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && (cause as NodeJS.ErrnoException).code === 'URL_NOT_ALLOWED') {
      throw new SsrfBlockedError(cause.message);
    }
    throw err;
  }
}

/** Read a Response body with a hard byte cap. Aborts the read stream past
 *  maxBytes instead of buffering the whole payload. Returns the bytes
 *  actually captured (≤ maxBytes) and whether truncation occurred.
 *  Falls back to arrayBuffer() when the response has no readable stream
 *  (e.g., under test mocks), still capping the result to maxBytes. */
export async function readBodyCapped(
  resp: Response,
  maxBytes: number,
): Promise<{ body: Buffer; truncated: boolean; capturedBytes: number }> {
  if (!resp.body || typeof resp.body.getReader !== 'function') {
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > maxBytes) {
      return { body: buf.subarray(0, maxBytes), truncated: true, capturedBytes: maxBytes };
    }
    return { body: buf, truncated: false, capturedBytes: buf.length };
  }
  const reader = resp.body.getReader();
  const chunks: Buffer[] = [];
  let captured = 0;
  let truncated = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = maxBytes - captured;
    if (value.length > remaining) {
      if (remaining > 0) {
        chunks.push(Buffer.from(value.subarray(0, remaining)));
        captured += remaining;
      }
      truncated = true;
      reader.cancel().catch(() => { /* stream already closing */ });
      break;
    }
    chunks.push(Buffer.from(value));
    captured += value.length;
  }
  return { body: Buffer.concat(chunks), truncated, capturedBytes: captured };
}
