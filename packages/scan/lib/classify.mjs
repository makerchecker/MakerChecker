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
 * @typedef {{ tool: Tool, severity: 'CATASTROPHIC'|'HIGH'|'MEDIUM'|'OK', signature: string|null, resembles: IncidentRef|null, control: Control|null, action: string|null, why: string|null, governedBy: { gate: Control, note: string }|null, evidence?: BodyEvidence[] }} Finding
 */

const SEV_RANK = { OK: 0, MEDIUM: 1, HIGH: 2, CATASTROPHIC: 3 };

const lc = (s) => String(s ?? '').toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build a matcher closure over one tool. A term "appears" when it is a substring
 * of the (lowercased) tool name — which catches camelCase / snake_case like
 * `deleteFile` -> `delete` — OR a whole-token match inside the description or any
 * parameter name. Whole-token matching in the haystack avoids `run` firing on
 * "running" while still catching hyphenated tokens like `force-push`.
 * @param {Tool} tool
 */
function makeMatcher(tool) {
  const name = lc(tool?.name);
  const params = Array.isArray(tool?.params) ? tool.params.map(lc) : [];
  const haystack = lc(tool?.description) + ' ' + params.join(' ');
  return function appears(term) {
    const t = lc(term);
    if (!t) return false;
    if (name.includes(t)) return true;
    return new RegExp('\\b' + esc(t) + '\\b').test(haystack);
  };
}

/**
 * Does this signature match the tool? One of its verbs must appear AND either an
 * argHint is present OR one of its strongVerbs appears in the tool name (the
 * "strong verb matches on the name alone" rule).
 * @param {Signature} sig
 * @param {(term: string) => boolean} appears
 * @param {string} nameLc
 */
function signatureMatches(sig, appears, nameLc) {
  const verbs = Array.isArray(sig?.verbs) ? sig.verbs : [];
  if (!verbs.some(appears)) return false;
  const argHints = Array.isArray(sig?.argHints) ? sig.argHints : [];
  if (argHints.some(appears)) return true;
  const strongVerbs = Array.isArray(sig?.strongVerbs) ? sig.strongVerbs : [];
  return strongVerbs.some((v) => nameLc.includes(lc(v)));
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
  const nameLc = lc(toolName);
  const sigs = Array.isArray(signatures) ? signatures : [];
  let best = null;
  for (const sig of sigs) {
    if (!sig || !signatureMatches(sig, appears, nameLc)) continue;
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
