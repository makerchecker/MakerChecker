# mc scan — module contracts (FIXED)

This is the interface contract for `@makerchecker/scan`. **Do not change these
signatures, field names, or JSON shapes.** `scan.mjs` (the CLI entry) imports the
`lib/*.mjs` modules by the exact names below and wires the pipeline. Each builder
implements one `lib` file against this contract. Interface drift breaks the build.

```
parseTools(path)  ->  loadPolicy(dir) + mergeSignatures(SIGNATURES, policy)
                  ->  classify(tool, signatures, policy) for each tool
                  ->  [ --llm: llmScan / llmCodeScan enrich the findings ]
                  ->  composePairs(findings)
                  ->  renderTerminal | renderJson | renderMarkdown
                      (or initPolicy for `init`, or generateFixScaffold for `--fix`)
```

Constraints that hold for every module:

- **Zero runtime dependencies.** Node >= 18, ESM (`.mjs`). Only `node:*` builtins.
- **Read-only. No network. No telemetry.** Nothing leaves the machine, ever.
- **Resilient.** Never throw on malformed/junk input; skip and continue.
- Every non-OK finding **names a real incident** from `incidents/entries` by `aid`.

Canonical severity ordering (used everywhere; do not redefine differently):

```js
const SEV_RANK = { OK: 0, MEDIUM: 1, HIGH: 2, CATASTROPHIC: 3 };
```

Control gate vocabulary (the only allowed `control` values; each maps 1:1 to a
MakerChecker enforcement primitive):

| control | meaning |
|---|---|
| `high_risk_requires_gate` | irreversible action must pass a named-human approval gate before it runs |
| `approval_gate` | a maker prepares, a separate checker approves (four-eyes) before commit |
| `limit_violation` | hard per-invocation + windowed caps, fail-closed (the kill switch) |
| `skill_not_granted` | deny-by-default; a tool not in the grant set cannot run |
| `sod_violation` | segregation of duties; the actor that prepares must not be the one that commits |
| `independent_citation_verification` | external claims/citations verified before they are filed |

---

## Shared data shapes

### Tool

```ts
type Tool = {
  name: string;          // tool / function name
  description: string;   // human description ('' if none)
  params: string[];      // flat list of parameter/argument names
  source: string;        // where it was found: "<relpath>" or "<relpath>:<line>"
};
```

### Signature (see `lib/signatures.mjs`)

```ts
type Control =
  | 'high_risk_requires_gate' | 'approval_gate' | 'limit_violation'
  | 'skill_not_granted' | 'sod_violation' | 'independent_citation_verification';

type IncidentRef = { aid: string; title: string };

type Signature = {
  id: string;                 // stable slug, e.g. 'destroy-data'
  category: string;           // corpus category, e.g. 'data-loss'
  verbs: string[];            // lowercased verb tokens that indicate this risk
  argHints?: string[];        // param/description tokens that CONFIRM the risk
  strongVerbs?: string[];     // verbs that match on the tool NAME alone (no argHint needed)
  nameOnlyVerbs?: string[];   // verbs matched ONLY as a name token, never in prose (e.g. 'format')
  severity: 'CATASTROPHIC' | 'HIGH' | 'MEDIUM';
  action: string;            // reads as: `${tool.name} ` + action, e.g. "destroys data that cannot be recovered"
  resembles: IncidentRef;    // the primary real incident this shape resembles
  alsoResembles?: IncidentRef[]; // other corpus incidents of the same shape
  control: Control;          // the gate that would have stopped it
  why: string;               // one honest paragraph: why it is irreversible + the fix
};
```

### Finding (returned by `classify`)

