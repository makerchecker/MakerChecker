// test/parse.test.mjs — parseTools: OpenAI, MCP, LangChain (.py), MCP server (.ts),
// function-calling object literals, junk-resilience, node_modules skipping, dedupe.
//
// Zero deps: node:test + node:assert/strict. Run: node --test test/parse.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { parseTools } from '../lib/parse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');

const byName = (tools) => Object.fromEntries(tools.map((t) => [t.name, t]));

// ---- shape sanity -----------------------------------------------------------

test('every returned tool matches the Tool shape', () => {
  const tools = parseTools(join(FIX, 'openai-tools.json'));
  assert.ok(tools.length > 0);
  for (const t of tools) {
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.description, 'string');
    assert.ok(Array.isArray(t.params));
    assert.equal(typeof t.source, 'string');
    assert.ok(t.source.length > 0);
  }
});

// ---- OpenAI tools/function schema ------------------------------------------

test('parses an OpenAI tools/function schema (array of type:function)', () => {
  const tools = parseTools(join(FIX, 'openai-tools.json'));
  const m = byName(tools);
  assert.deepEqual(Object.keys(m).sort(), ['delete_file', 'send_email']);

  assert.equal(m.delete_file.description, 'Delete a file permanently from disk');
  assert.deepEqual(m.delete_file.params, ['path', 'recursive']);
  assert.deepEqual(m.send_email.params, ['to', 'subject', 'body']);

  // JSON source has no line suffix.
  assert.ok(m.delete_file.source.endsWith('openai-tools.json'));
  assert.ok(!m.delete_file.source.includes(':'));
});

// ---- MCP tools/list JSON ----------------------------------------------------

test('parses an MCP tools/list JSON (tools[] with inputSchema)', () => {
  const tools = parseTools(join(FIX, 'mcp-tools-list.json'));
  const m = byName(tools);
  assert.deepEqual(Object.keys(m).sort(), ['read_ledger', 'wire_transfer']);

  assert.equal(m.wire_transfer.description, 'Move money between two bank accounts');
  assert.deepEqual(m.wire_transfer.params, ['amount', 'to_account']);
  assert.deepEqual(m.read_ledger.params, ['account']);
  assert.ok(m.wire_transfer.source.endsWith('mcp-tools-list.json'));
});

// ---- LangChain Python code discovery ---------------------------------------

test('discovers LangChain tools in a .py file (@tool, Tool(), StructuredTool)', () => {
  const tools = parseTools(join(FIX, 'langchain_tools.py'));
  const m = byName(tools);

  // @tool on drop_table, @tool("refund_customer") rename, Tool(...), StructuredTool.from_function(...)
  assert.deepEqual(
    Object.keys(m).sort(),
    ['drop_table', 'refund_customer', 'run_calculation', 'web_search']
  );

  // decorated function -> params from the signature (self/defaults handled).
  assert.deepEqual(m.drop_table.params, ['table_name', 'cascade']);
  // explicit decorator name overrides the function name.
  assert.deepEqual(m.refund_customer.params, ['customer_id', 'amount']);
  // constructor description is captured.
  assert.equal(m.web_search.description, 'Search the public web for a query.');
  assert.equal(m.run_calculation.description, 'Run an arbitrary numeric calculation.');

  // code source carries a line number.
  assert.match(m.drop_table.source, /langchain_tools\.py:\d+$/);
  // the plain helper must not be picked up as a tool.
  assert.equal(m.not_a_tool, undefined);
});

// ---- TS MCP server code discovery ------------------------------------------

test('discovers MCP server registrations in a .ts file (server.tool / registerTool)', () => {
  const tools = parseTools(join(FIX, 'mcp_server.ts'));
  const m = byName(tools);

  assert.ok(m.restart_service, 'restart_service found');
  assert.ok(m.delete_bucket, 'delete_bucket found');
  // the McpServer({ name: "ops" }) constructor object must NOT be treated as a tool.
  assert.equal(m.ops, undefined);

  // positional description (server.tool(name, description, schema, cb)).
  assert.equal(m.restart_service.description, 'Restart a production service by name');
  assert.deepEqual(m.restart_service.params, ['service', 'force']);

  // options-object description + inputSchema (server.registerTool(name, { ... }, cb)).
  assert.equal(m.delete_bucket.description, 'Delete an S3 bucket and all of its contents');
  assert.deepEqual(m.delete_bucket.params, ['bucket', 'region']);

  assert.match(m.restart_service.source, /mcp_server\.ts:\d+$/);
});

