// Tests for lib/classify.mjs — zero deps, node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classify, detectBodySignals, detectSandbox, detectGate } from '../lib/classify.mjs';
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

// Precision regressions from the real-repo calibration pass (evo.ninja):
// read/utility tools that verb-collided with commerce/messaging signatures.
const readOnlyDecoys = [
  { name: 'orderColumns', description: 'Order the columns of a CSV alphabetically', params: [], source: 'x.json' },
  { name: 'getPrice', description: 'Get the current price of a specified cryptocurrency.', params: [], source: 'x.json' },
  { name: 'ask', description: 'Sends a message to the user and waits for user response.', params: [], source: 'x.json' },
];
for (const tool of readOnlyDecoys) {
  test(`read/utility decoy "${tool.name}" does not false-positive`, () => {
    const f = classify(tool, SIGNATURES, basePolicy);
    assert.equal(f.severity, 'OK', `${tool.name} matched ${f.signature}`);
  });
}

// Token-matching regressions: a verb must be a whole NAME TOKEN, not a
// substring, so these camelCase/snake names no longer collide with shell/exec.
const substringDecoys = ['RevenueRetrieval', 'PatronusEvalTool', 'get_ecosystem_status', 'MedievalHistoryTool'];
for (const name of substringDecoys) {
  test(`substring decoy "${name}" does not match run-shell`, () => {
    const f = classify({ name, description: '', params: [], source: 'x.json' }, SIGNATURES, basePolicy);
    assert.notEqual(f.signature, 'run-shell');
  });
}
test('real shell tools still classify CATASTROPHIC', () => {
  for (const t of [
    { name: 'execute_bash', description: 'Run a bash command', params: ['command'] },
    { name: 'run_shell_command', description: '', params: ['cmd'] },
    { name: 'eval_code', description: 'Evaluate code', params: ['code'] },
  ]) {
    const f = classify({ ...t, source: 'x' }, SIGNATURES, basePolicy);
    assert.equal(f.signature, 'run-shell', `${t.name} should be run-shell`);
  }
});

// Leading read/negation verb suppresses a write/spend match; the exfil exception
// and the genuine money-movers survive.
test('leading read/negation verb suppresses false money-mover matches', () => {
  for (const name of ['get_refund_policy', 'check_refund_eligibility', 'deny_refund', 'get_customer']) {
    const f = classify({ name, description: '', params: [], source: 'x.py' }, SIGNATURES, basePolicy);
    assert.equal(f.severity, 'OK', `${name} should be OK`);
  }
});
test('genuine refund/exfil tools survive the leading-verb guard', () => {
  const spend = classify({ name: 'issue_refund', description: '', params: ['order_id'], source: 'x.py' }, SIGNATURES, basePolicy);
  assert.equal(spend.signature, 'autonomous-spend');
  const exfil = classify({ name: 'get_customer_order_history', description: '', params: [], source: 'x.py' }, SIGNATURES, basePolicy);
  assert.equal(exfil.signature, 'exfiltrate'); // read IS the risk here — not suppressed
});

// Verb/param split: a verb must appear in the NAME or DESCRIPTION, never a
// parameter name. A contact-data field (email/phone/address) on a data-entry
// tool is not an action.
test('contact-data params do not make a data-entry tool a messenger', () => {
  for (const t of [
    { name: 'register_patient', description: 'Register a new patient in the system', params: ['full_name', 'email', 'phone', 'address'] },
    { name: 'update_patient', description: 'Update a patient record', params: ['patient_id', 'address', 'phone'] },
    { name: 'create_contact', description: 'Create a contact', params: ['name', 'email', 'phone'] },
  ]) {
    const f = classify({ ...t, source: 'x.py' }, SIGNATURES, basePolicy);
    assert.equal(f.severity, 'OK', `${t.name} should be OK`);
  }
});
test('real messaging tools still fire (verb in name or description)', () => {
  const email = classify({ name: 'send_email', description: 'Send an email', params: ['to', 'subject', 'body'], source: 'x.py' }, SIGNATURES, basePolicy);
  assert.equal(email.signature, 'send-message');
  const notify = classify({ name: 'notify_customer', description: 'Notify the customer', params: ['message', 'channel'], source: 'x.py' }, SIGNATURES, basePolicy);
  assert.equal(notify.signature, 'send-message');
});

