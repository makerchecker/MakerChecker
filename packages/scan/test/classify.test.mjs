// Tests for lib/classify.mjs — zero deps, node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classify, detectBodySignals } from '../lib/classify.mjs';
import { SIGNATURES } from '../lib/signatures.mjs';

const basePolicy = { version: 1, ignore: [], allow: {}, customSignatures: [], path: null };

const deleteTool = {
  name: 'deleteRecord',
  description: 'Delete a record from the production database.',
  params: ['table', 'id'],
  source: 'tools.json',
};

const searchTool = {
  name: 'searchDocuments',
  description: 'Full-text search over the knowledge base.',
  params: ['query', 'limit'],
  source: 'tools.json',
};

test('a delete tool classifies as CATASTROPHIC and names a real incident', () => {
  const f = classify(deleteTool, SIGNATURES, basePolicy);
  assert.equal(f.severity, 'CATASTROPHIC');
  assert.equal(f.signature, 'destroy-data');
  assert.equal(f.control, 'high_risk_requires_gate');
  assert.equal(f.resembles.aid, 'AID-2025-0005');
  assert.ok(typeof f.action === 'string' && f.action.length > 0);
  assert.ok(typeof f.why === 'string' && f.why.length > 0);
  assert.equal(f.governedBy, null);
  assert.equal(f.tool, deleteTool);
});

test('a search tool classifies as OK with all hoisted fields null', () => {
  const f = classify(searchTool, SIGNATURES, basePolicy);
  assert.equal(f.severity, 'OK');
  assert.equal(f.signature, null);
  assert.equal(f.resembles, null);
  assert.equal(f.control, null);
  assert.equal(f.action, null);
  assert.equal(f.why, null);
  assert.equal(f.governedBy, null);
});

test('an allow-listed dangerous tool downgrades to OK but keeps the match + sets governedBy', () => {
  const gov = { gate: 'high_risk_requires_gate', note: 'Governed: deny-by-default, gated (was AID-2025-0005).' };
  const policy = { ...basePolicy, allow: { deleteRecord: gov } };
  const f = classify(deleteTool, SIGNATURES, policy);
  assert.equal(f.severity, 'OK');
  assert.deepEqual(f.governedBy, gov);
  // The match must survive so the report can say "was CATASTROPHIC — now governed".
  assert.equal(f.signature, 'destroy-data');
  assert.equal(f.resembles.aid, 'AID-2025-0005');
  assert.equal(f.control, 'high_risk_requires_gate');
  assert.ok(f.action && f.why);
});

test('an ignored tool is skipped entirely: OK, no match, no governedBy', () => {
  const policy = { ...basePolicy, ignore: ['deleteRecord'], allow: { deleteRecord: { gate: 'approval_gate', note: 'x' } } };
  const f = classify(deleteTool, SIGNATURES, policy);
  assert.equal(f.severity, 'OK');
  assert.equal(f.signature, null);
  assert.equal(f.resembles, null);
  assert.equal(f.control, null);
  assert.equal(f.governedBy, null); // ignore wins over allow
});

test('resilient to malformed input: never throws', () => {
  assert.doesNotThrow(() => classify(null, SIGNATURES, basePolicy));
  assert.doesNotThrow(() => classify({}, SIGNATURES, basePolicy));
  assert.doesNotThrow(() => classify(deleteTool, null, null));
  const f = classify({ name: 'x' }, SIGNATURES, {});
  assert.equal(f.severity, 'OK');
});

test('a bare "stock" noun is market data, not a purchase: get_stock_info(symbol) is OK', () => {
  const t = { name: 'get_stock_info', description: '', params: ['symbol'], source: 'app.py:10' };
  const f = classify(t, SIGNATURES, basePolicy);
  assert.equal(f.severity, 'OK');
  assert.equal(f.signature, null);
});

test('visualize_stock(symbol, api_key) does not match autonomous-spend', () => {
  const t = { name: 'visualize_stock', description: '', params: ['symbol', 'api_key'], source: 'app.py:42' };
  const f = classify(t, SIGNATURES, basePolicy);
  assert.notEqual(f.signature, 'autonomous-spend');
  assert.equal(f.severity, 'OK');
});

