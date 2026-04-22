// S3 — Pathfinding (via /api/best-route or /api/intent, since /api/decide is 410)
// S8 — Unreachable/phantom node (same endpoint)

const realHash = '314c645d5a6d1f896e57dc5ca7b263e32648877639dd6b9accb4a527d70c0a1f'; // bfx-lnd0
const phantomHash = '0'.repeat(64); // phantom

async function postJson(path, body) {
  const t0 = performance.now();
  const res = await fetch(`https://satrank.dev${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 100) }; }
  return {
    path,
    status: res.status,
    ms: Math.round(performance.now() - t0),
    www_auth_preview: (res.headers.get('www-authenticate') ?? '').slice(0, 50),
    body_error_code: json?.error?.code,
    body_error_msg: json?.error?.message,
    data_keys: Object.keys(json?.data ?? {}).slice(0, 8),
  };
}

// S3 — real pubkey
console.log('S3 real:', JSON.stringify(await postJson('/api/best-route', {
  caller: 'phase-13b-s3',
  targets: [realHash],
  walletProvider: 'phoenix',
})));

// S8 — phantom pubkey
console.log('S8 phantom:', JSON.stringify(await postJson('/api/best-route', {
  caller: 'phase-13b-s8',
  targets: [phantomHash],
})));

// Legacy /api/decide still gone?
console.log('S3b /api/decide:', JSON.stringify(await postJson('/api/decide', {
  caller: 'phase-13b-s3b',
  targets: [realHash],
})));
