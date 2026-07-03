// Tests for lib/compose.mjs — pairwise composition checks. Zero deps, node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composePairs, readsSensitive, sendsExternal } from '../lib/compose.mjs';
import { renderJson, renderMarkdown } from '../lib/report.mjs';

const okFinding = (tool) => ({
  tool, severity: 'OK', signature: null, resembles: null,
  control: null, action: null, why: null, governedBy: null,
});

const readEmail = okFinding({
  name: 'read_email',
  description: 'Read messages from the user inbox.',
  params: ['folder', 'limit'],
  source: 'tools.json',
});

const httpPost = okFinding({
  name: 'http_post',
  description: 'POST a payload to a URL.',
  params: ['url', 'body'],
  source: 'tools.json',
});

const weather = okFinding({
  name: 'get_weather',
  description: 'Current weather for a city.',
  params: ['city'],
  source: 'tools.json',
});

test('a sensitive reader + an external sender form an exfiltration pair', () => {
  const pairs = composePairs([readEmail, httpPost, weather]);
  assert.equal(pairs.length, 1);
  const p = pairs[0];
  assert.deepEqual(p.tools, ['read_email', 'http_post']);
  assert.equal(p.severity, 'HIGH');
  assert.equal(p.rule, 'exfiltration-pair');
  // Named against the real zero-click exfiltration incidents.
  assert.equal(p.resembles.aid, 'AID-2025-0002');
  assert.ok(p.alsoResembles.some((r) => r.aid === 'AID-2025-0006'));
  assert.equal(p.fix, 'separate the roles holding these two grants / gate the sender');
});

test('readsSensitive / sendsExternal heuristics', () => {
  assert.equal(readsSensitive(readEmail.tool), true);
  assert.equal(readsSensitive(weather.tool), false);
  assert.equal(sendsExternal(httpPost.tool), true);
  assert.equal(sendsExternal(weather.tool), false);
  // list_secrets is a reader; send_message is a sender by name alone.
  assert.equal(readsSensitive({ name: 'list_secrets', description: '', params: [] }), true);
  assert.equal(sendsExternal({ name: 'send_message', description: '', params: [] }), true);
});

test('no pair without both halves; a tool cannot pair with itself', () => {
  assert.deepEqual(composePairs([readEmail, weather]), []);
  assert.deepEqual(composePairs([httpPost, weather]), []);
  // read_and_send matches both roles but must not pair with itself.
  const both = okFinding({ name: 'send_email_from_inbox', description: 'Read the inbox and send email.', params: ['to'], source: 's' });
  assert.deepEqual(composePairs([both]), []);
});

test('a governed tool defeats the pair (gated sender is out of scope)', () => {
  const gated = { ...httpPost, governedBy: { gate: 'high_risk_requires_gate', note: 'gated' } };
  assert.deepEqual(composePairs([readEmail, gated]), []);
});

test('resilient to junk input', () => {
  assert.deepEqual(composePairs(null), []);
  assert.deepEqual(composePairs([null, {}, okFinding({ name: '', description: '', params: [] })]), []);
});

test('pairs render in JSON and Markdown reports', () => {
  const findings = [readEmail, httpPost];
  const pairs = composePairs(findings);
  const meta = {
    target: 't', toolCount: 2, sourceCount: 1,
    counts: { CATASTROPHIC: 0, HIGH: 0, MEDIUM: 0, OK: 2, GOVERNED: 0 },
    policyPath: null, failOn: 'CATASTROPHIC', scanVersion: '0.0.0', corpusSize: 41,
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
  const json = renderJson(findings, meta, pairs);
  assert.deepEqual(json.pairs, pairs);
  const md = renderMarkdown(findings, meta, pairs);
  assert.ok(md.includes('Composition pairs'));
  assert.ok(md.includes('`read_email` + `http_post`'));
  assert.ok(md.includes('AID-2025-0002'));
});
