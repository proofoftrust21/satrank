// S2 — Score check: agent evaluates a specific node
// No direct SDK helper; demonstrates the real-world pattern: direct fetch to
// /api/agent/:hash/verdict using the stored L402 deposit token.
const TOKEN = process.env.SATRANK_TOKEN;
const HASH = '314c645d5a6d1f896e57dc5ca7b263e32648877639dd6b9accb4a527d70c0a1f'; // bfx-lnd0, rank 1

const t0 = performance.now();
const res = await fetch(`https://satrank.dev/api/agent/${HASH}/verdict`, {
  headers: { Authorization: `L402 deposit:${TOKEN}` },
});
const t1 = performance.now();
const body = await res.json();
console.log(JSON.stringify({
  step: 'agent/verdict',
  status: res.status,
  ms: Math.round(t1 - t0),
  verdict_summary: body?.data?.verdict ?? body,
  bayesian_verdict: body?.data?.bayesian?.verdict,
  risk_profile: body?.data?.bayesian?.risk_profile,
  advisory: body?.data?.advisory?.advisory_level,
  recommendation: body?.data?.advisory?.recommendation,
}, null, 2));
