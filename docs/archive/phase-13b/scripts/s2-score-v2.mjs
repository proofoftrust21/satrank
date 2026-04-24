// S2 v2 — Can we read an agent's score WITHOUT a token?
// Try both /agent/:hash (non-verdict) and /agents/top which is free.
const HASH = '314c645d5a6d1f896e57dc5ca7b263e32648877639dd6b9accb4a527d70c0a1f';

async function probe(path) {
  const t0 = performance.now();
  const res = await fetch(`https://satrank.dev${path}`);
  const body = await res.json().catch(() => null);
  return {
    path,
    status: res.status,
    ms: Math.round(performance.now() - t0),
    www_authenticate: res.headers.get('www-authenticate'),
    error_code: body?.error?.code,
    sample: Array.isArray(body?.data) ? { count: body.data.length, first_keys: Object.keys(body.data[0] ?? {}).slice(0, 8) } : Object.keys(body?.data ?? body ?? {}).slice(0, 8),
  };
}

const paths = [
  `/api/agent/${HASH}`,
  `/api/agent/${HASH}/verdict`,
  `/api/agent/${HASH}/history`,
  `/api/agents/top?limit=1`,
  `/api/agents/search?q=ACINQ&limit=3`,
];
for (const p of paths) {
  console.log(JSON.stringify(await probe(p)));
}
