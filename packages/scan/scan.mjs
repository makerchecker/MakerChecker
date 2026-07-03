#!/usr/bin/env node
// mc scan — see what your AI agent can do that you can't undo, in 60 seconds,
// named against the real disaster it resembles.
//
// Read-only. No signup, no server, no telemetry. Nothing leaves your machine.
//
//   npx @makerchecker/scan <path>
//
// <path> is a JSON file of tool/function definitions, or a directory to search.
// Supports OpenAI function/tools schemas, MCP tools/list output, LangChain tool
// dumps, and bare arrays of { name, description, parameters }.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { SIGNATURES } from './signatures.mjs';

const C = process.stdout.isTTY
  ? { red: (s) => `\x1b[1;31m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m` }
  : { red: (s) => s, yellow: (s) => s, dim: (s) => s, bold: (s) => s, green: (s) => s };

const SEV_RANK = { CATASTROPHIC: 3, HIGH: 2, MEDIUM: 1, OK: 0 };

// ---- extract tool definitions from whatever shape the input is in ----
function toolsFromJson(data) {
  const out = [];
  const push = (name, description, params) => {
    if (typeof name === 'string' && name.trim()) out.push({ name, description: description || '', params: paramNames(params) });
  };
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    // OpenAI: { type:'function', function:{ name, description, parameters } }
    if (node.function && typeof node.function === 'object') return push(node.function.name, node.function.description, node.function.parameters);
    // MCP: { name, description, inputSchema }
    if (node.name && (node.inputSchema || node.parameters || node.description !== undefined)) {
      return push(node.name, node.description, node.inputSchema || node.parameters);
    }
    // { tools: [...] } or nested containers
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v);
  };
  walk(data);
  // de-dupe by name
  const seen = new Set();
  return out.filter((t) => (seen.has(t.name) ? false : seen.add(t.name)));
}

function paramNames(schema) {
  if (!schema || typeof schema !== 'object') return [];
  const props = schema.properties || (schema.type === 'object' ? {} : null);
  return props ? Object.keys(props) : [];
}

function findJsonFiles(path) {
  const st = statSync(path);
  if (st.isFile()) return extname(path) === '.json' ? [path] : [];
  const out = [];
  for (const name of readdirSync(path)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(path, name);
    try {
      const s = statSync(p);
      if (s.isDirectory()) out.push(...findJsonFiles(p));
      else if (extname(p) === '.json') out.push(p);
    } catch { /* skip unreadable */ }
  }
  return out;
}

// ---- classify a tool against the corpus signatures ----
function classify(tool) {
  const hay = `${tool.name} ${tool.description} ${tool.params.join(' ')}`.toLowerCase();
  const tokens = hay.split(/[^a-z0-9]+/).filter(Boolean);
  const tokenSet = new Set(tokens);
  let best = null;
  for (const sig of SIGNATURES) {
    const verbHit = sig.verbs.some((v) => tokenSet.has(v) || tool.name.toLowerCase().includes(v));
    if (!verbHit) continue;
    const argHit = (sig.argHints || []).some((a) => tokenSet.has(a) || hay.includes(a));
    // require an arg/context hint for MEDIUM-ish verbs to cut false positives on
    // generic words like "get"/"read"; strong destructive verbs match on verb alone.
    const strongVerb = ['delete', 'drop', 'destroy', 'wipe', 'truncate', 'force-push', 'pay', 'transfer', 'wire', 'withdraw', 'terraform'].some((v) => tool.name.toLowerCase().includes(v));
    if (!argHit && !strongVerb) continue;
    if (!best || SEV_RANK[sig.severity] > SEV_RANK[best.severity]) best = sig;
  }
  return best;
}

// ---- run ----
const target = process.argv[2];
if (!target) {
  console.error('usage: npx @makerchecker/scan <path-to-tools.json | directory>');
  process.exit(2);
}

let files;
try { files = findJsonFiles(target); } catch (e) { console.error(`cannot read ${target}: ${e.message}`); process.exit(2); }

const tools = [];
for (const f of files) {
  try { tools.push(...toolsFromJson(JSON.parse(readFileSync(f, 'utf8')))); } catch { /* not tool JSON, skip */ }
}

if (tools.length === 0) {
  console.log(C.dim(`No agent tool definitions found in ${target}.`));
  console.log(C.dim('Point mc scan at a JSON file of function/tool definitions, or a directory containing one.'));
  process.exit(0);
}

const findings = tools
  .map((t) => ({ tool: t, sig: classify(t) }))
  .map((f) => ({ ...f, severity: f.sig ? f.sig.severity : 'OK' }))
  .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);

const counts = { CATASTROPHIC: 0, HIGH: 0, MEDIUM: 0, OK: 0 };
for (const f of findings) counts[f.severity]++;

console.log('');
console.log(C.bold(`mc scan  ·  ${tools.length} tools  ·  ${files.length} file(s)`));
console.log(C.dim('read-only, nothing left your machine'));
console.log('');

// The red panel: the worst finding, told against the real incident.
const worst = findings.find((f) => f.severity === 'CATASTROPHIC') || findings.find((f) => f.severity === 'HIGH');
if (worst && worst.sig) {
  const tag = worst.severity === 'CATASTROPHIC' ? C.red('CATASTROPHIC') : C.yellow('HIGH');
  console.log(`  ${tag} — ${C.bold(worst.tool.name)}`);
  console.log(`  ${C.dim('This tool ' + worst.sig.action + '.')}`);
  console.log(`  ${C.dim('Resembles ' + worst.sig.resembles.title + '')}`);
  console.log(`  ${C.dim('(' + worst.sig.resembles.aid + ' in the Agent Incident Database).')}`);
  console.log('');
  console.log(`  ${worst.sig.why}`);
  console.log('');
  console.log(`  ${C.green('Fix:')} gate it with ${C.bold('mc policy init')} (generates a deny-by-default ${worst.sig.control} rule).`);
  console.log('');
  console.log(C.dim('  ────────────────────────────────────────────────────────────'));
  console.log('');
}

// The inventory.
for (const f of findings) {
  if (f.severity === 'OK') continue;
  const tag = f.severity === 'CATASTROPHIC' ? C.red('CATASTROPHIC') : f.severity === 'HIGH' ? C.yellow('HIGH    ') : C.dim('MEDIUM  ');
  console.log(`  ${tag}  ${f.tool.name.padEnd(28)} ${C.dim(f.sig.action)}`);
}
const okCount = counts.OK;
if (okCount) console.log(`  ${C.green('OK       ')}  ${C.dim(okCount + ' reversible tool(s), not flagged')}`);
console.log('');
console.log(C.bold(`  ${counts.CATASTROPHIC} catastrophic, ${counts.HIGH} high, ${counts.MEDIUM} medium.`));
console.log('');
console.log(C.dim('  Every finding is named against a real, sourced incident:'));
console.log(C.dim('  https://github.com/sammysltd/makerchecker/tree/main/incidents'));
console.log('');
console.log(C.dim("  What this won't catch: runtime grants (it reads tool definitions, not"));
console.log(C.dim('  your live policy), prompt-injection in your data, or logic bugs. It'));
console.log(C.dim('  finds the actions your agent CAN take that it cannot take back.'));
console.log('');

// exit non-zero if anything catastrophic, so it can gate CI.
process.exit(counts.CATASTROPHIC > 0 ? 1 : 0);
