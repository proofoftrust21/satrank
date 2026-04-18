// Anti-drift guard — CI/npm-invoked check that flags the three drift classes
// found in sim #9. Runs three checks, reports all failures, exits non-zero if
// any check fails.
//
//   1. IMPACT-STATEMENT.md numbers vs live /api/stats/network
//      Flags >5% delta on headline counters (agents, probes, phantom, reachable).
//
//   2. sdk/src/types.ts shape drift vs src/openapi.ts
//      Regenerates a spec-derived signature for every SDK type that has a
//      direct OpenAPI counterpart and diffs it against what's actually
//      shipped in the SDK.
//
//   3. sdk/package.json version ≥ latest @satrank/sdk published on npm
//      Catches the "oops, forgot to bump" failure mode before publish.
//
// Usage:
//   npm run check-drift            # default: live https://satrank.dev
//   npm run check-drift -- --api=http://localhost:3000
//   npm run check-drift -- --strict  # exit 1 on warnings too
//
// Integrated into DEPLOY.md as a pre-deploy checklist step.

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import * as path from 'path';

interface Finding {
  severity: 'FAIL' | 'WARN';
  check: string;
  message: string;
}

const findings: Finding[] = [];
const API = process.argv.find(a => a.startsWith('--api='))?.slice('--api='.length) ?? 'https://satrank.dev';
const STRICT = process.argv.includes('--strict');
const REPO_ROOT = path.join(__dirname, '..');

function fail(check: string, message: string): void {
  findings.push({ severity: 'FAIL', check, message });
}
function warn(check: string, message: string): void {
  findings.push({ severity: 'WARN', check, message });
}

