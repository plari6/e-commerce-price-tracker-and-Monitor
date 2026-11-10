// Last-resort price reading with an LLM (multi-model fallback chain) when no extractor found a price.
// The answer is only accepted if that exact price appears in the page text, so the model cannot invent one.
import { createRouterFromEnv } from './ai/index.js';
import { parsePrice, priceAppearsIn } from './price.js';

const SYSTEM = `You read e-commerce product pages. From the page text, extract the CURRENT selling price of the main product
(not related products, not shipping, not monthly instalments, not the crossed-out "was" price).
Reply with JSON only: {"price": number|null, "currency": "ISO 4217 code"|null, "list_price": number|null, "in_stock": true|false|null, "title": string|null, "price_text": "the price exactly as written on the page"}.
If you are not sure which number is the product price, use null.`;

let router = null;

export function aiAvailable(env = process.env) {
  return Boolean(env.GEMINI_API_KEY || env.GROQ_API_KEY || env.NVIDIA_API_KEY || env.OPENROUTER_API_KEY || env.OLLAMA_BASE_URL);
}

export function getRouter(env = process.env, opts = {}) {
  if (!router || opts.fresh) {
    router = createRouterFromEnv(env, {
      onEvent: (e) => { if (e.type === 'failure' && env.AI_DEBUG) console.warn(`[ai] ${e.target} ${e.kind} -> next model`); },
      ...opts,
    });
  }
  return router;
}

/** @returns {Promise<null | {price:number, currency:string|null, listPrice:number|null, inStock:boolean|null, title:string|null, method:string}>} */
export async function aiExtract({ text, url, currencyHint, title }, { ai = getRouter() } = {}) {
  if (!text || text.length < 40) return null;
  const prompt = `URL: ${url}\nPage title: ${title || '?'}\nExpected currency (if shown): ${currencyHint || 'unknown'}\n\nPAGE TEXT:\n${text.slice(0, 7000)}`;
  let res;
  try {
    res = await ai.generate({
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
      json: true,
      temperature: 0,
      maxTokens: 1024,
      parse: (t) => {
        const j = JSON.parse(t.replace(/^\s*```(json)?/i, '').replace(/```\s*$/, ''));
        if (typeof j !== 'object' || j === null) throw new Error('not an object');
        return j;
      },
    });
  } catch {
    return null; // every model failed: the product is simply marked "no price found" this run
  }
  const j = res.data;
  const amount = typeof j.price === 'number' ? j.price : parsePrice(j.price_text ?? j.price, { currencyHint })?.amount;
  if (!amount || amount <= 0) return null;
  if (!priceAppearsIn(text, amount)) return null; // hallucination guard
  const list = typeof j.list_price === 'number' && j.list_price > amount && priceAppearsIn(text, j.list_price) ? j.list_price : null;
  return {
    price: amount,
    currency: (j.currency || parsePrice(j.price_text, { currencyHint })?.currency || currencyHint || '').toUpperCase() || null,
    listPrice: list,
    inStock: typeof j.in_stock === 'boolean' ? j.in_stock : null,
    title: j.title || title || null,
    method: `ai:${res.target}`,
    confidence: 'medium',
  };
}
