// test/fix.test.mjs — the --fix governance scaffold generator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateFixScaffold } from '../lib/fix.mjs';

const finding = (name, severity, over = {}) => ({
  severity, signature: 'x', governedBy: null,
  tool: { name, description: '', params: [], source: 's' }, ...over,
});

test('returns null when there is nothing to govern', () => {
  assert.equal(generateFixScaffold([]), null);
  assert.equal(generateFixScaffold([finding('safe', 'OK')]), null);
  assert.equal(generateFixScaffold([{ ...finding('gov', 'CATASTROPHIC'), governedBy: { gate: 'g', note: 'n' } }]), null);
  assert.equal(generateFixScaffold([{ ...finding('note', 'MEDIUM'), unverified: true }]), null);
});

test('high-risk skills go to the separate risk-desk; medium to the agent', () => {
  const out = generateFixScaffold([
    finding('send_transaction', 'CATASTROPHIC', { action: 'moves value' }),
    finding('list_records', 'MEDIUM'),
  ]);
  assert.match(out, /\.defineSkill\('send_transaction@1', \{ riskTier: 'high' \}\)/);
  assert.match(out, /\.grant\('risk-desk', 'send_transaction@1'\)/);
  assert.match(out, /\.grant\('agent', 'list_records@1'\)/);
  assert.match(out, /gov\.governedTool\('approver', 'send_transaction@1'/);
  assert.match(out, /gov\.governedTool\('my-agent', 'list_records@1'/);
});

test('composition pairs become role conflicts', () => {
  const out = generateFixScaffold(
    [finding('write_contract', 'CATASTROPHIC'), finding('fetch_ipfs_content', 'MEDIUM')],
    [{ rule: 'injection-drain-pair', tools: ['fetch_ipfs_content', 'write_contract'] }],
  );
  assert.match(out, /\.defineConflict\('fetch_ipfs_content@1', 'write_contract@1'\)/);
});

test('non-identifier tool names become safe JS identifiers and skill refs', () => {
  const out = generateFixScaffold([finding('0x.swap!', 'CATASTROPHIC')]);
  assert.match(out, /export const _0x_swap_ = gov\.governedTool/);
  assert.match(out, /'0x.swap_@1'/); // dot kept (valid in a skill ref), ! sanitized
});

test('the generated scaffold is syntactically valid JavaScript', () => {
  const out = generateFixScaffold([
    finding('send_transaction', 'CATASTROPHIC'),
    finding('read_email', 'HIGH'),
    finding('list_files', 'MEDIUM'),
  ], [{ rule: 'exfiltration-pair', tools: ['read_email', 'send_transaction'] }]);
  const dir = mkdtempSync(join(tmpdir(), 'mcfix-'));
  const file = join(dir, 'mc-governance.mjs');
  try {
    writeFileSync(file, out);
    execFileSync(process.execPath, ['--check', file]); // throws on a syntax error
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
