import crypto, { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { finalizeEvent } from 'nostr-tools/pure';
const BASE = 'https://satrank.dev';
const idx = process.argv[2];
const N = parseInt(process.argv[3] ?? '32', 10);
const sk = new Uint8Array(fs.readFileSync(path.join('/Users/lochju/satrank/scripts/sim/runs/sim-12/keys', `${idx}.bin`)));
function nip98(url, method) {
  const tags = [['u', url], ['method', method]];
  tags.push(['payload', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855']);
  const tmpl = { kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' };
  return `Nostr ${Buffer.from(JSON.stringify(finalizeEvent(tmpl, sk))).toString('base64')}`;
}
const url = `${BASE}/api/services?category=ai`;
const auth = nip98(url, 'GET');
const results = [];
for (let i = 0; i < N; i++) {
  const r = await fetch(url, { headers: { Authorization: auth } });
  results.push(r.status);
}
const ok = results.filter(s => s === 200).length;
const rl = results.filter(s => s === 429).length;
console.log(`agent ${idx}: ${ok}/${N} ok, ${rl} rate-limited`);
