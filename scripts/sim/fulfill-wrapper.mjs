// NIP-98 + POST /api/fulfill wrapper. Each sim agent invokes this via the
// runner's bash_runner tool. Reads the per-agent key from runs/<SIM_RUN>/keys/<idx>.bin.
//
// Usage:
//   SIM_RUN=sim-N node scripts/sim/fulfill-wrapper.mjs <idx> <intent_json> <max_sats> [<max_latency_ms>]
import crypto, { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SATRANK_BASE ?? 'https://satrank.dev';
const runId = process.env.SIM_RUN;
if (!runId) { console.error('SIM_RUN env required'); process.exit(1); }

function nip98(url, method, body, sk) {
  const tags = [['u', url], ['method', method]];
  const hash = body.length > 0
    ? crypto.createHash('sha256').update(body, 'utf8').digest('hex')
    : 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  tags.push(['payload', hash]);
  const tmpl = { kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' };
  return `Nostr ${Buffer.from(JSON.stringify(finalizeEvent(tmpl, sk))).toString('base64')}`;
}

const idx = process.argv[2];
const intentJson = process.argv[3];
const maxSats = parseInt(process.argv[4], 10);
const maxLatencyMs = parseInt(process.argv[5] ?? '8000', 10);
if (!idx || !intentJson || !maxSats) {
  console.error('usage: SIM_RUN=sim-N node fulfill-wrapper.mjs <idx> <intent_json> <max_sats> [<max_latency_ms>]');
  process.exit(1);
}

const keyFile = path.join(__dirname, 'runs', runId, 'keys', `${idx}.bin`);
const sk = new Uint8Array(fs.readFileSync(keyFile));
const pubkey = getPublicKey(sk);
const intent = JSON.parse(intentJson);
const url = `${BASE}/api/fulfill`;
const body = JSON.stringify({ intent, max_sats: maxSats, max_latency_ms: maxLatencyMs });
const auth = nip98(url, 'POST', body, sk);

const t0 = Date.now();
const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: auth },
  body,
});
const elapsed_ms = Date.now() - t0;
const txt = await res.text();
let parsed;
try { parsed = JSON.parse(txt); } catch { parsed = { raw: txt }; }
if (parsed && typeof parsed.body === 'string' && parsed.body.length > 800) {
  parsed.body_preview = parsed.body.slice(0, 800) + `... [${parsed.body.length} bytes total]`;
  delete parsed.body;
}
console.log(JSON.stringify({
  http_status: res.status,
  elapsed_ms,
  agent_pubkey: pubkey,
  result: parsed,
}, null, 2));
