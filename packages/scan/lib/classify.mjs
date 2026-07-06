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
  'send-message', 'destroy-data', 'run-shell', 'commit-decision', 'web3-value-movement',
]);
// web3-value-movement guards. A read token anywhere in the name (get_quote,
// check_allowance, deposit_address) is a read, not a transfer. And an ambiguous
// crypto hint (token/position) inside an auth/identity context (send_reset_token,
// send_position_update over GPS) is not on-chain value movement.
const WEB3_READ_TOKENS = new Set([...READ_LEAD, 'quote', 'quoter', 'router', 'balance', 'allowance', 'price', 'info', 'status', 'decode', 'calc', 'holdings', 'report', 'summary', 'signal', 'history', 'trending', 'chart', 'metadata']);
const WEB3_AMBIG_HINTS = new Set(['token', 'tokens', 'position', 'native']);
const AUTH_CTX_RE = /\b(email|password|otp|verification|verify|reset|magic[- ]?link|login|session|loyalty|reward|coupon|voucher|api[_ ]?key|apikey|access[_ ]?token|refresh[_ ]?token|bearer|jwt|sms|invite|newsletter|gps|location|coordinate|dispatch|ticket|crowd)\b/i;
// Simulation / dry-run tokens. A tool named submit_backtest, paper_trade,
// simulate_order, or mock_send runs against synthetic state — it commits nothing
// real, so it must not match a live money/trade/message signature by name. Same
// escape hatch as READ_LEAD: body evidence can still re-raise it if the body
// actually reaches a live venue. `sandbox` is here too — a sandboxed action is
// the SAFE pattern we deliberately downgrade, not flag.
const SIMULATION_TOKENS = new Set([
  'backtest', 'backtesting', 'simulate', 'simulation', 'simulated', 'sim',
  'paper', 'papertrade', 'dryrun', 'sandbox', 'sandboxed', 'mock', 'mocked',
  'replay', 'stub', 'fake',
]);
// The same signal in the DESCRIPTION, not just the tool name. Many tools are named
// place_order / process_refund but their docstring says "paper trading account",
// "Simulates a refund", "mock order", "dry run", "for demonstration" — they commit
// nothing real. A live money/trade/message signature must not fire CATASTROPHIC on
// these. Phrase-anchored so a live tool that merely MENTIONS "not a simulation"
// isn't caught. Body evidence can still re-raise (a fake "paper" wrapper that POSTs
// to a live venue).
const SIM_DESC_RE = /\b(paper[- ]?trad|mock[- ]?(trad|order|account|api|payment|refund)|simulat|dry[- ]?run|sandbox|for (demo|demonstration|testing|illustration|educational)|not (a )?real|no real (money|order|trade|funds)|stub|dummy)/i;
// A parameter that names an approval / authorization token the caller must present.
// The developer has ATTEMPTED a gate (e.g. an out-of-band RiskGuard issues it), so
// this is not a "no one is checking" finding — downgrade one step and say why.
// (If the LLM can forge the token it's weaker than real SoD, but that's a design
// review, not the CATASTROPHIC "wired straight to a live venue" claim.)
const APPROVAL_PARAM_RE = /^(approval_token|approval|authorization|authorization_token|auth_token|approved_by|approver|sign_?off|signoff|approval_id)$/;

// A confirmation/override parameter the MODEL itself sets in the same tool call.
// Unlike APPROVAL_PARAM_RE (an out-of-band token the developer built), this is a
// boolean the calling LLM flips on itself — a prompt injection sets it to true.
// This is the QuantDinger place_quick_order(confirm_live_trading=...) shape: the
// maker and the checker are the same actor. It NEVER downgrades a finding; it
// raises a distinct "the model can approve itself" note.
const SELF_APPROVAL_PARAM_RE = /^confirm(ed|ation)?(_|$)|^(force|yes|i_am_sure|auto_approve|skip_confirm(ation)?|acknowledge)$/;
// The signatures where a model-settable confirmation flag is the self-approval bug.
const SELF_APPROVABLE_SIGS = new Set(['move-money', 'execute-trade', 'autonomous-spend', 'destroy-data', 'run-shell', 'web3-value-movement']);

