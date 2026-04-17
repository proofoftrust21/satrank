// Shared SSRF protection for all outbound HTTP requests.
// RFC1918 private ranges + loopback + link-local + **CGN** (RFC6598, 100.64/10).
// Audit H4 noted CGN was missing — an attacker-controlled hostname resolving
// into a CGN range could target ISP infrastructure we don't operate.
const PRIVATE_IPV4_RE = /^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|0\.0\.0\.0|169\.254\.\d+\.\d+|22[4-9]\.\d+\.\d+\.\d+|2[3-5]\d\.\d+\.\d+\.\d+|255\.255\.255\.255)$/;
const SERVER_IP = process.env.SERVER_IP ?? '178.104.108.108';

export function isPrivateIp(ip: string): boolean {
  // IPv4
  if (PRIVATE_IPV4_RE.test(ip) || ip === SERVER_IP) return true;
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