```ts
type Finding = {
  tool: Tool;                                 // the tool as parsed
  severity: 'CATASTROPHIC' | 'HIGH' | 'MEDIUM' | 'OK';
  signature: string | null;                   // matched Signature.id, or null when OK/unmatched
  resembles: IncidentRef | null;              // hoisted from the matched signature
  control: Control | null;                    // hoisted from the matched signature
  action: string | null;                      // hoisted from the matched signature
  why: string | null;                         // hoisted from the matched signature
  governedBy: { gate: Control; note: string } | null; // set when policy.allow governs this tool
  // optional enrichments (present only when detected; additive, never break the contract):
  evidence?: { kind: string; marker: string; line: number }[]; // body-signal matches that raised severity
  mitigation?: { kind: 'sandbox' | 'gate' | 'approval-param'; note: string }; // a downgrade and why
  modelControlled?: { param: string; kind: 'value' | 'target'; note: string }; // a free amount/recipient param
  selfApproval?: { param: string; note: string };  // a model-settable confirm flag (QuantDinger shape)
  demoContext?: true;                              // finding lives under a test/example/demo path
  // set by the opt-in --llm deep scan (see below):
  staticSeverity?: string;   // the deterministic severity before the LLM raised it (the CI-gate floor)
  assessedBy?: 'llm';        // an LLM re-ranked or annotated this finding
  discoveredBy?: 'llm-code-scan'; // an undeclared capability found by the Mode B code scan
  unverified?: boolean;      // an LLM note whose evidence could not be corroborated (never gates CI)
};
```

Rules for `classify`:

- Match `tool` against every signature. A signature matches when one of its
  `verbs` appears (as a token in name/description/params, or as a substring of
  `tool.name`) **and** (an `argHint` is present **or** the matched verb is in
  `strongVerbs` and appears in `tool.name`). This mirrors the MVP's "strong verb"
  rule but moves the list into signature data.
- Of all matching signatures, keep the one with the highest `SEV_RANK`.
- No match -> `severity: 'OK'`, all hoisted fields `null`.
- **Governance downgrade:** if `policy.ignore` contains `tool.name`, return
  `severity: 'OK'`, `governedBy: null` (skipped entirely). If `policy.allow[tool.name]`
  exists, set `governedBy = policy.allow[tool.name]` and force `severity: 'OK'`, but
  KEEP `signature`/`resembles`/`control`/`action`/`why` populated from the match so
  the report can render "was CATASTROPHIC — now governed by <gate>". This is the
  free-to-paid bridge made literal.

---

## mc-policy.json (the config AND the governance policy)

The same file the free scan generates is the file the paid MakerChecker engine
enforces. Deny-by-default.

```ts
type Policy = {
  version: number;                 // schema version, currently 1
  severityThreshold: 'CATASTROPHIC' | 'HIGH' | 'MEDIUM' | 'OK'; // min severity to SHOW in the inventory (default 'MEDIUM')
  failOn: 'CATASTROPHIC' | 'HIGH' | 'MEDIUM' | 'OK';           // severity that makes the CLI exit non-zero (default 'CATASTROPHIC')
  ignore: string[];                // tool names to skip entirely (never flagged)
  allow: {                         // tools already governed -> downgrade to OK, mark governedBy
    [toolName: string]: { gate: Control; note: string };
  };
  customSignatures: Signature[];   // extra org-specific signatures, merged over builtin
  // resolved at load time (not authored by the user):
  path: string | null;            // absolute path of the mc-policy.json that was loaded, or null
};
```

On disk, `path` is omitted; it is populated by `loadPolicy`. `examples/mc-policy.json`
is the worked example; `mc-policy.schema.json` is the JSON Schema (validates the
on-disk shape, i.e. without `path`).

---

## Meta (built by `scan.mjs`, passed to every renderer)

```ts
type Meta = {
  target: string;         // the path that was scanned
  toolCount: number;      // findings.length
  sourceCount: number;    // distinct source files parsed
  counts: { CATASTROPHIC: number; HIGH: number; MEDIUM: number; OK: number; GOVERNED: number };
  policyPath: string | null;   // policy.path
  failOn: string;         // resolved fail-on severity
  scanVersion: string;    // package version
  corpusSize: number;     // number of incidents in the Agent Incident Database (41)
  generatedAt: string;    // ISO timestamp
  llm: object | null;     // set only under --llm: { mode, provider, model, endpointHost, reach,
                          //   reproducible:false, toolsReassessed, discovered, notes, dropped }
};
```

`renderJson` returns `{ meta, findings, counts, pairs }`; `pairs` is the composition
output (see `lib/compose.mjs`). `renderTerminal` and `renderMarkdown` also take
`pairs` as a third argument and render a "Composition" section from it.

---

## lib/signatures.mjs

Pure data. No logic, no imports.

