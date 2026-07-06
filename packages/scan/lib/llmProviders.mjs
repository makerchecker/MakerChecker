// lib/llmProviders.mjs — the zero-dep, multi-provider transport for the opt-in
// --llm deep scan. This is the ONLY place a model id, endpoint, or price literal
// lives; every sibling module reads cfg.model and never hardcodes one.
//
// Providers span two request/response FAMILIES: Anthropic (/v1/messages) and
// OpenAI-compatible (/v1/chat/completions — OpenAI, OpenRouter, Together, Groq,
// and local Ollama / self-hosted servers). Plain fetch only, no SDKs.
//
// callModel() NEVER throws: every network/HTTP/parse failure degrades to
// {text:null} so the caller keeps its deterministic static finding. The single
// function that throws is resolveLlmConfig(), and only for a misconfiguration
// (unknown provider, missing key) BEFORE anything leaves the machine.

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the provider table (the only place endpoints/models/prices live) -------

/**
 * @typedef {{ family: 'anthropic'|'openai', defaultBaseUrl: string|null, path: string, defaultModel: string|null, envKeys: string[], needsKey: boolean, defaultConcurrency: number }} ProviderEntry
 */

/** @type {Record<string, ProviderEntry>} */
export const PROVIDERS = {
  anthropic: { family: 'anthropic', defaultBaseUrl: 'https://api.anthropic.com', path: '/v1/messages', defaultModel: 'claude-haiku-4-5', envKeys: ['ANTHROPIC_API_KEY'], needsKey: true, defaultConcurrency: 4 },
  openai: { family: 'openai', defaultBaseUrl: 'https://api.openai.com', path: '/v1/chat/completions', defaultModel: 'gpt-4o-mini', envKeys: ['OPENAI_API_KEY'], needsKey: true, defaultConcurrency: 4 },
  openrouter: { family: 'openai', defaultBaseUrl: 'https://openrouter.ai/api', path: '/v1/chat/completions', defaultModel: 'openai/gpt-4o-mini', envKeys: ['OPENROUTER_API_KEY'], needsKey: true, defaultConcurrency: 4 },
  together: { family: 'openai', defaultBaseUrl: 'https://api.together.xyz', path: '/v1/chat/completions', defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', envKeys: ['TOGETHER_API_KEY'], needsKey: true, defaultConcurrency: 4 },
  groq: { family: 'openai', defaultBaseUrl: 'https://api.groq.com/openai', path: '/v1/chat/completions', defaultModel: 'llama-3.3-70b-versatile', envKeys: ['GROQ_API_KEY'], needsKey: true, defaultConcurrency: 4 },
  // The privacy path: a local model, nothing leaves the machine, no key.
  ollama: { family: 'openai', defaultBaseUrl: 'http://localhost:11434', path: '/v1/chat/completions', defaultModel: 'qwen2.5-coder:7b', envKeys: [], needsKey: false, defaultConcurrency: 1 },
  // Any OpenAI-compatible server; base-url + model REQUIRED; key relaxed on loopback/LAN.
  'openai-compatible': { family: 'openai', defaultBaseUrl: null, path: '/v1/chat/completions', defaultModel: null, envKeys: ['OPENAI_API_KEY'], needsKey: true, defaultConcurrency: 4 },
};

export function listProviders() {
  return Object.keys(PROVIDERS);
}

// ---- the two family clients -------------------------------------------------

const CLIENTS = {
  anthropic: {
    buildRequest(req, cfg) {
      const body = { model: cfg.model, max_tokens: req.maxTokens ?? 512, messages: [{ role: 'user', content: req.user }] };
      if (req.system) body.system = req.system;
      // Deliberately NO temperature/top_p/top_k/seed/thinking/output_config: they
      // 400 on current Claude models, and omitting `thinking` keeps a classifier cheap.
      const headers = { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' };
      return { url: cfg.url, init: { method: 'POST', headers, body: JSON.stringify(body) } };
    },
    parseResponse(json) {
      if (json?.stop_reason === 'refusal') return null;
      const text = (Array.isArray(json?.content) ? json.content : [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join('');
      return text || null;
    },
  },
  openai: {
    buildRequest(req, cfg) {
      const messages = [];
      if (req.system) messages.push({ role: 'system', content: req.system });
      messages.push({ role: 'user', content: req.user });
      const body = { model: cfg.model, messages, temperature: 0, seed: 7 };
      const tokenKey = cfg.provider === 'openai' && /^(o\d|gpt-5)/.test(cfg.model) ? 'max_completion_tokens' : 'max_tokens';
      body[tokenKey] = req.maxTokens ?? 512;
      if (cfg.jsonMode) body.response_format = { type: 'json_object' };
      const headers = { 'content-type': 'application/json' };
      if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
      if (cfg.provider === 'openrouter') headers['x-title'] = 'mc-scan';
      return { url: cfg.url, init: { method: 'POST', headers, body: JSON.stringify(body) } };
    },
    parseResponse(json) {
      const c = json?.choices?.[0]?.message?.content;
      if (typeof c === 'string') return c || null;
      if (Array.isArray(c)) return c.map((p) => p?.text || '').join('') || null;
      return null;
    },
  },
};

// ---- URL / host helpers -----------------------------------------------------

export function joinUrl(base, path) {
  const b = String(base).replace(/\/+$/, '');
  if (path.startsWith('/v1/') && /\/v1$/.test(b)) return b + path.slice(3); // no /v1/v1
  if (b.endsWith(path)) return b;
  return b + path;
}

export function safeHost(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

// Pure literal matching, NO DNS. 'device' (nothing leaves this machine) is only
// ever loopback; 'lan' is a private-range host; everything else is 'cloud'.
export function classifyHost(host) {
  const h = String(host);
  const loopback = h === 'localhost' || /^127(\.\d+){3}$/.test(h) || h === '::1' || h === '[::1]' || h === '0.0.0.0';
  if (loopback) return 'device';
  const lan = /\.local$|\.internal$/.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  if (lan) return 'lan';
  return 'cloud';
}

// ---- config resolution (the ONLY throwing function) -------------------------

/**
 * Resolve a provider config from flags > env > policy.llm > built-in defaults.
 * Throws only on misconfiguration, before any request is built.
 * @returns {{ provider: string, family: string, model: string, baseUrl: string, url: string, apiKey: string|null, jsonMode: boolean, concurrency: number, providerEntry: ProviderEntry, destinationHost: string, reach: 'device'|'lan'|'cloud' }}
 */
export function resolveLlmConfig({ flags = {}, env = process.env, policy } = {}) {
  const llmPolicy = isPlainObject(policy?.llm) ? policy.llm : {};
  const provider = String(flags.llmProvider || env.MC_LLM_PROVIDER || llmPolicy.provider || 'anthropic').toLowerCase();
  const entry = PROVIDERS[provider];
  if (!entry) throw new Error(`--llm-provider "${provider}" is not one of: ${listProviders().join(', ')}`);

  const model = flags.llmModel || env.MC_LLM_MODEL || llmPolicy.model || entry.defaultModel;
  const baseUrl = flags.llmBaseUrl || env.MC_LLM_BASE_URL || llmPolicy.baseUrl || entry.defaultBaseUrl;
  if (!baseUrl) throw new Error(`provider "${provider}" needs --llm-base-url (the endpoint origin)`);
  if (!model) throw new Error(`provider "${provider}" needs --llm-model`);

  // Key: flag > provider env > generic env. NEVER from policy, so mc-policy.json
  // stays committable and secret-free.
  let apiKey = flags.llmKey || null;
  if (!apiKey) for (const k of entry.envKeys) if (env[k]) { apiKey = env[k]; break; }
  if (!apiKey) apiKey = env.MC_LLM_KEY || null;

  const url = joinUrl(baseUrl, entry.path);
  const host = safeHost(url);
  const reach = classifyHost(host);

  // Self-hosted OpenAI-compatible servers on loopback/LAN need no key; --llm-no-key forces it.
  const needsKey = entry.needsKey && !(provider === 'openai-compatible' && reach !== 'cloud') && !flags.llmNoKey;
  if (needsKey && !apiKey) {
    throw new Error(
      `--llm with provider "${provider}" requires an API key (set ${entry.envKeys.concat(['--llm-key', 'MC_LLM_KEY']).join(' or ')}). ` +
        'The default scan (no --llm) sends nothing anywhere.',
    );
  }

  const jsonMode = typeof flags.llmJson === 'boolean' ? flags.llmJson : typeof llmPolicy.jsonMode === 'boolean' ? llmPolicy.jsonMode : true;
  const concurrency = flags.llmConcurrency || entry.defaultConcurrency;

  return { provider, family: entry.family, model, baseUrl, url, apiKey, jsonMode, concurrency, providerEntry: entry, destinationHost: host, reach };
}

// ---- the transport ----------------------------------------------------------

/**
 * Call the model. NEVER throws — any failure returns { text: null }.
 * @param {object} cfg  a resolved config (family selects the client)
 * @param {{ system?: string, user: string, maxTokens?: number }} req
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ text: string|null }>}
 */
export async function callModel(cfg, req, { fetchImpl = fetch } = {}) {
  const client = CLIENTS[cfg.family];
  if (!client) return { text: null };
  let jsonMode = cfg.jsonMode;
  for (let attempt = 0; attempt <= 2; attempt++) {
    let built;
    try { built = client.buildRequest(req, { ...cfg, jsonMode }); } catch { return { text: null }; }
    let res;
    try { res = await fetchImpl(built.url, built.init); } catch { return { text: null }; }
    if (res.status === 429 && attempt < 2) {
      const ra = Number(res.headers?.get?.('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 8000) : 500 * 2 ** attempt + Math.floor(Math.random() * 250));
      continue;
    }
    if (!res.ok) {
      // Some OpenAI-compatible servers reject response_format: strip it and retry once.
      if (jsonMode && res.status === 400 && attempt < 2) { jsonMode = false; continue; }
      return { text: null };
    }
    let data;
    try { data = await res.json(); } catch { return { text: null }; }
    try { return { text: client.parseResponse(data) }; } catch { return { text: null }; }
  }
  return { text: null };
}

// ---- bounded worker pool ----------------------------------------------------

/** Run fn over items with at most `concurrency` in flight. Order-preserving. */
export async function pMap(items, fn, concurrency) {
  const out = new Array(items.length);
  let i = 0;
  const width = Math.min(concurrency || 1, items.length) || 1;
  const workers = Array.from({ length: width }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---- JSON extraction --------------------------------------------------------

// Balanced scan from the first `open` delimiter, ignoring delimiters in strings.
function balancedFrom(text, open, close) {
  const start = text.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  let inStr = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === inStr && text[i - 1] !== '\\') inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

export function extractFirstJson(text) {
  const s = String(text ?? '');
  const greedy = s.match(/\{[\s\S]*\}/);
  if (greedy) { try { return JSON.parse(greedy[0]); } catch { /* fall through */ } }
  const bal = balancedFrom(s, '{', '}');
  if (bal) { try { return JSON.parse(bal); } catch { return null; } }
  return null;
}

export function extractFirstJsonArray(text) {
  const s = String(text ?? '');
  const greedy = s.match(/\[[\s\S]*\]/);
  if (greedy) { try { const v = JSON.parse(greedy[0]); if (Array.isArray(v)) return v; } catch { /* fall through */ } }
  const bal = balancedFrom(s, '[', ']');
  if (bal) { try { const v = JSON.parse(bal); return Array.isArray(v) ? v : null; } catch { return null; } }
  return null;
}

// ---- cost / token estimate --------------------------------------------------

// Per-MTok [input, output] USD, for the caveat and --llm-estimate. Unknown -> null.
const PRICE = {
  'claude-opus-4-8': [5, 25],
  'claude-sonnet-5': [3, 15],
  'claude-haiku-4-5': [1, 5],
  'claude-fable-5': [10, 50],
  'gpt-4o-mini': [0.15, 0.6],
};

export function estimateTokens(str) {
  return Math.ceil(String(str ?? '').length / 4) + 400; // +overhead per request
}

/** @returns {{ usd: number|null }} */
export function costEstimate(model, inTok, outTok, reach) {
  if (reach === 'device') return { usd: 0 };
  const p = PRICE[model];
  if (!p) return { usd: null };
  return { usd: (inTok / 1e6) * p[0] + (outTok / 1e6) * p[1] };
}

// ---- the loud, honest caveat ------------------------------------------------

/**
 * Build the stderr caveat lines from a resolved plan. Three-way by reach — never
 * claims "this machine" for a network host.
 * @param {{ mode: string, provider: string, model: string, url: string, host: string, reach: string, toolsSent: number, filesSent: number, estInputTokens: number, estCostUsd: number|null }} plan
 * @returns {string[]}
 */
export function llmCaveatLines(plan) {
  const what =
    plan.mode === 'code'
      ? `up to ${plan.filesSent} source snippet(s) flagged by static markers`
      : plan.mode === 'tools'
        ? `the name, description, params, and a body snippet of ${plan.toolsSent} ambiguous tool(s)`
        : `${plan.toolsSent} ambiguous tool(s) and up to ${plan.filesSent} source snippet(s)`;
  const idLine = `  provider ${plan.provider}  model ${plan.model}  endpoint ${plan.url}`;
  if (plan.reach === 'device') {
    return [
      '  --llm ON, LOCAL model — nothing leaves this machine.',
      idLine,
      `  ${what} is sent to your local endpoint. $0 API cost.`,
    ];
  }
  if (plan.reach === 'lan') {
    return [
      `  --llm ON — sending to a model on your LOCAL NETWORK (host ${plan.host}) — not off your LAN, but not this machine either.`,
      idLine,
      `  ${what}. Windows may contain secrets near the flagged calls (masked before send).`,
    ];
  }
  const cost = plan.estCostUsd == null ? 'set by your provider' : `~$${plan.estCostUsd.toFixed(4)}`;
  return [
    '  WARNING: --llm is ON — the one part of mc scan that is NOT offline.',
    idLine,
    `  ${what} will be sent over the network to ${plan.host}. Windows may contain secrets near the flagged calls (masked before send).`,
    `  Estimated ~${plan.estInputTokens.toLocaleString('en-US')} input tokens; cost ${cost}.`,
    '  The default scan (no --llm) sends nothing anywhere. For a fully private deep scan: --llm-provider ollama.',
  ];
}
