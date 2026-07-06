// lib/codescan.mjs — the opt-in --llm code-scan (Mode B).
//
// Mode A (llmScan.mjs) re-ranks the tools the static parser already extracted.
// Mode B reads SELECTED SOURCE WINDOWS and emits ADDITIVE, incident-anchored
// findings for capabilities the parser never turned into a tool — the verified
// "aider/devika/Polymarket scan as 0 tools and exit clean" gap, where the danger
// is a plain function or method, not a registered tool.
//
// READ-ONLY: it readFileSync's source and regex-matches. It NEVER imports, evals,
// or executes scanned code. Transport is llmProviders (callModel/pMap) — never
// re-specced here. Anti-hallucination is enforced IN PROCESS: every model claim
// must quote a real source line verbatim and be corroborated by a real dangerous
// API call in the surrounding lines, or it is dropped / demoted to a note.

import { readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';

import { walkFiles } from './parse.mjs';
import { BODY_MARKERS, SANDBOX_RE } from './classify.mjs';
import { SIGNATURES } from './signatures.mjs';
import { callModel, extractFirstJsonArray, pMap } from './llmProviders.mjs';

const SEV_RANK = { OK: 0, MEDIUM: 1, HIGH: 2, CATASTROPHIC: 3 };
const MAX_READ_BYTES = 512 * 1024; // never read a pathologically large file into a window

const DEFAULT_CAPS = {
  maxFiles: 40, windowLines: 40, maxBytesPerChunk: 48000, maxChunks: 12, maxFindings: 50, perFileFindings: 10,
};

// Per signatureId, the regex that MUST literally appear in the cited window or the
// claim can only become a NOTE. private_key / ClobClient are SELECTION signals
// only (a file that merely loads a key must not corroborate "moves money").
const CORROBORATE = {
  'run-shell': /subprocess\.\w+|os\.system|os\.popen|child_process|execSync|\bexec\s*\(|\beval\s*\(|shell\s*=\s*True|Popen\s*\(|pty\.spawn/i,
  'destroy-data': /os\.remove|os\.unlink|shutil\.rmtree|fs\.(rm|unlink|rmdir)(Sync)?\s*\(|DROP\s+TABLE|DELETE\s+FROM|\brm\s+-rf/i,
  'destroy-infra': /terraform\s+destroy|deprovision|delete_cluster|destroy_stack|teardown|\bnuke\b/i,
  'force-rewrite-history': /push\s+--force|force[-_]?push|reset\s+--hard|\brebase\b/i,
  'move-money': /send_raw_transaction|sign_transaction|\.transfer\s*\(|functions\.approve|create_transfer|stripe\.(Charge|PaymentIntent|Transfer)|\bwire\b|payout/i,
  'execute-trade': /place_order|post_order|create_order|submit_order|market_order|\.buy\s*\(|\.sell\s*\(|ccxt|alpaca/i,
  'autonomous-spend': /stripe|checkout|create_order|\.purchase\(|payment_intent|charge\s*\(/i,
  exfiltrate: /requests\.(get|post)|httpx|axios|fetch\s*\(|urllib\.request|boto3|smtplib|\.upload/i,
  'send-message': /smtplib|send_message|slack_sdk|WebClient|tweepy|twilio|sendgrid|resend|\.emails?\.send/i,
  'provision-infra': /boto3|\.run_instances|terraform\s+apply|helm\s+install|create_cluster|RunTask/i,
  'grant-access': /grant_role|iam\.(put|attach)|create_access|set_permission|add_member/i,
};
// commit-decision and file-external have no reliable code regex -> a claim to them
// can ONLY ever be an unverified NOTE.
const IMPORT_MARKERS = /langchain|crewai|autogen|FastMCP|from\s+anthropic|import\s+openai|from\s+web3|py_clob_client|import\s+boto3|\bpexpect\b/i;

const SIG_BY_ID = Object.fromEntries(SIGNATURES.map((s) => [s.id, s]));
const CATALOG_JSON = JSON.stringify(SIGNATURES.map((s) => ({ id: s.id, severity: s.severity, action: s.action, aid: s.resembles.aid })));

const SYSTEM_PROMPT =
  'You are a static security reviewer for AI-agent codebases. You are given ' +
  'line-numbered SOURCE CODE from a repository whose AI agent can invoke the ' +
  'functions/methods shown. Find UNDECLARED dangerous capabilities: plain ' +
  'functions, class methods, or thin wrappers that let the agent take a ' +
  'high-consequence, hard-to-reverse action but are NOT registered as formal ' +
  'tools and would be missed by a schema-only scanner. Match each to the closest ' +
  'entry in this INCIDENT SIGNATURE CATALOG (each id names a real reproduced ' +
  `incident): ${CATALOG_JSON}. STRICT RULES: 1. Report a capability ONLY if the ` +
  'dangerous operation is LITERALLY PRESENT in the numbered lines (an actual ' +
  'subprocess/exec, an actual fund transfer/signing, an actual delete/drop, an ' +
  'actual network send of private data). If unsure, do NOT report it — missing a ' +
  'finding is far better than inventing one. 2. Cite exactly ONE unmodified ' +
  'source line: `file` exactly as in the "### FILE:" header, `line` the integer ' +
  "from that line's \"NNN|\" prefix, and `quote` that line's text VERBATIM — no " +
  'ellipsis, no joining lines, no edits. 3. signatureId MUST be an id from the ' +
  'catalog, or null. Never invent an id. 4. Ignore ordinary reads, pure ' +
  'computation, logging, config, type defs, and test/mock code. 5. Output ONLY a ' +
  'JSON array, max 8 items, shape: [{"file":"aider/run_cmd.py","line":62,' +
  '"symbol":"run_cmd_subprocess","quote":"process = subprocess.Popen(",' +
  '"signatureId":"run-shell","why":"the agent can run any shell command with no gate"}]';

// ---- selection + windows (no network — reused by --llm-estimate) ------------

function readFileSafe(file) {
  try {
    if (statSync(file).size > MAX_READ_BYTES) return null;
    return readFileSync(file, 'utf8');
  } catch { return null; }
}

function anyBodyMarker(content) {
  let weighted = 0;
  for (const mk of BODY_MARKERS) if (mk.re.test(content)) weighted += SEV_RANK[mk.severity] || 1;
  return weighted;
}

function corroborateHits(content) {
  for (const id in CORROBORATE) if (CORROBORATE[id].test(content)) return true;
  return false;
}

// Files with a CATASTROPHIC static finding are already flagged — don't re-send them.
function catastrophicStaticFiles(staticFindings) {
  const set = new Set();
  for (const f of staticFindings || []) {
    if (f && f.severity === 'CATASTROPHIC' && typeof f.tool?.source === 'string') {
      set.add(f.tool.source.split(':')[0]);
    }
  }
  return set;
}

function redactWindow(text) {
  return text
    .replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED]')
    .replace(/(private_key|api_key|secret|token)(\s*[:=]\s*)['"][^'"]+['"]/gi, '$1$2[REDACTED]')
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '[REDACTED]');
}

/**
 * Select files, extract marker-dense windows, and build the chunks that WOULD be
 * sent — all locally, no network. Used by llmCodeScan and by --llm-estimate.
 * @returns {{ chunks: Array<{text:string, files:Set<string>}>, cache: Map<string,{lines:string[]}>, sentFiles: Set<string>, filesScanned:number, filesSelected:number, filesSkippedByCap:number, redactions:number, estInputBytes:number }}
 */
export function planCodeScan(root, staticFindings, cfg = {}) {
  const caps = { ...DEFAULT_CAPS, ...(cfg.codeScan || {}) };
  const covered = catastrophicStaticFiles(staticFindings);
  const files = walkFiles(root);
  const cache = new Map();

  // 1) SELECT — score every file locally; keep dense ones.
  const scored = [];
  for (const file of files) {
    const rel = relative(root, file) || file;
    if (covered.has(rel)) continue;
    const content = readFileSafe(file);
    if (content == null) continue;
    const score = anyBodyMarker(content) + (corroborateHits(content) ? 2 : 0) + (IMPORT_MARKERS.test(content) ? 1 : 0);
    if (score < 1) continue;
    cache.set(rel, { lines: content.split('\n'), sandboxed: SANDBOX_RE.test(content) });
    scored.push({ rel, content, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const filesScanned = files.length;
  const selected = scored.slice(0, caps.maxFiles);
  let filesSkippedByCap = scored.length - selected.length;

  // 2) EXTRACT WINDOWS — coalesce marker-dense regions per file.
  let redactions = 0;
  const windows = [];
  for (const { rel, content } of selected) {
    const lines = content.split('\n');
    const hot = [];
    for (let i = 0; i < lines.length; i++) {
      if (BODY_MARKERS.some((mk) => mk.re.test(lines[i])) || corroborateHits(lines[i])) hot.push(i);
    }
    if (!hot.length) continue;
    // coalesce [i-W, i+W] ranges
    const ranges = [];
    for (const i of hot) {
      const lo = Math.max(0, i - caps.windowLines);
      const hi = Math.min(lines.length - 1, i + caps.windowLines);
      const last = ranges[ranges.length - 1];
      if (last && lo <= last.hi + 1) last.hi = Math.max(last.hi, hi);
      else ranges.push({ lo, hi });
    }
    for (const { lo, hi } of ranges) {
      const numbered = [];
      for (let i = lo; i <= hi; i++) numbered.push(`${i + 1}| ${lines[i]}`);
      const raw = `### FILE: ${rel}  (lines ${lo + 1}-${hi + 1})\n${numbered.join('\n')}`;
      const redacted = redactWindow(raw);
      if (redacted !== raw) redactions++;
      windows.push({ rel, text: redacted });
    }
  }

  // 3) CHUNK + CAP — pack windows under the byte budget, up to maxChunks.
  const chunks = [];
  let cur = { text: '', files: new Set() };
  for (const w of windows) {
    if (cur.text && cur.text.length + w.text.length > caps.maxBytesPerChunk) {
      chunks.push(cur);
      cur = { text: '', files: new Set() };
      if (chunks.length >= caps.maxChunks) break;
    }
    cur.text += (cur.text ? '\n\n' : '') + w.text;
    cur.files.add(w.rel);
  }
  if (cur.text && chunks.length < caps.maxChunks) chunks.push(cur);

  const sentFiles = new Set();
  let estInputBytes = 0;
  for (const c of chunks) { c.files.forEach((f) => sentFiles.add(f)); estInputBytes += c.text.length + SYSTEM_PROMPT.length; }
  // windows dropped because we hit the chunk cap
  const windowFiles = new Set(windows.map((w) => w.rel));
  filesSkippedByCap += [...windowFiles].filter((f) => !sentFiles.has(f)).length;

  return { chunks, cache, sentFiles, filesScanned, filesSelected: selected.length, filesSkippedByCap, redactions, estInputBytes, caps };
}

// ---- verification (the anti-hallucination core) -----------------------------

function verifyItem(item, cache, sentFiles) {
  if (!item || typeof item !== 'object') return { drop: true };
  const rel = item.file;
  if (!sentFiles.has(rel) || !cache.has(rel)) return { drop: true };
  const line = Number(item.line);
  if (!Number.isInteger(line) || line < 1) return { drop: true };
  const { lines, sandboxed } = cache.get(rel);
  const quote = String(item.quote ?? '').trim();
  if (quote.replace(/\s/g, '').length < 8) return { drop: true };

  // QUOTE CHECK: the quoted text must appear verbatim within L-3..L+3.
  const qLo = Math.max(0, line - 1 - 3);
  const qHi = Math.min(lines.length - 1, line - 1 + 3);
  const nearby = lines.slice(qLo, qHi + 1).join('\n');
  if (!nearby.includes(quote)) return { drop: true };

  // CORROBORATION: a real signature id whose dangerous API appears within L-5..L+5.
  const sig = SIG_BY_ID[item.signatureId];
  let verified = false;
  if (sig && CORROBORATE[sig.id]) {
    const cLo = Math.max(0, line - 1 - 5);
    const cHi = Math.min(lines.length - 1, line - 1 + 5);
    if (CORROBORATE[sig.id].test(lines.slice(cLo, cHi + 1).join('\n'))) verified = true;
  }
  return { drop: false, sig, verified, sandboxed, line, quote, rel };
}

function clampToSandbox(sev, sandboxed) {
  if (!sandboxed) return sev;
  if (sev === 'CATASTROPHIC') return 'HIGH';
  if (sev === 'HIGH') return 'MEDIUM';
  return sev;
}

function buildFinding(item, v) {
  const sig = v.sig;
  // Only a real, corroborated signature gets a scored severity; everything else is
  // an unverified NOTE that never counts toward the tally or the CI gate.
  const scored = v.verified && sig;
  const severity = scored ? clampToSandbox(sig.severity, v.sandboxed) : 'MEDIUM';
  const source = `${v.rel}:${v.line}`;
  return {
    tool: {
      name: item.symbol || source,
      description: '(undeclared capability — not a registered tool)',
      params: [],
      source,
    },
    severity,
    staticSeverity: 'OK',
    signature: scored ? sig.id : null,
    resembles: scored ? sig.resembles : null,
    control: scored ? sig.control : null,
    action: scored ? sig.action : null,
    why: scored ? sig.why : null,
    assessedBy: 'llm',
    discoveredBy: 'llm-code-scan',
    evidence: [{ kind: scored ? sig.id : 'unverified', marker: v.quote, line: v.line, file: v.rel }],
    llmNote: typeof item.why === 'string' ? item.why : '',
    unverified: !scored,
    mitigation: v.sandboxed && scored ? { kind: 'sandbox', note: 'runs inside a disposable sandbox' } : undefined,
    governedBy: null,
  };
}

// Drop an llm finding shadowed by a static finding on the same file (same name or
// within +/-3 lines), then dedup the llm set by file:symbol keeping the worst.
function merge(staticFindings, llm, caps) {
  const staticByFile = new Map();
  for (const f of staticFindings || []) {
    const src = typeof f.tool?.source === 'string' ? f.tool.source : '';
    const file = src.split(':')[0];
    const ln = Number(src.split(':')[1]) || null;
    if (!staticByFile.has(file)) staticByFile.set(file, []);
    staticByFile.get(file).push({ name: f.tool?.name, line: ln });
  }
  const kept = new Map();
  for (const f of llm) {
    const [file, lnStr] = f.tool.source.split(':');
    const ln = Number(lnStr) || null;
    const shadow = (staticByFile.get(file) || []).some((s) => s.name === f.tool.name || (s.line && ln && Math.abs(s.line - ln) <= 3));
    if (shadow) continue;
    const key = `${file}:${f.tool.name}`;
    const prev = kept.get(key);
    if (!prev || SEV_RANK[f.severity] > SEV_RANK[prev.severity]) kept.set(key, f);
  }
  // per-file + global caps
  const perFile = new Map();
  const out = [];
  for (const f of [...kept.values()].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])) {
    const file = f.tool.source.split(':')[0];
    const n = perFile.get(file) || 0;
    if (n >= caps.perFileFindings || out.length >= caps.maxFindings) continue;
    perFile.set(file, n + 1);
    out.push(f);
  }
  return out;
}

// ---- the Mode B entry point -------------------------------------------------

/**
 * Read selected source, ask the model for undeclared capabilities, verify each
 * against the real bytes, and merge additive findings over the static set. Never
 * throws — a chunk failure just yields fewer findings.
 * @returns {Promise<{ findings: object[], meta: object }>}
 */
export async function llmCodeScan(root, staticFindings, cfg, { fetchImpl = fetch } = {}) {
  const plan = planCodeScan(root, staticFindings, cfg);
  const meta = {
    filesScanned: plan.filesScanned, filesSent: plan.sentFiles.size, filesSkippedByCap: plan.filesSkippedByCap,
    discovered: 0, notes: 0, dropped: 0, redactions: plan.redactions, chunks: plan.chunks.length,
  };
  if (!plan.chunks.length) return { findings: staticFindings, meta };

  const replies = await pMap(
    plan.chunks,
    (chunk) => callModel(cfg, { system: SYSTEM_PROMPT, user: chunk.text, maxTokens: 1500 }, { fetchImpl }),
    cfg.concurrency,
  );

  const verified = [];
  const notes = [];
  for (const { text } of replies) {
    const items = text ? extractFirstJsonArray(text) : null;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const v = verifyItem(item, plan.cache, plan.sentFiles);
      if (v.drop) { meta.dropped++; continue; }
      const finding = buildFinding(item, v);
      if (finding.unverified) notes.push(finding);
      else verified.push(finding);
    }
  }
  const additive = merge(staticFindings, [...verified, ...notes], plan.caps);
  meta.discovered = additive.filter((f) => !f.unverified).length;
  meta.notes = additive.filter((f) => f.unverified).length;
  return { findings: [...staticFindings, ...additive], meta };
}
