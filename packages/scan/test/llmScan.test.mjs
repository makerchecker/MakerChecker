// test/llmScan.test.mjs — the opt-in --llm deep scan. All network stubbed;
// these tests never leave the machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { llmScan, isAmbiguous } from '../lib/llmScan.mjs';

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
  json: async () => ({ content: [{ text: JSON.stringify(verdict) }] }),
});

test('throws before sending anything when the API key is missing', async () => {
  await assert.rejects(
    () => llmScan([finding()], { apiKey: undefined }),
    /ANTHROPIC_API_KEY/,
  );
});

test('selects the ambiguous findings: MEDIUM, OK-with-body, unmatched', () => {
  assert.equal(isAmbiguous(finding({ severity: 'MEDIUM', signature: 'sig' })), true);
  assert.equal(isAmbiguous(finding({ severity: 'OK', signature: 'sig', tool: { body: 'x = 1' } })), true);
  assert.equal(isAmbiguous(finding({ severity: 'OK', signature: null })), true);
  // static already confident: not sent
  assert.equal(isAmbiguous(finding({ severity: 'CATASTROPHIC', signature: 'destroy-data' })), false);
  assert.equal(isAmbiguous(finding({ severity: 'OK', signature: 'sig' })), false);
  // governed tools are settled, never sent
  assert.equal(isAmbiguous(finding({ severity: 'MEDIUM', governedBy: { gate: 'approval_gate', note: '' } })), false);
});

test('a CATASTROPHIC verdict raises an OK-with-body finding and marks it', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return okResponse({ severity: 'CATASTROPHIC', action: 'shells out', why: 'body calls subprocess' });
  };
  const f = finding({ severity: 'OK', signature: null, tool: { name: 'helper', body: 'subprocess.run(cmd)' } });
  const [out] = await llmScan([f], { fetchImpl, apiKey: 'k' });
  assert.equal(out.severity, 'CATASTROPHIC');
  assert.equal(out.assessedBy, 'llm');
  assert.equal(out.action, 'shells out');
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.messages[0].content, /subprocess\.run/);
});

test('a lower verdict never lowers a static severity', async () => {
  const fetchImpl = async () => okResponse({ severity: 'OK', action: 'harmless', why: 'looks fine' });
  const f = finding({ severity: 'MEDIUM', signature: 'sig' });
  const [out] = await llmScan([f], { fetchImpl, apiKey: 'k' });
  assert.equal(out.severity, 'MEDIUM'); // the deterministic floor stands
  assert.equal(out.assessedBy, 'llm'); // but the annotation is recorded
});

test('a malformed response leaves the finding unchanged', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ content: [{ text: 'not json at all' }] }) });
  const f = finding({ severity: 'MEDIUM', signature: 'sig' });
  const [out] = await llmScan([f], { fetchImpl, apiKey: 'k' });
  assert.equal(out, f);
});

test('a failed request leaves the finding unchanged', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const f = finding({ severity: 'MEDIUM', signature: 'sig' });
  const [out] = await llmScan([f], { fetchImpl, apiKey: 'k' });
  assert.equal(out, f);
});

test('unambiguous findings pass through without a network call', async () => {
  let called = 0;
  const fetchImpl = async () => { called++; return okResponse({ severity: 'OK', action: '', why: '' }); };
  const f = finding({ severity: 'CATASTROPHIC', signature: 'destroy-data' });
  const [out] = await llmScan([f], { fetchImpl, apiKey: 'k' });
  assert.equal(out, f);
  assert.equal(called, 0);
});