// Signatures where a model-chosen amount/recipient turns the finding into a
// concrete, demonstrable bug (not just an ungated capability).
const MODEL_CONTROLLED_SIGS = new Set([
  'autonomous-spend', 'move-money', 'execute-trade', 'bind-commitment', 'send-message', 'web3-value-movement',
]);
// A parameter that names a MONETARY / quantity value the model fills in freely.
const VALUE_PARAM_RE = /^(amount|amt|price|total|subtotal|sum|cost|fee|value|balance|qty|quantity|units|shares|notional|refund_amount|charge_amount|transfer_amount|payment_amount|withdraw(al)?_amount)$/;
// A parameter that names the DESTINATION / identity the money or message goes to.
const TARGET_PARAM_RE = /^(recipient|to|to_account|dest|destination|account|account_id|account_number|iban|routing|card|card_number|wallet|wallet_address|payee|beneficiary|address)$/;
// A source path that marks the tool as demo/sample/test code, not the deployed
// agent. A finding here is real-shaped but NOT evidence a shipped product is
// exposed — it must never drive a PR or a headline stat. We TAG (not drop): the
// pattern still counts as "seen in the wild", just flagged as demo context.
const DEMO_PATH_RE = /(^|\/)([\w-]*(tests?|fixtures?)|__tests__|examples?|samples?|notebooks?|demos?|cookbooks?|recipes?|playground|docs?)(\/|$)/i;

/**
 * Build matchers over one tool. Verbs describe what the tool DOES, so they match
 * the NAME (camelCase/snake/kebab-token-aware) or the DESCRIPTION only — never a
 * parameter name. That is the whole point of the split: `register_patient(email,
 * phone)` collects contact data, it does not "email" anyone, so the param named
 * `email` must not satisfy the send-message verb. ArgHints describe PARAMETERS,
 * so they additionally match param names. Both use whole-token matching in text
 * (so `run` never fires on "running") and camelCase tokens in the name.
 * @param {Tool} tool
 */
function makeMatcher(tool) {
  const tokens = nameTokens(tool?.name);
  const params = Array.isArray(tool?.params) ? tool.params.map(lc) : [];
  const descLc = lc(tool?.description);
  const paramsLc = params.join(' ');
  const inText = (t, hay) => new RegExp('\\b' + esc(t) + '\\b').test(hay);
  // Verbs: name token or a word in the description. NOT parameter names.
  const verbAppears = (term) => {
    const t = lc(term);
    if (!t) return false;
    return tokens.has(t) || inText(t, descLc);
  };
  // ArgHints: name token, or a word in the description OR a parameter name.
  const argAppears = (term) => {
    const t = lc(term);
    if (!t) return false;
    return tokens.has(t) || inText(t, descLc + ' ' + paramsLc);
  };
  return { verbAppears, argAppears };
}

/**
 * Does this signature match the tool? One of its verbs must appear (in the name
 * or description) AND either an argHint is present (name/description/params) OR
 * one of its strongVerbs appears in the tool name (the "strong verb matches on
 * the name alone" rule).
 * @param {Signature} sig
 * @param {{ verbAppears: (t: string) => boolean, argAppears: (t: string) => boolean }} m
 * @param {Set<string>} tokens  camelCase/snake-aware tokens of the tool name
 */