test('a confirmed spend still matches: buy verb in the name, price/quantity argHints', () => {
  const strong = { name: 'buy_item', description: '', params: ['item_id'], source: 's' };
  assert.equal(classify(strong, SIGNATURES, basePolicy).signature, 'autonomous-spend');
  const hinted = { name: 'checkout_cart', description: 'Complete the purchase.', params: ['cart', 'price', 'quantity'], source: 's' };
  const f = classify(hinted, SIGNATURES, basePolicy);
  assert.notEqual(f.severity, 'OK');
});

test('highest-severity match wins when several signatures match', () => {
  // "exec" is a strong verb (CATASTROPHIC run-shell); a shell tool should be
  // CATASTROPHIC, not settle for a lower-severity match.
  const shellTool = { name: 'execCommand', description: 'Execute a shell command.', params: ['command'], source: 's' };
  const f = classify(shellTool, SIGNATURES, basePolicy);
  assert.equal(f.severity, 'CATASTROPHIC');
  assert.equal(f.signature, 'run-shell');
});

// ---- body signals ------------------------------------------------------------

test('detectBodySignals finds shell/destroy/send/write markers with line numbers', () => {
  const body = [
    'import subprocess',        // line 10
    'subprocess.run(cmd)',      // line 11: shell
    'shutil.rmtree(path)',      // line 12: destroy
    'requests.post(url, data)', // line 13: external-send
    "open(path, 'w')",          // line 14: write
  ].join('\n');
  const signals = detectBodySignals(body, 10);
  const kinds = signals.map((s) => s.kind);
  assert.ok(kinds.includes('shell'));
  assert.ok(kinds.includes('destroy'));
  assert.ok(kinds.includes('external-send'));
  assert.ok(kinds.includes('write'));
  assert.equal(signals.find((s) => s.kind === 'destroy').line, 12);
});

test('a blandly-named tool whose body shells out is raised to CATASTROPHIC with evidence', () => {
  const bland = {
    name: 'tidy_workspace',
    description: 'Tidy up the workspace.',
    params: ['target'],
    source: 'app.py:8',
    body: '    subprocess.run(["rm", "-rf", target])\n    return "done"',
    bodyLine: 9,
  };
  const f = classify(bland, SIGNATURES, basePolicy);
  assert.equal(f.severity, 'CATASTROPHIC');
  assert.equal(f.signature, 'run-shell');
  assert.ok(f.resembles && f.resembles.aid, 'names a real incident');
  assert.ok(f.action.includes('body evidence'), 'action carries a body-evidence note');
  assert.ok(Array.isArray(f.evidence) && f.evidence.length > 0);
  assert.equal(f.evidence[0].line, 9);
});

test('a body signal never LOWERS severity: a delete tool with a benign body stays CATASTROPHIC', () => {
  const t = { ...deleteTool, body: "    open(path, 'w').write(data)", bodyLine: 5 };
  const f = classify(t, SIGNATURES, basePolicy);
  assert.equal(f.severity, 'CATASTROPHIC'); // write (MEDIUM) must not downgrade
  assert.equal(f.signature, 'destroy-data');
  assert.ok(f.evidence.some((e) => e.kind === 'write'));
});

test('a tool with no body signals gains no evidence field', () => {
  const t = { ...searchTool, body: '    return index.lookup(query)', bodyLine: 3 };
  const f = classify(t, SIGNATURES, basePolicy);
  assert.equal(f.severity, 'OK');
  assert.equal(f.evidence, undefined);
});

test('an external-send body raises an OK tool only to MEDIUM — an HTTP call alone is not exfiltration', () => {
  const t = {
    name: 'sync_notes',
    description: 'Sync notes.',
    params: ['notes'],
    source: 'app.py:20',
    body: '    requests.post("https://example.com/collect", json=notes)',
    bodyLine: 21,
  };
  const f = classify(t, SIGNATURES, basePolicy);
  assert.equal(f.severity, 'MEDIUM');
  assert.equal(f.signature, 'exfiltrate');
  // the send capability still feeds the composition pass via the evidence list
  assert.equal(f.evidence[0].kind, 'external-send');
});
