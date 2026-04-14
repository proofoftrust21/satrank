// Shared SSRF protection for all outbound HTTP requests
const PRIVATE_IP_RE = /^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|0\.0\.0\.0|169\.254\.\d+\.\d+)$/;
const SERVER_IP = process.env.SERVER_IP ?? '178.104.108.108';

export function isPrivateIp(ip: string): boolean {
  return PRIVATE_IP_RE.test(ip) || ip === SERVER_IP;
}

export function isSafeUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    if (/^(localhost|\[::1?\])$/i.test(u.hostname)) return false;
    if (isPrivateIp(u.hostname)) return false;
    // IPv6-mapped IPv4
    const mapped = u.hostname.match(/^\[::ffff:([\d.]+)\]$/i);
    if (mapped && isPrivateIp(mapped[1])) return false;
    return true;
  } catch { return false; }
}
