// Head-to-head parity: parseIntent with identical inputs.
import { parseIntent } from '@satrank/sdk/nlp';

const cases = [
  { input: 'I need weather data for Paris', categories: ['data', 'weather'] },
  { input: 'find me a cheap weather api for paris under 50 sats', categories: ['data', 'weather', 'payment'] },
  { input: '💥💥💥', categories: ['data'] },
  { input: 'pay for gpt prompt 200 tokens', categories: ['data', 'payment', 'llm'] },
];
for (const c of cases) {
  const p = parseIntent(c.input, { categories: c.categories });
  console.log(JSON.stringify({ input: c.input.slice(0, 40), cats: c.categories, parsed: p }));
}
