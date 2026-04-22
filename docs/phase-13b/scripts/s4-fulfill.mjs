// S4 — Happy-path fulfill.
// Uses a mock wallet that logs invoice + returns a phantom preimage so we can
// observe the full fulfill() flow end to end without risking real sats.
import { SatRank } from '@satrank/sdk';

class LoggingMockWallet {
  constructor() { this.calls = []; }
  async payInvoice(bolt11, maxFeeSats) {
    this.calls.push({ bolt11_prefix: bolt11.slice(0, 40), maxFeeSats });
    // Short-circuit with a phantom preimage + fee — this is NOT a real payment.
    return { preimage: 'f'.repeat(64), feePaidSats: 0 };
  }
  async isAvailable() { return true; }
}

const wallet = new LoggingMockWallet();
const sr = new SatRank({
  apiBase: 'https://satrank.dev',
  wallet,
  caller: 'phase-13b-agent-s4',
});

const t0 = performance.now();
try {
  const result = await sr.fulfill({
    intent: { category: 'data/weather', keywords: ['paris'] },
    budget_sats: 50,
  });
  console.log(JSON.stringify({
    step: 'fulfill',
    ms: Math.round(performance.now() - t0),
    result: {
      success: result.success,
      cost_sats: result.cost_sats,
      candidates_tried: result.candidates_tried,
      error: result.error,
      endpoint_used: result.endpoint_used,
    },
    walletCalls: wallet.calls.length,
  }, null, 2));
} catch (e) {
  console.log(JSON.stringify({
    step: 'fulfill',
    ms: Math.round(performance.now() - t0),
    error_class: e.constructor?.name,
    error_code: e.code,
    statusCode: e.statusCode,
    message: e.message,
    walletCalls: wallet.calls.length,
  }, null, 2));
}
