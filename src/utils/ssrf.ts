// Shared SSRF protection for all outbound HTTP requests
const PRIVATE_IPV4_RE = /^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|0\.0\.0\.0|169\.254\.\d+\.\d+)$/;
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
