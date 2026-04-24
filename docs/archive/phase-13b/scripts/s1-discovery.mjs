// S1 — Discovery: "I need weather data for Paris"
// Uses only /api/intent/categories + /api/intent (unauthenticated discovery).
import { SatRank } from '@satrank/sdk';
import { parseIntent } from '@satrank/sdk/nlp';

const t0 = performance.now();
const sr = new SatRank({ apiBase: 'https://satrank.dev', caller: 'phase-13b-agent' });

const cats = await sr.listCategories();
const t1 = performance.now();
console.log(JSON.stringify({
  step: 'listCategories',
  ms: Math.round(t1 - t0),
  count: cats.categories.length,
  sample: cats.categories.slice(0, 5),
}, null, 2));

const parsed = parseIntent('I need weather data for Paris', {
  categories: cats.categories.map((c) => c.name),
});
const t2 = performance.now();
console.log(JSON.stringify({
  step: 'parseIntent',
  ms: Math.round(t2 - t1),
  parsed,
}, null, 2));

const res = await sr.resolveIntent({
  category: parsed.intent.category || 'data',
  keywords: parsed.intent.keywords,
  limit: 5,
  caller: 'phase-13b-agent',
});
const t3 = performance.now();
console.log(JSON.stringify({
  step: 'resolveIntent',
  ms: Math.round(t3 - t2),
  total_matched: res.meta.total_matched,
  returned: res.meta.returned,
  strictness: res.meta.strictness,
  warnings: res.meta.warnings,
  top: res.candidates.slice(0, 3).map((c) => ({
    rank: c.rank,
    url: c.endpoint_url,
    service: c.service_name,
    price: c.price_sats,
    verdict: c.bayesian.verdict,
    advisory: c.advisory.advisory_level,
  })),
}, null, 2));
console.log(`TOTAL_MS=${Math.round(t3 - t0)}`);
