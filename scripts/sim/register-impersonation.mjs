// Phase 10 smoke — try to register as a DIFFERENT operator pubkey than the
// NIP-98 signer. Should be rejected with 403.
import crypto, { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SATRANK_BASE ?? 'https://satrank.dev';
const sk = new Uint8Array(fs.readFileSync(path.join(__dirname, 'runs', 'sim-12', 'keys', '8.bin')));
const realPubkey = getPublicKey(sk);
const FAKE_PUBKEY = 'f'.repeat(64);

const body = JSON.stringify({
  endpoint_url: 'https://api.attacker-test.dev/data',
  http_method: 'POST',
  operator_pubkey: FAKE_PUBKEY,  // different from NIP-98 signer
  domain: 'attacker-test.dev',
  signature_b64: 'this-is-a-dummy-signature-twenty-plus-chars',
});
function nip98(url, method, body) {
  const tags = [['u', url], ['method', method]];
  const hash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
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
console.log(JSON.stringify({ http_status: res.status, signer: realPubkey, claimed: FAKE_PUBKEY, response: JSON.parse(txt) }, null, 2));
