// LangChain agent that uses sr.fulfill() as a tool.
//
// The agent receives natural-language queries, picks the right L402 service
// from SatRank's ranked candidates, pays the invoice via LND, and returns
// the service response. The agent itself is powered by any chat model
// LangChain supports (OpenAI, Anthropic, Ollama, ...).
//
// Install (in your app, alongside the SDK):
//   npm install @satrank/sdk langchain @langchain/core @langchain/openai zod
//
// Run:
//   OPENAI_API_KEY=sk-... \
//   LND_MACAROON=$(xxd -ps -u -c 1000 ~/.lnd/admin.macaroon) \
//   npx tsx sdk/examples/langchain-agent.ts "what's the weather in tokyo"

import { SatRank } from '@satrank/sdk';
import { LndWallet } from '@satrank/sdk/wallet';
import { parseIntent } from '@satrank/sdk/nlp';
import { ChatOpenAI } from '@langchain/openai';
import { DynamicStructuredTool } from 'langchain/tools';
import { AgentExecutor, createToolCallingAgent } from 'langchain/agents';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { z } from 'zod';

// ---- Boot the SatRank client with an LND wallet ------------------------

const sr = new SatRank({
  apiBase: 'https://satrank.dev',
  wallet: new LndWallet({
    restEndpoint: process.env.LND_REST ?? 'https://127.0.0.1:8080',
    macaroonHex: process.env.LND_MACAROON!,
  }),
  caller: 'langchain-demo',
});

// Prime the live categories once — parseIntent needs them.
const { categories } = await sr.listCategories();
const categoryNames = categories.map((c) => c.name);

// ---- Define the fulfill() tool ----------------------------------------

const fulfillTool = new DynamicStructuredTool({
  name: 'satrank_fulfill',
  description:
    'Call a Lightning-native HTTP service via SatRank. Given a natural-language ' +
    'request, discovers the best-ranked paid API, pays up to budget_sats, ' +
    'and returns the response body. Only use when the user wants live data ' +
    '(weather, prices, AI inference, search, …) that requires a paid API.',
  schema: z.object({
    request: z.string().describe('Natural-language description of what to fetch'),
    budget_sats: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(50)
      .describe('Hard cap on sats spent across all candidate attempts'),
  }),
  func: async ({ request, budget_sats }) => {
    const parsed = parseIntent(request, { categories: categoryNames });
    if (parsed.category_confidence < 0.3) {
      return JSON.stringify({
        error: 'unclear_category',
        hint: 'ask the user to pick one of: ' + categoryNames.slice(0, 6).join(', '),
      });
    }
    const result = await sr.fulfill({
      intent: parsed.intent,
      budget_sats,
      max_fee_sats: 5,
      timeout_ms: 20_000,
    });
    return JSON.stringify({
      success: result.success,
      cost_sats: result.cost_sats,
      response: result.response_body ?? null,
      error: result.error ?? null,
      endpoint: result.endpoint_used ?? null,
    });
  },
});

// ---- Wire up the agent -------------------------------------------------

const llm = new ChatOpenAI({ model: 'gpt-4o-mini', temperature: 0 });

const prompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    'You are a helpful agent with access to Lightning-paid APIs via the satrank_fulfill tool. ' +
      'When a user asks for live data, call the tool with a concise request and a reasonable ' +
      'budget (default 50 sats, max 200). Report the result concisely.',
  ],
  ['human', '{input}'],
  ['placeholder', '{agent_scratchpad}'],
]);

const agent = createToolCallingAgent({ llm, tools: [fulfillTool], prompt });
const executor = new AgentExecutor({ agent, tools: [fulfillTool], verbose: false });

// ---- Run ---------------------------------------------------------------

const userInput = process.argv.slice(2).join(' ') || "what's the weather in paris";
console.log(`> ${userInput}\n`);

const out = await executor.invoke({ input: userInput });
console.log(out.output);
