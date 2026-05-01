// SatRank simulation setup — generate fresh ephemeral Nostr keys for each agent
// + pre-credit token_balance via SSH to prod. Run BEFORE runner.mjs.
//
// Usage:
//   SIM_RUN=sim-N node scripts/sim/setup.mjs
//
// Outputs:
//   runs/<SIM_RUN>/keys/<idx>.bin
//   runs/<SIM_RUN>/agents.json
import crypto, { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SSH = process.env.SATRANK_SSH ?? 'root@178.104.108.108';
const SEED_SATS = Number(process.env.SIM_SEED_SATS ?? 100);

const runId = process.env.SIM_RUN ?? `sim-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
const runDir = path.join(__dirname, 'runs', runId);
const keysDir = path.join(runDir, 'keys');
fs.mkdirSync(keysDir, { recursive: true });

const personasFile = path.join(__dirname, 'personas.json');
const { agents: personas } = JSON.parse(fs.readFileSync(personasFile, 'utf8'));

const agents = personas.map(p => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  fs.writeFileSync(path.join(keysDir, `${p.idx}.bin`), Buffer.from(sk));
  return { idx: p.idx, pubkey: pk };
});

const valueRows = agents
  .map(a => `('${a.pubkey}', ${SEED_SATS}, 1, EXTRACT(EPOCH FROM now())::int, ${SEED_SATS}, ${SEED_SATS})`)
  .join(',\n  ');
const seedSql = `
INSERT INTO token_balance
  (payment_hash, balance_credits, rate_sats_per_request, created_at, max_quota, remaining)
VALUES
  ${valueRows}
ON CONFLICT (payment_hash) DO UPDATE
  SET balance_credits = ${SEED_SATS}, remaining = ${SEED_SATS};
`;
const seedScript = `
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });
p.query(\`${seedSql}\`)
  .then(r => { console.log('seeded', r.rowCount ?? 0, 'rows'); p.end(); })
  .catch(e => { console.error(e.message); process.exit(1); });
`;

console.log(`Sim setup — run=${runId}, seed=${SEED_SATS} sats per agent`);
console.log(`Keys → ${keysDir}`);
agents.forEach(a => console.log(`  agent ${a.idx}: ${a.pubkey}`));
console.log(`\nSeeding token_balance via ${SSH} (single SSH session)...`);
const out = execSync(
  `ssh ${SSH} "docker exec -i satrank-api node" <<'NODE_EOF'\n${seedScript}\nNODE_EOF\n`,
  { shell: '/bin/bash', encoding: 'utf8' },
);
console.log(out);

fs.writeFileSync(path.join(runDir, 'agents.json'), JSON.stringify({ runId, agents }, null, 2));
console.log(`Registry → ${runDir}/agents.json`);
console.log(`\nNext: SIM_RUN=${runId} ANTHROPIC_API_KEY=... node scripts/sim/runner.mjs`);
