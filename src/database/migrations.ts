// Schema and index creation with version tracking
import type Database from 'better-sqlite3';
import { logger } from '../logger';

/** Returns true if the given version has already been applied. */
function hasVersion(db: Database.Database, version: number): boolean {
  const row = db.prepare('SELECT 1 AS found FROM schema_version WHERE version = ?').get(version) as unknown;
  return row !== undefined;
}

/** Records a migration version. */
function recordVersion(db: Database.Database, version: number, description: string): void {
  db.prepare('INSERT INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)').run(
    version,
    new Date().toISOString(),
    description,
  );
}

export function runMigrations(db: Database.Database): void {
  // schema_version table — must exist before anything else
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL,
      description TEXT NOT NULL
    );
  `);

  // v1: Core tables + indexes
  if (!hasVersion(db, 1)) {
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
    recordVersion(db, 1, 'Core tables: agents, transactions, attestations, score_snapshots');
  }

  // v2: capacity_sats column for Lightning graph nodes
  if (!hasVersion(db, 2)) {
    try {
      db.exec('ALTER TABLE agents ADD COLUMN capacity_sats INTEGER DEFAULT NULL');
    } catch {
      // Column already exists (upgrading from pre-versioned schema)
    }
    recordVersion(db, 2, 'Add capacity_sats to agents');
  }

  // v3: LN+ ratings, original pubkey, query count
  if (!hasVersion(db, 3)) {
    const v3Columns: [string, string][] = [
      ['public_key', 'TEXT DEFAULT NULL'],
      ['positive_ratings', 'INTEGER NOT NULL DEFAULT 0'],
      ['negative_ratings', 'INTEGER NOT NULL DEFAULT 0'],
      ['lnplus_rank', 'INTEGER NOT NULL DEFAULT 0'],
      ['query_count', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [col, def] of v3Columns) {
      try {
        db.exec(`ALTER TABLE agents ADD COLUMN ${col} ${def}`);
      } catch {
        // Column already exists
      }
    }
    recordVersion(db, 3, 'Add LN+ ratings, public_key, query_count to agents');
  }

  // v4: LN+ graph centrality ranks
  if (!hasVersion(db, 4)) {
    const v4Columns: [string, string][] = [
      ['hubness_rank', 'INTEGER NOT NULL DEFAULT 0'],
      ['betweenness_rank', 'INTEGER NOT NULL DEFAULT 0'],
      ['hopness_rank', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [col, def] of v4Columns) {
      try {
        db.exec(`ALTER TABLE agents ADD COLUMN ${col} ${def}`);
      } catch {
        // Column already exists
      }
    }
    recordVersion(db, 4, 'Add centrality ranks to agents');
  }

  // v5: CHECK constraint triggers + source/pubkey indexes
  if (!hasVersion(db, 5)) {
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
    recordVersion(db, 5, 'CHECK constraint triggers and source/pubkey indexes');
  }

  // v6: UNIQUE constraint on (attester_hash, subject_hash) to prevent cross-tx duplicate attestations
  if (!hasVersion(db, 6)) {
    // Deduplicate existing data: keep the most recent attestation per (attester, subject) pair
    db.exec(`
      DELETE FROM attestations WHERE rowid NOT IN (
        SELECT MAX(rowid) FROM attestations GROUP BY attester_hash, subject_hash
      )
    `);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_attestations_unique_attester_subject ON attestations(attester_hash, subject_hash)');
    recordVersion(db, 6, 'UNIQUE constraint on attestations(attester_hash, subject_hash)');
  }

  // v7: ON DELETE CASCADE for attestations.tx_id → transactions.tx_id
  // SQLite doesn't support ALTER CONSTRAINT, so we recreate the table with the new FK.
  // Wrapped in a transaction: DROP+RENAME must be atomic to avoid losing the table on crash.
  if (!hasVersion(db, 7)) {
    db.transaction(() => {
    db.exec(`
      CREATE TABLE attestations_new (
        attestation_id TEXT PRIMARY KEY,
        tx_id TEXT NOT NULL REFERENCES transactions(tx_id) ON DELETE CASCADE,
        attester_hash TEXT NOT NULL REFERENCES agents(public_key_hash),
        subject_hash TEXT NOT NULL REFERENCES agents(public_key_hash),
        score INTEGER NOT NULL CHECK(score >= 0 AND score <= 100),
        tags TEXT,
        evidence_hash TEXT,
        timestamp INTEGER NOT NULL,
        UNIQUE(tx_id, attester_hash)
      );

      INSERT INTO attestations_new SELECT * FROM attestations;

      DROP TABLE attestations;
      ALTER TABLE attestations_new RENAME TO attestations;

      -- Recreate indexes lost during table swap
      CREATE INDEX IF NOT EXISTS idx_attestations_subject ON attestations(subject_hash);
      CREATE INDEX IF NOT EXISTS idx_attestations_attester ON attestations(attester_hash);
      CREATE INDEX IF NOT EXISTS idx_attestations_timestamp ON attestations(timestamp);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_attestations_unique_attester_subject ON attestations(attester_hash, subject_hash);
    `);
    recordVersion(db, 7, 'ON DELETE CASCADE for attestations.tx_id FK');
    })();
  }

  // v8: Composite index on score_snapshots for efficient delta queries
  if (!hasVersion(db, 8)) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_snapshots_agent_computed ON score_snapshots(agent_hash, computed_at)');
    recordVersion(db, 8, 'Composite index on score_snapshots(agent_hash, computed_at) for delta queries');
  }

  // v9: category column on attestations for structured negative feedback
  if (!hasVersion(db, 9)) {
    try {
      db.exec("ALTER TABLE attestations ADD COLUMN category TEXT NOT NULL DEFAULT 'general'");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column name')) throw err;
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_attestations_category ON attestations(category)');
    recordVersion(db, 9, 'Add category column to attestations for structured negative feedback');
  }

  // v10: probe_results table for route probing data
  if (!hasVersion(db, 10)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS probe_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_hash TEXT NOT NULL REFERENCES agents(public_key_hash),
        probed_at INTEGER NOT NULL,
        reachable INTEGER NOT NULL DEFAULT 0 CHECK(reachable IN (0, 1)),
        latency_ms INTEGER,
        hops INTEGER,
        estimated_fee_msat INTEGER,
        failure_reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_probe_target ON probe_results(target_hash);
      CREATE INDEX IF NOT EXISTS idx_probe_target_time ON probe_results(target_hash, probed_at);
    `);
    recordVersion(db, 10, 'Probe results table for route probing data');
  }

  // v11: v2 report support — verified/weight columns, relax unique constraint
  // C5: wrapped in transaction so partial failure doesn't leave schema in limbo
  if (!hasVersion(db, 11)) {
    db.transaction(() => {
      db.exec('DROP INDEX IF EXISTS idx_attestations_unique_attester_subject');

      const v11Columns: [string, string][] = [
        ['verified', 'INTEGER NOT NULL DEFAULT 0'],
        ['weight', 'REAL NOT NULL DEFAULT 1.0'],
      ];
      for (const [col, def] of v11Columns) {
        try {
          db.exec(`ALTER TABLE attestations ADD COLUMN ${col} ${def}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('duplicate column name')) throw err;
        }
      }

      db.exec('CREATE INDEX IF NOT EXISTS idx_attestations_attester_subject_time ON attestations(attester_hash, subject_hash, timestamp)');
      recordVersion(db, 11, 'v2 report support: verified/weight columns, relax unique constraint for multi-report');
    })();
  }

  // v12: channel_snapshots + fee_snapshots for predictive signals + unique_peers column
  if (!hasVersion(db, 12)) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS channel_snapshots (
          agent_hash TEXT NOT NULL,
          channel_count INTEGER NOT NULL,
          capacity_sats INTEGER NOT NULL,
          snapshot_at INTEGER NOT NULL
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_channel_snapshots_agent ON channel_snapshots(agent_hash, snapshot_at)');

      db.exec(`
        CREATE TABLE IF NOT EXISTS fee_snapshots (
          channel_id TEXT NOT NULL,
          node1_pub TEXT NOT NULL,
          node2_pub TEXT NOT NULL,
          fee_base_msat INTEGER NOT NULL,
          fee_rate_ppm INTEGER NOT NULL,
          snapshot_at INTEGER NOT NULL
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_fee_snapshots_node ON fee_snapshots(node1_pub, snapshot_at)');

      // unique_peers column for diversity scoring (number of distinct peers)
      try {
        db.exec('ALTER TABLE agents ADD COLUMN unique_peers INTEGER');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('duplicate column name')) throw err;
      }

      recordVersion(db, 12, 'Channel/fee snapshots, unique_peers for diversity scoring');
    })();
  }

  // v13: last_queried_at for hot node priority probing + performance indexes
  if (!hasVersion(db, 13)) {
    try {
      db.exec('ALTER TABLE agents ADD COLUMN last_queried_at INTEGER');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column name')) throw err;
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_agents_score ON agents(avg_score DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_probe_reachable ON probe_results(reachable, probed_at)');
    recordVersion(db, 13, 'last_queried_at, performance indexes for stats/leaderboard');
  }

  // v14: stale flag for fossil agents (not seen in 90+ days)
  // Post-bitcoind migration cleanup — the DB inherited ~4k fossils from the old Voltage node.
  // Soft-flagged only: history preserved, stale=0 is restored automatically when the crawler
  // or a probe sees the agent again.
  if (!hasVersion(db, 14)) {
    db.transaction(() => {
      try {
        db.exec('ALTER TABLE agents ADD COLUMN stale INTEGER NOT NULL DEFAULT 0');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('duplicate column name')) throw err;
      }
      // Recompute the stale flag for every existing row from last_seen
      const cutoff = Math.floor(Date.now() / 1000) - 90 * 86400;
      db.prepare('UPDATE agents SET stale = CASE WHEN last_seen < ? THEN 1 ELSE 0 END').run(cutoff);
      db.exec('CREATE INDEX IF NOT EXISTS idx_agents_stale ON agents(stale)');
      // Composite index for the leaderboard / top-by-score hot path with stale filter
      db.exec('CREATE INDEX IF NOT EXISTS idx_agents_stale_score ON agents(stale, avg_score DESC)');
      recordVersion(db, 14, 'Add stale flag for fossil agents (not seen in 90+ days)');
    })();
  }

  // v15: unique_peers column for diversity scoring.
  // v12 recorded this column but it never actually landed on the production schema
  // (the ALTER inside v12 was silently dropped somehow — schema_version says v12 is
  // applied, PRAGMA table_info shows no unique_peers column). v15 re-adds it
  // idempotently so new and existing deployments converge on the same schema.
  // The column is nullable so existing rows stay null and fall back to the BTC-based
  // diversity formula until the crawler fills them in with real peer counts.
  if (!hasVersion(db, 15)) {
    try {
      db.exec('ALTER TABLE agents ADD COLUMN unique_peers INTEGER');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column name')) throw err;
    }
    recordVersion(db, 15, 'Add unique_peers column to agents (recovers failed v12 ALTER)');
  }

  // v16: Composite index on fee_snapshots for dedup lookup
  if (!hasVersion(db, 16)) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_fee_snapshots_channel ON fee_snapshots(channel_id, node1_pub, snapshot_at)');
    recordVersion(db, 16, 'Composite index on fee_snapshots(channel_id, node1_pub, snapshot_at) for dedup lookup');
  }

  // v20: probe_amount_sats column for multi-amount probing.
  // Probes at 1k/10k/100k/1M sats reveal the max routable amount per node.
  // v22: service_endpoints for HTTP health tracking (sovereign oracle)
  if (!hasVersion(db, 22)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS service_endpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_hash TEXT,
        url TEXT NOT NULL UNIQUE,
        last_http_status INTEGER,
        last_latency_ms INTEGER,
        last_checked_at INTEGER,
        check_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_service_endpoints_url ON service_endpoints(url)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_service_endpoints_checked ON service_endpoints(last_checked_at)');
    recordVersion(db, 22, 'service_endpoints table for HTTP health tracking');
  }

  // v21: token_balance for L402 quota system (21 requests per token)
  if (!hasVersion(db, 21)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS token_balance (
        payment_hash BLOB PRIMARY KEY,
        remaining INTEGER NOT NULL DEFAULT 21,
        created_at INTEGER NOT NULL
      )
    `);
    recordVersion(db, 21, 'token_balance table for L402 quota system');
  }

  if (!hasVersion(db, 20)) {
    try { db.exec('ALTER TABLE probe_results ADD COLUMN probe_amount_sats INTEGER DEFAULT 1000'); } catch { /* column already exists */ }
    recordVersion(db, 20, 'probe_amount_sats column on probe_results for multi-amount probing');
  }

  // v19: probed_at index for countProbesLast24h — the query
  // `SELECT COUNT(*) FROM probe_results WHERE probed_at >= ?` was doing a
  // full table scan on 1.7M rows (~24s). The existing indexes start with
  // target_hash so they can't be used for a probed_at-only filter.
  if (!hasVersion(db, 19)) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_probe_time ON probe_results(probed_at)');
    recordVersion(db, 19, 'idx_probe_time on probe_results(probed_at) for countProbesLast24h performance');
  }

  // v18: pagerank_score for sovereign centrality (replaces LN+ dependency)
  if (!hasVersion(db, 18)) {
    try { db.exec('ALTER TABLE agents ADD COLUMN pagerank_score REAL DEFAULT NULL'); } catch { /* column already exists */ }
    recordVersion(db, 18, 'pagerank_score column on agents — sovereign centrality replacing LN+ dependency');
  }

  // v17: disabled_channels column on agents for probe failure classification.
  // Tracks how many of a node's channel directions are disabled in gossip.
  // Combined with probe reachability: unreachable + high disabled_channels = dead node.
  if (!hasVersion(db, 17)) {
    try { db.exec('ALTER TABLE agents ADD COLUMN disabled_channels INTEGER NOT NULL DEFAULT 0'); } catch { /* column already exists */ }
    recordVersion(db, 17, 'disabled_channels column on agents for probe failure classification');
  }

  logger.info('Migrations executed successfully');
}

// --- Rollback (down) functions ---
// Each down() reverses the corresponding up() migration.
// SQLite limitations: ALTER TABLE DROP COLUMN requires SQLite 3.35+.
// For older versions, the column simply remains (harmless).

const downMigrations: Record<number, (db: Database.Database) => void> = {
  20: (db) => {
    try { db.exec('ALTER TABLE probe_results DROP COLUMN probe_amount_sats'); } catch { /* SQLite < 3.35 */ }
  },
  19: (db) => {
    db.exec('DROP INDEX IF EXISTS idx_probe_time');
  },
  18: (db) => {
    try { db.exec('ALTER TABLE agents DROP COLUMN pagerank_score'); } catch { /* SQLite < 3.35 */ }
  },
  17: (db) => {
    try { db.exec('ALTER TABLE agents DROP COLUMN disabled_channels'); } catch { /* SQLite < 3.35 */ }
  },
  16: (db) => {
    db.exec('DROP INDEX IF EXISTS idx_fee_snapshots_channel');
  },
  15: (db) => {
    try { db.exec('ALTER TABLE agents DROP COLUMN unique_peers'); } catch { /* SQLite < 3.35 or column never existed */ }
  },
  14: (db) => {
    db.exec('DROP INDEX IF EXISTS idx_agents_stale_score');
    db.exec('DROP INDEX IF EXISTS idx_agents_stale');
    try { db.exec('ALTER TABLE agents DROP COLUMN stale'); } catch { /* SQLite < 3.35 */ }
  },
  13: (db) => {
    try { db.exec('ALTER TABLE agents DROP COLUMN last_queried_at'); } catch { /* SQLite < 3.35 */ }
  },
  12: (db) => {
    db.exec('DROP TABLE IF EXISTS fee_snapshots');
    db.exec('DROP TABLE IF EXISTS channel_snapshots');
  },
  11: (db) => {
    db.exec('DROP INDEX IF EXISTS idx_attestations_attester_subject_time');
    try { db.exec('ALTER TABLE attestations DROP COLUMN verified'); } catch { /* SQLite < 3.35 */ }
    try { db.exec('ALTER TABLE attestations DROP COLUMN weight'); } catch { /* SQLite < 3.35 */ }
    // Restore the unique index (deduplicate first)
    db.exec(`
      DELETE FROM attestations WHERE rowid NOT IN (
        SELECT MAX(rowid) FROM attestations GROUP BY attester_hash, subject_hash
      )
    `);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_attestations_unique_attester_subject ON attestations(attester_hash, subject_hash)');
  },
  10: (db) => {
    db.exec('DROP TABLE IF EXISTS probe_results');
  },
  9: (db) => {
    db.exec('DROP INDEX IF EXISTS idx_attestations_category');
    try { db.exec('ALTER TABLE attestations DROP COLUMN category'); } catch { /* SQLite < 3.35 */ }
  },
  8: (db) => {
    db.exec('DROP INDEX IF EXISTS idx_snapshots_agent_computed');
  },
  7: (db) => {
    // Revert to attestations table without ON DELETE CASCADE
    db.exec(`
      CREATE TABLE IF NOT EXISTS attestations_old (
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

      INSERT INTO attestations_old SELECT * FROM attestations;

      DROP TABLE attestations;
      ALTER TABLE attestations_old RENAME TO attestations;

      CREATE INDEX IF NOT EXISTS idx_attestations_subject ON attestations(subject_hash);
      CREATE INDEX IF NOT EXISTS idx_attestations_attester ON attestations(attester_hash);
      CREATE INDEX IF NOT EXISTS idx_attestations_timestamp ON attestations(timestamp);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_attestations_unique_attester_subject ON attestations(attester_hash, subject_hash);
    `);
  },
  6: (db) => {
    db.exec('DROP INDEX IF EXISTS idx_attestations_unique_attester_subject');
  },
  5: (db) => {
    db.exec(`
      DROP TRIGGER IF EXISTS trg_agents_ratings_check;
      DROP TRIGGER IF EXISTS trg_agents_ratings_check_insert;
      DROP INDEX IF EXISTS idx_agents_source;
      DROP INDEX IF EXISTS idx_agents_public_key;
    `);
  },
  4: (db) => {
    for (const col of ['hubness_rank', 'betweenness_rank', 'hopness_rank']) {
      try { db.exec(`ALTER TABLE agents DROP COLUMN ${col}`); } catch { /* SQLite < 3.35 */ }
    }
  },
  3: (db) => {
    for (const col of ['public_key', 'positive_ratings', 'negative_ratings', 'lnplus_rank', 'query_count']) {
      try { db.exec(`ALTER TABLE agents DROP COLUMN ${col}`); } catch { /* SQLite < 3.35 */ }
    }
  },
  2: (db) => {
    // capacity_sats was added in v2 but also exists in v1 CREATE TABLE — only drop if it was added by v2
    try { db.exec('ALTER TABLE agents DROP COLUMN capacity_sats'); } catch { /* SQLite < 3.35 */ }
  },
  1: (db) => {
    db.exec(`
      DROP TABLE IF EXISTS score_snapshots;
      DROP TABLE IF EXISTS attestations;
      DROP TABLE IF EXISTS transactions;
      DROP TABLE IF EXISTS agents;
    `);
  },
  21: (db) => {
    db.exec('DROP TABLE IF EXISTS token_balance');
  },
  22: (db) => {
    db.exec('DROP TABLE IF EXISTS service_endpoints');
  },
};

/** Rolls back migrations from current to target version (exclusive).
 *  E.g., rollbackTo(db, 4) with current=6 runs down(6), down(5).
 *  The entire rollback is wrapped in a transaction for atomicity. */
export function rollbackTo(db: Database.Database, targetVersion: number): void {
  const applied = getAppliedVersions(db);
  const toRollback = applied
    .map(v => v.version)
    .filter(v => v > targetVersion)
    .sort((a, b) => b - a); // descending

  // Validate all rollback functions exist before starting
  for (const version of toRollback) {
    if (!downMigrations[version]) {
      throw new Error(`No rollback function for migration v${version}`);
    }
  }

  const rollback = db.transaction(() => {
    for (const version of toRollback) {
      const down = downMigrations[version]!;
      logger.info({ version }, 'Rolling back migration');
      down(db);
      db.prepare('DELETE FROM schema_version WHERE version = ?').run(version);
    }
  });

  rollback();
  logger.info({ target: targetVersion, rolled: toRollback }, 'Rollback complete');
}

/** Returns all applied migration versions (for testing/inspection). */
export function getAppliedVersions(db: Database.Database): { version: number; applied_at: string; description: string }[] {
  try {
    return db.prepare('SELECT version, applied_at, description FROM schema_version ORDER BY version').all() as {
      version: number;
      applied_at: string;
      description: string;
    }[];
  } catch {
    return [];
  }
}
