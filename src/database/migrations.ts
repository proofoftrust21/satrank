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

  logger.info('Migrations executed successfully');
}

// --- Rollback (down) functions ---
// Each down() reverses the corresponding up() migration.
// SQLite limitations: ALTER TABLE DROP COLUMN requires SQLite 3.35+.
// For older versions, the column simply remains (harmless).

const downMigrations: Record<number, (db: Database.Database) => void> = {
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
