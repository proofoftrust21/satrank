// Phase 7 — C11/C12 : agent verdict expose operator_id quand operator verified,
// et attache un advisory OPERATOR_UNVERIFIED dans advisories[] sinon.
//
// Scope du fichier : uniquement le branchement VerdictService ↔ OperatorService.
// Les tests de scoring Bayesian ou de flags advisory vivent dans verdict.test.ts
// et advisoryService tests respectivement.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ScoringService } from '../services/scoringService';
import { TrendService } from '../services/trendService';
import { VerdictService } from '../services/verdictService';
import { RiskService } from '../services/riskService';
import { createBayesianVerdictService } from './helpers/bayesianTestFactory';
import { OperatorService } from '../services/operatorService';
import {
  OperatorRepository,
  OperatorIdentityRepository,
  OperatorOwnershipRepository,
} from '../repositories/operatorRepository';
import {
  EndpointStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import { sha256 } from '../utils/crypto';
import type { Agent } from '../types';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function makeAgentWithPubkey(pubkey: string): Agent {
  return {
    public_key_hash: sha256(pubkey),
    public_key: pubkey,
    alias: 'op-node',
    first_seen: NOW - 90 * DAY,
    last_seen: NOW - DAY,
    source: 'observer_protocol',
    total_transactions: 10,
    total_attestations_received: 0,
    avg_score: 60,
    capacity_sats: null,
    positive_ratings: 0,
    negative_ratings: 0,
    lnplus_rank: 0,
    hubness_rank: 0,
    betweenness_rank: 0,
    hopness_rank: 0,
    unique_peers: null,
    last_queried_at: null,
    query_count: 0,
  };
}

function setupVerdictWithOperator(): {
  db: Database.Database;
  agentRepo: AgentRepository;
  verdictService: VerdictService;
  operatorService: OperatorService;
} {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const agentRepo = new AgentRepository(db);
  const txRepo = new TransactionRepository(db);
  const attestationRepo = new AttestationRepository(db);
  const snapshotRepo = new SnapshotRepository(db);
  const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
  const trendService = new TrendService(agentRepo, snapshotRepo);
  const operatorService = new OperatorService(
    new OperatorRepository(db),
    new OperatorIdentityRepository(db),
    new OperatorOwnershipRepository(db),
    new EndpointStreamingPosteriorRepository(db),
    new NodeStreamingPosteriorRepository(db),
    new ServiceStreamingPosteriorRepository(db),
  );
  const verdictService = new VerdictService(
    agentRepo, attestationRepo, scoringService, trendService, new RiskService(),
    createBayesianVerdictService(db),
    undefined, undefined,
    operatorService,
  );
  return { db, agentRepo, verdictService, operatorService };
}

describe('VerdictService — C11/C12 operator_id + OPERATOR_UNVERIFIED advisory', () => {
  let db: Database.Database;

  afterEach(() => { db?.close(); });

  it('operator_id=null et pas d\'advisory operator quand aucun ownership', async () => {
    const ctx = setupVerdictWithOperator();
    db = ctx.db;
    const pubkey = '02' + 'a'.repeat(64);
    ctx.agentRepo.insert(makeAgentWithPubkey(pubkey));

    const v = await ctx.verdictService.getVerdict(sha256(pubkey));
    expect(v.operator_id).toBeNull();
    expect(v.advisories.find(a => a.code === 'OPERATOR_UNVERIFIED')).toBeUndefined();
  });

  it('operator_id=null et OPERATOR_UNVERIFIED (info) quand operator pending', async () => {
    const ctx = setupVerdictWithOperator();
    db = ctx.db;
    const pubkey = '02' + 'b'.repeat(64);
    ctx.agentRepo.insert(makeAgentWithPubkey(pubkey));
    const opId = 'op-verdict-pending';
    ctx.operatorService.upsertOperator(opId);
    ctx.operatorService.claimOwnership(opId, 'node', pubkey);

    const v = await ctx.verdictService.getVerdict(sha256(pubkey));
    expect(v.operator_id).toBeNull();
    const adv = v.advisories.find(a => a.code === 'OPERATOR_UNVERIFIED');
    expect(adv).toBeDefined();
    expect(adv!.level).toBe('info');
    expect((adv!.data as { operator_status: string }).operator_status).toBe('pending');
  });

  it('operator_id=null et OPERATOR_UNVERIFIED (warning) quand operator rejected', async () => {
    const ctx = setupVerdictWithOperator();
    db = ctx.db;
    const pubkey = '02' + 'c'.repeat(64);
    ctx.agentRepo.insert(makeAgentWithPubkey(pubkey));
    const opId = 'op-verdict-rejected';
    ctx.operatorService.upsertOperator(opId);
    ctx.operatorService.claimOwnership(opId, 'node', pubkey);
    ctx.db.prepare(`UPDATE operators SET status='rejected' WHERE operator_id = ?`).run(opId);

    const v = await ctx.verdictService.getVerdict(sha256(pubkey));
    expect(v.operator_id).toBeNull();
    const adv = v.advisories.find(a => a.code === 'OPERATOR_UNVERIFIED');
    expect(adv).toBeDefined();
    expect(adv!.level).toBe('warning');
    expect((adv!.data as { operator_status: string }).operator_status).toBe('rejected');
  });

  it('operator_id exposé et PAS d\'OPERATOR_UNVERIFIED quand operator verified', async () => {
    const ctx = setupVerdictWithOperator();
    db = ctx.db;
    const pubkey = '02' + 'd'.repeat(64);
    ctx.agentRepo.insert(makeAgentWithPubkey(pubkey));
    const opId = 'op-verdict-verified';
    ctx.operatorService.upsertOperator(opId);
    ctx.operatorService.claimOwnership(opId, 'node', pubkey);
    // 2/3 preuves suffisent (règle dure).
    ctx.operatorService.claimIdentity(opId, 'ln_pubkey', pubkey);
    ctx.operatorService.markIdentityVerified(opId, 'ln_pubkey', pubkey, 'proof-ln');
    ctx.operatorService.claimIdentity(opId, 'nip05', 'op@example.com');
    ctx.operatorService.markIdentityVerified(opId, 'nip05', 'op@example.com', 'proof-nip05');

    const v = await ctx.verdictService.getVerdict(sha256(pubkey));
    expect(v.operator_id).toBe(opId);
    expect(v.advisories.find(a => a.code === 'OPERATOR_UNVERIFIED')).toBeUndefined();
  });

  it('operator_id=null quand agent n\'a pas de public_key (pas de lookup possible)', async () => {
    const ctx = setupVerdictWithOperator();
    db = ctx.db;
    const hash = sha256('no-pubkey-agent');
    ctx.agentRepo.insert({
      ...makeAgentWithPubkey('unused'),
      public_key_hash: hash,
      public_key: null,
    });

    const v = await ctx.verdictService.getVerdict(hash);
    expect(v.operator_id).toBeNull();
  });
});
