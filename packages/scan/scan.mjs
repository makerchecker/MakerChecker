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
import { llmScan, isAmbiguous } from './lib/llmScan.mjs';
import { llmCodeScan } from './lib/codescan.mjs';
import { resolveLlmConfig } from './lib/llmProviders.mjs';
import { renderTerminal, renderJson, renderMarkdown } from './lib/report.mjs';
import { initPolicy } from './lib/policyInit.mjs';
import { generateFixScaffold } from './lib/fix.mjs';

const SCAN_VERSION = '0.2.0';
const CORPUS_SIZE = 41; // incidents in the Agent Incident Database
const SEV_RANK = { OK: 0, MEDIUM: 1, HIGH: 2, CATASTROPHIC: 3 };
const SEVERITIES = new Set(Object.keys(SEV_RANK));

// ---- tiny arg parser (zero deps) --------------------------------------------
function parseArgs(argv) {
  const positional = [];
  const flags = { json: false, markdown: false, policy: null, failOn: null, llm: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--llm') flags.llm = true;
    else if (a === '--markdown' || a === '--md') flags.markdown = true;
    else if (a === '--policy' || a === '-p') flags.policy = argv[++i] ?? null;
    else if (a === '--fail-on') flags.failOn = (argv[++i] ?? '').toUpperCase() || null;
    else if (a === '--fix') flags.fix = true;
    else if (a === '--out' || a === '-o') flags.out = argv[++i] ?? null;
    // --llm configuration (see lib/llmProviders.mjs); opt-in, off by default.
    else if (a === '--llm-mode') flags.llmMode = (argv[++i] ?? '').toLowerCase() || null;
    else if (a === '--llm-provider') flags.llmProvider = argv[++i] ?? null;
    else if (a === '--llm-model') flags.llmModel = argv[++i] ?? null;
    else if (a === '--llm-base-url') flags.llmBaseUrl = argv[++i] ?? null;
    else if (a === '--llm-key') flags.llmKey = argv[++i] ?? null;
    else if (a === '--llm-no-key') flags.llmNoKey = true;
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
Read-only. By default nothing leaves your machine.

  --fix [--out <file>]      write a MakerChecker governance scaffold (deny-by-default,
                            separation of duties) for the flagged tools

Deep scan (opt-in, off by default):
  --llm                     enable the LLM deep scan (Mode A re-ranks ambiguous
                            tools; Mode B reads source for undeclared capabilities)
  --llm-mode <tools|code|both>   default both
  --llm-provider <id>       anthropic (default) | openai | openrouter | together |
                            groq | ollama | openai-compatible
  --llm-model <id>          override the provider's default model
  --llm-base-url <url>      endpoint origin (Ollama / self-hosted / any gateway)
  --llm-key <key>           inline key (prefer the provider's *_API_KEY env var)

For a fully private deep scan (nothing leaves the machine): --llm-provider ollama`;

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

// Opt-in deep scan (--llm). The default scan sends NOTHING anywhere; passing
// --llm IS the opt-in. Two modes: Mode A re-ranks ambiguous parsed tools; Mode B
// reads selected source for undeclared capabilities. Provider/model/key are
// user-configurable (Anthropic / OpenAI / OpenAI-compatible / local Ollama).
let llmMeta = null;
if (flags.llm && !isInit) {
  const mode = (flags.llmMode || process.env.MC_LLM_MODE || policy.llm?.mode || 'both').toLowerCase();

  let config;
  try {
    config = resolveLlmConfig({ flags, env: process.env, policy });
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }

  // One-line, non-blocking notice to STDERR (stdout stays byte-clean for --json).
  if (config.reach === 'device') {
    console.error(`  --llm: local model ${config.model} at ${config.destinationHost} — nothing leaves this machine. Analyzing…`);
  } else {
    console.error(`  --llm: sending to ${config.destinationHost} (provider ${config.provider}, model ${config.model}). Use --llm-provider ollama to keep it local. Analyzing…`);
  }

  llmMeta = {
    mode, provider: config.provider, model: config.model, endpointHost: config.destinationHost, reach: config.reach,
    reproducible: false, toolsReassessed: 0, discovered: 0, notes: 0, dropped: 0,
  };
  if (mode !== 'code') {
    findings = await llmScan(findings, { config });
    llmMeta.toolsReassessed = findings.filter((f) => f.assessedBy === 'llm' && f.discoveredBy !== 'llm-code-scan').length;
  }
  if (mode !== 'tools') {
    const r = await llmCodeScan(resolve(target), findings, config, {});
    findings = r.findings;
    Object.assign(llmMeta, r.meta);
  }
  if (config.reach === 'device' && llmMeta.toolsReassessed === 0 && llmMeta.discovered === 0 && llmMeta.notes === 0) {
    console.error(`  --llm: no local model responded at ${config.destinationHost}. Is \`ollama serve\` running and did you \`ollama pull ${config.model}\`? Showing the static result.`);
  }
}

