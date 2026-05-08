// Phase 10 smoke — register an endpoint with NIP-98 signed body.
// Uses a sim-12 agent key as the operator pubkey.
import crypto, { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SATRANK_BASE ?? 'https://satrank.dev';

const idx = process.argv[2] ?? '1';
const keyFile = path.join(__dirname, 'runs', 'sim-12', 'keys', `${idx}.bin`);
const sk = new Uint8Array(fs.readFileSync(keyFile));
const pubkey = getPublicKey(sk);

const body = JSON.stringify({
  endpoint_url: 'https://api.smoke-test.dev/data',
  http_method: 'POST',
  operator_pubkey: pubkey,
  domain: 'smoke-test.dev',
  recall_body_template: '{"text":"smoke"}',
  expected_price_sats_min: 5,
  expected_price_sats_max: 25,
  signature_b64: 'smoke-signature-b64-placeholder-1234567890',
});

function nip98(url, method, body) {
  const tags = [['u', url], ['method', method]];
  const hash = body.length > 0
    ? crypto.createHash('sha256').update(body, 'utf8').digest('hex')
    : 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  tags.push(['payload', hash]);
  const tmpl = { kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' };
  return `Nostr ${Buffer.from(JSON.stringify(finalizeEvent(tmpl, sk))).toString('base64')}`;
}

const url = `${BASE}/api/operator/register-endpoint`;
const auth = nip98(url, 'POST', body);

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: auth },
  body,
});
const txt = await res.text();
let parsed;
try { parsed = JSON.parse(txt); } catch { parsed = { raw: txt }; }
console.log(JSON.stringify({ http_status: res.status, agent_pubkey: pubkey, result: parsed }, null, 2));
