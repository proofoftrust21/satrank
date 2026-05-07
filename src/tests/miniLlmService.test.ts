// Phase 12.14 — MiniLlmService unit tests.
//
// We mock the Anthropic client so the suite runs offline + deterministic.
// The test surface : prompt construction (per task), happy path response
// shape, input length cap, error propagation.
import { describe, it, expect, vi } from 'vitest';
import { MiniLlmService, SELF_HOSTED_MINI_LLM_ENDPOINTS } from '../services/miniLlmService';

function makeMockClient(textResponse: string, usage = { input_tokens: 12, output_tokens: 7 }) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: textResponse }],
        usage,
      })),
    },
  };
}

describe('MiniLlmService.buildPrompt', () => {
  it('classify : asks for a single label only', () => {
    const { system } = MiniLlmService.buildPrompt({
      task: 'classify',
      text: 'A cat sat on the mat.',
      options: { labels: ['animal', 'furniture', 'other'] },
    });
    expect(system).toContain('single best label');
    expect(system).toContain('"animal","furniture","other"');
  });

  it('summarize : honours max_words option', () => {
    const { system } = MiniLlmService.buildPrompt({
      task: 'summarize',
      text: 'Long article body here.',
      options: { max_words: 25 },
    });
    expect(system).toContain('Length budget : 25 words');
    expect(system).toContain('plain prose');
  });

  it('translate : honours target language', () => {
    const { system } = MiniLlmService.buildPrompt({
      task: 'translate',
      text: 'Bonjour',
      options: { target: 'spanish' },
    });
    expect(system).toContain('Target language : spanish');
  });

  it('rejects empty text', () => {
    expect(() =>
      MiniLlmService.buildPrompt({ task: 'classify', text: '' }),
    ).toThrow(/text is required/);
  });

  it('rejects oversize text', () => {
    expect(() =>
      MiniLlmService.buildPrompt({
        task: 'summarize',
        text: 'a'.repeat(8_001),
      }),
    ).toThrow(/exceeds 8000 chars/);
  });
});

describe('MiniLlmService.run', () => {
  it('returns the model output trimmed and structured', async () => {
    const client = makeMockClient('  positive  \n');
    const svc = new MiniLlmService({ client: client as never, now: () => 0 });
    const r = await svc.run({ task: 'classify', text: 'I love it!' });
    expect(r.task).toBe('classify');
    expect(r.result).toBe('positive');
    expect(r.usage).toEqual({ input_tokens: 12, output_tokens: 7 });
    expect(r.model).toMatch(/^claude-haiku-4-5/);
  });

  it('passes system + user prompt to the underlying client', async () => {
    const client = makeMockClient('en bref : un chat dort');
    const svc = new MiniLlmService({ client: client as never, now: () => 100 });
    await svc.run({
      task: 'summarize',
      text: 'Le chat dort sur le tapis depuis trois heures.',
      options: { max_words: 10 },
    });
    expect(client.messages.create).toHaveBeenCalledTimes(1);
    const call = client.messages.create.mock.calls[0][0] as {
      system: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.system).toContain('plain prose');
    expect(call.messages[0].content).toContain('chat dort');
  });

  it('measures upstream latency', async () => {
    const client = makeMockClient('label');
    let t = 0;
    const svc = new MiniLlmService({
      client: client as never,
      now: () => {
        t += 250;
        return t;
      },
    });
    const r = await svc.run({ task: 'classify', text: 'test' });
    expect(r.upstream_latency_ms).toBe(250);
  });

  it('propagates Anthropic errors', async () => {
    const client = {
      messages: {
        create: vi.fn(async () => {
          throw new Error('429 rate limited');
        }),
      },
    };
    const svc = new MiniLlmService({ client: client as never });
    await expect(svc.run({ task: 'classify', text: 'x' })).rejects.toThrow(/rate limited/);
  });
});

describe('SELF_HOSTED_MINI_LLM_ENDPOINTS', () => {
  it('declares 3 endpoints under the canonical ai/* taxonomy at 10 sats each', () => {
    const specs = SELF_HOSTED_MINI_LLM_ENDPOINTS('https://satrank.dev');
    expect(specs).toHaveLength(3);
    const cats = specs.map(s => s.category).sort();
    expect(cats).toEqual(['ai/classify', 'ai/summarize', 'ai/translate']);
    for (const s of specs) {
      expect(s.price_sats).toBe(10);
      expect(s.http_method).toBe('POST');
      expect(s.url.startsWith('https://satrank.dev/api/mini-llm/')).toBe(true);
    }
  });

  it('uses the supplied base URL', () => {
    const specs = SELF_HOSTED_MINI_LLM_ENDPOINTS('http://localhost:3000');
    expect(specs[0].url).toBe('http://localhost:3000/api/mini-llm/classify');
  });
});