const pairs = composePairs(findings);

// --fix: write a MakerChecker governance scaffold for the flagged capabilities.
// A terminal action (like init): generate the file and exit.
if (flags.fix && !isInit) {
  const scaffold = generateFixScaffold(findings, pairs);
  if (!scaffold) {
    console.log('Nothing to fix — no ungoverned findings.');
    process.exit(0);
  }
  const outPath = resolve(flags.out || 'mc-governance.mjs');
  try {
    writeFileSync(outPath, scaffold);
  } catch (e) {
    console.error(`could not write ${outPath}: ${e.message}`);
    process.exit(2);
  }
  const n = findings.filter((f) => !f.governedBy && f.severity !== 'OK' && !f.unverified).length;
  console.log('');
  console.log(`Wrote ${relative(process.cwd(), outPath) || outPath} — a MakerChecker governance scaffold for ${n} flagged capabilit${n === 1 ? 'y' : 'ies'}.`);
  console.log('Deny-by-default; high-risk skills are held by a separate approver role, and composition');
  console.log('pairs are enforced as role conflicts. Run `npm i @makerchecker/embedded`, wire your');
  console.log('executors, and call the governed wrappers instead of the raw tools.');
  console.log('');
  process.exit(0);
}

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
  if (f.unverified) continue; // LLM notes never count toward the tally or the gate
  counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  if (f.governedBy) counts.GOVERNED++;
}

const failOn = (flags.failOn && SEVERITIES.has(flags.failOn))
  ? flags.failOn
  : (policy.failOn || 'CATASTROPHIC');

// Source files across BOTH declared tools and any --llm code-scan discoveries.
const sourceCount = new Set(findings.map((f) => String(f.tool?.source || '').split(':')[0]).filter(Boolean)).size;

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
  llm: llmMeta,
};

// ---- nothing found ----------------------------------------------------------
// findings (not tools) so a --llm code-scan that discovered undeclared
// capabilities in a repo with zero DECLARED tools still reports them.
if (findings.length === 0) {
  if (flags.json) { console.log(JSON.stringify({ meta, findings: [], counts, pairs: [] }, null, 2)); process.exit(0); }
  console.log(`No agent tool definitions found in ${target}.`);
  console.log('Point mc scan at a JSON file of function/tool definitions, or a directory containing one.');
  if (!flags.llm) console.log('If this is an agent codebase whose capabilities are plain functions, try a deep scan: --llm --llm-provider ollama');
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
// Set exitCode rather than calling process.exit(): the report we just wrote may
// be hundreds of KB of JSON, and process.exit() truncates unflushed stdout when
// it is a pipe (a CI step, `| jq`, a batch runner). Letting the event loop drain
// naturally guarantees the full report reaches the consumer, then we exit with
// the gate's code.
// The CI gate reads the DETERMINISTIC static severity, so a run with and without
// --llm returns the same exit code (LLM output is non-reproducible and never
// gates a build). Unverified notes never gate either.
const failRank = SEV_RANK[failOn] ?? SEV_RANK.CATASTROPHIC;
const gateSeverity = (f) => f.staticSeverity ?? f.severity;
const tripped = findings.some(
  (f) => !f.governedBy && !f.unverified && (SEV_RANK[gateSeverity(f)] ?? 0) >= failRank && gateSeverity(f) !== 'OK',
);
process.exitCode = tripped ? 1 : 0;
