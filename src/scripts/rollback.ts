// Phase 12B: rollback now means restoring from a pg_dump backup — see docs/DEPLOY.md
// The old multi-version stepper (rollbackTo / getAppliedVersions) was removed in the
// Postgres migration. Schema is now bootstrapped idempotently from postgres-schema.sql;
// data recovery is handled via pg_restore against a prior `npm run backup` dump.
import { logger } from '../logger';

logger.warn(
  'Phase 12B: rollback now means restoring from a pg_dump backup — see docs/DEPLOY.md',
);
process.exit(0);
