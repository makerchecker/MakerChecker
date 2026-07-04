// test/report.test.mjs — zero-dep tests for lib/report.mjs.
// Run: node --test test/report.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderTerminal, renderJson, renderMarkdown } from '../lib/report.mjs';

const ESC = '\x1b['; // ANSI CSI introducer

// ---- sample data -----------------------------------------------------------
function mkTool(name, source) {
  return { name, description: '', params: [], source: source || `tools.json` };
}

/** A representative findings array: one of every severity, plus a governed one. */
const findings = [
  {
    tool: mkTool('deleteDatabase', 'db.json:12'),
    severity: 'CATASTROPHIC',
    signature: 'destroy-data',
    resembles: {
      aid: 'AID-2025-0005',
      title: 'the Replit agent that deleted a production database during a code freeze',
    },
    control: 'high_risk_requires_gate',
    action: 'destroys data that cannot be recovered',
    why: 'A delete is a one-way door. Gate it behind a named human, deny-by-default.',
    governedBy: null,
  },
  {
    tool: mkTool('fetchUrl', 'net.json:3'),
    severity: 'HIGH',
    signature: 'exfiltrate',
    resembles: { aid: 'AID-2025-0001', title: 'CamoLeak, GitHub Copilot Chat image-proxy exfiltration' },
    control: 'high_risk_requires_gate',
    action: 'can carry private data out to an attacker-controlled destination',
    why: 'A tool that reads secrets and reaches the network is an exfiltration path.',
    governedBy: null,
  },
  {
    tool: mkTool('provisionCluster', 'infra.json:7'),
    severity: 'MEDIUM',
    signature: 'provision-infra',
    resembles: { aid: 'AID-2026-0003', title: 'the DN42 agent that ran up a $6,531 AWS bill' },
    control: 'limit_violation',
    action: 'spends money or provisions infrastructure with no cap',
    why: 'Provisioning in a loop with no cap is a runaway bill.',
    governedBy: null,
  },
  {
    tool: mkTool('getWeather', 'read.json:1'),
    severity: 'OK',
    signature: null,
    resembles: null,
    control: null,
    action: null,
    why: null,
    governedBy: null,
  },
  {
    // governed: severity forced OK, but signature/resembles/etc kept.
    tool: mkTool('wireTransfer', 'pay.json:9'),
    severity: 'OK',
    signature: 'move-money',
    resembles: { aid: 'AID-2026-0004', title: 'the Grok-connected wallet drained of $150K' },
    control: 'limit_violation',
    action: 'moves money out of your control',
    why: 'A transfer is a one-way door; cap it and gate anything over the line.',
    governedBy: { gate: 'limit_violation', note: 'deny-by-default; resembles AID-2026-0004' },
  },
];

const meta = {
  target: 'examples/pv-agent-tools.json',
  toolCount: findings.length,
  sourceCount: 5,
  counts: { CATASTROPHIC: 1, HIGH: 1, MEDIUM: 1, OK: 2, GOVERNED: 1 },
  policyPath: null,
  failOn: 'CATASTROPHIC',
  scanVersion: '0.2.0',
  corpusSize: 41,
  generatedAt: '2026-07-01T00:00:00.000Z',
};

// helper: run a renderer with a forced isTTY value, restoring after.
function withTTY(value, fn) {
  const orig = process.stdout.isTTY;
  try {
    process.stdout.isTTY = value;
    return fn();
  } finally {
    process.stdout.isTTY = orig;
  }
}

