// test/policy.test.mjs — loadPolicy up-tree lookup + defaults + validation;
// mergeSignatures (custom wins). Zero deps, node:test + node:assert/strict.
//
// policy.mjs owns *loading and validating* the policy. The actual skip/downgrade
// behaviour lives in classify.mjs (tested there); here we assert that the loaded
// policy correctly carries the `ignore` and `allow` entries that drive those
// behaviours, plus defaults, up-tree discovery, and error-clear validation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_POLICY, loadPolicy, mergeSignatures, validatePolicy } from '../lib/policy.mjs';
import { SIGNATURES } from '../lib/signatures.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'mc-policy-test-'));
}

const VALID_CUSTOM_SIG = {
  id: 'phi-export',
  category: 'data-exfiltration',
  verbs: ['export', 'download'],
  argHints: ['phi', 'mrn'],
  severity: 'HIGH',
  action: 'exports protected health information out of the system of record',
  resembles: { aid: 'AID-2025-0006', title: 'ShadowLeak zero-click Gmail exfiltration' },
  control: 'high_risk_requires_gate',
  why: 'A tool that can pull PHI and reach the network is an exfiltration path.',
};

test('no config found -> DEFAULT_POLICY with path null', () => {
  const dir = tmp();
  try {
    const p = loadPolicy(dir);
    assert.deepEqual(p, DEFAULT_POLICY);
    assert.equal(p.path, null);
    // must be a fresh object, not the shared constant (no mutation bleed)
    assert.notEqual(p, DEFAULT_POLICY);
    assert.notEqual(p.allow, DEFAULT_POLICY.allow);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a valid config loads and is discovered by walking UP the tree', () => {
  const root = tmp();
  const nested = join(root, 'a', 'b', 'c');
  mkdirSync(nested, { recursive: true });
  const file = join(root, 'mc-policy.json');
  writeFileSync(file, JSON.stringify({
    version: 1,
    severityThreshold: 'HIGH',
    failOn: 'HIGH',
    ignore: ['search_cases'],
    allow: {
      delete_case_records: { gate: 'high_risk_requires_gate', note: 'Deny-by-default — resembles AID-2025-0005.' },
    },
    customSignatures: [VALID_CUSTOM_SIG],
  }));
  try {
    const p = loadPolicy(nested); // start deep, must find it at the root
    assert.equal(p.path, file);
    assert.equal(p.version, 1);
    assert.equal(p.severityThreshold, 'HIGH');
    assert.equal(p.failOn, 'HIGH');
    assert.deepEqual(p.ignore, ['search_cases']); // arrays replace
    assert.deepEqual(p.allow.delete_case_records, {
      gate: 'high_risk_requires_gate',
      note: 'Deny-by-default — resembles AID-2025-0005.',
    });
    assert.equal(p.customSignatures.length, 1);
    assert.equal(p.customSignatures[0].id, 'phi-export');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit --policy path loads exactly that file (no up-tree walk)', () => {
  const dir = tmp();
  const file = join(dir, 'custom-name.json');
  writeFileSync(file, JSON.stringify({ version: 1, failOn: 'MEDIUM' }));
  try {
    const p = loadPolicy('/some/unrelated/dir', file);
    assert.equal(p.path, file);
    assert.equal(p.failOn, 'MEDIUM');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an ignore list skips a tool (the tool is carried in policy.ignore)', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'mc-policy.json'), JSON.stringify({
    version: 1,
    ignore: ['run_migration'],
  }));
  try {
    const p = loadPolicy(dir);
    assert.ok(p.ignore.includes('run_migration'), 'ignored tool present so classify will skip it');
    // per contract, ignore replaces the default [] entirely
    assert.deepEqual(p.ignore, ['run_migration']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an allow entry downgrades a tool to OK (gate + note carried in policy.allow)', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'mc-policy.json'), JSON.stringify({
    version: 1,
    allow: {
      wire_reimbursement: { gate: 'limit_violation', note: 'Deny-by-default — resembles AID-2026-0004.' },
    },
  }));
  try {
    const p = loadPolicy(dir);
    const gov = p.allow.wire_reimbursement;
    assert.ok(gov, 'governed tool present in policy.allow so classify will downgrade it to OK');
    assert.equal(gov.gate, 'limit_violation');
    assert.match(gov.note, /AID-2026-0004/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an invalid config errors clearly and is coerced to safe defaults (never throws)', () => {
  // validatePolicy surfaces clear, field-level errors...
  const raw = {
    version: 2,
    severityThreshold: 'SUPER_BAD',
    failOn: 'nope',
    ignore: 'not-an-array',
    allow: { bad_tool: { gate: 'not_a_control', note: 'x' }, ok_tool: { gate: 'approval_gate', note: 'ok' } },
    customSignatures: [{ id: 'broken' }], // missing required fields
    bogusKey: true,
  };
  const { policy, errors } = validatePolicy(raw);
  assert.ok(errors.length >= 5, `expected multiple clear errors, got: ${JSON.stringify(errors)}`);
  assert.ok(errors.some((e) => /severityThreshold/.test(e)));
  assert.ok(errors.some((e) => /failOn/.test(e)));
  assert.ok(errors.some((e) => /ignore/.test(e)));
  assert.ok(errors.some((e) => /not_a_control/.test(e)));
  assert.ok(errors.some((e) => /customSignatures\[0\]/.test(e)));
  assert.ok(errors.some((e) => /unknown property "bogusKey"/.test(e)));

  // ...and the coerced policy is safe: bad values fall back to defaults, the one
  // valid allow entry survives, the broken signature is dropped.
  assert.equal(policy.version, 1);
  assert.equal(policy.severityThreshold, DEFAULT_POLICY.severityThreshold);
  assert.equal(policy.failOn, DEFAULT_POLICY.failOn);
  assert.deepEqual(policy.ignore, []);
  assert.equal(policy.allow.bad_tool, undefined);
  assert.deepEqual(policy.allow.ok_tool, { gate: 'approval_gate', note: 'ok' });
  assert.deepEqual(policy.customSignatures, []);

  // loadPolicy never throws on the same junk on disk and coerces likewise.
  const dir = tmp();
  const file = join(dir, 'mc-policy.json');
  writeFileSync(file, JSON.stringify(raw));
  try {
    const p = loadPolicy(dir);
    assert.equal(p.path, file);
    assert.equal(p.severityThreshold, DEFAULT_POLICY.severityThreshold);
    assert.equal(p.failOn, DEFAULT_POLICY.failOn);
    assert.deepEqual(p.ignore, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed JSON on disk never throws -> defaults with path null', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'mc-policy.json'), '{ this is : not json');
  try {
    const p = loadPolicy(dir);
    assert.deepEqual(p, DEFAULT_POLICY);
    assert.equal(p.path, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeSignatures: a custom signature with a builtin id REPLACES the builtin', () => {
  const overrideId = SIGNATURES[0].id;
  const override = {
    id: overrideId,
    category: 'data-loss',
    verbs: ['nuke'],
    severity: 'HIGH',
    action: 'does a custom thing',
    resembles: { aid: 'AID-2025-0005', title: 'x' },
    control: 'approval_gate',
    why: 'because',
  };
  const policy = { ...DEFAULT_POLICY, customSignatures: [override, VALID_CUSTOM_SIG] };
  const merged = mergeSignatures(SIGNATURES, policy);

  // exactly one signature with the overridden id, and it is the custom one
  const withId = merged.filter((s) => s.id === overrideId);
  assert.equal(withId.length, 1);
  assert.equal(withId[0].action, 'does a custom thing');
  assert.equal(withId[0].control, 'approval_gate');
  // the brand-new custom signature is appended
  assert.ok(merged.some((s) => s.id === 'phi-export'));
  // total count: builtins - 1 replaced + 2 custom
  assert.equal(merged.length, SIGNATURES.length - 1 + 2);
});

test('mergeSignatures is defensive against a policy with no customSignatures', () => {
  assert.deepEqual(mergeSignatures(SIGNATURES, DEFAULT_POLICY), SIGNATURES);
  assert.deepEqual(mergeSignatures(SIGNATURES, {}), SIGNATURES);
});
