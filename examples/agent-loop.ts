#!/usr/bin/env npx tsx
// Agent-in-a-box: the full decide → pay → report cycle in 30 lines.
// Usage: SATRANK_URL=https://satrank.dev SATRANK_API_KEY=<key> npx tsx examples/agent-loop.ts
//
// This script simulates an autonomous agent that:
// 1. Picks a random counterparty from the leaderboard
// 2. Asks SatRank: should I pay this agent?
// 3. Simulates a payment (replace with real Lightning payment)
// 4. Reports the outcome back to SatRank (free)

const BASE = process.env.SATRANK_URL || 'http://localhost:3000';
const API_KEY = process.env.SATRANK_API_KEY || '';
const MY_HASH = process.env.MY_AGENT_HASH || 'a'.repeat(64); // replace with your agent's SHA256 hash

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`);
  return res.json();
}

async function run() {
  // 1. Pick a counterparty from the leaderboard
  const top = await get('/api/agents/top?limit=10') as { data: { publicKeyHash: string; alias: string }[] };
  const target = top.data[Math.floor(Math.random() * top.data.length)];
  console.log(`Target: ${target.alias} (${target.publicKeyHash.slice(0, 12)}...)`);

  // 2. Ask SatRank: should I pay?
  const decision = await post('/api/decide', { target: target.publicKeyHash, caller: MY_HASH });
  console.log(`Decision: go=${decision.data.go}, successRate=${decision.data.successRate}, verdict=${decision.data.verdict}`);

  if (!decision.data.go) {
    console.log(`Skipping — reason: ${decision.data.reason}`);
    return;
  }

  // 3. Simulate payment (replace with real Lightning payment)
  const paymentSucceeded = Math.random() > 0.1; // 90% success rate
  const outcome = paymentSucceeded ? 'success' : 'failure';
  console.log(`Payment: ${outcome}`);

  // 4. Report outcome (free — no L402 required)
  const report = await post('/api/report', {
    target: target.publicKeyHash,
    reporter: MY_HASH,
    outcome,
    // Optional: include paymentHash + preimage for 2x weight bonus
    // paymentHash: '<sha256 of preimage>',
    // preimage: '<payment preimage hex>',
  }, { 'X-API-Key': API_KEY });

  console.log(`Report: id=${report.data?.reportId}, weight=${report.data?.weight}, verified=${report.data?.verified}`);
}

run().catch(console.error);
