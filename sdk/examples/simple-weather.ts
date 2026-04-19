// Simple weather lookup — 10 lines, prod-real.
//
// Run:  LND_MACAROON=$(xxd -ps -u -c 1000 ~/.lnd/data/chain/bitcoin/mainnet/admin.macaroon) \
//       npx tsx sdk/examples/simple-weather.ts

import { SatRank } from '@satrank/sdk';
import { LndWallet } from '@satrank/sdk/wallet';

const sr = new SatRank({
  apiBase: 'https://satrank.dev',
  wallet: new LndWallet({ restEndpoint: 'https://127.0.0.1:8080', macaroonHex: process.env.LND_MACAROON! }),
  caller: 'simple-weather-example',
});

const result = await sr.fulfill({
  intent: { category: 'data/weather', keywords: ['paris'] },
  budget_sats: 50,
});

console.log(result.success ? result.response_body : result.error);
