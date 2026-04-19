// Checkpoint 2 demo — parseIntent() against real prod /api/intent/categories.
// Run: cd sdk && npx tsx scripts/checkpoint2-demo.ts

import { SatRank } from '../src/index';
import { parseIntent } from '../src/nlp';

const FIXTURES: string[] = [
  'I need weather data fast under 50 sats',
  'give me the bitcoin price within 3 seconds for 10 sats',
  'ai/code helper under 200 sats',
  'search engine for typescript libraries',
  'latest market data please',
  'urgent bitcoin news',
  'cook me a pizza', // no category match
];

async function main(): Promise<void> {
  const sr = new SatRank({ apiBase: 'https://satrank.dev' });
  const { categories } = await sr.listCategories();
  const catNames = categories.map((c) => c.name);
  console.log(`Loaded ${catNames.length} prod categories`);
  console.log(`Sample: ${catNames.slice(0, 5).join(', ')}…\n`);

  for (const input of FIXTURES) {
    const r = parseIntent(input, { categories: catNames });
    console.log(`IN:  "${input}"`);
    console.log(`OUT: ${JSON.stringify(r, null, 0)}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
