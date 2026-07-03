// lib/policyInit.mjs — generate a deny-by-default mc-policy.json from findings.
//
// THE FREE-TO-PAID BRIDGE, MADE LITERAL.
//
// The object this builds, written to mc-policy.json, is the SAME file the paid,
// self-hosted MakerChecker engine enforces in production. Every entry it writes
// under `allow` names a MakerChecker enforcement primitive (the `gate`):
//
//   high_risk_requires_gate  — the irreversible action must pass a named-human
//                              approval gate before it can run.
//   approval_gate            — a maker prepares, a separate checker approves
//                              (four-eyes) before it commits.
//   limit_violation          — hard per-invocation + windowed caps, fail-closed
//                              (the kill switch).
//   skill_not_granted        — deny-by-default; a tool not in the grant set
//                              cannot run at all.
//   sod_violation            — segregation of duties; the actor that prepares
//                              must not be the one that commits.
//   independent_citation_verification — external claims/citations are verified
//                              before they are filed.
//
// The FREE `mc scan` generates this policy (deny-by-default: every irreversible
// tool starts gated). The PAID MakerChecker engine reads this exact file and
// enforces those same gates at runtime, with an audit trail a regulator can
// verify. There is no second config, no re-authoring: the thing you scan with is
// the thing you govern with.
//
// Zero deps, no I/O (scan.mjs writes the file). Deterministic.

import { DEFAULT_POLICY } from './policy.mjs';

/**
 * @typedef {import('./classify.mjs').Finding} Finding
 * @typedef {import('./policy.mjs').Policy} Policy
 * @typedef {import('./signatures.mjs').Control} Control
 */

// One human-readable clause per enforcement primitive, so each generated `note`
// tells a reader (and a regulator) exactly what the gate will do in production.
const GATE_CLAUSE = {
  high_risk_requires_gate:
    'It must pass a named-human approval gate before it runs.',
  approval_gate:
    'A maker prepares and a separate checker approves it (four-eyes) before it commits.',
  limit_violation:
    'It is bounded by hard per-invocation and windowed caps, fail-closed.',
  skill_not_granted:
    'It is not in the grant set: deny-by-default, it cannot run unless explicitly granted.',
  sod_violation:
    'Segregation of duties: the actor that prepares it must not be the one that commits it.',
  independent_citation_verification:
    'Its external claims and citations are independently verified before they are filed.',
};

/**
 * Is this finding a dangerous (CATASTROPHIC/HIGH) irreversible action that must
 * be gated deny-by-default?
 *
 * A finding qualifies when its current severity is CATASTROPHIC or HIGH, OR when
 * it is ALREADY governed by an existing policy (governedBy set) against a matched
 * signature — in the governed case classify() forces severity to 'OK' but keeps
 * the signature, so we must still re-emit its gate. This is what makes `mc scan
 * init` idempotent: re-running it over an already-governed agent reproduces the
 * same deny-by-default policy instead of silently un-gating everything.
 * @param {Finding} f
 * @returns {boolean}
 */
function isDangerous(f) {
  if (!f || !f.tool || !f.tool.name) return false;
  if (f.severity === 'CATASTROPHIC' || f.severity === 'HIGH') return true;
  // Already governed against a real signature -> keep it gated on re-init.
  if (f.governedBy && f.signature) return true;
  return false;
}

/**
 * Compose the deny-by-default justification for one allow entry. Always names the
 * real incident (resembles.aid) this tool's shape resembles, and states the gate
 * MakerChecker will enforce.
 * @param {Finding} f
 * @param {Control} gate
 * @returns {string}
 */
function buildNote(f, gate) {
  const name = f.tool && f.tool.name ? f.tool.name : 'this tool';
  const action = f.action || 'takes an action that cannot be undone';
  const ref = f.resembles || null;
  const aid = ref && ref.aid ? ref.aid : null;
  const title = ref && ref.title ? ref.title : null;
  const clause = GATE_CLAUSE[gate] || GATE_CLAUSE.high_risk_requires_gate;

  const resemblesPart = aid
    ? ` — resembles ${aid}${title ? ` (${title})` : ''}`
    : '';

  return `Deny-by-default. ${name} ${action}${resemblesPart}. ${clause} Enforced by MakerChecker.`;
}

/**
 * Build a deny-by-default policy from a set of findings.
 *
 * Starts from DEFAULT_POLICY. For every dangerous finding (see isDangerous) it
 * writes `allow[tool.name] = { gate: <finding.control>, note: <justification
 * naming resembles.aid> }`. The returned object is the ON-DISK policy shape: it
 * does NOT include the resolved `path` field. Written to mc-policy.json, it is
 * exactly what the paid MakerChecker engine enforces — and re-running `mc scan`
 * with it downgrades those tools to OK (governed / green).
 * @param {Finding[]} findings
 * @returns {Omit<Policy, 'path'>}
 */
export function initPolicy(findings) {
  // Drop the resolved-at-load-time `path`: this is the on-disk shape.
  const { path: _path, ...base } = DEFAULT_POLICY;

  /** @type {Record<string, { gate: Control, note: string }>} */
  const allow = {};

  const list = Array.isArray(findings) ? findings : [];
  for (const f of list) {
    if (!isDangerous(f)) continue;
    const name = f.tool.name;
    if (Object.prototype.hasOwnProperty.call(allow, name)) continue; // first wins

    // Prefer the signature's recommended control; fall back to an existing gate,
    // then to the strongest default. `gate` is always a valid MakerChecker
    // enforcement primitive.
    const gate =
      f.control ||
      (f.governedBy && f.governedBy.gate) ||
      'high_risk_requires_gate';

    allow[name] = { gate, note: buildNote(f, gate) };
  }

  return {
    version: base.version,
    severityThreshold: base.severityThreshold,
    failOn: base.failOn,
    ignore: [],
    allow,
    customSignatures: [],
  };
}