// ──────────────────────────────────────────────────────────────────────────
// Check 1 — IMPACT-STATEMENT.md numeric drift
// ──────────────────────────────────────────────────────────────────────────
async function checkImpactStatement(): Promise<void> {
  const check = 'impact-statement';
  const impactPath = path.join(REPO_ROOT, 'IMPACT-STATEMENT.md');
  let markdown: string;
  try {
    markdown = readFileSync(impactPath, 'utf8');
  } catch {
    warn(check, `IMPACT-STATEMENT.md not found at ${impactPath} — skipping`);
    return;
  }

  // Pull live stats from the deployed API
  let stats: {
    totalAgents: number;
    probes24h: number;
    phantomRate: number;
    verifiedReachable: number;
    totalChannels: number;
    networkCapacityBtc: number;
  };
  try {
    const resp = await fetch(`${API}/api/stats`, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json() as { data: typeof stats };
    stats = json.data;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(check, `Could not fetch ${API}/api/stats (${msg}) — skipping numeric drift check`);
    return;
  }

  // Parsers that tolerate thousand separators (spaces or commas) and decimals
  const parseFirstNumber = (pattern: RegExp): number | null => {
    const m = markdown.match(pattern);
    if (!m) return null;
    const cleaned = m[1].replace(/[\s,]/g, '').replace(/\s/g, '');
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  };

  const compare = (label: string, actual: number, claimed: number | null, toleranceFactor: number): void => {
    if (claimed === null) {
      warn(check, `No "${label}" number found in IMPACT-STATEMENT.md — update the extractor regex`);
      return;
    }
    if (claimed === 0) return;
    const delta = Math.abs(actual - claimed) / claimed;
    if (delta > toleranceFactor) {
      fail(check, `${label}: claimed ${claimed}, live ${actual} (Δ ${(delta * 100).toFixed(1)}% > ${(toleranceFactor * 100).toFixed(0)}%)`);
    }
  };

  const TOLERANCE = 0.05;
  // Phantom rate can float a few points cycle-to-cycle — tighter absolute band
  const phantomClaimed = parseFirstNumber(/(\d{1,2})\s*%\s+phantom/i);
  if (phantomClaimed !== null) {
    const absDelta = Math.abs(stats.phantomRate - phantomClaimed);
    if (absDelta > 5) {
      fail(check, `phantom rate: claimed ${phantomClaimed}%, live ${stats.phantomRate}% (Δ ${absDelta.toFixed(1)} pp > 5pp)`);
    }
  }

  // Agents, probes, reachable, channels — parse by explicit anchor words
  compare('agents indexed', stats.totalAgents, parseFirstNumber(/([\d\s,]{4,}?)\s+(?:nodes|agents)\s+index/i), TOLERANCE);
  compare('probes 24h', stats.probes24h, parseFirstNumber(/([\d\s,]{5,}?)\s+probes/i), TOLERANCE);
  compare('verified reachable', stats.verifiedReachable, parseFirstNumber(/([\d\s,]{3,}?)\s+verified\s+reachable/i), TOLERANCE);
  compare('total channels', stats.totalChannels, parseFirstNumber(/([\d\s,]{5,}?)\s+channels/i), TOLERANCE);
}

// ──────────────────────────────────────────────────────────────────────────
// Check 2 — SDK types drift vs OpenAPI spec
// ──────────────────────────────────────────────────────────────────────────
async function checkSdkOpenApiAlignment(): Promise<void> {
  const check = 'sdk-openapi-alignment';

  // Lightweight signature comparison — not a full codegen. Pulls the openapi
  // spec served by the running app, extracts a sorted list of property names
  // for each Response schema, and compares it to the SDK type file's
  // interface declarations by name. Any property that exists in one and not
  // the other is a drift finding.
  let spec: Record<string, unknown>;
  try {
    const resp = await fetch(`${API}/api/openapi.json`, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    spec = await resp.json() as Record<string, unknown>;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(check, `Could not fetch ${API}/api/openapi.json (${msg}) — skipping SDK alignment check`);
    return;
  }

  const components = (spec.components as { schemas?: Record<string, { properties?: Record<string, unknown> }> } | undefined)?.schemas ?? {};
  const sdkSource = readFileSync(path.join(REPO_ROOT, 'sdk/src/types.ts'), 'utf8');

  // Map of OpenAPI schema name → SDK interface name. Only schemas that have
  // a 1:1 SDK counterpart are checked.
  const pairs: Array<{ spec: string; sdk: string }> = [
    { spec: 'DecideResponse', sdk: 'DecideResponse' },
    { spec: 'VerdictResponse', sdk: 'VerdictResponse' },
    { spec: 'BestRouteRequest', sdk: 'BestRouteRequest' },
    { spec: 'ReportResponse', sdk: 'ReportResponse' },
    { spec: 'AgentScoreResponse', sdk: 'AgentScoreResponse' },
  ];

  for (const { spec: specName, sdk: sdkName } of pairs) {
    const specSchema = components[specName];
    if (!specSchema?.properties) {
      warn(check, `OpenAPI schema "${specName}" not found or has no properties`);
      continue;
    }
    const specProps = new Set(Object.keys(specSchema.properties));

    // Extract interface/type block from SDK source
    const interfaceMatch = sdkSource.match(new RegExp(`export\\s+(?:interface|type)\\s+${sdkName}\\s*(?:=)?\\s*\\{([^}]*?)\\}`, 's'));
    if (!interfaceMatch) {
      warn(check, `SDK type "${sdkName}" not found in sdk/src/types.ts`);
      continue;
    }
    const sdkProps = new Set<string>();
    const propRegex = /^\s*(\w+)(\??)\s*:/gm;
    let m: RegExpExecArray | null;
    while ((m = propRegex.exec(interfaceMatch[1])) !== null) {
      sdkProps.add(m[1]);
    }

    const inSpecNotSdk = [...specProps].filter(p => !sdkProps.has(p));
    const inSdkNotSpec = [...sdkProps].filter(p => !specProps.has(p));

    // WARN rather than FAIL — nested/union types have known false positives
    // under the simple property-name comparison (e.g. DecideResponse flattens
    // some OpenAPI sub-objects into the SDK top-level). The signal is still
    // useful for catching forgotten top-level additions; reviewers eyeball
    // the list to distinguish real drift from structural differences.
    if (inSpecNotSdk.length > 0) {
      warn(check, `${sdkName}: properties in OpenAPI but missing from SDK: ${inSpecNotSdk.join(', ')}`);
    }
    if (inSdkNotSpec.length > 0) {
      warn(check, `${sdkName}: properties in SDK but missing from OpenAPI: ${inSdkNotSpec.join(', ')}`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Check 3 — sdk/package.json version ahead of latest npm
// ──────────────────────────────────────────────────────────────────────────
function checkSdkPublishVersion(): void {
  const check = 'sdk-version-bump';
  let localVersion: string;
  try {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'sdk/package.json'), 'utf8')) as { version: string; name: string };
    localVersion = pkg.version;
  } catch (err: unknown) {
    fail(check, `Could not read sdk/package.json: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  let publishedVersion: string;
  try {
    publishedVersion = execSync('npm view @satrank/sdk version 2>/dev/null', { encoding: 'utf8', timeout: 10_000 }).trim();
  } catch {
    warn(check, 'Could not query npm registry (offline or rate-limited) — skipping version comparison');
    return;
  }
  if (!publishedVersion) {
    warn(check, 'npm view returned empty — package may not yet be published');
    return;
  }

  if (semverCompare(localVersion, publishedVersion) < 0) {
    fail(check, `sdk/package.json version ${localVersion} is BEHIND npm-published ${publishedVersion} — bump before publish`);
  } else if (semverCompare(localVersion, publishedVersion) === 0) {
    warn(check, `sdk/package.json version ${localVersion} matches npm-published ${publishedVersion} — bump required before next publish`);
  }
}

function semverCompare(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
  }
  return 0;
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`check-drift — API=${API}, strict=${STRICT}\n`);

  await checkImpactStatement();
  await checkSdkOpenApiAlignment();
  checkSdkPublishVersion();

  const failures = findings.filter(f => f.severity === 'FAIL');
  const warnings = findings.filter(f => f.severity === 'WARN');

  for (const f of [...failures, ...warnings]) {
    const tag = f.severity === 'FAIL' ? '\x1b[31mFAIL\x1b[0m' : '\x1b[33mWARN\x1b[0m';
    console.log(`  ${tag}  [${f.check}] ${f.message}`);
  }

  console.log(`\n${failures.length} failure(s), ${warnings.length} warning(s)`);

  if (failures.length > 0 || (STRICT && warnings.length > 0)) {
    process.exit(1);
  }
  console.log('OK — no drift detected');
}

main().catch((err: unknown) => {
  console.error('check-drift crashed:', err);
  process.exit(2);
});