```ts
export const SIGNATURES: Signature[];          // the expanded, corpus-backed risk table
export const IRREVERSIBLE_VERBS: Set<string>;  // union of every SIGNATURES[i].verbs, lowercased
```

- Cover all seven corpus categories: `data-loss`, `data-exfiltration`,
  `unauthorized-financial-action`, `runaway-execution`, `wrongful-automated-decision`,
  `binding-commitment`, `fabrication`.
- Every `resembles.aid` / `alsoResembles[].aid` MUST exist in `incidents/entries`.

## lib/policy.mjs

```ts
export const DEFAULT_POLICY: Policy;   // version:1, severityThreshold:'MEDIUM', failOn:'CATASTROPHIC',
                                       // ignore:[], allow:{}, customSignatures:[], path:null

export function loadPolicy(dir: string, explicitPath?: string): Policy;
// Resolve a policy: if explicitPath is given, load exactly that file; otherwise
// walk UP the tree from `dir` looking for the nearest mc-policy.json. Parse it,
// deep-merge over DEFAULT_POLICY (arrays replace, objects merge), validate
// (unknown severities -> defaults; bad types -> defaults; never throw), and set
// `path` to the absolute file path used (or null if none found). Read-only.

export function mergeSignatures(builtin: Signature[], policy: Policy): Signature[];
// Return builtin concatenated with policy.customSignatures. A custom signature
// with the same `id` as a builtin REPLACES the builtin (custom wins).
```

## lib/parse.mjs

```ts
export function parseTools(path: string): Tool[];
// `path` is a file or a directory. Discover tool definitions and return a
// de-duplicated Tool[] (dedupe by name; first occurrence wins, but prefer a
// non-empty description). Read-only, resilient to junk. Must handle:
//   - OpenAI tools/function schemas: { type:'function', function:{ name, description, parameters } }
//   - MCP tools/list JSON: { tools: [ { name, description, inputSchema } ] }
//   - bare arrays of { name, description, parameters }
//   - code discovery in .py/.ts/.tsx/.js/.jsx/.mjs/.cjs: regex scan for
//       * LangChain: @tool decorators (name= and docstring captured), Tool(...)/StructuredTool
//       * function-calling tool objects / MCP server registrations
//         (server.tool("name", ...), @mcp.tool(), registerTool("name"), tool(fn, {name,...}))
//       * Vercel AI SDK / Genkit object-key factories (const x = tool({ description, execute }))
//     Rejects Solidity ABI entries and JSX form fields (false-positive discipline).
// For JSON, `source` is the relative file path. For code discovery, `source` is
// "<relpath>:<line>". Skip node_modules and dotfiles. Never throw on a bad file.
// `params` are flattened parameter/argument names (JSON Schema properties keys,
// or the argument identifiers found in code).
```

## lib/classify.mjs

```ts
export function classify(tool: Tool, signatures: Signature[], policy: Policy): Finding;
// See "Rules for classify" above. Deterministic. No I/O.
```

## lib/report.mjs

```ts
export function renderTerminal(findings: Finding[], meta: Meta, pairs?: Pair[]): string;
// The delightful, honest terminal card (the MVP output style, upgraded). Uses
// ANSI colour only when process.stdout.isTTY. Sections: header, the red panel for
// the single worst ungoverned finding (named against its incident), the inventory
// filtered by policy.severityThreshold, a governed/green section for tools with
// governedBy, the count summary, the corpus link, and a "what this won't catch"
// footer. Returns the full string (scan.mjs prints it). No process.exit here.

export function renderJson(findings: Finding[], meta: Meta, pairs?: Pair[]): object;
// A stable machine object: { meta, findings, counts, pairs }. Returns the OBJECT
// (scan.mjs does JSON.stringify). Must be pure JSON (no undefined, no functions).

export function renderMarkdown(findings: Finding[], meta: Meta, pairs?: Pair[]): string;
// A shareable results card in Markdown: a summary line, a table of non-OK
// findings (Severity | Tool | Resembles (aid) | Fix control), a governed section,
// and the "what this won't catch" note. Screenshot/paste friendly.
```

## lib/policyInit.mjs