// ---- renderTerminal --------------------------------------------------------
test('renderTerminal produces every expected section', () => {
  const s = withTTY(false, () => renderTerminal(findings, meta));

  // header
  assert.match(s, /mc scan/);
  assert.match(s, /v0\.2\.0/);
  assert.match(s, /Scanned examples\/pv-agent-tools\.json/);
  assert.match(s, /checked against 41 real agent incidents/);

  // hero panel: worst ungoverned finding, named against its incident
  assert.match(s, /CATASTROPHIC/);
  assert.match(s, /deleteDatabase/);
  assert.match(s, /Replit agent that deleted a production database/);
  assert.match(s, /AID-2025-0005/);
  assert.match(s, /high_risk_requires_gate/);
  assert.match(s, /Seen in: db\.json:12/);

  // inventory table with all ungoverned severities
  assert.match(s, /Findings \(3\)/);
  assert.match(s, /SEVERITY/);
  assert.match(s, /fetchUrl/);
  assert.match(s, /AID-2025-0001/);
  assert.match(s, /provisionCluster/);
  assert.match(s, /AID-2026-0003/);

  // governed section shows the original severity + gate
  assert.match(s, /Governed \(1\)/);
  assert.match(s, /wireTransfer/);
  assert.match(s, /was CATASTROPHIC/);
  assert.match(s, /now governed by limit_violation/);

  // summary line
  assert.match(s, /1 catastrophic/);
  assert.match(s, /1 high/);
  assert.match(s, /1 medium/);
  assert.match(s, /1 governed/);
  assert.match(s, /2 certified/);

  // corpus link + footer
  assert.match(s, /Agent Incident Database \(41\)/);
  assert.match(s, /github\.com\/sammysltd\/makerchecker/);
  assert.match(s, /What this won't catch/);

  // ends with a newline
  assert.ok(s.endsWith('\n'));
});

test('renderTerminal strips ANSI colour when not a TTY', () => {
  const s = withTTY(false, () => renderTerminal(findings, meta));
  assert.ok(!s.includes(ESC), 'no ANSI escape codes when isTTY is false');
});

test('renderTerminal emits ANSI colour when a TTY', () => {
  const s = withTTY(true, () => renderTerminal(findings, meta));
  assert.ok(s.includes(ESC), 'ANSI escape codes present when isTTY is true');
  // stripping the colour codes must leave the same visible content
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(stripped, /deleteDatabase/);
  assert.match(stripped, /AID-2025-0005/);
});

test('renderTerminal handles an all-clear (no ungoverned findings)', () => {
  const clean = [findings[3], findings[4]]; // OK + governed only
  const cleanMeta = {
    ...meta,
    toolCount: 2,
    counts: { CATASTROPHIC: 0, HIGH: 0, MEDIUM: 0, OK: 2, GOVERNED: 1 },
  };
  const s = withTTY(false, () => renderTerminal(clean, cleanMeta));
  assert.match(s, /CERTIFIED/);
  assert.doesNotMatch(s, /Findings \(/);
  assert.match(s, /Governed \(1\)/);
});

// ---- renderJson ------------------------------------------------------------
test('renderJson returns a stable { meta, findings, counts, pairs } object', () => {
  const o = renderJson(findings, meta);
  assert.deepEqual(Object.keys(o).sort(), ['counts', 'findings', 'meta', 'pairs']);
  assert.deepEqual(o.pairs, []);
  assert.equal(o.meta, meta);
  assert.equal(o.findings.length, findings.length);
  assert.deepEqual(o.counts, meta.counts);
});

test('renderJson is pure JSON (round-trips with no data loss, no undefined)', () => {
  const o = renderJson(findings, meta);
  const round = JSON.parse(JSON.stringify(o));
  assert.deepEqual(round, o);
  assert.ok(!JSON.stringify(o).includes('undefined'));
  assert.equal(round.findings[0].resembles.aid, 'AID-2025-0005');
  assert.equal(round.findings[4].governedBy.gate, 'limit_violation');
});

// ---- renderMarkdown --------------------------------------------------------
test('renderMarkdown produces a shareable card with the required sections', () => {
  const md = renderMarkdown(findings, meta);

  // summary line
  assert.match(md, /## mc scan/);
  assert.match(md, /\*\*5 tools\*\*/);
  assert.match(md, /1 catastrophic · 1 high · 1 medium/);

  // worst-finding callout
  assert.match(md, /> \*\*Worst finding:\*\* `deleteDatabase`/);
  assert.match(md, /AID-2025-0005/);

  // findings table with the exact header the contract asks for
  assert.match(md, /\| Severity \| Tool \| Resembles \(aid\) \| Fix control \|/);
  assert.match(md, /\|---\|---\|---\|---\|/);
  assert.match(md, /\| CATASTROPHIC \| `deleteDatabase` \| AID-2025-0005 \| `high_risk_requires_gate` \|/);
  assert.match(md, /`fetchUrl`/);
  assert.match(md, /`provisionCluster`/);

  // governed section
  assert.match(md, /### Governed/);
  assert.match(md, /`wireTransfer` — was CATASTROPHIC, now governed by `limit_violation`/);

  // footer
  assert.match(md, /What this won't catch/);
  assert.match(md, /41-incident Agent Incident Database/);

  // no ANSI ever in markdown
  assert.ok(!md.includes(ESC));
});

test('renderMarkdown handles no findings gracefully', () => {
  const md = renderMarkdown([], { ...meta, toolCount: 0, counts: { CATASTROPHIC: 0, HIGH: 0, MEDIUM: 0, OK: 0, GOVERNED: 0 } });
  assert.match(md, /CERTIFIED/);
  assert.doesNotMatch(md, /### Findings/);
});
