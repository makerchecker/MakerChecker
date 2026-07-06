// test/expansion.test.mjs — the capability-expansion batch:
//   - jsToolConstructors: Vercel AI SDK / Genkit object-key tools
//   - Python @tool truth fixes: description-as-name bug + docstring capture
//   - Precision hotfix: Solidity ABI + JSX form fields no longer flagged
//   - nameOnlyVerbs: `format` fires on a name, never on prose
//   - self-approval anti-pattern: model-settable confirm flag flagged, never a gate
//
// Zero deps: node:test + node:assert/strict. Run: node --test test/expansion.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseTools } from '../lib/parse.mjs';
import { classify } from '../lib/classify.mjs';
import { SIGNATURES } from '../lib/signatures.mjs';
import { DEFAULT_POLICY } from '../lib/policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');
const byName = (tools) => Object.fromEntries(tools.map((t) => [t.name, t]));
const classifyOne = (tool) => classify(tool, SIGNATURES, DEFAULT_POLICY);

// ---- jsToolConstructors: Vercel AI SDK / Genkit object-key tools -------------

test('discovers AI-SDK object-key tools by their binding name', () => {
  const tools = byName(parseTools(join(FIX, 'ai_sdk_tools.ts')));
  assert.ok(tools.tradingPush, 'tradingPush (const binding) should be discovered');
  assert.ok(tools.getQuote, 'getQuote (const binding) should be discovered');
  assert.ok(tools.read_file, 'defineTool with a name: field should be discovered');
  assert.ok(!tools.notATool, 'tool() with no description/schema must be skipped');
});

test('AI-SDK inputSchema params are extracted from z.object', () => {
  const tools = byName(parseTools(join(FIX, 'ai_sdk_tools.ts')));
  assert.deepEqual(tools.tradingPush.params, ['symbol', 'qty', 'side', 'confirm_live_trading']);
});

test('a discovered AI-SDK live-order tool classifies CATASTROPHIC with self-approval', () => {
  const tools = byName(parseTools(join(FIX, 'ai_sdk_tools.ts')));
  const f = classifyOne(tools.tradingPush);
  assert.equal(f.severity, 'CATASTROPHIC');
  assert.ok(f.selfApproval, 'the model-settable confirm_live_trading flag should be flagged');
  assert.equal(f.selfApproval.param, 'confirm_live_trading');
});

test("one AI-SDK tool's body never bleeds into the next (body-cap)", () => {
  const tools = byName(parseTools(join(FIX, 'ai_sdk_tools.ts')));
  // getQuote's body must not contain the broker POST from tradingPush.
  assert.ok(!/broker\.example\.com/.test(tools.getQuote.body || ''));
});

// ---- Python @tool truth fixes ----------------------------------------------

test('@tool(description=...) uses the function name, not the description, as the name', () => {
  const tools = byName(parseTools(join(FIX, 'py_tool_desc.py')));
  assert.ok(tools.broadcast_update, 'name should be the def name broadcast_update');
  assert.ok(
    !Object.keys(tools).some((n) => n.startsWith('Send an announcement')),
    'the description string must never become a tool name',
  );
  assert.match(tools.broadcast_update.description, /announcement message/);
});

test('@tool("explicit") takes the positional string as the name and captures the docstring', () => {
  const tools = byName(parseTools(join(FIX, 'py_tool_desc.py')));
  assert.ok(tools.explicit_name, 'positional string literal renames the tool');
  assert.match(tools.explicit_name.description, /Adds one/);
});

test('bare @tool captures the docstring as the description', () => {
  const tools = byName(parseTools(join(FIX, 'py_tool_desc.py')));
  assert.match(tools.delete_records.description, /Delete all rows/);
});

test('a docstring-described broadcaster classifies as send-message', () => {
  const tools = byName(parseTools(join(FIX, 'py_tool_desc.py')));
  const f = classifyOne(tools.broadcast_update);
  assert.equal(f.signature, 'send-message');
  assert.equal(f.severity, 'HIGH');
});

// ---- self-approval gate inversion ------------------------------------------

test('an in-body check of a model-settable confirm flag does NOT earn a downgrade', () => {
  const tools = byName(parseTools(join(FIX, 'py_tool_desc.py')));
  const f = classifyOne(tools.wipe_database);
  assert.equal(f.severity, 'CATASTROPHIC', 'gate inversion: a self-checked flag is not a human gate');
  assert.ok(f.selfApproval, 'the confirm parameter should be flagged as self-approval');
  assert.equal(f.selfApproval.param, 'confirm');
});

