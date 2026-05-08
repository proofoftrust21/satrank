// SSRF guard. Used by probe.ts + crawler.ts before any outbound fetch.
//
// Resolves the URL's hostname to its A/AAAA addresses and rejects:
//   - non-https schemes (http, file, ftp, javascript:, data:, …)
//   - RFC 1918 private ranges (10.*, 172.16-31.*, 192.168.*)
//   - loopback (127.*, ::1)
//   - link-local (169.254.* — AWS/GCP metadata) and IPv6 fe80:*
//   - IPv6 unique local (fc00::/7)
//   - multicast (224.*, ff*:)
//
// Pre-resolution does not fully close the DNS-rebinding window (the kernel
// may re-resolve between this check and fetch's connect). That residual
// risk is mitigated by infrastructure-level egress firewalling — not in
// this file. See docs F10.

import { promises as dns } from 'node:dns';

const BLOCKED = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^::1$/,
  /^169\.254\./,
  /^fe80:/i,
  /^fc[0-9a-f][0-9a-f]:/i,
  /^fd[0-9a-f][0-9a-f]:/i,
  /^224\./,
  /^ff[0-9a-f][0-9a-f]:/i,
];

export class SsrfBlockedError extends Error {
  constructor(reason: string) {
    super(`SSRF guard: ${reason}`);
    this.name = 'SsrfBlockedError';
  }
}

export async function assertSafeUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(`scheme ${parsed.protocol} not allowed`);
  }

  // Bare-IP literals: skip DNS, check the host directly.
  const isLiteral = /^[\d.]+$/.test(parsed.hostname) || parsed.hostname.includes(':');
  let addresses: string[];
  if (isLiteral) {
    addresses = [parsed.hostname.replace(/^\[|\]$/g, '')];
  } else {
    const v4 = await dns.resolve4(parsed.hostname).catch(() => [] as string[]);
    const v6 = await dns.resolve6(parsed.hostname).catch(() => [] as string[]);
    if (v4.length === 0 && v6.length === 0) {
      throw new SsrfBlockedError(`DNS resolution failed for ${parsed.hostname}`);
    }
    addresses = [...v4, ...v6];
  }
  for (const addr of addresses) {
    if (BLOCKED.some((re) => re.test(addr))) {
      throw new SsrfBlockedError(`blocked address ${addr} for host ${parsed.hostname}`);
    }
  }
}

/** Quick scheme-only check for catalogue ingestion paths (crawler).
 *  Cheaper than assertSafeUrl (no DNS) ; use during upsert + leave the
 *  full SSRF check to the probe step. */
export function isHttpsUrl(u: string): boolean {
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
}
