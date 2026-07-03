# mc scan — module contracts (FIXED)

This is the interface contract for `@makerchecker/scan`. **Do not change these
signatures, field names, or JSON shapes.** `scan.mjs` (the CLI entry) imports the
six `lib/*.mjs` modules by the exact names below and wires the pipeline. Each
builder implements exactly one `lib` file against this contract. Interface drift
breaks the build.

```
parseTools(path)  ->  loadPolicy(dir) + mergeSignatures(SIGNATURES, policy)
                  ->  classify(tool, signatures, policy) for each tool
                  ->  renderTerminal | renderJson | renderMarkdown  (or initPolicy)
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
};
```

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
//   - code discovery in .py/.ts/.js/.mjs/.ts: regex scan for
//       * LangChain: @tool decorators, Tool(name=..., description=...), StructuredTool
//       * function-calling tool objects / MCP server registrations
//         (server.tool("name", ...), @mcp.tool(), registerTool("name"))
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
export function renderTerminal(findings: Finding[], meta: Meta): string;
// The delightful, honest terminal card (the MVP output style, upgraded). Uses
// ANSI colour only when process.stdout.isTTY. Sections: header, the red panel for
// the single worst ungoverned finding (named against its incident), the inventory
// filtered by policy.severityThreshold, a governed/green section for tools with
// governedBy, the count summary, the corpus link, and a "what this won't catch"
// footer. Returns the full string (scan.mjs prints it). No process.exit here.

export function renderJson(findings: Finding[], meta: Meta): object;
// A stable machine object: { meta, findings, counts }. Returns the OBJECT
// (scan.mjs does JSON.stringify). Must be pure JSON (no undefined, no functions).

export function renderMarkdown(findings: Finding[], meta: Meta): string;
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

---

## CLI (`scan.mjs`) — fixed wiring

```
scan <path> [--json | --markdown] [--policy <file>] [--fail-on <severity>]
scan init [<path>] [--policy <outfile>]     # writes mc-policy.json via initPolicy
```

- Default `<path>` is `.`.
- `--policy <file>`: on scan, load that policy file; on `init`, the output path
  (default `./mc-policy.json`).
- `--fail-on <severity>`: overrides `policy.failOn`. CLI exits non-zero when any
  finding's severity rank >= the resolved fail-on rank (governed/OK tools excluded).
- `init` prints a short explanation of how the generated file maps to MakerChecker.
