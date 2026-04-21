#!/usr/bin/env node
// Batch-port common SQLite→Postgres test patterns we can verify deterministically.
// Run: node tools/port-tests-batch.mjs [file1 file2 ...]
// No arg: processes all src/tests/**/*.test.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { argv } from 'node:process';

const files = argv.slice(2).length
  ? argv.slice(2)
  : execSync('find src/tests -name "*.test.ts"').toString().trim().split('\n');

let totalChanges = 0;
for (const f of files) {
  const before = readFileSync(f, 'utf8');
  let s = before;
  let changes = 0;

  // 1. Stray `afterEach(async () => { db?.close(); });` → remove
  if (s.match(/^\s*afterEach\(async \(\) => \{\s*db\?\.close\(\);\s*\}\);/m)) {
    s = s.replace(/^\s*afterEach\(async \(\) => \{\s*db\?\.close\(\);\s*\}\);\s*\n/gm, '');
    changes++;
  }

  // 2. Lone `db.close();` or `db?.close();` — Pool has no close()
  s = s.replace(/^[ \t]*db\?\.close\(\);\s*\n/gm, (m) => { changes++; return ''; });
  s = s.replace(/^[ \t]*db\.close\(\);\s*\n/gm, (m) => { changes++; return ''; });
  s = s.replace(/^[ \t]*ctx\.db\.close\(\);\s*\n/gm, (m) => { changes++; return ''; });

  // 3. Stray malformed indent: `\n    db = testDb.pool;\nVARNAME = ...;`
  // Pattern: after `db = testDb.pool;` a line like `serviceRepo = ...` without leading indent.
  s = s.replace(/(    db = testDb\.pool;\n)([A-Za-z_][A-Za-z0-9_]*\s*=)/g, (m, p1, p2) => {
    changes++;
    return p1 + '    ' + p2;
  });

  // 4. Stray malformed indent: `db = testDb.pool;\nconst agentRepo = ...`
  s = s.replace(/(    db = testDb\.pool;\n)(const )/g, (m, p1, p2) => {
    changes++;
    return p1 + '    ' + p2;
  });

  // 5. Hanging `});` missing indent after the pool line block
  //    `beforeEach(async () => {\n    testDb = await setupTestPool();\n\n    db = testDb.pool;\nfoo = ...;\n    bar = ...;\n  });`
  // Too contextual — skip.

  if (changes > 0) {
    writeFileSync(f, s);
    console.log(`${f}: ${changes} changes`);
    totalChanges += changes;
  }
}
console.log(`Total changes: ${totalChanges}`);
