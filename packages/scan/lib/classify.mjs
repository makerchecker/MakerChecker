// lib/classify.mjs — classify one Tool against the signature table and policy.
//
// Matches a tool's name/description/params against the signature table using the
// verb + arg-hint rule (strongest destructive verbs match on the tool NAME alone),
// keeps the highest-severity match, then applies policy governance: `ignore` skips
// a tool entirely; `allow` downgrades it to OK while keeping the matched incident so
// the report can say "was CATASTROPHIC — now governed by <gate>".
//
// Zero deps, deterministic, no I/O. See CONTRACTS.md ("Rules for classify").

/**
 * @typedef {import('./signatures.mjs').Signature} Signature
 * @typedef {import('./signatures.mjs').Control} Control
 * @typedef {import('./signatures.mjs').IncidentRef} IncidentRef
 * @typedef {import('./parse.mjs').Tool} Tool
 * @typedef {import('./policy.mjs').Policy} Policy
 * @typedef {{ kind: string, marker: string, line: number }} BodyEvidence
 * @typedef {{ tool: Tool, severity: 'CATASTROPHIC'|'HIGH'|'MEDIUM'|'OK', signature: string|null, resembles: IncidentRef|null, control: Control|null, action: string|null, why: string|null, governedBy: { gate: Control, note: string }|null, evidence?: BodyEvidence[], mitigation?: { kind: 'sandbox'|'gate', note: string } }} Finding
 */

const SEV_RANK = { OK: 0, MEDIUM: 1, HIGH: 2, CATASTROPHIC: 3 };

const lc = (s) => String(s ?? '').toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Split a tool name into lowercased tokens across camelCase, snake_case, and
// kebab boundaries: "deleteFile" -> [delete, file], "PatronusEvalTool" ->
// [patronus, eval, tool], "get_stock_info" -> [get, stock, info]. This is what
// lets us match a verb as a WORD in the name without the substring collisions
// that made "eval" fire on "retrieval"/"evaluator" and "system" on "ecosystem".
function nameTokenList(name) {
  const raw = String(name ?? '').match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z0-9]+|[A-Z]+|[0-9]+/g) || [];
  return raw.map((t) => t.toLowerCase());
}
function nameTokens(name) {
  return new Set(nameTokenList(name));
}

// A tool whose LEADING name token is a read or negation verb does not perform
// the write/spend/message its later tokens hint at: get_refund_policy READS a
// policy, check_refund_eligibility EVALUATES one, deny_refund records a DENIAL —
// none move money. Exfiltrate is the deliberate exception: a read IS the risk
// there, so a leading "get"/"fetch" must not suppress it.
const READ_LEAD = new Set([
  'get', 'fetch', 'read', 'view', 'list', 'search', 'query', 'find', 'lookup',
  'retrieve', 'load', 'describe', 'show', 'count', 'is', 'has', 'can', 'should',
  'check', 'validate', 'verify', 'inspect', 'calculate', 'estimate', 'evaluate',
  'preview', 'summarize', 'analyze', 'classify', 'detect',
  'deny', 'reject', 'decline', 'refuse',
]);
const NAME_SUPPRESSIBLE = new Set([
  'autonomous-spend', 'move-money', 'execute-trade', 'bind-commitment',
  'send-message', 'destroy-data', 'run-shell', 'commit-decision',
]);

/**
 * Build a matcher closure over one tool. A term "appears" when it is a whole
 * TOKEN of the tool name (camelCase/snake/kebab-aware) — so `deleteFile` matches
 * `delete` but `retrieval` does NOT match `eval` — OR a whole-token match inside
 * the description or any parameter name.
 * @param {Tool} tool
 */
function makeMatcher(tool) {
  const tokens = nameTokens(tool?.name);
  const params = Array.isArray(tool?.params) ? tool.params.map(lc) : [];
  const haystack = lc(tool?.description) + ' ' + params.join(' ');
  return function appears(term) {
    const t = lc(term);
    if (!t) return false;
    if (tokens.has(t)) return true;
    return new RegExp('\\b' + esc(t) + '\\b').test(haystack);
  };
}

/**
 * Does this signature match the tool? One of its verbs must appear AND either an
 * argHint is present OR one of its strongVerbs appears in the tool name (the
 * "strong verb matches on the name alone" rule).
 * @param {Signature} sig
 * @param {(term: string) => boolean} appears
 * @param {Set<string>} tokens  camelCase/snake-aware tokens of the tool name
 */
