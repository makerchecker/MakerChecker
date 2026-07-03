#!/usr/bin/env node
// mc scan — find what your agent can do on its own, in 60 seconds,
// named against the real disaster it resembles.
//
// Read-only. No signup, no server, no telemetry. Nothing leaves your machine.
//
//   npx @makerchecker/scan <path>                 scan a tools.json or a directory
//   npx @makerchecker/scan <path> --json          machine-readable output
//   npx @makerchecker/scan <path> --markdown      a shareable results card
//   npx @makerchecker/scan <path> --policy p.json  scan against a policy file
//   npx @makerchecker/scan <path> --fail-on high  exit non-zero at/above severity
//   npx @makerchecker/scan init [<path>]          write a deny-by-default mc-policy.json
//
// This file is the FIXED CLI wiring. It imports the six lib modules by their exact
// names and wires parse -> loadPolicy -> classify -> report (or initPolicy). The
// lib module bodies are implemented separately against CONTRACTS.md; do not change
// the imports or the pipeline here.
import { writeFileSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';

import { parseTools } from './lib/parse.mjs';
import { loadPolicy, mergeSignatures } from './lib/policy.mjs';
import { SIGNATURES } from './lib/signatures.mjs';
import { classify } from './lib/classify.mjs';
import { composePairs } from './lib/compose.mjs';
import { renderTerminal, renderJson, renderMarkdown } from './lib/report.mjs';
import { initPolicy } from './lib/policyInit.mjs';

const SCAN_VERSION = '0.2.0';
const CORPUS_SIZE = 41; // incidents in the Agent Incident Database
const SEV_RANK = { OK: 0, MEDIUM: 1, HIGH: 2, CATASTROPHIC: 3 };
const SEVERITIES = new Set(Object.keys(SEV_RANK));

// ---- tiny arg parser (zero deps) --------------------------------------------
function parseArgs(argv) {
  const positional = [];
  const flags = { json: false, markdown: false, policy: null, failOn: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--markdown' || a === '--md') flags.markdown = true;
    else if (a === '--policy' || a === '-p') flags.policy = argv[++i] ?? null;
    else if (a === '--fail-on') flags.failOn = (argv[++i] ?? '').toUpperCase() || null;
    else if (a === '-h' || a === '--help') flags.help = true;
    else if (a === '--version' || a === '-v') flags.version = true;
    else if (a.startsWith('-')) { /* unknown flag: ignore, stay resilient */ }
    else positional.push(a);
  }
  return { positional, flags };
}

const USAGE = `mc scan — find what your agent can do on its own, before anyone can stop it.

  scan <path> [--json | --markdown] [--policy <file>] [--fail-on <severity>]
  scan init [<path>] [--policy <outfile>]

<path> is a tool/function JSON file or a directory to search (default: .).
Read-only. Nothing leaves your machine.`;

// ---- run --------------------------------------------------------------------
const { positional, flags } = parseArgs(process.argv.slice(2));

if (flags.version) { console.log(SCAN_VERSION); process.exit(0); }
if (flags.help) { console.log(USAGE); process.exit(0); }

const isInit = positional[0] === 'init';
const target = (isInit ? positional[1] : positional[0]) || '.';

// Resolve the directory to anchor policy lookup from (file -> its dir).
function anchorDir(p) {
  const abs = resolve(p);
  try { return statSync(abs).isDirectory() ? abs : dirname(abs); }
  catch { return dirname(abs); }
}

// Parse tools (read-only, resilient — never throws on junk).
let tools = [];
try { tools = parseTools(resolve(target)); }
catch (e) { console.error(`cannot read ${target}: ${e.message}`); process.exit(2); }

// Load policy (explicit --policy wins on scan; on init it is the OUTPUT path).
const policy = loadPolicy(anchorDir(target), isInit ? undefined : (flags.policy || undefined));
const signatures = mergeSignatures(SIGNATURES, policy);

// Classify every tool, then run pairwise composition checks across the set.
let findings = tools.map((t) => classify(t, signatures, policy));
const pairs = composePairs(findings);

// ---- init subcommand: write the deny-by-default policy -----------------------
if (isInit) {
  const outPath = resolve(flags.policy || 'mc-policy.json');
  const policyObj = initPolicy(findings);
  try {
    writeFileSync(outPath, JSON.stringify(policyObj, null, 2) + '\n');
  } catch (e) {
    console.error(`could not write ${outPath}: ${e.message}`);
    process.exit(2);
  }
  const gated = Object.keys(policyObj.allow || {}).length;
  console.log('');
  console.log(`Wrote ${relative(process.cwd(), outPath) || outPath} — a deny-by-default policy.`);
  console.log(`  ${gated} tool(s) your agent could fire on its own now require a gate.`);
  console.log('');
  console.log('This file is both the scan config and the governance policy.');
  console.log('The free scan generated it; the self-hosted MakerChecker engine enforces');
  console.log('this exact file in production, with an audit trail a regulator can verify.');
  console.log('Edit `allow`/`ignore`, then commit it next to your agent.');
  console.log('');
  process.exit(0);
}

// ---- tally -------------------------------------------------------------------
const emptyCounts = () => ({ CATASTROPHIC: 0, HIGH: 0, MEDIUM: 0, OK: 0, GOVERNED: 0 });
const counts = emptyCounts();
for (const f of findings) {
  counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  if (f.governedBy) counts.GOVERNED++;
}

const failOn = (flags.failOn && SEVERITIES.has(flags.failOn))
  ? flags.failOn
  : (policy.failOn || 'CATASTROPHIC');

const sourceCount = new Set(tools.map((t) => String(t.source || '').split(':')[0]).filter(Boolean)).size;

const meta = {
  target,
  toolCount: findings.length,
  sourceCount,
  counts,
  policyPath: policy.path || null,
  failOn,
  scanVersion: SCAN_VERSION,
  corpusSize: CORPUS_SIZE,
  generatedAt: new Date().toISOString(),
};

// ---- no tools found ----------------------------------------------------------
if (tools.length === 0) {
  if (flags.json) { console.log(JSON.stringify({ meta, findings: [], counts, pairs: [] }, null, 2)); process.exit(0); }
  console.log(`No agent tool definitions found in ${target}.`);
  console.log('Point mc scan at a JSON file of function/tool definitions, or a directory containing one.');
  process.exit(0);
}

// ---- report ------------------------------------------------------------------
if (flags.json) {
  console.log(JSON.stringify(renderJson(findings, meta, pairs), null, 2));
} else if (flags.markdown) {
  console.log(renderMarkdown(findings, meta, pairs));
} else {
  console.log(renderTerminal(findings, meta, pairs));
}

// ---- exit code: gate CI on --fail-on / policy.failOn -------------------------
const failRank = SEV_RANK[failOn] ?? SEV_RANK.CATASTROPHIC;
const tripped = findings.some((f) => !f.governedBy && (SEV_RANK[f.severity] ?? 0) >= failRank && f.severity !== 'OK');
process.exit(tripped ? 1 : 0);