```ts
export function initPolicy(findings: Finding[]): Policy;
// Deny-by-default generator. Start from DEFAULT_POLICY. For every finding whose
// severity is CATASTROPHIC or HIGH (using the finding's matched signature, even if
// currently governed), write an `allow[tool.name] = { gate: <finding.control>,
// note: <deny-by-default explanation naming resembles.aid> }` entry. Do NOT include
// `path` in the returned object (it is the on-disk shape). The returned object,
// written to mc-policy.json, is exactly what the paid MakerChecker engine enforces:
// re-running `mc scan` with it shows those tools as governed (green).
```

## lib/compose.mjs

```ts
type Pair = {
  rule: 'rce-pair' | 'injection-drain-pair' | 'exfiltration-pair';
  severity: 'CATASTROPHIC' | 'HIGH';
  actor: string; actorSource: string;      // the tool that acts (exec / moves value / sends)
  readers: string[]; readerSources: string[]; moreReaders: number; // up to 5 untrusted/sensitive readers
  tools: [string, string]; sources: [string, string];  // legacy [reader, actor], reader-first
  risk: string; resembles: IncidentRef; alsoResembles: IncidentRef[]; control: 'sod_violation'; fix: string;
};

export function composePairs(findings: Finding[]): Pair[];
// Capabilities safe alone, lethal together. Token-aware (name tokens + params,
// never the description). Three rules in severity order (an actor is claimed once,
// by its worst role): RCE (untrusted reader + shell), injection-drain (untrusted
// reader + value mover), exfiltration (sensitive reader + external sender).
// One finding per actor. Governed tools are out of scope. Deterministic, no I/O.
export function readsUntrusted(tool: Tool): boolean;
export function readsSensitive(tool: Tool): boolean;
export function sendsExternal(tool: Tool): boolean;
```

## lib/fix.mjs

```ts
export function generateFixScaffold(findings: Finding[], pairs?: Pair[]): string | null;
// Build a runnable @makerchecker/embedded governance scaffold for the flagged
// findings, or null when there is nothing to govern. Deny-by-default: high-risk
// skills granted to a separate `risk-desk` role, composition pairs turned into
// `defineConflict` role conflicts, one governedTool wrapper per tool. `mc scan
// --fix` writes it to mc-governance.mjs. Writes a NEW file; never edits user code.
```

## lib/llmProviders.mjs + lib/llmScan.mjs + lib/codescan.mjs (opt-in --llm)

```ts
export function resolveLlmConfig(opts): Config;   // provider/model/key from flag > env > policy > default
export function llmScan(findings, { config }): Promise<Finding[]>;         // Mode A: re-rank ambiguous tools
export function llmCodeScan(root, findings, config, opts): Promise<{ findings, meta }>; // Mode B: source scan
```

Providers: `anthropic` (default), `openai`, `openrouter`, `together`, `groq`,
`ollama`, `openai-compatible`. Zero deps (plain fetch), NEVER lowers a static
severity, and every finding stays incident-anchored. This is the ONE part of mc
scan that is not offline, and only under an explicit `--llm`.

---

## CLI (`scan.mjs`) — fixed wiring

```
scan <path> [--json | --markdown] [--policy <file>] [--fail-on <severity>]
scan <path> --fix [--out <file>]            # writes mc-governance.mjs via generateFixScaffold
scan <path> --llm [--llm-mode <tools|code|both>] [--llm-provider <id>]
                  [--llm-model <id>] [--llm-base-url <url>] [--llm-key <key>]
scan init [<path>] [--policy <outfile>]     # writes mc-policy.json via initPolicy
```

- Default `<path>` is `.`.
- `--policy <file>`: on scan, load that policy file; on `init`, the output path
  (default `./mc-policy.json`).
- `--fail-on <severity>`: overrides `policy.failOn`. CLI exits non-zero when any
  finding's severity rank >= the resolved fail-on rank (governed/OK tools excluded).
  Gates on the DETERMINISTIC static severity, so a run with and without `--llm`
  returns the same exit code.
- `--fix`: terminal action; writes a MakerChecker governance scaffold and exits.
- `--llm`: opt-in deep scan (Mode A re-ranks ambiguous tools, Mode B reads source
  for undeclared capabilities). Off by default; the default scan sends nothing.
- `init` prints a short explanation of how the generated file maps to MakerChecker.
