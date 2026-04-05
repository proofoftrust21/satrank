#!/usr/bin/env npx tsx
// Agent-in-a-box: one line to decide, pay, and report.
// Usage: SATRANK_URL=https://satrank.dev npx tsx examples/agent-loop.ts

import { SatRankClient } from '../sdk/src/client';

const satrank = new SatRankClient(process.env.SATRANK_URL || 'http://localhost:3000', {
  headers: process.env.SATRANK_API_KEY ? { 'X-API-Key': process.env.SATRANK_API_KEY } : {},
});

const MY_HASH = process.env.MY_AGENT_HASH || 'a'.repeat(64);

async function run() {
  // Pick a counterparty from the leaderboard
  const top = await satrank.getTopAgents(10);
  const target = top.agents[Math.floor(Math.random() * top.agents.length)];
  console.log(`Target: ${target.alias} (${target.publicKeyHash.slice(0, 12)}...)`);

  // One line: decide → pay → report
  const result = await satrank.transact(
    target.publicKeyHash,
    MY_HASH,
    async () => {
      // Replace with your real Lightning payment logic
      const success = Math.random() > 0.1;
      console.log(`Payment: ${success ? 'success' : 'failure'}`);
      return { success };
      // For 2x weight bonus, return { success, preimage: '...', paymentHash: '...' }
    },
  );

  if (!result.paid && !result.decision.go) {
    console.log(`Skipped — ${result.decision.reason}`);
  } else {
    console.log(`Done — paid=${result.paid}, weight=${result.report?.weight}`);
  }
}

run().catch(console.error);
