import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Phase 12B — Postgres harness. The global setup ensures
    // `satrank_test_template` exists with schema v41 + deposit_tiers seed.
    // Each test file clones it into `satrank_test_<uuid>` for isolation.
    globalSetup: './src/tests/helpers/globalSetup.ts',
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
