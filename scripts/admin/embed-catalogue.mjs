#!/usr/bin/env node
// Phase 12.0 (2026-05-05) — capability backfill admin script.
//
// Per audit semantic-rank-layer (lens L1 cost-scale, lens L4 alternatives,
// lens L6 sovereignty). Populates input_schema / output_schema /
// modalities / languages / freshness_sla_sec / deterministic on every
// row in service_endpoints whose capability_provenance IS NULL.
//
// Each LLM inference is persisted in capability_inference_log (Phase
// 12.1) with full prompt + raw response + parsed result, so a future
// audit / model swap / human review can replay end-to-end.
//
// Usage (locally, with SSH tunnel to prod Postgres) :
//   ANTHROPIC_API_KEY=sk-ant-... \
//   DATABASE_URL=postgres://USER:PWD@127.0.0.1:5432/satrank \
//   node scripts/admin/embed-catalogue.mjs
//
// Usage (on prod box) :
//   ssh root@SATRANK
//   docker exec -it satrank-api sh
//   ANTHROPIC_API_KEY=... node /app/scripts/admin/embed-catalogue.mjs
//
// Env :
//   ANTHROPIC_API_KEY   required
//   DATABASE_URL        required (defaults to read from env)
//   BACKFILL_RUN_ID     optional (default backfill-YYYY-MM-DDThh-mm-ss)
//   BACKFILL_LIMIT      optional (default 1000 ; cap per run)
//   BACKFILL_DRY_RUN    optional ; when 'true' don't write to DB
//   BACKFILL_MODEL      optional (default claude-haiku-4-5-20251001)

import { Client } from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY required'); process.exit(1); }
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error('ERROR: DATABASE_URL required'); process.exit(1); }
const RUN_ID = process.env.BACKFILL_RUN_ID ?? `backfill-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const LIMIT = Number(process.env.BACKFILL_LIMIT ?? 1000);
const DRY_RUN = process.env.BACKFILL_DRY_RUN === 'true';
const MODEL = process.env.BACKFILL_MODEL ?? 'claude-haiku-4-5-20251001';

const PROMPT_TEMPLATE = `You infer machine-readable capability metadata for a paid HTTP API endpoint.
Given the endpoint's name, description, category, and provider below, return STRICT JSON
matching this schema (no markdown, no preamble) :

{
  "input_schema": <JSON Schema or null>,
  "output_schema": <JSON Schema or null>,
  "modalities": ["text"|"image"|"audio"|"video"|"code"|"embedding"|"json"|"binary"]   # 1-4 of these
  "languages": ["en"|"fr"|...] | []                  # BCP-47 codes ; empty when N/A
  "freshness_sla_sec": <int> | null                 # max acceptable staleness for time-sensitive data
  "deterministic": true | false                     # true if same input → same output
}

Rules :
  - input_schema may be null when endpoint takes no body (GET-only).
  - output_schema may be null when format is genuinely unknown ; otherwise sketch the
    fields the response is expected to carry.
  - modalities reflects the I/O CONTENT (e.g. an endpoint that takes JSON and returns
    JSON is ["text"] ; one that returns audio bytes is ["audio"]).
  - freshness_sla_sec : 60 for realtime market data, 3600 for hourly cohorts, 86400
    for daily aggregates, null for static reference data.
  - deterministic : true for read-only data lookups + archives ; false for LLM
    completions / generative APIs / anything stochastic.
  - Be honest about uncertainty : prefer null + empty arrays to fabricated structure.

ENDPOINT :
  url: {{URL}}
  name: {{NAME}}
  description: {{DESCRIPTION}}
  category: {{CATEGORY}}
  provider: {{PROVIDER}}`;

const client = new Anthropic({ apiKey: API_KEY });

const db = new Client({ connectionString: DB_URL });
await db.connect();

const { rows: endpoints } = await db.query(`
  SELECT id, url, name, description, category, provider
    FROM service_endpoints
   WHERE NOT deprecated
     AND capability_provenance IS NULL
   ORDER BY id ASC
   LIMIT $1
