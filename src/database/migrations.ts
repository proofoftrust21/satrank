// Schema and index creation
import type Database from 'better-sqlite3';
import { logger } from '../logger';

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      public_key_hash TEXT PRIMARY KEY,
      alias TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('observer_protocol', '4tress', 'lightning_graph', 'manual')),
      total_transactions INTEGER NOT NULL DEFAULT 0,
      total_attestations_received INTEGER NOT NULL DEFAULT 0,
      avg_score REAL NOT NULL DEFAULT 0,
      capacity_sats INTEGER DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      tx_id TEXT PRIMARY KEY,
      sender_hash TEXT NOT NULL REFERENCES agents(public_key_hash),
      receiver_hash TEXT NOT NULL REFERENCES agents(public_key_hash),
      amount_bucket TEXT NOT NULL CHECK(amount_bucket IN ('micro', 'small', 'medium', 'large')),
      timestamp INTEGER NOT NULL,
      payment_hash TEXT NOT NULL,
      preimage TEXT,
      status TEXT NOT NULL CHECK(status IN ('verified', 'pending', 'failed', 'disputed')),
      protocol TEXT NOT NULL CHECK(protocol IN ('l402', 'keysend', 'bolt11'))
    );

    CREATE TABLE IF NOT EXISTS attestations (
      attestation_id TEXT PRIMARY KEY,
      tx_id TEXT NOT NULL REFERENCES transactions(tx_id),
      attester_hash TEXT NOT NULL REFERENCES agents(public_key_hash),
      subject_hash TEXT NOT NULL REFERENCES agents(public_key_hash),
      score INTEGER NOT NULL CHECK(score >= 0 AND score <= 100),
      tags TEXT,
      evidence_hash TEXT,
      timestamp INTEGER NOT NULL,
      UNIQUE(tx_id, attester_hash)
    );

    CREATE TABLE IF NOT EXISTS score_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      agent_hash TEXT NOT NULL REFERENCES agents(public_key_hash),
      score REAL NOT NULL,
      components TEXT NOT NULL,
      computed_at INTEGER NOT NULL
    );

    -- Indexes for frequent queries
    CREATE INDEX IF NOT EXISTS idx_transactions_sender ON transactions(sender_hash);
    CREATE INDEX IF NOT EXISTS idx_transactions_receiver ON transactions(receiver_hash);
    CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp);
    CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_attestations_subject ON attestations(subject_hash);
    CREATE INDEX IF NOT EXISTS idx_attestations_attester ON attestations(attester_hash);
    CREATE INDEX IF NOT EXISTS idx_attestations_timestamp ON attestations(timestamp);
    CREATE INDEX IF NOT EXISTS idx_snapshots_agent ON score_snapshots(agent_hash);
    CREATE INDEX IF NOT EXISTS idx_snapshots_computed ON score_snapshots(computed_at);
    CREATE INDEX IF NOT EXISTS idx_agents_alias ON agents(alias);
  `);

  // v0.2: add capacity_sats column for Lightning graph nodes
  try {
    db.exec('ALTER TABLE agents ADD COLUMN capacity_sats INTEGER DEFAULT NULL');
  } catch {
    // Column already exists
  }

  // v0.3: LN+ ratings, original pubkey, query count
  const v03Columns: [string, string][] = [
    ['public_key', 'TEXT DEFAULT NULL'],
    ['positive_ratings', 'INTEGER NOT NULL DEFAULT 0'],
    ['negative_ratings', 'INTEGER NOT NULL DEFAULT 0'],
    ['lnplus_rank', 'INTEGER NOT NULL DEFAULT 0'],
    ['query_count', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [col, def] of v03Columns) {
    try {
      db.exec(`ALTER TABLE agents ADD COLUMN ${col} ${def}`);
    } catch {
      // Column already exists
    }
  }

  // v0.4: LN+ graph centrality ranks
  const v04Columns: [string, string][] = [
    ['hubness_rank', 'INTEGER NOT NULL DEFAULT 0'],
    ['betweenness_rank', 'INTEGER NOT NULL DEFAULT 0'],
    ['hopness_rank', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [col, def] of v04Columns) {
    try {
      db.exec(`ALTER TABLE agents ADD COLUMN ${col} ${def}`);
    } catch {
      // Column already exists
    }
  }

  // v0.5: CHECK constraints on rating/rank columns + indexes for crawler queries
  // SQLite doesn't support ADD CONSTRAINT on existing columns, so we enforce via triggers
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_agents_ratings_check
    BEFORE UPDATE ON agents
    FOR EACH ROW
    WHEN NEW.positive_ratings < 0 OR NEW.negative_ratings < 0
      OR NEW.lnplus_rank < 0 OR NEW.lnplus_rank > 10
      OR NEW.hubness_rank < 0 OR NEW.betweenness_rank < 0 OR NEW.hopness_rank < 0
    BEGIN
      SELECT RAISE(ABORT, 'Invalid rating or rank value');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_agents_ratings_check_insert
    BEFORE INSERT ON agents
    FOR EACH ROW
    WHEN NEW.positive_ratings < 0 OR NEW.negative_ratings < 0
      OR NEW.lnplus_rank < 0 OR NEW.lnplus_rank > 10
      OR NEW.hubness_rank < 0 OR NEW.betweenness_rank < 0 OR NEW.hopness_rank < 0
    BEGIN
      SELECT RAISE(ABORT, 'Invalid rating or rank value');
    END;

    CREATE INDEX IF NOT EXISTS idx_agents_source ON agents(source);
    CREATE INDEX IF NOT EXISTS idx_agents_public_key ON agents(public_key);
  `);

  logger.info('Migrations executed successfully');
}
