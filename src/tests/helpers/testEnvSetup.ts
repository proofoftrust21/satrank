// Phase 12A audit fix (2026-05-07) — vitest setupFiles entry.
//
// Runs in each test worker BEFORE any test file imports `../config`. Sets
// the env vars that the audit-fix `buildCanonicalNip98Url` helper now reads
// from `config.SATRANK_API_BASE` so that tests signing NIP-98 envelopes
// against `http://127.0.0.1:80` (the long-standing test convention) match
// the URL the verifier reconstructs.
//
// Without this, every test file using `BASE_URL = 'http://127.0.0.1:80'`
// would 401 on every NIP-98-protected route because the verifier
// reconstructs the canonical URL from `config.SATRANK_API_BASE` (default
// `https://satrank.dev`).

if (!process.env.SATRANK_API_BASE) {
  process.env.SATRANK_API_BASE = 'http://127.0.0.1:80';
}
