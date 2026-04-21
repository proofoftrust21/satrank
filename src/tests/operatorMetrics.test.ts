// Phase 7 — C13 : assertion que les métriques operators sont bien émises.
//
// On ne teste pas les handlers HTTP Prometheus (/metrics) ici — la scrape
// route est couverte par modules.test.ts et le rendu prom-client est
// couvert par la lib elle-même. On vérifie plutôt les points d'émission :
//   - operatorClaimsTotal incrémenté par resourceType à chaque claimOwnership
//   - operatorVerificationsTotal incrémenté par {type,result} à chaque verify
//   - operatorsTotal mis à jour via countByStatus() sur un snapshot
import { webcrypto } from 'node:crypto';
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto: unknown }).crypto = webcrypto;
}
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { OperatorService } from '../services/operatorService';
import {
  OperatorRepository,
  OperatorIdentityRepository,
  OperatorOwnershipRepository,
} from '../repositories/operatorRepository';
import {
  EndpointStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import { OperatorController } from '../controllers/operatorController';
import {
  operatorClaimsTotal,
  operatorVerificationsTotal,
  operatorsTotal,
} from '../middleware/metrics';
import { errorHandler } from '../middleware/errorHandler';
// @ts-expect-error — ESM subpath
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
let testDb: TestDb;

function signNip98(url: string, method: string, body: string): string {
  const sk = generateSecretKey();
  const tags: string[][] = [
    ['u', url],
    ['method', method],
  ];
  if (body.length > 0) {
    const hash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    tags.push(['payload', hash]);
  }
  const template = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
  const signed = finalizeEvent(template, sk);
  return `Nostr ${Buffer.from(JSON.stringify(signed)).toString('base64')}`;
}

// prom-client types le label comme `Partial<Record<T, string | number>>` —
// on loose le type ici pour partager le helper entre counter et gauge.
interface MetricLike {
  get: () => Promise<{ values: Array<{ value: number; labels: Partial<Record<string, string | number>> }> }>;
}

async function readLabeledValue(
  metric: MetricLike,
  labels: Record<string, string>,
): Promise<number> {
  const snapshot = await metric.get();
  const match = snapshot.values.find((v) =>
    Object.entries(labels).every(([k, val]) => String(v.labels[k]) === val),
  );
  return match?.value ?? 0;
}

function makeOperatorService(db: Pool): OperatorService {
  return new OperatorService(
    new OperatorRepository(db),
    new OperatorIdentityRepository(db),
    new OperatorOwnershipRepository(db),
    new EndpointStreamingPosteriorRepository(db),
    new NodeStreamingPosteriorRepository(db),
    new ServiceStreamingPosteriorRepository(db),
  );
}

const BASE_URL = 'http://127.0.0.1:80';
const REGISTER_URL = `${BASE_URL}/api/operator/register`;

describe('Phase 7 — C13 operator metrics emission', async () => {
  let db: Pool;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
});

  afterEach(async () => {
    await teardownTestPool(testDb);
  });

  it('operatorClaimsTotal incrémente par resource_type à chaque claimOwnership', async () => {
    const service = makeOperatorService(db);
    const before = {
      node: await readLabeledValue(operatorClaimsTotal, { resource_type: 'node' }),
      endpoint: await readLabeledValue(operatorClaimsTotal, { resource_type: 'endpoint' }),
      service: await readLabeledValue(operatorClaimsTotal, { resource_type: 'service' }),
    };

    await service.upsertOperator('op-metrics-claims');
    await service.claimOwnership('op-metrics-claims', 'node', '02' + 'f'.repeat(64));
    await service.claimOwnership('op-metrics-claims', 'endpoint', 'a'.repeat(64));
    await service.claimOwnership('op-metrics-claims', 'endpoint', 'b'.repeat(64));
    await service.claimOwnership('op-metrics-claims', 'service', 'c'.repeat(64));

    expect(await readLabeledValue(operatorClaimsTotal, { resource_type: 'node' })).toBe(before.node + 1);
    expect(await readLabeledValue(operatorClaimsTotal, { resource_type: 'endpoint' })).toBe(before.endpoint + 2);
    expect(await readLabeledValue(operatorClaimsTotal, { resource_type: 'service' })).toBe(before.service + 1);
  });

  it('operatorVerificationsTotal incrémente par {type,result} via le controller', async () => {
    const service = makeOperatorService(db);
    const controller = new OperatorController({
      operatorService: service,
      // DNS TXT resolver stub. La vraie fonction lookup _satrank.<domain> donc
      // on match sur _satrank.ok.* (success) vs _satrank.ko.* (mismatch).
      dnsTxtResolver: async (host: string) => {
        if (host === '_satrank.ok.example.com') return [['satrank-operator=op-metrics-dns-ok']];
        if (host === '_satrank.ko.example.com') return [['satrank-operator=someone-else']];
        return [];
      },
    });

    const app = express();
    app.use(express.json({
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        if (buf && buf.length > 0) req.rawBody = Buffer.from(buf);
      },
    }));
    app.post('/api/operator/register', controller.register);
    app.use(errorHandler);

    const before = {
      dnsSuccess: await readLabeledValue(operatorVerificationsTotal, { type: 'dns', result: 'success' }),
      dnsFailure: await readLabeledValue(operatorVerificationsTotal, { type: 'dns', result: 'failure' }),
    };

    // Success case : DNS TXT match
    const bodyOk = {
      operator_id: 'op-metrics-dns-ok',
      identities: [{ type: 'dns', value: 'ok.example.com' }],
      ownerships: [],
    };
    const resOk = await request(app)
      .post('/api/operator/register')
      .set('Host', '127.0.0.1:80')
      .set('Authorization', signNip98(REGISTER_URL, 'POST', JSON.stringify(bodyOk)))
      .send(bodyOk);
    expect(resOk.status).toBe(201);

    // Failure case : DNS TXT mismatch
    const bodyKo = {
      operator_id: 'op-metrics-dns-ko',
      identities: [{ type: 'dns', value: 'ko.example.com' }],
      ownerships: [],
    };
    const resKo = await request(app)
      .post('/api/operator/register')
      .set('Host', '127.0.0.1:80')
      .set('Authorization', signNip98(REGISTER_URL, 'POST', JSON.stringify(bodyKo)))
      .send(bodyKo);
    expect(resKo.status).toBe(201);

    expect(await readLabeledValue(operatorVerificationsTotal, { type: 'dns', result: 'success' }))
      .toBe(before.dnsSuccess + 1);
    expect(await readLabeledValue(operatorVerificationsTotal, { type: 'dns', result: 'failure' }))
      .toBe(before.dnsFailure + 1);
  });

  it('operatorsTotal reflète countByStatus() — gauge set à partir d\'un snapshot', async () => {
    const repo = new OperatorRepository(db);
    const service = new OperatorService(
      repo,
      new OperatorIdentityRepository(db),
      new OperatorOwnershipRepository(db),
      new EndpointStreamingPosteriorRepository(db),
      new NodeStreamingPosteriorRepository(db),
      new ServiceStreamingPosteriorRepository(db),
    );

    await service.upsertOperator('op-g-pending-a');
    await service.upsertOperator('op-g-pending-b');
    await service.upsertOperator('op-g-rejected');
    await db.query(`UPDATE operators SET status='rejected' WHERE operator_id = 'op-g-rejected'`);

    // Simule le refresh de scrape /metrics
    const counts = await repo.countByStatus();
    operatorsTotal.set({ status: 'verified' }, counts.verified);
    operatorsTotal.set({ status: 'pending' }, counts.pending);
    operatorsTotal.set({ status: 'rejected' }, counts.rejected);

    expect(await readLabeledValue(operatorsTotal, { status: 'verified' })).toBe(0);
    expect(await readLabeledValue(operatorsTotal, { status: 'pending' })).toBe(2);
    expect(await readLabeledValue(operatorsTotal, { status: 'rejected' })).toBe(1);
  });
});
