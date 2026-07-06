// test/llmProviders.test.mjs — the zero-dep multi-provider transport. All
// network stubbed; nothing leaves the machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveLlmConfig, listProviders, joinUrl, safeHost, classifyHost,
  callModel, pMap, extractFirstJson, extractFirstJsonArray, costEstimate,
} from '../lib/llmProviders.mjs';

// ---- resolveLlmConfig -------------------------------------------------------

test('anthropic default throws a provider-aware missing-key message', () => {
  assert.throws(() => resolveLlmConfig({ flags: {}, env: {} }), /ANTHROPIC_API_KEY/);
});

test('ollama resolves keyless, local, concurrency 1', () => {
  const c = resolveLlmConfig({ flags: { llmProvider: 'ollama' }, env: {} });
  assert.equal(c.reach, 'device');
  assert.equal(c.model, 'qwen2.5-coder:7b');
  assert.equal(c.apiKey, null);
  assert.equal(c.concurrency, 1);
});

test('openai-compatible on loopback relaxes the key requirement', () => {
  const c = resolveLlmConfig({ flags: { llmProvider: 'openai-compatible', llmBaseUrl: 'http://localhost:8000', llmModel: 'x' }, env: {} });
  assert.equal(c.reach, 'device');
  assert.equal(c.apiKey, null);
});

test('an unknown provider throws and lists the valid ones', () => {
  assert.throws(() => resolveLlmConfig({ flags: { llmProvider: 'bogus' }, env: {} }), (e) => /bogus/.test(e.message) && /anthropic/.test(e.message));
});

test('key resolves from the provider env var; flag beats env', () => {
  const c1 = resolveLlmConfig({ flags: { llmProvider: 'openai' }, env: { OPENAI_API_KEY: 'envk' } });
  assert.equal(c1.apiKey, 'envk');
  const c2 = resolveLlmConfig({ flags: { llmProvider: 'openai', llmKey: 'flagk' }, env: { OPENAI_API_KEY: 'envk' } });
  assert.equal(c2.apiKey, 'flagk');
});

test('policy.llm supplies provider/model but never the key', () => {
  const c = resolveLlmConfig({ flags: {}, env: { OPENAI_API_KEY: 'k' }, policy: { llm: { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'SHOULD_BE_IGNORED' } } });
  assert.equal(c.provider, 'openai');
  assert.equal(c.model, 'gpt-4o-mini');
  assert.equal(c.apiKey, 'k'); // from env, NOT from policy
});

// ---- url + host helpers -----------------------------------------------------

test('joinUrl does not double a trailing /v1', () => {
  assert.equal(joinUrl('https://x/v1', '/v1/chat/completions'), 'https://x/v1/chat/completions');
  assert.equal(joinUrl('https://api.anthropic.com', '/v1/messages'), 'https://api.anthropic.com/v1/messages');
});

test('classifyHost: cloud / lan / device', () => {
  assert.equal(classifyHost('api.anthropic.com'), 'cloud');
  assert.equal(classifyHost('192.168.1.9'), 'lan');
  assert.equal(classifyHost('127.0.0.1'), 'device');
  assert.equal(classifyHost('localhost'), 'device');
  assert.equal(safeHost('http://localhost:11434/v1/chat/completions'), 'localhost');
});

// ---- family clients (via callModel, stubbed) --------------------------------

test('anthropic request sends no temperature/thinking and the right headers', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'hi' }] }) }; };
  const cfg = { family: 'anthropic', provider: 'anthropic', model: 'claude-haiku-4-5', url: 'https://api.anthropic.com/v1/messages', apiKey: 'k', jsonMode: true, concurrency: 1 };
  const { text } = await callModel(cfg, { user: 'x', maxTokens: 10 }, { fetchImpl });
  assert.equal(text, 'hi');
  assert.equal(seen.init.headers['x-api-key'], 'k');
  assert.equal(seen.init.headers['anthropic-version'], '2023-06-01');
  assert.ok(!('temperature' in seen.body) && !('thinking' in seen.body) && !('response_format' in seen.body));
});

