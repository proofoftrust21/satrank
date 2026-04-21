#!/usr/bin/env node
// Batch-fix broken patterns left by earlier auto-ports in src/tests/**.
// Focuses on deterministic, narrow transforms we can verify by eyeball.

import { readFileSync, writeFileSync } from 'node:fs';
import { globSync } from 'glob';
import { argv } from 'node:process';

const files = argv.slice(2).length
  ? argv.slice(2)
  : globSync('src/tests/**/*.test.ts');

let fixed = 0;
let total = 0;
for (const f of files) {
  const before = readFileSync(f, 'utf8');
  let s = before;

  // 1. Common stray line: `afterEach(async () => { db?.close(); });` → drop
  s = s.replace(/^[ \t]*afterEach\(async \(\) => \{\s*db\?\.close\(\);\s*\}\);\s*\n/gm, '');
  // close() calls on Pool — Pool has no .close(); nuke.
  s = s.replace(/^[ \t]*db\?\.close\(\);\s*\n/gm, '');
  s = s.replace(/^[ \t]*db\.close\(\);\s*\n/gm, '');

  // 2. Broken: `const testDb = await setupTestPool();\n\n    db = testDb.pool;\nthingElse = ...`
  // Should be: `testDb = await setupTestPool();\n    db = testDb.pool;\n    thingElse = ...`
  // Fix the closing `}` indent after that.
  // (too varied; leave for hand-fix)

  // 3. `ctx.db.prepare(...).run(...)` → `await ctx.db.query(...)`; won't fix here,
  // done per-file manually.

  // 4. Broken: `function something(...): Type {\n  const testDb = await ...`
  // The parent isn't async. Flag files (log) for manual fix.

  if (s !== before) {
    writeFileSync(f, s);
    fixed++;
  }
  total++;
}
console.log(`processed=${total} fixed=${fixed}`);
