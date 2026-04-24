// S6 — Manual L402 paywall: make a paid call without auth, read the 402
// challenge headers + body (invoice shape).
const t0 = performance.now();
const res = await fetch('https://satrank.dev/api/decide', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    caller: 'phase-13b-agent-s6',
    targets: ['314c645d5a6d1f896e57dc5ca7b263e32648877639dd6b9accb4a527d70c0a1f'],
  }),
});
const t1 = performance.now();
const bodyText = await res.text();
let body;
try { body = JSON.parse(bodyText); } catch { body = { raw_text: bodyText.slice(0, 200) }; }

const wwwAuth = res.headers.get('www-authenticate');
console.log(JSON.stringify({
  step: 'decide_without_token',
  status: res.status,
  ms: Math.round(t1 - t0),
  www_authenticate: wwwAuth,
  body_error: body?.error,
  headers: {
    'x-api-version': res.headers.get('x-api-version'),
    'ratelimit-remaining': res.headers.get('ratelimit-remaining'),
  },
}, null, 2));
