import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Phase 12B — Postgres harness. The global setup ensures
    // `satrank_test_template` exists with schema v41 + deposit_tiers seed.
    // Each test file clones it into `satrank_test_<uuid>` for isolation.
    globalSetup: './src/tests/helpers/globalSetup.ts',
    // Phase 12C — src/tests/archive/ contient les fichiers SQLite-era
    // conservés pour référence mais non portés au client pg. Vitest doit
    // les ignorer (imports relatifs cassés par le git mv) ; un éventuel
    // port Phase 12D les réintégrera si jugé utile. Cf.
    // docs/phase-12c/TS-ERRORS-AUDIT.md.
    exclude: ['**/node_modules/**', '**/dist/**', 'src/tests/archive/**'],
    // CREATE DATABASE is serialised by pg — running many files in parallel
    // is fine at the query level but causes noise during cloning. Keep
    // threads enabled but cap to 4 to stay under typical pg max_connections
    // headroom when cloning + test body overlap.
    poolOptions: {
      threads: { maxThreads: 4, minThreads: 1 },
    },
    testTimeout: 20_000,
  },
});
