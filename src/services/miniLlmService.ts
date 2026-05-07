// Phase 12.14 (2026-05-08) — self-hosted L402 mini-AI endpoint.
//
// Why this exists : Sim 20 confirmed that 7/10 personas could not be
// indispensable because no AI service in the SatRank catalogue is
// priced under their 15-30 sat budget — every AI provider passes
// through OpenAI/Anthropic costs at 30-100 sat/req. Engineering at
// the rank/filter layer (Phase 12.11-13) cannot solve this — the bug
// is catalogue concentration, not ranking. Phase 12.14 closes the
// gap from the operator side : SatRank itself runs an L402 endpoint
// for the three primitives every AI persona expected (classify,
// summarize, translate) at 10 sats. Same Lightning rail, same
// L402 contract — Bitcoin-pure end to end.
//
// Backend choice : Anthropic Claude Haiku 4.5. Reason : ~$0.001-0.003
// per call covered by the 10-sat charge ($0.004 at 0.0004 $/sat) with
// 25-100% margin. Backend dependency is ours, not the agent's. Could
// be swapped to a self-hosted Llama 3.2 1B via Ollama later — the L402
// front is invariant.
//
// Catalog auto-registration : at app boot, an upsert into
// service_endpoints registers the three endpoints under the canonical
// taxonomy (ai/classify, ai/summarize, ai/translate) so /api/intent
// and BM25 ranker surface them. We use the SatRank operator pubkey so
// ownership is unambiguous in the audit trail.
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../logger';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const MAX_INPUT_CHARS = 8_000;       // ~2000 tokens — fits cheap-tier ceiling
const MAX_OUTPUT_TOKENS = 800;       // summary cap
const ANTHROPIC_TIMEOUT_MS = 12_000; // hard upstream timeout

export type MiniLlmTask = 'classify' | 'summarize' | 'translate';

export interface MiniLlmRequest {
  task: MiniLlmTask;
  text: string;
  /** Free-form options : labels for classify, target language for translate, etc. */
  options?: Record<string, unknown>;
}

export interface MiniLlmResponse {
  task: MiniLlmTask;
  result: string;
  /** Approximate token usage reported by Anthropic ; useful for the
   *  operator to track cost vs revenue per call type. */
  usage: { input_tokens: number; output_tokens: number };
  /** Model id actually called — exposed so the agent can pin or compare
   *  output across versions. */
  model: string;
  /** Wall-clock latency budget consumption. */
  upstream_latency_ms: number;
}

export interface MiniLlmServiceDeps {
  client: Anthropic;
  now?: () => number;
}

export class MiniLlmService {
  private readonly now: () => number;

  constructor(private readonly deps: MiniLlmServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  static buildPrompt(req: MiniLlmRequest): { system: string; user: string } {
    if (!req.text || req.text.length === 0) {
      throw new Error('text is required');
    }
    if (req.text.length > MAX_INPUT_CHARS) {
      throw new Error(`text exceeds ${MAX_INPUT_CHARS} chars`);
    }
    const labelsHint =
      req.task === 'classify'
        ? `Available labels (when supplied) : ${JSON.stringify((req.options?.labels as string[]) ?? ['general'])}.`
        : '';
    const langHint =
      req.task === 'translate'
        ? `Target language : ${(req.options?.target as string) ?? 'en'}.`
        : '';
    const length =
      req.task === 'summarize'
        ? `Length budget : ${(req.options?.max_words as number) ?? 60} words.`
        : '';
    const taskInstr: Record<MiniLlmTask, string> = {
      classify:
        'Output a single best label. Reply ONLY with the label, no prose, no JSON, no quotes.',
      summarize:
        'Output a tight summary in plain prose. No prefix, no headings, no JSON.',
      translate:
        'Output the translated text only, no source-language framing, no notes.',
    };
    const system =
      `You are SatRank Mini-AI, a Lightning-paid micro-classifier. ${taskInstr[req.task]} ` +
      `${labelsHint} ${langHint} ${length}`.replace(/\s+/g, ' ').trim();
    const user = req.text;
    return { system, user };
  }

  async run(req: MiniLlmRequest): Promise<MiniLlmResponse> {
    const { system, user } = MiniLlmService.buildPrompt(req);
    const t0 = this.now();
    const response = await this.deps.client.messages.create(
      {
        model: HAIKU_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        messages: [{ role: 'user', content: user }],
      },
      { timeout: ANTHROPIC_TIMEOUT_MS },
    );
    const elapsed = this.now() - t0;

    // Anthropic returns content as an array of blocks ; the first text
    // block is the answer. Concatenating handles the rare multi-block
    // response (no inline tool use here).
    const textOut = (response.content ?? [])
      .map(b => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();

    const usage = response.usage ?? { input_tokens: 0, output_tokens: 0 };
    logger.info(
      {
        task: req.task,
        text_chars: user.length,
        elapsed_ms: elapsed,
        in_tokens: usage.input_tokens,
        out_tokens: usage.output_tokens,
        model: HAIKU_MODEL,
      },
      'mini-llm: call complete',
    );
    return {
      task: req.task,
      result: textOut,
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
      },
      model: HAIKU_MODEL,
      upstream_latency_ms: elapsed,
    };
  }
}

/** Catalogue auto-registration helper. Idempotent — calls upsertSelfHostedEndpoint
 *  for each of the three task endpoints. Called once at app boot. */
export interface SelfHostedEndpointSpec {
  url: string;
  name: string;
  description: string;
  category: 'ai/classify' | 'ai/summarize' | 'ai/translate';
  price_sats: number;
  http_method: 'POST';
}

export const SELF_HOSTED_MINI_LLM_ENDPOINTS = (apiBase: string): SelfHostedEndpointSpec[] => [
  {
    url: `${apiBase}/api/mini-llm/classify`,
    name: 'SatRank Mini-AI : Classify',
    description: 'Cheap text classification (10 sats). Single best label out. Powered by Claude Haiku 4.5 via L402 Lightning gateway.',
    category: 'ai/classify',
    price_sats: 10,
    http_method: 'POST',
  },
  {
    url: `${apiBase}/api/mini-llm/summarize`,
    name: 'SatRank Mini-AI : Summarize',
    description: 'Cheap text summarization (10 sats). Plain-prose summary. Powered by Claude Haiku 4.5 via L402 Lightning gateway.',
    category: 'ai/summarize',
    price_sats: 10,
    http_method: 'POST',
  },
  {
    url: `${apiBase}/api/mini-llm/translate`,
    name: 'SatRank Mini-AI : Translate',
    description: 'Cheap text translation (10 sats). Target language via options.target. Powered by Claude Haiku 4.5 via L402 Lightning gateway.',
    category: 'ai/translate',
    price_sats: 10,
    http_method: 'POST',
  },
];