// ---- Precision hotfix: no false positives on ABI / JSX ----------------------

test('Solidity ABI entries are not parsed as tools', () => {
  const tools = parseTools(join(FIX, 'solidity_abi.ts'));
  const names = tools.map((t) => t.name);
  assert.ok(!names.includes('transfer'), 'ABI function entry must not become a tool');
  assert.ok(!names.includes('approve'), 'ABI function entry must not become a tool');
  assert.equal(tools.length, 0, 'an ABI constants file yields zero tools');
});

test('React form fields in .tsx are not parsed as tools', () => {
  const tools = parseTools(join(FIX, 'form_fields.tsx'));
  const names = tools.map((t) => t.name);
  assert.ok(!names.includes('email'), 'a form field is not a tool');
  assert.ok(!names.includes('password'), 'a form field is not a tool');
});

// ---- nameOnlyVerbs: `format` fires on a name, never on prose ----------------

test('`format` in a description does not fire destroy-data', () => {
  const tool = {
    name: 'create_appointment',
    description: 'Create an appointment. date must be a string (format: YYYY-MM-DD).',
    params: ['date', 'patient'],
    source: 'x.py:1',
  };
  const f = classifyOne(tool);
  assert.notEqual(f.signature, 'destroy-data', 'prose "format:" must not read as a disk format');
});

test('`format` as a name token still fires destroy-data', () => {
  const tool = { name: 'format_disk', description: 'Format the drive.', params: ['disk'], source: 'x.py:1' };
  const f = classifyOne(tool);
  assert.equal(f.signature, 'destroy-data');
  assert.equal(f.severity, 'CATASTROPHIC');
});

// ---- web3-value-movement signature -----------------------------------------

test('send_transaction and swaps fire web3-value-movement (CATASTROPHIC)', () => {
  const sendTx = classifyOne({ name: 'send_transaction', description: 'Send a raw transaction on-chain.', params: ['chain', 'transaction'], source: 'x.ts:1' });
  assert.equal(sendTx.signature, 'web3-value-movement');
  assert.equal(sendTx.severity, 'CATASTROPHIC');

  const swap = classifyOne({ name: 'swap_exact_tokens', description: 'Swap one token for another.', params: ['tokenIn', 'tokenOut', 'amountIn'], source: 'x.ts:1' });
  assert.equal(swap.signature, 'web3-value-movement');
  assert.equal(swap.severity, 'CATASTROPHIC');
});

test('a model-settable confirm on a web3 mover is flagged as self-approval', () => {
  const f = classifyOne({ name: 'bridge_tokens', description: 'Bridge assets across chains.', params: ['chain', 'amountIn', 'confirm'], source: 'x.ts:1' });
  assert.equal(f.signature, 'web3-value-movement');
  assert.ok(f.selfApproval);
});

test('ERC-20 allowance reads and deposit-address reads do NOT fire web3 (the verified FPs)', () => {
  // uniswap_check_approval: no nameOnlyVerb matches, and move-money no longer owns "swap"
  assert.notEqual(classifyOne({ name: 'uniswap_check_approval', description: 'Check the ERC-20 allowance a spender has to transfer tokens.', params: ['token', 'spender'], source: 'x.ts:1' }).signature, 'move-money');
  // renzo_get_deposit_address: "deposit" matches, but the leading read token suppresses it
  const dep = classifyOne({ name: 'renzo_get_deposit_address', description: 'Get the deposit address for a wallet.', params: ['wallet'], source: 'x.ts:1' });
  assert.notEqual(dep.signature, 'web3-value-movement');
  assert.notEqual(dep.signature, 'move-money');
});

test('an auth/identity token send is not a wallet drain', () => {
  const f = classifyOne({ name: 'send_reset_token', description: 'Send a password reset token by email.', params: ['token', 'email'], source: 'x.py:1' });
  assert.notEqual(f.signature, 'web3-value-movement');
});

test('a blandly-named tool whose body sends a raw transaction fires web3 via body evidence', () => {
  const f = classifyOne({ name: 'execute', description: 'Execute the plan.', params: ['plan'], source: 'x.ts:1', body: 'const hash = await walletClient.sendTransaction(tx)', bodyLine: 2 });
  assert.equal(f.signature, 'web3-value-movement');
  assert.equal(f.severity, 'CATASTROPHIC');
});
