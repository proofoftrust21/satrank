// Checkpoint 1 demo — sr.fulfill() against real prod (https://satrank.dev).
//
// Wallet is stubbed: we capture the real 402 challenge, decode the invoice
// locally, and return a fake preimage. That means the 2nd call will fail (the
// server won't accept our fake preimage), and we'll observe a paid_failure
// outcome in the candidates_tried log. This is intentional — the goal is to
// demonstrate the full L402 dance end-to-end against prod without spending
// real sats from the LN node (channel-safety rule).
//
// Run: cd sdk && npx tsx scripts/checkpoint1-demo.ts

import { SatRank } from '../src/index';
import { decodeBolt11Amount } from '../src/bolt11';
import type { Wallet } from '../src/types';

const PROD = 'https://satrank.dev';

function logStep(step: string, label: string, payload: unknown): void {
  const ts = new Date().toISOString().slice(11, 23);
  const header = `[${ts}] ${step}  ${label}`;
  console.log('\n' + '━'.repeat(80));
  console.log(header);
  console.log('─'.repeat(80));
  if (typeof payload === 'string') console.log(payload);
  else console.log(JSON.stringify(payload, null, 2));
}

// Instrumented fetch — logs every outbound HTTP + key response headers.
function instrumentedFetch(base: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init.method ?? 'GET';
    const t0 = Date.now();
    logStep(`→ ${method}`, url, {
      headers: init.headers ?? null,
      body: init.body ?? null,
    });
    const res = await base(input, init);
    const dt = Date.now() - t0;
    const www = res.headers.get('www-authenticate');
    logStep(
      `← ${res.status}`,
      `${url} (${dt}ms)`,
      www ? { status: res.status, wwwAuth: www.slice(0, 200) + '…' } : { status: res.status },
    );
    return res;
  }) as typeof fetch;
}

// Stub wallet — logs the invoice, decodes amount, returns fake preimage.
function demoWallet(): Wallet {
  return {
    isAvailable: async () => true,
    payInvoice: async (bolt11, maxFeeSats) => {
      const amt = decodeBolt11Amount(bolt11);
      logStep(
        '$ wallet.payInvoice',
        'STUB (no real LN payment)',
        {
          invoice_prefix: bolt11.slice(0, 40) + '…',
          invoice_decoded_sats: amt,
          max_fee_sats: maxFeeSats,
          returning: 'fake preimage (server will reject auth retry)',
        },
      );
      return {
        preimage: 'de'.repeat(32),
        feePaidSats: 0,
      };
    },
  };
}

async function main(): Promise<void> {
  console.log('Checkpoint 1 — sr.fulfill() prod demo');
  console.log(`Target: ${PROD}`);
  console.log(`Date: ${new Date().toISOString()}\n`);

  const sr = new SatRank({
    apiBase: PROD,
    fetch: instrumentedFetch(fetch),
    wallet: demoWallet(),
    caller: 'phase6-checkpoint1-demo',
  });

  const result = await sr.fulfill({
    intent: { category: 'data' },
    budget_sats: 50,
    timeout_ms: 15_000,
    max_fee_sats: 5,
    retry_policy: 'none', // stop after first candidate — we expect paid_failure
  });

  logStep('✅ FINAL RESULT', 'FulfillResult', result);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
