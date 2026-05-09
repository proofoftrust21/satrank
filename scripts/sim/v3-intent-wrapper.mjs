// SatRank V3 sim wrapper — calls POST /api/intent end-to-end through L402.
//
// Each call:
//   1. POST /api/intent → 402 with WWW-Authenticate (macaroon + invoice)
//   2. Pay invoice via prod LND (SSH execute) — self-payment allowed
//   3. POST /api/intent again with Authorization: L402 <mac>:<preimage>
//   4. Print {http_status, elapsed_ms, sats_paid, candidates_count, candidates}
//
// Usage:
//   node scripts/sim/v3-intent-wrapper.mjs <intent_json>
// Example:
//   node scripts/sim/v3-intent-wrapper.mjs '{"category":"data","budget_sats":50,"max_latency_ms":8000}'

import { execSync } from 'node:child_process';

const intentJson = process.argv[2];
if (!intentJson) {
  console.error('usage: node v3-intent-wrapper.mjs <intent_json>');
  process.exit(1);
}
let intent;
try {
  intent = JSON.parse(intentJson);
} catch (e) {
  console.error('intent_json invalid:', e.message);
  process.exit(1);
}

const BASE = process.env.SATRANK_BASE ?? 'https://satrank.dev';
const SSH_HOST = process.env.SATRANK_HOST ?? 'root@178.104.108.108';

function out(obj) {
  console.log(JSON.stringify(obj));
}

const t0 = Date.now();

// 1. First call → 402 with WWW-Auth
let chal;
try {
  const r = await fetch(`${BASE}/api/intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(intent),
  });
  if (r.status !== 402) {
    out({ http_status: r.status, error: 'expected 402, got other', body: (await r.text()).slice(0, 400) });
    process.exit(1);
  }
  const auth = r.headers.get('www-authenticate') ?? '';
  const m = auth.match(/macaroon="([^"]+)",\s*invoice="([^"]+)"/);
  if (!m) {
    out({ error: 'no L402 challenge in WWW-Authenticate', auth_header: auth });
    process.exit(1);
  }
  chal = { macaroon: m[1], invoice: m[2] };
} catch (e) {
  out({ error: 'fetch /api/intent (challenge) failed', message: e.message });
  process.exit(1);
}

// 2. Pay via SSH+LND on prod (self-payment allowed)
let preimage;
try {
  const cmd = `ssh ${SSH_HOST} "set -a; source /root/satrank/.env.production; set +a; hex=\\$(xxd -p -c 99999 /root/satrank/fulfill.macaroon); /usr/bin/curl -sk -X POST -H 'Grpc-Metadata-macaroon: '\\$hex -H 'Content-Type: application/json' -d '{\\"payment_request\\":\\"${chal.invoice}\\",\\"fee_limit_sat\\":\\"5\\",\\"allow_self_payment\\":true,\\"timeout_seconds\\":30,\\"no_inflight_updates\\":true}' \\$LND_REST_URL/v2/router/send"`;
  const stdout = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // /v2/router/send streams updates ; with no_inflight_updates we get a single result line
  let parsed;
  for (const line of stdout.trim().split('\n')) {
    try {
      const obj = JSON.parse(line);
      if (obj.result?.payment_preimage) { parsed = obj.result; break; }
    } catch {}
  }
  if (!parsed?.payment_preimage) {
    out({ error: 'payInvoice failed or did not return preimage', stdout: stdout.slice(0, 400) });
    process.exit(1);
  }
  preimage = parsed.payment_preimage;
} catch (e) {
  out({ error: 'SSH+LND payInvoice threw', message: e.message });
  process.exit(1);
}

// 3. Retry with L402 Authorization
let retry;
try {
  const r = await fetch(`${BASE}/api/intent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `L402 ${chal.macaroon}:${preimage}`,
    },
    body: JSON.stringify(intent),
  });
  retry = { status: r.status, body: await r.text() };
} catch (e) {
  out({ error: 'fetch /api/intent (retry) failed', message: e.message });
  process.exit(1);
}

const elapsed_ms = Date.now() - t0;

if (retry.status !== 200) {
  out({
    http_status: retry.status,
    elapsed_ms,
    sats_paid: 2,
    error: 'retry returned non-200',
    body: retry.body.slice(0, 400),
  });
  process.exit(0);
}

let payload;
try { payload = JSON.parse(retry.body); } catch { payload = null; }
const candidates = payload?.data?.candidates ?? [];

out({
  http_status: 200,
  elapsed_ms,
  sats_paid: 2,
  intent,
  candidates_count: candidates.length,
  candidates: candidates.map((c) => ({
    url: c.url,
    name: c.name,
    category: c.category,
    price_sats: c.price_sats,
    p_e2e: c.bayesian?.p_success,
    n_obs: c.bayesian?.n_obs,
    is_meaningful: c.is_meaningful,
    median_latency_ms: c.median_latency_ms,
  })),
});