function signatureMatches(sig, appears, tokens) {
  const verbs = Array.isArray(sig?.verbs) ? sig.verbs : [];
  const matchedVerbs = verbs.filter(appears);
  if (!matchedVerbs.length) return false;
  // Distinct-token rule: the confirming argHint must be a DIFFERENT token than
  // the one that satisfied the verb. A single word that lives in both lists
  // (e.g. "price" as a bind-commitment verb AND argHint) is one signal, not two,
  // so `getPrice` no longer self-confirms as a pricing commitment.
  const matched = new Set(matchedVerbs.map(lc));
  const argHints = Array.isArray(sig?.argHints) ? sig.argHints : [];
  if (argHints.some((a) => !matched.has(lc(a)) && appears(a))) return true;
  // Strong verbs match on the NAME alone — but as a whole token, so "eval" fires
  // on an "eval" tool, not on "retrieval"/"evaluator".
  const strongVerbs = Array.isArray(sig?.strongVerbs) ? sig.strongVerbs : [];
  return strongVerbs.some((v) => tokens.has(lc(v)));
}

// ---- body signals ------------------------------------------------------------
//
// High-signal static markers in a tool's function body. What a tool is NAMED is a
// claim; what its body CALLS is evidence. A body signal can only RAISE severity —
// a blandly-named tool that shells out is treated like a shell tool — never lower
// it. Each kind maps to the builtin signature whose incident it resembles.
const BODY_MARKERS = [
  { kind: 'shell', sigId: 'run-shell', severity: 'CATASTROPHIC',
    re: /\bsubprocess\.\w+|\bos\.system\b|\bos\.popen\b|child_process|\bexecSync\b|\bexec\s*\(|\beval\s*\(/ },
  { kind: 'destroy', sigId: 'destroy-data', severity: 'CATASTROPHIC',
    re: /\bos\.remove\b|\bos\.unlink\b|\bshutil\.rmtree\b|\bfs\.rm(?:Sync|dir|dirSync)?\s*\(|\bfs\.unlink(?:Sync)?\s*\(|DROP\s+TABLE|DELETE\s+FROM/i },
  // An outbound HTTP call alone is what half of all legitimate tools do — it is
  // MEDIUM evidence here and feeds the composition pass, where read-sensitive +
  // send-external pairs surface as the real exfiltration risk.
  { kind: 'external-send', sigId: 'exfiltrate', severity: 'MEDIUM',
    re: /\brequests\.post\b|\bfetch\s*\(|\baxios\b|\bsmtplib\b|\bboto3\b|\burllib\.request\b|\bhttpx\b/ },
  { kind: 'write', sigId: 'destroy-data', severity: 'MEDIUM',
    re: /\bopen\s*\([^)\n]*['"][wa]b?['"]|\bwriteFileSync\b|\bfs\.writeFile\b|\bfs\.appendFile\b/ },
];

// A dangerous action inside a disposable sandbox (an e2b cloud VM, a container,
// a WASM/RestrictedPython interpreter) cannot touch the user's real systems —
// a `rm -rf` there wipes a throwaway VM. When execution is demonstrably
// sandboxed we downgrade and say so, rather than crying "deletes your home
// directory" about a container. Marker in the tool body OR the surrounding file.
// Note the leading \b but no trailing \b on e2b/daytona: matches "E2BExecTool"
// and "DaytonaPythonTool" (name-derived) as well as "from e2b import".
const SANDBOX_RE = /\be2b|@e2b\/|\bdaytona|Sandbox\.create|CodeInterpreter|code_interpreter|codeInterpreter|\bpyodide\b|RestrictedPython|\bgvisor\b|\bfirecracker\b|\bnsjail\b|\bbubblewrap\b|\bfirejail\b|dockerode|docker\.from_env|DockerClient|\bwasmer\b|\bwasmtime\b/i;

// An in-body human gate before the dangerous call: a confirm prompt, a yes/no,
// an approval check. Conservative — cross-scope UI gates (an editor's
// accept/reject) are out of a per-tool scanner's reach and NOT matched here.
const GATE_RE = /\binput\s*\(|\bconfirm\b|yes_no|\bprompt\s*\(|are you sure|\bapprove\b|require.?confirm|click to (?:run|confirm|approve)|await .*\.confirm/i;

export function detectSandbox(text) {
  return SANDBOX_RE.test(String(text ?? ''));
}

export function detectGate(text) {
  return GATE_RE.test(String(text ?? ''));
}

/**
 * Scan a body snippet for high-signal markers. Returns one evidence entry per
 * marker kind per line, with 1-based line numbers offset by `startLine`.
 * @param {string} body
 * @param {number} startLine
 * @returns {Array<{ kind: string, marker: string, line: number, severity: 'CATASTROPHIC'|'HIGH'|'MEDIUM', sigId: string }>}
 */
export function detectBodySignals(body, startLine = 1) {
  const signals = [];
  const lines = String(body ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const mk of BODY_MARKERS) {
      const m = mk.re.exec(lines[i]);
      if (m) signals.push({ kind: mk.kind, marker: m[0].trim(), line: startLine + i, severity: mk.severity, sigId: mk.sigId });
    }
  }
  return signals;
}

/**
 * Classify a tool against the signature table and governance policy.
 * @param {Tool} tool
 * @param {Signature[]} signatures
 * @param {Policy} policy
 * @returns {Finding}
 */
export function classify(tool, signatures, policy) {
  const okFinding = () => ({
    tool,
    severity: 'OK',
    signature: null,
    resembles: null,
    control: null,
    action: null,
    why: null,
    governedBy: null,
  });

  // Malformed tool -> stay resilient, report nothing.
  if (!tool || typeof tool !== 'object') return okFinding();

  const toolName = tool.name;

  // policy.ignore: skip entirely (never flagged, not even as governed).
  if (Array.isArray(policy?.ignore) && policy.ignore.includes(toolName)) {
    return okFinding();
  }

  // Find the highest-severity matching signature (first match wins on ties).
  const appears = makeMatcher(tool);
  const tokenList = nameTokenList(toolName);
  const tokens = new Set(tokenList);
  const lead = tokenList[0] || '';
  const sigs = Array.isArray(signatures) ? signatures : [];
  let best = null;
  for (const sig of sigs) {
    if (!sig || !signatureMatches(sig, appears, tokens)) continue;
    // Leading read/negation verb: the name-based match is a false positive for a
    // write/spend signature (body evidence below can still re-raise it if the
    // function actually acts). Skip it and let a lower-severity or OK match stand.
    if (READ_LEAD.has(lead) && NAME_SUPPRESSIBLE.has(sig.id)) continue;
    const rank = SEV_RANK[sig.severity] ?? 0;
    if (best === null || rank > (SEV_RANK[best.severity] ?? 0)) best = sig;
  }

  const finding = best
    ? {
        tool,
        severity: best.severity,
        signature: best.id ?? null,
        resembles: best.resembles ?? null,
        control: best.control ?? null,
        action: best.action ?? null,
        why: best.why ?? null,
        governedBy: null,
      }
    : okFinding();

  // Body signals: evidence from the function body can RAISE severity (never
  // lower it). A blandly-named tool whose body shells out is a shell tool.
  if (typeof tool.body === 'string' && tool.body) {
    const signals = detectBodySignals(tool.body, tool.bodyLine || 1);
    if (signals.length) {
      finding.evidence = signals.map(({ kind, marker, line }) => ({ kind, marker, line }));
      let top = signals[0];
      for (const s of signals) if ((SEV_RANK[s.severity] ?? 0) > (SEV_RANK[top.severity] ?? 0)) top = s;
      if ((SEV_RANK[top.severity] ?? 0) > (SEV_RANK[finding.severity] ?? 0)) {
        const sig = sigs.find((s) => s && s.id === top.sigId);
        finding.severity = top.severity;
        if (sig) {
          finding.signature = sig.id;
          finding.resembles = sig.resembles ?? null;
          finding.control = sig.control ?? null;
          finding.action = `${sig.action} (body evidence: ${top.marker} at line ${top.line})`;
          finding.why = sig.why ?? null;
        }
      }
    }
  }

  // Sandbox / in-body gate: a dangerous action that can only reach a disposable
  // sandbox, or that is guarded by a confirm prompt in its own body, is not the
  // "wipes your real system" risk the incident implies. Downgrade one step and
  // record why — never below MEDIUM (a sandbox escape or a skipped prompt is
  // still worth a look), and only for the execution/destruction signatures where
  // the mitigation actually applies.
  const MITIGABLE = new Set(['run-shell', 'destroy-data', 'exfiltrate']);
  if (finding.severity !== 'OK' && MITIGABLE.has(finding.signature)) {
    // A tool named/described as an e2b/Daytona/sandbox executor is confined even
    // when we only have its JSON spec (no body to read the Sandbox.create call).
    const sandboxed = tool.sandboxed === true || detectSandbox(tool.body) || detectSandbox(`${tool.name} ${tool.description}`);
    const gated = detectGate(tool.body);
    if (sandboxed || gated) {
      const reason = sandboxed ? 'runs inside a disposable sandbox' : 'guarded by an in-body confirmation';
      const lowered = finding.severity === 'CATASTROPHIC' ? 'HIGH' : 'MEDIUM';
      finding.mitigation = { kind: sandboxed ? 'sandbox' : 'gate', note: reason };
      finding.severity = lowered;
      finding.action = `${finding.action || 'runs with no one checking it'} — but ${reason}`;
    }
  }

  // policy.allow: this tool is already governed -> downgrade to OK, mark
  // governedBy, but KEEP the matched incident/control so the report can render
  // "was CATASTROPHIC — now governed by <gate>". The free-to-paid bridge.
  const allow = policy?.allow;
  const gov = allow && typeof allow === 'object' ? allow[toolName] : undefined;
  if (gov && typeof gov === 'object') {
    finding.governedBy = { gate: gov.gate, note: gov.note };
    finding.severity = 'OK';
  }

  return finding;
}