`, [LIMIT]);

console.log(`run_id=${RUN_ID} model=${MODEL} dry_run=${DRY_RUN} pending=${endpoints.length}`);
let applied = 0;
let failed = 0;
let skipped = 0;

for (const ep of endpoints) {
  const prompt = PROMPT_TEMPLATE
    .replace('{{URL}}', ep.url ?? '(unknown)')
    .replace('{{NAME}}', ep.name ?? '(none)')
    .replace('{{DESCRIPTION}}', (ep.description ?? '(none)').slice(0, 600))
    .replace('{{CATEGORY}}', ep.category ?? '(none)')
    .replace('{{PROVIDER}}', ep.provider ?? '(none)');
  const promptHash = createHash('sha256').update(prompt, 'utf8').digest('hex');

  let responseRaw = '';
  let parsed = null;
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });
    responseRaw = resp.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n')
      .trim();
    try {
      parsed = JSON.parse(responseRaw);
    } catch {
      const m = responseRaw.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    }
  } catch (err) {
    console.error(`[skip] id=${ep.id} url=${ep.url} llm_error=${err.message}`);
    skipped += 1;
    continue;
  }

  if (!parsed || typeof parsed !== 'object') {
    console.error(`[skip] id=${ep.id} url=${ep.url} parse_failed`);
    skipped += 1;
    continue;
  }

  // Persist log row first (audit trail). Always written even if apply
  // step fails — that's the point of the trail.
  let logId = null;
  if (!DRY_RUN) {
    const { rows: logRows } = await db.query(`
      INSERT INTO capability_inference_log
        (endpoint_url, model_id, prompt_hash, prompt_raw, response_raw,
         parsed_capability, run_kind, run_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'backfill', $7, EXTRACT(EPOCH FROM NOW())::int)
       RETURNING log_id
    `, [
      ep.url,
      MODEL,
      promptHash,
      prompt,
      responseRaw,
      parsed,
      RUN_ID,
    ]);
    logId = logRows[0]?.log_id;
  }

  const inputSchema = parsed.input_schema ?? null;
  const outputSchema = parsed.output_schema ?? null;
  const modalities = Array.isArray(parsed.modalities) ? parsed.modalities.slice(0, 8).map(String) : null;
  const languages = Array.isArray(parsed.languages) ? parsed.languages.slice(0, 32).map(String) : null;
  const freshness = (typeof parsed.freshness_sla_sec === 'number' && parsed.freshness_sla_sec >= 0) ? parsed.freshness_sla_sec : null;
  const deterministic = (typeof parsed.deterministic === 'boolean') ? parsed.deterministic : null;

  if (DRY_RUN) {
    console.log(`[dry] id=${ep.id} url=${ep.url} modalities=${JSON.stringify(modalities)} det=${deterministic}`);
    continue;
  }

  try {
    await db.query(`
      UPDATE service_endpoints
         SET input_schema = $1,
             output_schema = $2,
             modalities = $3,
             languages = $4,
             freshness_sla_sec = $5,
             deterministic = $6,
             capability_provenance = 'crawler_inferred'
       WHERE id = $7
    `, [
      inputSchema,
      outputSchema,
      modalities,
      languages,
      freshness,
      deterministic,
      ep.id,
    ]);
    if (logId != null) {
      await db.query(`
        UPDATE capability_inference_log
           SET applied = TRUE,
               applied_at = EXTRACT(EPOCH FROM NOW())::int
         WHERE log_id = $1
      `, [logId]);
    }
    applied += 1;
    process.stdout.write(applied % 10 === 0 ? `... ${applied}\n` : '.');
  } catch (err) {
    console.error(`[fail] id=${ep.id} url=${ep.url} db_error=${err.message}`);
    failed += 1;
  }
}

console.log(`\nrun_id=${RUN_ID} applied=${applied} failed=${failed} skipped=${skipped} total=${endpoints.length}`);
await db.end();
