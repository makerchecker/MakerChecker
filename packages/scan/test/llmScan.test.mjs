// test/llmScan.test.mjs — the opt-in --llm deep scan, Mode A. All network
// stubbed; these tests never leave the machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { llmScan, isAmbiguous } from '../lib/llmScan.mjs';

const CONFIG = {
  provider: 'anthropic',
  family: 'anthropic',
  model: 'claude-haiku-4-5',
  url: 'https://api.anthropic.com/v1/messages',
  apiKey: 'k',
  jsonMode: false,
  concurrency: 4,
};

const finding = (over = {}) => ({
  severity: 'OK',
  signature: null,
  resembles: null,
  control: null,
  action: null,
  why: null,
  governedBy: null,
  ...over,
  tool: { name: 't', description: '', params: [], source: 'x.py:1', ...(over.tool || {}) },
});

const okResponse = (verdict) => ({
  ok: true,
  status: 200,
  json: async () => ({ content: [{ type: 'text', text: JSON.stringify(verdict) }] }),
});

test('selects the ambiguous findings: MEDIUM, OK-with-body, unmatched', () => {
  assert.equal(isAmbiguous(finding({ severity: 'MEDIUM', signature: 'sig' })), true);
  assert.equal(isAmbiguous(finding({ severity: 'OK', signature: 'sig', tool: { body: 'x = 1' } })), true);
  assert.equal(isAmbiguous(finding({ severity: 'OK', signature: null })), true);
  assert.equal(isAmbiguous(finding({ severity: 'CATASTROPHIC', signature: 'destroy-data' })), false);
  assert.equal(isAmbiguous(finding({ severity: 'OK', signature: 'sig' })), false);
  assert.equal(isAmbiguous(finding({ severity: 'MEDIUM', governedBy: { gate: 'approval_gate', note: '' } })), false);
});

test('a CATASTROPHIC verdict raises an OK-with-body finding and records staticSeverity', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return okResponse({ severity: 'CATASTROPHIC', action: 'shells out', why: 'body calls subprocess' });
  };
  const f = finding({ severity: 'OK', signature: null, tool: { name: 'helper', body: 'subprocess.run(cmd)' } });
  const [out] = await llmScan([f], { config: CONFIG, fetchImpl });
  assert.equal(out.severity, 'CATASTROPHIC');
  assert.equal(out.staticSeverity, 'OK'); // the CI-gate floor is preserved
  assert.equal(out.assessedBy, 'llm');
  assert.equal(out.action, 'shells out');
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.messages[0].content, /subprocess\.run/);
});

test('a lower verdict never lowers a static severity', async () => {
  const fetchImpl = async () => okResponse({ severity: 'OK', action: 'harmless', why: 'looks fine' });
  const f = finding({ severity: 'MEDIUM', signature: 'sig' });
  const [out] = await llmScan([f], { config: CONFIG, fetchImpl });
  assert.equal(out.severity, 'MEDIUM'); // the deterministic floor stands
  assert.equal(out.assessedBy, 'llm'); // but the annotation is recorded
});

test('a malformed response leaves the finding unchanged', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'not json' }] }) });
  const f = finding({ severity: 'MEDIUM', signature: 'sig' });
  const [out] = await llmScan([f], { config: CONFIG, fetchImpl });
  assert.equal(out, f);
});

test('a failed request leaves the finding unchanged', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const f = finding({ severity: 'MEDIUM', signature: 'sig' });
  const [out] = await llmScan([f], { config: CONFIG, fetchImpl });
  assert.equal(out, f);
});

test('unambiguous findings pass through without a network call', async () => {
  let called = 0;
  const fetchImpl = async () => { called++; return okResponse({ severity: 'OK', action: '', why: '' }); };
  const f = finding({ severity: 'CATASTROPHIC', signature: 'destroy-data' });
  const [out] = await llmScan([f], { config: CONFIG, fetchImpl });
  assert.equal(out, f);
  assert.equal(called, 0);
});

test('an OpenAI-family config parses choices[].message.content', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ severity: 'HIGH', action: 'a', why: 'w' }) } }] }),
  });
  const cfg = { ...CONFIG, provider: 'openai', family: 'openai', model: 'gpt-4o-mini' };
  const f = finding({ severity: 'MEDIUM', signature: 'sig' });
  const [out] = await llmScan([f], { config: cfg, fetchImpl });
  assert.equal(out.severity, 'HIGH');
  assert.equal(out.assessedBy, 'llm');
});
