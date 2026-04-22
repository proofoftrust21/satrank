// S9 — Malformed intent robustness.
import { SatRank } from '@satrank/sdk';
import { parseIntent } from '@satrank/sdk/nlp';

const sr = new SatRank({ apiBase: 'https://satrank.dev', caller: 'phase-13b-s9' });

const cases = [
  { label: 'empty_string', input: '' },
  { label: 'whitespace', input: '   \n\t  ' },
  { label: 'absurd_text', input: 'qwertyuiop asdfghjkl zxcvbnm 1234567890' },
  { label: 'emoji_only', input: '🦀🦀🦀 🌮🌮 🌙' },
  { label: 'very_long', input: 'need '.repeat(200) + 'weather paris' },
];

for (const c of cases) {
  try {
    const parsed = parseIntent(c.input, { categories: ['data', 'weather', 'payment'] });
    console.log(`[${c.label}] parsed:`, JSON.stringify(parsed));
  } catch (e) {
    console.log(`[${c.label}] threw: ${e.constructor?.name} ${e.message}`);
  }
}

// And resolveIntent with gibberish category:
try {
  const res = await sr.resolveIntent({ category: '💥💥', limit: 1 });
  console.log('resolve emoji category:', JSON.stringify(res.meta));
} catch (e) {
  console.log('resolve emoji category threw:', e.constructor?.name, e.code, e.message);
}

// And an intent with budget NaN:
try {
  const res = await sr.resolveIntent({ category: 'data', budget_sats: NaN, limit: 1 });
  console.log('resolve NaN budget:', JSON.stringify(res.meta));
} catch (e) {
  console.log('resolve NaN budget threw:', e.constructor?.name, e.code, e.message);
}