function signatureMatches(sig, m, tokens) {
  const { verbAppears, argAppears } = m;
  const verbs = Array.isArray(sig?.verbs) ? sig.verbs : [];
  // nameOnlyVerbs match ONLY as a whole name token, never in description/params
  // prose: `format` fires on format_disk but not on "(format: YYYY-MM-DD)".
  const nameOnlyVerbs = Array.isArray(sig?.nameOnlyVerbs) ? sig.nameOnlyVerbs : [];
  const matchedVerbs = verbs
    .filter(verbAppears)
    .concat(nameOnlyVerbs.filter((v) => tokens.has(lc(v))));
  if (!matchedVerbs.length) return false;
  // Distinct-token rule: the confirming argHint must be a DIFFERENT token than
  // the one that satisfied the verb. A single word that lives in both lists
  // (e.g. "price" as a bind-commitment verb AND argHint) is one signal, not two,
  // so `getPrice` no longer self-confirms as a pricing commitment.
  const matched = new Set(matchedVerbs.map(lc));
  const argHints = Array.isArray(sig?.argHints) ? sig.argHints : [];
  if (argHints.some((a) => !matched.has(lc(a)) && argAppears(a))) return true;
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
export const BODY_MARKERS = [
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
  // On-chain write: a raw signed transaction / contract write settles irreversibly.
  // Backstops the name-anchored web3 signature and recovers terse tools whose name
  // carries no crypto hint (executeSwap, fund_account) but whose body sends a tx.
  { kind: 'onchain-write', sigId: 'web3-value-movement', severity: 'CATASTROPHIC',
    re: /walletClient\.sendTransaction|\.sendTransaction\s*\(|\bwriteContract\s*\(|contract\.write\b|signTypedData|eth_sendRawTransaction|eth_sendTransaction|eth_signTransaction|\.signTransaction\s*\(|sendUserOperation/ },
  // Broker order submission (Alpaca / IBKR). ccxt's bare create_order is EXCLUDED:
  // it collides with e-commerce carts.
  { kind: 'broker-order', sigId: 'execute-trade', severity: 'CATASTROPHIC',
    re: /\.submit_order\s*\(|\.place_order\s*\(|\.placeOrder\s*\(|\bib_insync\b|\balpaca_trade_api\b|tradeapi\.submit_order/ },
];

// A dangerous action inside a disposable sandbox (an e2b cloud VM, a container,
// a WASM/RestrictedPython interpreter) cannot touch the user's real systems —
// a `rm -rf` there wipes a throwaway VM. When execution is demonstrably
// sandboxed we downgrade and say so, rather than crying "deletes your home
// directory" about a container. Marker in the tool body OR the surrounding file.
// Note the leading \b but no trailing \b on e2b/daytona: matches "E2BExecTool"
// and "DaytonaPythonTool" (name-derived) as well as "from e2b import".
export const SANDBOX_RE = /\be2b|@e2b\/|\bdaytona|Sandbox\.create|CodeInterpreter|code_interpreter|codeInterpreter|\bpyodide\b|RestrictedPython|\bgvisor\b|\bfirecracker\b|\bnsjail\b|\bbubblewrap\b|\bfirejail\b|dockerode|docker\.from_env|DockerClient|\bwasmer\b|\bwasmtime\b/i;

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
  const matcher = makeMatcher(tool);
  const descLc = lc(tool?.description);
  const tokenList = nameTokenList(toolName);
  const tokens = new Set(tokenList);
  const lead = tokenList[0] || '';
  const sigs = Array.isArray(signatures) ? signatures : [];
  let best = null;
  for (const sig of sigs) {
    if (!sig || !signatureMatches(sig, matcher, tokens)) continue;
    // Leading read/negation verb: the name-based match is a false positive for a
    // write/spend signature (body evidence below can still re-raise it if the
    // function actually acts). Skip it and let a lower-severity or OK match stand.
    if (READ_LEAD.has(lead) && NAME_SUPPRESSIBLE.has(sig.id)) continue;
    // Simulation/dry-run tool matched a live-action signature by name only: the
    // action isn't real. Skip (body evidence below can still re-raise it).
    if (NAME_SUPPRESSIBLE.has(sig.id)
      && (tokenList.some((t) => SIMULATION_TOKENS.has(t)) || SIM_DESC_RE.test(descLc))) continue;
    // web3-value-movement: a read token anywhere in the name is a read (get_quote,
    // renzo_get_deposit_address, check_allowance); and when the only crypto hint is
    // ambiguous (token/position) in an auth/identity context (send_reset_token,
    // send_position_update over GPS), it is not on-chain value movement.
    if (sig.id === 'web3-value-movement') {
      if (tokenList.some((t) => WEB3_READ_TOKENS.has(t))) continue;
      const hasHard = (sig.argHints || []).some((h) => !WEB3_AMBIG_HINTS.has(lc(h)) && matcher.argAppears(h));
      if (!hasHard && AUTH_CTX_RE.test(`${toolName} ${descLc}`)) continue;
    }
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
    let signals = detectBodySignals(tool.body, tool.bodyLine || 1);
    // A READ-named tool (get_price, check_approval, get_quote) whose 60-line body
    // window bleeds into a neighbouring method's writeContract/sendTransaction is
    // not itself an on-chain mover. Honour the same read guard the name match uses,
    // so body-snippet bleed can't manufacture a web3 CATASTROPHIC on a reader.
    if (tokenList.some((t) => WEB3_READ_TOKENS.has(t))) {
      signals = signals.filter((s) => s.sigId !== 'web3-value-movement');
    }
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

  // Self-approval anti-pattern: a confirmation/override parameter the MODEL sets
  // in its own tool call is not a gate — a prompt injection flips it to true. This
  // is the QuantDinger place_quick_order(confirm_live_trading=...) shape. We FLAG
  // it (never downgrade), and below we refuse to let an in-body check of that same
  // model-supplied flag earn a mitigation downgrade.
  if (SELF_APPROVABLE_SIGS.has(finding.signature)
    && (finding.severity === 'HIGH' || finding.severity === 'CATASTROPHIC')
    && Array.isArray(tool.params)) {
    const selfParam = tool.params.map(lc).find((p) => SELF_APPROVAL_PARAM_RE.test(p));
    if (selfParam) {
      finding.selfApproval = {
        param: selfParam,
        note: `confirmation parameter "${selfParam}" is model-settable — the agent can approve itself`,
      };
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
    // An in-body confirm check of a MODEL-settable flag is theatre, not a gate:
    // the model set the flag, so checking it protects nothing. Refuse the downgrade.
    const gated = detectGate(tool.body) && !finding.selfApproval;
    if (sandboxed || gated) {
      const reason = sandboxed ? 'runs inside a disposable sandbox' : 'guarded by an in-body confirmation';
      const lowered = finding.severity === 'CATASTROPHIC' ? 'HIGH' : 'MEDIUM';
      finding.mitigation = { kind: sandboxed ? 'sandbox' : 'gate', note: reason };
      finding.severity = lowered;
      finding.action = `${finding.action || 'runs with no one checking it'} — but ${reason}`;
    }
  }

  // Model-controlled value: an action tool whose OWN PARAMETERS include the
  // amount/recipient/identity means the LLM fills that value in freely — a prompt
  // injection or a hallucination sets it to anything. This is the difference
  // between a design observation ("this agent can refund") and a concrete bug
  // ("this agent refunds an ATTACKER-CHOSEN amount to an ATTACKER-CHOSEN account").
  // We flag it, not re-rank it: it's what turns a finding into a repro.
  if (MODEL_CONTROLLED_SIGS.has(finding.signature) && Array.isArray(tool.params)) {
    const params = tool.params.map(lc);
    const value = params.find((p) => VALUE_PARAM_RE.test(p));
    const target = params.find((p) => TARGET_PARAM_RE.test(p));
    const hit = value || target;
    if (hit) {
      finding.modelControlled = {
        param: hit,
        kind: value ? 'value' : 'target',
        note: value
          ? `the "${value}" is a free parameter — the model chooses how much`
          : `the "${target}" is a free parameter — the model chooses the destination`,
      };
    }
  }

  // Approval-token parameter: the tool requires an approval/authorization token to
  // act (an out-of-band gate the developer built). Not the "no one is checking"
  // risk — downgrade one step (never below MEDIUM) and record it. A concrete find
  // here would be "the LLM can forge the token", which is a design review, not the
  // CATASTROPHIC claim, so we must not PR it as ungated.
  if (finding.severity !== 'OK' && Array.isArray(tool.params)
    && tool.params.map(lc).some((p) => APPROVAL_PARAM_RE.test(p))) {
    finding.mitigation = { kind: 'approval-param', note: 'requires an approval/authorization token to act' };
    finding.severity = finding.severity === 'CATASTROPHIC' ? 'HIGH' : (finding.severity === 'HIGH' ? 'MEDIUM' : finding.severity);
    finding.action = `${finding.action || 'runs with no one checking it'} — but requires an approval/authorization token`;
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

  // Demo/test/example context: tag any non-OK finding whose source lives under a
  // test/example/notebook path. Keeps the finding (the pattern IS in the wild) but
  // lets gen-pr and the data-card exclude it — a finding in someone's test fixture
  // is not a shipped-product exposure and must never reach a PR.
  if (finding.severity !== 'OK' && typeof tool.source === 'string' && DEMO_PATH_RE.test(tool.source)) {
    finding.demoContext = true;
  }

  return finding;
}
