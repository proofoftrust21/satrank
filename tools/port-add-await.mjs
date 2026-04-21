#!/usr/bin/env node
// Add `await` to calls of methods that are now async (returned Promise).
// Scope: only tests that passed initial visual checks in this batch.
//
// Strategy:
//   - Parse the source textually for specific LHS patterns:
//     * `const X = scoring.computeScore(...)` → `const X = await scoring.computeScore(...)`
//     * `const X = repo.findByHash(...)` → `const X = await repo.findByHash(...)`
//     * `expect(scoring.computeScore(...)).` → `expect(await scoring.computeScore(...)).`
//   - Do NOT modify lines already containing `await`.
//   - Do NOT modify lines inside type definitions (heuristic: skip `interface`, `type X = `).
//
// Run: node tools/port-add-await.mjs <file...>

import { readFileSync, writeFileSync } from 'node:fs';
import { argv } from 'node:process';

const METHOD_PATTERNS = [
  // ScoringService
  'scoring\\.computeScore', 'scoringService\\.computeScore',
  'scoring\\.getScore', 'scoringService\\.getScore',
  // Repos - read methods returning Promise
  '\\w*[rR]epo\\.findByHash', '\\w*[rR]epo\\.findById', '\\w*[rR]epo\\.findByAgent',
  '\\w*[rR]epo\\.findByOperator', '\\w*[rR]epo\\.findByPubkey',
  '\\w*[rR]epo\\.findAll', '\\w*[rR]epo\\.findLatest\\w*',
  '\\w*[rR]epo\\.findRecent\\w*', '\\w*[rR]epo\\.findBy\\w*',
  '\\w*[rR]epo\\.count\\w*', '\\w*[rR]epo\\.list\\w*', '\\w*[rR]epo\\.get\\w*',
  '\\w*[rR]epo\\.insert', '\\w*[rR]epo\\.update\\w*', '\\w*[rR]epo\\.delete\\w*',
  '\\w*[rR]epo\\.upsert\\w*',
  '\\w*[rR]epository\\.findByHash', '\\w*[rR]epository\\.findById',
  // Bayesian service
  'bayesian\\.\\w+', 'bayesianService\\.\\w+', 'bayesianVerdict\\.\\w+',
  'verdict\\.buildVerdict', 'verdictService\\.\\w+',
  // Other common services
  'operatorService\\.\\w+', 'service\\.\\w+',
];

const ASYNC_CALL_RE = new RegExp(
  `(?<!await\\s)(?<!\\.)(?<![A-Za-z_])((?:${METHOD_PATTERNS.join('|')})\\s*\\()`,
  'g',
);

let totalChanges = 0;
for (const f of argv.slice(2)) {
  const before = readFileSync(f, 'utf8');
  const lines = before.split('\n');
  let changes = 0;
  for (let i = 0; i < lines.length; i++) {
    let ln = lines[i];
    // skip type/interface lines
    if (/^\s*(interface|type\s+\w+\s*=)/.test(ln)) continue;
    // skip imports
    if (/^\s*import\b/.test(ln)) continue;
    // skip lines that already have `await`
    if (/\bawait\b/.test(ln)) {
      // Could have a second call on same line lacking await — skip conservatively
      continue;
    }
    // Property access on a call's result: `.scoring.computeScore(...).total`
    // Detect: pattern `scoring.computeScore(arg1).member` → wrap in await and parens
    // Simplified: if line contains `<method>(...)` but no await, prepend await to the LHS.
    const mExpect = ln.match(/^(\s*)expect\((([A-Za-z_][A-Za-z0-9_]*\.)+[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\))\)/);
    // Too risky. Skip expect(...) patterns; user will review.
  }
  // Don't auto-apply — this script is a reconnaissance tool.
}
console.log('This script is exploratory — no files modified. See manual fixes.');
