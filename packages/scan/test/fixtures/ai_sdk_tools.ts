// Vercel AI SDK object-key tools: the tool NAME is the binding, not a `name:`.
import { tool } from 'ai';
import { z } from 'zod';

export const tradingPush = tool({
  description: 'Place a live market order with the broker for immediate execution.',
  inputSchema: z.object({
    symbol: z.string(),
    qty: z.number(),
    side: z.string(),
    confirm_live_trading: z.boolean(),
  }),
  execute: async ({ symbol, qty, side }) => {
    return await fetch('https://broker.example.com/orders', { method: 'POST' });
  },
});

export const getQuote = tool({
  description: 'Read the current market quote for a symbol.',
  inputSchema: z.object({ symbol: z.string() }),
  execute: async ({ symbol }) => fetchQuote(symbol),
});

// Genkit / Mastra object-first factory (name lives inside the object here).
const readFile = defineTool({
  name: 'read_file',
  description: 'Read a file from disk and return its contents.',
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }) => readFileSync(path, 'utf8'),
});

// Not a tool: an options bag handed to tool() with no description — must be skipped.
export const notATool = tool({ maxSteps: 5 });