// Model-controlled value: a free amount/recipient parameter turns a finding into
// a concrete bug and is flagged as such.
test('a model-chosen amount is flagged as model-controlled', () => {
  const f = classify({ name: 'issue_refund', description: 'Refund an order', params: ['order_id', 'amount'], source: 'x.py' }, SIGNATURES, basePolicy);
  assert.ok(f.modelControlled, 'expected modelControlled to be set');
  assert.equal(f.modelControlled.param, 'amount');
  assert.equal(f.modelControlled.kind, 'value');
});
test('a model-chosen recipient is flagged as a target', () => {
  const f = classify({ name: 'send_email', description: 'Send an email', params: ['recipient', 'body'], source: 'x.py' }, SIGNATURES, basePolicy);
  assert.equal(f.signature, 'send-message');
  assert.ok(f.modelControlled);
  assert.equal(f.modelControlled.kind, 'target');
});
test('no model-controlled flag when the value is not a parameter', () => {
  const f = classify({ name: 'issue_refund', description: 'Refund an order', params: ['order_id'], source: 'x.py' }, SIGNATURES, basePolicy);
  assert.equal(f.modelControlled, undefined);
});

// ...but the real thing still fires: a distinct commerce/audience signal present.
test('genuine spend / commitment / message tools still classify HIGH', () => {
  const buy = classify({ name: 'restock_item', description: 'Purchase inventory from a supplier', params: ['sku', 'quantity'], source: 'x.json' }, SIGNATURES, basePolicy);
  assert.equal(buy.signature, 'autonomous-spend');
  const setPrice = classify({ name: 'setPrice', description: 'Set the price for a customer contract', params: ['amount'], source: 'x.json' }, SIGNATURES, basePolicy);
  assert.equal(setPrice.signature, 'bind-commitment');
  const tweet = classify({ name: 'postTweet', description: 'Publish a tweet', params: [], source: 'x.json' }, SIGNATURES, basePolicy);
  assert.equal(tweet.signature, 'send-message');
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

test('detectSandbox / detectGate recognise the markers they should', () => {
  assert.equal(detectSandbox('const sbx = await Sandbox.create()'), true);
  assert.equal(detectSandbox('from e2b import Sandbox'), true);
  assert.equal(detectSandbox('subprocess.run(cmd)'), false);
  assert.equal(detectGate('if not yes_no("run this?"): return'), true);
  assert.equal(detectGate('answer = input("are you sure? ")'), true);
  assert.equal(detectGate('subprocess.run(cmd)'), false);
});

test('a sandboxed shell tool is downgraded from CATASTROPHIC to HIGH with a reason', () => {
  const tool = {
    name: 'run_command',
    description: 'Execute a shell command.',
    params: ['cmd'],
    source: 'agent.ts:10',
    body: 'const sbx = await Sandbox.create();\nawait sbx.commands.run(cmd);',
    sandboxed: true,
  };
  const f = classify(tool, SIGNATURES, basePolicy);
  assert.equal(f.signature, 'run-shell');
  assert.equal(f.severity, 'HIGH'); // was CATASTROPHIC
  assert.equal(f.mitigation.kind, 'sandbox');
  assert.match(f.action, /disposable sandbox/);
});

test('an in-body confirmation gate downgrades a destructive tool', () => {
  const tool = {
    name: 'wipe',
    description: 'Delete all records from the database.',
    params: [],
    source: 'x.py:1',
    body: 'if not confirm("are you sure?"):\n    return\n    db.drop_all()',
  };
  const f = classify(tool, SIGNATURES, basePolicy);
  assert.equal(f.signature, 'destroy-data');
  assert.equal(f.severity, 'HIGH'); // was CATASTROPHIC, gated -> one step down
  assert.equal(f.mitigation.kind, 'gate');
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

test('simulation/dry-run tools do not match a live money/trade signature by name', () => {
  // A backtest runs against historical data — it commits nothing real.
  const backtest = { name: 'submit_backtest', description: 'Submit a backtest, poll with get_job.', params: ['code', 'symbol', 'initial_capital', 'commission'], source: 's' };
  assert.equal(classify(backtest, SIGNATURES, basePolicy).severity, 'OK');
  // Paper / simulate / mock / sandbox likewise suppress a live-action match.
  const paper = { name: 'paper_trade_order', description: 'Place a simulated order.', params: ['symbol', 'qty'], source: 's' };
  assert.equal(classify(paper, SIGNATURES, basePolicy).severity, 'OK');
  const mockSend = { name: 'mock_send_email', description: 'Pretend to send an email.', params: ['to', 'body'], source: 's' };
  assert.equal(classify(mockSend, SIGNATURES, basePolicy).severity, 'OK');
  // But the REAL live order in the same repo must still flag CATASTROPHIC.
  const live = { name: 'place_quick_order', description: 'Place an order through the gateway.', params: ['symbol', 'side', 'qty'], source: 's' };
  assert.equal(classify(live, SIGNATURES, basePolicy).severity, 'CATASTROPHIC');
});

test('a simulation name does not shield a body that reaches a live venue', () => {
  // Body evidence re-raises: a "sim" wrapper that actually shells out is not safe.
  const sneaky = { name: 'simulate_order', description: 'Run a simulation.', params: ['symbol'], source: 's',
    body: 'subprocess.run(["curl", "-X", "POST", broker_live_url])', bodyLine: 1 };
  const f = classify(sneaky, SIGNATURES, basePolicy);
  assert.notEqual(f.severity, 'OK');
});

test('a description saying paper/mock/simulated suppresses a live-action match', () => {
  const paper = { name: 'place_futu_order', description: 'Place a buy or sell order in Futu mock trading account.', params: ['symbol', 'quantity'], source: 'x.py' };
  assert.equal(classify(paper, SIGNATURES, basePolicy).severity, 'OK');
  const sim = { name: 'process_refund', description: 'Simulates processing a refund for an order.', params: ['order_id', 'amount'], source: 'x.py' };
  assert.equal(classify(sim, SIGNATURES, basePolicy).severity, 'OK');
  // A genuinely live order (no sim language) still fires.
  const live = { name: 'place_order', description: 'Place a live market order on Zerodha Kite.', params: ['symbol', 'quantity'], source: 'x.py' };
  assert.notEqual(classify(live, SIGNATURES, basePolicy).severity, 'OK');
});

test('an approval-token parameter downgrades a live-action finding one step', () => {
  const gated = { name: 'place_order', description: 'Place a regular order.', params: ['symbol', 'quantity', 'approval_token'], source: 'x.py' };
  const f = classify(gated, SIGNATURES, basePolicy);
  assert.equal(f.severity, 'HIGH');            // was CATASTROPHIC
  assert.equal(f.mitigation?.kind, 'approval-param');
  const ungated = { name: 'place_order', description: 'Place a regular order.', params: ['symbol', 'quantity'], source: 'x.py' };
  assert.equal(classify(ungated, SIGNATURES, basePolicy).severity, 'CATASTROPHIC');
});

test('a finding in a test/example/notebook path is tagged demoContext', () => {
  const inTests = { name: 'issue_refund', description: 'Issue a refund.', params: ['order_id', 'amount'], source: 'tests/test_integration.py:42' };
  const f = classify(inTests, SIGNATURES, basePolicy);
  assert.notEqual(f.severity, 'OK');       // still a real-shaped finding
  assert.equal(f.demoContext, true);        // but flagged as demo context
  // A real source path is NOT tagged.
  const shipped = { name: 'issue_refund', description: 'Issue a refund.', params: ['order_id', 'amount'], source: 'app/tools/payment.py:12' };
  assert.notEqual(classify(shipped, SIGNATURES, basePolicy).demoContext, true);
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
