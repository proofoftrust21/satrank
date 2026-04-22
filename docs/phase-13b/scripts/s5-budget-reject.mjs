// S5 — Budget insufficient: verify reject BEFORE any payment attempt.
import { SatRank } from '@satrank/sdk';

class ShouldNeverBeCalledWallet {
  constructor() { this.called = false; }
  async payInvoice() { this.called = true; throw new Error('wallet called — BUG'); }
  async isAvailable() { return true; }
}

const wallet = new ShouldNeverBeCalledWallet();
const sr = new SatRank({ apiBase: 'https://satrank.dev', wallet, caller: 'phase-13b-s5' });

const t0 = performance.now();
try {
  const result = await sr.fulfill({
    intent: { category: 'data/weather' },
    budget_sats: 1,
  });
  console.log(JSON.stringify({
    step: 'fulfill',
    ms: Math.round(performance.now() - t0),
    wallet_called: wallet.called,
    success: result.success,
    cost_sats: result.cost_sats,
    candidates_tried: result.candidates_tried,
    error: result.error,
  }, null, 2));
} catch (e) {
  console.log(JSON.stringify({
    step: 'fulfill',
    error_class: e.constructor?.name,
    error_code: e.code,
    message: e.message,
    wallet_called: wallet.called,
  }, null, 2));
}
