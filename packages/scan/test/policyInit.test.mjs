// test/policyInit.test.mjs — initPolicy(findings) must produce a deny-by-default
// mc-policy.json that governs every CATASTROPHIC/HIGH tool, and re-running the
// scan against that policy must downgrade those tools to OK (governed / green).
//
// Zero deps. Run: node --test test/policyInit.test.mjs
//
// The scan re-run is simulated by localClassify(), a compact reimplementation of
// the classify() governance rules in CONTRACTS.md (verb/argHint/strongVerb match,
// highest-severity wins, ignore -> OK, allow[name] -> OK + governedBy while
// keeping the matched signature fields). It runs against the REAL SIGNATURES
// table so the round-trip is genuine and independent of the classify.mjs build.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { initPolicy } from '../lib/policyInit.mjs';
import { DEFAULT_POLICY } from '../lib/policy.mjs';
import { SIGNATURES } from '../lib/signatures.mjs';

const SEV_RANK = { OK: 0, MEDIUM: 1, HIGH: 2, CATASTROPHIC: 3 };
const CONTROLS = new Set([
  'high_risk_requires_gate',
  'approval_gate',
  'limit_violation',
  'skill_not_granted',
  'sod_violation',
  'independent_citation_verification',
]);

// --- a faithful, self-contained classify() per CONTRACTS.md ------------------
function tokenize(tool) {
  const blob = [tool.name, tool.description, ...(tool.params || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return new Set(blob.split(/[^a-z0-9-]+/).filter(Boolean));
}

function localClassify(tool, policy) {
  const name = String(tool.name || '').toLowerCase();
  const tokens = tokenize(tool);
  let best = null;

  for (const sig of SIGNATURES) {
    const strong = new Set(sig.strongVerbs || []);
    const argHints = sig.argHints || [];
    const hasArgHint = argHints.some((h) => tokens.has(String(h).toLowerCase()));
    let matched = false;
    for (const v of sig.verbs) {
      const lv = String(v).toLowerCase();
      const verbPresent = tokens.has(lv) || name.includes(lv);
      if (!verbPresent) continue;
      if (hasArgHint || (strong.has(v) && name.includes(lv))) {
        matched = true;
        break;
      }
    }
    if (!matched) continue;
    if (!best || SEV_RANK[sig.severity] > SEV_RANK[best.severity]) best = sig;
  }

  const base = {
    tool,
    severity: best ? best.severity : 'OK',
    signature: best ? best.id : null,
    resembles: best ? best.resembles : null,
    control: best ? best.control : null,
    action: best ? best.action : null,
    why: best ? best.why : null,
    governedBy: null,
  };

  // Governance downgrade.
  if (policy && Array.isArray(policy.ignore) && policy.ignore.includes(tool.name)) {
    return { ...base, severity: 'OK', governedBy: null };
  }
  if (policy && policy.allow && policy.allow[tool.name]) {
    return { ...base, severity: 'OK', governedBy: policy.allow[tool.name] };
  }
  return base;
}

// --- fixtures: tools that trip real signatures + benign controls -------------
const TOOLS = [
  { name: 'delete_case_records', description: 'delete rows from a table', params: ['table', 'id'], source: 't.json' },
  { name: 'exec_shell', description: 'run a shell command', params: ['command'], source: 't.json' },
  { name: 'force_push_branch', description: 'force push to a git branch', params: ['branch', 'force'], source: 't.json' },
  { name: 'search_cases', description: 'search the case index', params: ['query'], source: 't.json' },
  { name: 'list_widgets', description: 'return a list of widgets', params: ['page'], source: 't.json' },
];

function firstPass() {
  return TOOLS.map((t) => localClassify(t, DEFAULT_POLICY));
}

// --- tests -------------------------------------------------------------------

test('fixtures actually trip real signatures (guards the test itself)', () => {
  const findings = firstPass();
  const dangerous = findings.filter((f) => f.severity === 'CATASTROPHIC' || f.severity === 'HIGH');
  assert.ok(dangerous.length >= 2, `expected >=2 dangerous fixtures, got ${dangerous.length}`);
  // and at least one benign/OK so we can prove init does NOT over-gate
  assert.ok(findings.some((f) => f.severity === 'OK'), 'expected at least one OK fixture');
});

test('init writes a governing allow entry for every CATASTROPHIC/HIGH finding', () => {
  const findings = firstPass();
  const dangerous = findings.filter((f) => f.severity === 'CATASTROPHIC' || f.severity === 'HIGH');
  const policy = initPolicy(findings);

  for (const f of dangerous) {
    const entry = policy.allow[f.tool.name];
    assert.ok(entry, `missing allow entry for ${f.tool.name}`);
    assert.equal(entry.gate, f.control, `gate for ${f.tool.name} must equal its signature control`);
    assert.ok(CONTROLS.has(entry.gate), `gate ${entry.gate} must be a valid control`);
    assert.ok(
      entry.note.includes(f.resembles.aid),
      `note for ${f.tool.name} must name incident ${f.resembles.aid}`,
    );
    assert.ok(/deny-by-default/i.test(entry.note), 'note must state deny-by-default posture');
    assert.ok(/MakerChecker/.test(entry.note), 'note must credit the enforcing engine');
  }

  // exactly the dangerous tools are governed — nothing benign is over-gated
  assert.equal(Object.keys(policy.allow).length, dangerous.length);
});

test('OK / non-dangerous tools are NOT added to allow', () => {
  const findings = firstPass();
  const policy = initPolicy(findings);
  for (const f of findings) {
    if (f.severity === 'CATASTROPHIC' || f.severity === 'HIGH') continue;
    assert.ok(!policy.allow[f.tool.name], `${f.tool.name} (${f.severity}) must not be gated`);
  }
});

test('a scan re-run against the generated policy downgrades dangerous tools to OK + governed', () => {
  const findings = firstPass();
  const dangerous = new Set(
    findings.filter((f) => f.severity === 'CATASTROPHIC' || f.severity === 'HIGH').map((f) => f.tool.name),
  );
  const policy = initPolicy(findings);

  const rerun = TOOLS.map((t) => localClassify(t, { ...policy, path: null }));
  for (const f of rerun) {
    if (dangerous.has(f.tool.name)) {
      assert.equal(f.severity, 'OK', `${f.tool.name} should be downgraded to OK`);
      assert.ok(f.governedBy, `${f.tool.name} should carry governedBy`);
      assert.ok(CONTROLS.has(f.governedBy.gate), 'governedBy.gate must be a valid control');
      // the incident context survives the downgrade (was-CATASTROPHIC / now-governed)
      assert.ok(f.signature, 'matched signature must be kept after governance');
      assert.ok(f.resembles && f.resembles.aid, 'resembles must be kept after governance');
    } else {
      assert.equal(f.governedBy, null, `${f.tool.name} should not be governed`);
    }
  }
});

test('init is idempotent over an already-governed agent (re-init reproduces the policy)', () => {
  const findings = firstPass();
  const policy = initPolicy(findings);
  const rerun = TOOLS.map((t) => localClassify(t, { ...policy, path: null }));
  const policy2 = initPolicy(rerun); // findings are now governed (severity OK)

  const keys1 = Object.keys(policy.allow).sort();
  const keys2 = Object.keys(policy2.allow).sort();
  assert.deepEqual(keys2, keys1, 're-init must keep governing the same tools');
  for (const k of keys1) {
    assert.equal(policy2.allow[k].gate, policy.allow[k].gate, `gate for ${k} must be stable across re-init`);
  }
});

test('returned object is the on-disk deny-by-default shape (no path, correct defaults)', () => {
  const policy = initPolicy(firstPass());
  assert.ok(!('path' in policy), 'on-disk shape must not include resolved path');
  assert.equal(policy.version, 1);
  assert.equal(policy.severityThreshold, 'MEDIUM');
  assert.equal(policy.failOn, 'CATASTROPHIC');
  assert.deepEqual(policy.ignore, []);
  assert.deepEqual(policy.customSignatures, []);
  assert.equal(typeof policy.allow, 'object');
});

test('resilient: junk and empty input never throw and never over-gate', () => {
  assert.deepEqual(initPolicy(undefined).allow, {});
  assert.deepEqual(initPolicy([]).allow, {});
  const policy = initPolicy([
    null,
    undefined,
    {},
    { tool: {} },
    { tool: { name: '' }, severity: 'CATASTROPHIC' },
    { tool: { name: 'ok_tool' }, severity: 'OK' },
    { tool: { name: 'medium_tool' }, severity: 'MEDIUM' },
  ]);
  assert.deepEqual(policy.allow, {}, 'no valid dangerous findings -> empty allow');
});

test('duplicate tool names are de-duplicated (first occurrence wins)', () => {
  const dup = [
    { tool: { name: 'dup' }, severity: 'CATASTROPHIC', control: 'high_risk_requires_gate', resembles: { aid: 'AID-2025-0005', title: 'x' }, action: 'destroys data' },
    { tool: { name: 'dup' }, severity: 'HIGH', control: 'approval_gate', resembles: { aid: 'AID-2022-0002', title: 'y' }, action: 'other' },
  ];
  const policy = initPolicy(dup);
  assert.equal(Object.keys(policy.allow).length, 1);
  assert.equal(policy.allow.dup.gate, 'high_risk_requires_gate', 'first finding wins');
});