test('anthropic parseResponse concatenates text blocks and refusal -> null', async () => {
  const cfg = { family: 'anthropic', provider: 'anthropic', model: 'm', url: 'u', apiKey: 'k', jsonMode: false, concurrency: 1 };
  const two = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }) });
  assert.equal((await callModel(cfg, { user: 'x' }, { fetchImpl: two })).text, 'ab');
  const refuse = async () => ({ ok: true, status: 200, json: async () => ({ stop_reason: 'refusal', content: [] }) });
  assert.equal((await callModel(cfg, { user: 'x' }, { fetchImpl: refuse })).text, null);
});

test('openai request sets Bearer + json_object; max_completion_tokens only for o*/gpt-5', async () => {
  let body;
  const fetchImpl = async (u, init) => { body = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }; };
  const base = { family: 'openai', provider: 'openai', url: 'https://api.openai.com/v1/chat/completions', apiKey: 'k', jsonMode: true, concurrency: 1 };
  await callModel({ ...base, model: 'gpt-4o-mini' }, { user: 'x', maxTokens: 20 }, { fetchImpl });
  assert.equal(body.max_tokens, 20);
  assert.equal(body.temperature, 0);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  await callModel({ ...base, model: 'o3-mini' }, { user: 'x', maxTokens: 20 }, { fetchImpl });
  assert.equal(body.max_completion_tokens, 20);
  assert.ok(!('max_tokens' in body));
});

test('callModel never throws: fetch error, 500, and bad JSON all yield {text:null}', async () => {
  const cfg = { family: 'openai', provider: 'openai', model: 'm', url: 'u', apiKey: 'k', jsonMode: false, concurrency: 1 };
  assert.equal((await callModel(cfg, { user: 'x' }, { fetchImpl: async () => { throw new Error('down'); } })).text, null);
  assert.equal((await callModel(cfg, { user: 'x' }, { fetchImpl: async () => ({ ok: false, status: 500 }) })).text, null);
  assert.equal((await callModel(cfg, { user: 'x' }, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } }) })).text, null);
});

test('a 400 in jsonMode strips response_format and retries once', async () => {
  const bodies = [];
  const fetchImpl = async (u, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) return { ok: false, status: 400 };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  const cfg = { family: 'openai', provider: 'ollama', model: 'm', url: 'u', apiKey: null, jsonMode: true, concurrency: 1 };
  const { text } = await callModel(cfg, { user: 'x' }, { fetchImpl });
  assert.equal(text, 'ok');
  assert.ok('response_format' in bodies[0]);
  assert.ok(!('response_format' in bodies[1]));
});

// ---- pMap + JSON extraction -------------------------------------------------

test('pMap caps in-flight work and preserves order', async () => {
  let inflight = 0, peak = 0;
  const fn = async (x) => { inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, 5)); inflight--; return x * 2; };
  const out = await pMap([1, 2, 3, 4, 5, 6], fn, 2);
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12]);
  assert.ok(peak <= 2);
});

test('extractFirstJson / extractFirstJsonArray tolerate surrounding prose', () => {
  assert.deepEqual(extractFirstJson('sure: {"severity":"HIGH"} done'), { severity: 'HIGH' });
  assert.deepEqual(extractFirstJsonArray('here [{"a":1},{"b":2}] end'), [{ a: 1 }, { b: 2 }]);
  assert.equal(extractFirstJson('no json'), null);
});

test('costEstimate is 0 for device and null for an unknown model', () => {
  assert.equal(costEstimate('anything', 1000, 500, 'device').usd, 0);
  assert.equal(costEstimate('mystery-model', 1000, 500, 'cloud').usd, null);
  assert.ok(costEstimate('claude-haiku-4-5', 1e6, 0, 'cloud').usd === 1);
});

test('listProviders includes the seven providers', () => {
  const p = listProviders();
  for (const name of ['anthropic', 'openai', 'openrouter', 'together', 'groq', 'ollama', 'openai-compatible']) assert.ok(p.includes(name), name);
});
