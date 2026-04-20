// Phase 11 audit F-08 — Does src/utils/ssrf.ts itself have bypass gaps?
//
// The central SSRF utility's `isSafeUrl` / `isPrivateIp` is a regex over the
// literal hostname string. Non-standard IPv4 notations (decimal, octal, hex)
// may slip past the regex even though Node/undici's fetch will still dial
// the loopback address. This script enumerates the bypass patterns without
// making any network request.
//
// Run manually (not in CI):
//
//   npx tsx src/tests/security/ssrf-utility-bypass.ts

import { isSafeUrl, isUrlBlocked } from '../../utils/ssrf';

const cases: Array<{ label: string; url: string; expectBlock: boolean }> = [
  // --- Sanity : patterns that MUST be blocked ---
  { label: 'literal 127.0.0.1',            url: 'http://127.0.0.1/',             expectBlock: true  },
  { label: 'localhost hostname',           url: 'http://localhost/',             expectBlock: true  },
  { label: 'IPv6 loopback',                url: 'http://[::1]/',                 expectBlock: true  },
  { label: 'IPv4-mapped IPv6 (loopback)',  url: 'http://[::ffff:127.0.0.1]/',    expectBlock: true  },
  { label: 'RFC1918 10/8',                 url: 'http://10.0.0.1/',              expectBlock: true  },
  { label: 'RFC1918 192.168/16',           url: 'http://192.168.1.1/',           expectBlock: true  },
  { label: 'link-local 169.254/16',        url: 'http://169.254.169.254/',       expectBlock: true  },
  { label: 'CGN 100.64/10 (RFC6598)',      url: 'http://100.64.0.1/',            expectBlock: true  },
  { label: 'userinfo prefix',              url: 'http://a@127.0.0.1/',           expectBlock: true  },
  // --- Known bypass shapes ---
  { label: 'decimal IPv4 (= 127.0.0.1)',   url: 'http://2130706433/',            expectBlock: true  },
  { label: 'octal IPv4 (= 127.0.0.1)',     url: 'http://0177.0.0.1/',            expectBlock: true  },
  { label: 'hex IPv4 (= 127.0.0.1)',       url: 'http://0x7f.0.0.1/',            expectBlock: true  },
  { label: 'hex flat (= 127.0.0.1)',       url: 'http://0x7f000001/',            expectBlock: true  },
  { label: 'zero-prefixed 127.00.00.01',   url: 'http://127.00.00.01/',          expectBlock: true  },
];

console.log('F-08 — ssrf.ts bypass surface\n');

let fails = 0;
for (const c of cases) {
  const safe = isSafeUrl(c.url);
  const blocked = isUrlBlocked(c.url);
  const actuallyBlocks = !safe || blocked;
  const verdict = actuallyBlocks === c.expectBlock ? 'OK  ' : 'MISS';
  if (verdict === 'MISS') fails++;
  console.log(`  [${verdict}] ${c.label.padEnd(34)} url=${c.url.padEnd(36)} isSafeUrl=${safe} isUrlBlocked=${blocked}`);
}

if (fails > 0) {
  console.log(`\n${fails} bypass shape(s) NOT blocked by the ssrf.ts utility.`);
  console.log('Upstream consequence: even if probeController added isSafeUrl(), these shapes still reach loopback.');
  process.exit(2);
}
console.log('\nAll bypass shapes blocked.');