// ---- function-calling object literals in code ------------------------------

test('discovers function-calling tool object literals in .js code', () => {
  const tools = parseTools(join(FIX, 'tool-array.js'));
  const m = byName(tools);
  assert.ok(m.charge_card, 'charge_card found');
  assert.equal(m.charge_card.description, "Charge a customer's credit card");
  assert.deepEqual(m.charge_card.params, ['amount', 'token']);
  // a non-tool object (no description/parameters) is ignored.
  assert.equal(m.ada, undefined);
  assert.equal(m.user, undefined);
});

// ---- body snippet capture ----------------------------------------------------

test('code discovery captures a body snippet with its start line; JSON does not', () => {
  const code = byName(parseTools(join(FIX, 'body_tool.py')));
  const t = code.tidy_workspace;
  assert.ok(t, 'tidy_workspace found');
  assert.equal(typeof t.body, 'string');
  assert.ok(t.body.includes('subprocess.run'), 'body contains the following lines');
  assert.equal(typeof t.bodyLine, 'number');
  assert.ok(t.bodyLine > 1);

  const json = byName(parseTools(join(FIX, 'openai-tools.json')));
  assert.equal(json.delete_file.body, undefined);
});

test('body snippet is capped at 60 lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-body-'));
  try {
    const filler = Array.from({ length: 200 }, (_, i) => `    x${i} = ${i}`).join('\n');
    writeFileSync(join(dir, 'big.py'), `@tool\ndef long_tool(a):\n${filler}\n`);
    const t = byName(parseTools(dir)).long_tool;
    assert.ok(t.body.split('\n').length <= 60);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- directory scan, resilience, dedupe, node_modules ----------------------

test('scanning the fixtures directory finds all sources and skips junk', () => {
  const tools = parseTools(FIX);
  const m = byName(tools);

  // tools from every fixture kind are present.
  for (const name of [
    'delete_file', 'send_email', 'wire_transfer', 'read_ledger',
    'drop_table', 'refund_customer', 'web_search', 'run_calculation',
    'restart_service', 'delete_bucket', 'charge_card',
  ]) {
    assert.ok(m[name], `${name} discovered in directory scan`);
  }

  // node_modules content is skipped entirely.
  assert.equal(m.rm_rf_everything, undefined);

  // broken.json did not throw and produced no tools.
  // (implicit: parseTools returned without error)
});

test('never throws on a missing path and returns []', () => {
  assert.deepEqual(parseTools(join(FIX, 'does-not-exist-xyz.json')), []);
});

test('dedupes by name, preferring a non-empty description', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-parse-'));
  try {
    // first sighting has an empty description, second fills it in.
    writeFileSync(join(dir, 'a.json'), JSON.stringify([{ name: 'dup_tool', parameters: { type: 'object', properties: { x: {} } } }]));
    writeFileSync(join(dir, 'b.json'), JSON.stringify([{ name: 'dup_tool', description: 'the real one', parameters: { type: 'object', properties: { x: {} } } }]));
    const tools = parseTools(dir);
    const dupes = tools.filter((t) => t.name === 'dup_tool');
    assert.equal(dupes.length, 1, 'only one entry per name');
    assert.equal(dupes[0].description, 'the real one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('is resilient to a directory full of non-tool / junk files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-junk-'));
  try {
    writeFileSync(join(dir, 'notes.txt'), 'hello world');            // ignored ext
    writeFileSync(join(dir, 'data.json'), '{ nope not json ]');       // bad json
    writeFileSync(join(dir, 'random.py'), 'x = 1\nprint("hi")\n');     // no tools
    const tools = parseTools(dir);
    assert.deepEqual(tools, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
