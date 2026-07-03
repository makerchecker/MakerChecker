# @makerchecker/embedded

In-process MakerChecker governance. **Import the primitives and use them
standalone** — deny-by-default authorization and separation of duties — with no
server, no Postgres, and no audit chain. Add the signed, offline-verifiable
chain only when you want it.

The package is three composable tiers. Take only the layer you need:

| Import | You get | Pulls in |
| --- | --- | --- |
| `@makerchecker/embedded/policy` | the **pure decision** — deny-by-default authorization + separation of duties | nothing (no crypto, no clock, no state) |
| `@makerchecker/embedded/governor` | a **stateful enforcement point** that wraps your tools and tracks who has acted | just `./policy` |
| `@makerchecker/embedded/audit` | an **optional** genesis-rooted, Ed25519-signed, hash-chained log | `node:crypto` |
| `@makerchecker/embedded` (root) | a governor with the signed chain **already attached** — the one-liner | all of the above |

## Just the primitives — no chain, no database

If all you want is the enforcement decision, import `./policy`. It has zero
dependencies, touches no crypto, keeps no state, and never reads a clock —
`decide()` is a pure function you can call anywhere, including in a reducer, an
edge function, or a test.

```js
import { definePolicy, decide, enforce, GovernanceDeniedError } from "@makerchecker/embedded/policy";

const policy = definePolicy({
  skills: { "read-invoice@1": {}, "execute-payment@1": { riskTier: "high" } },
  roles:  { "ap-bot": { grants: ["read-invoice@1"] } },   // NOT execute-payment
  agents: { "agent-1": { role: "ap-bot" } },
});

decide(policy, { agent: "agent-1", skill: "read-invoice@1" });
// { effect: "allow", code: null, reason: null }

decide(policy, { agent: "agent-1", skill: "execute-payment@1" });
// { effect: "deny", code: "skill_not_granted", reason: "..." }

enforce(policy, { agent: "agent-1", skill: "execute-payment@1" });
// throws GovernanceDeniedError  (err.code === "skill_not_granted")
```

Separation of duties is passed in as context — you tell `decide()` which roles
have already acted this session, and it stays pure. It needs a policy that
declares the conflicting roles:

```js
const sod = definePolicy({
  skills: { "submit-payment@1": {}, "approve-payment@1": {} },
  roles:  {
    maker:   { grants: ["submit-payment@1"] },
    checker: { grants: ["approve-payment@1"], conflicts: ["maker"] },
  },
  agents: { "checker-bot": { role: "checker" } },
});

decide(sod, { agent: "checker-bot", skill: "approve-payment@1" }, { sessionActors: ["maker"] });
// { effect: "deny", code: "sod_violation", ... }  — the "maker" role already acted this session
```

The policy is a plain, serializable spec (`policy.toJSON()` / `policyToSpec`), so
you can load it from JSON/YAML and diff it in review like any other artifact.

## Add enforcement — wrap your tools (`./governor`)

The governor lifts the one thing a decision can't be pure about — **which roles
have already acted in a session** — out of `decide()` and holds it for you. It
wraps a tool so the call is authorized before it runs and refused before any side
effect. It records nothing unless you give it an `onDecision` sink, and it never
imports crypto.

```js
import { createGovernor } from "@makerchecker/embedded/governor";

const gov = createGovernor({ onDecision: (event) => myLogger.info(event) });
gov.defineSkill("execute-payment@1", { riskTier: "high" })
   .defineRole("ap-bot")
   .defineAgent("agent-1", "ap-bot");

const pay = gov.wrap("agent-1", "execute-payment@1", async (i) => rail.wire(i));
await pay({ amountUsd: 1_000_000 });   // throws GovernanceDeniedError — executor never runs
```

## Add the signed trail — the root export

The batteries-included root wires the `./audit` chain in as the governor's sink,
so every allow and deny lands in a genesis-rooted, hash-chained, Ed25519-signed
log with one line of setup.

```js
import { createGovernor } from "@makerchecker/embedded";

const gov = createGovernor();
gov.defineSkill("read-invoice@1")
   .defineSkill("execute-payment@1", { riskTier: "high" })
   .defineRole("ap-bot")
   .grant("ap-bot", "read-invoice@1")          // NOT execute-payment — deny by default
   .defineAgent("agent-1", "ap-bot");

const pay = gov.wrap("agent-1", "execute-payment@1", async (i) => rail.wire(i));
await pay({ amountUsd: 1_000_000 });            // throws GovernanceDeniedError [skill_not_granted]
```

The bundle it exports uses the **same chain format and the same verifier** as the
full server, so it verifies in the independent `@makerchecker/proof-verifier` with
no trust in the producing process:

```js
import { verifyBundle } from "@makerchecker/proof-verifier/core";
import { nodeCrypto } from "@makerchecker/proof-verifier/node";

const verdict = await verifyBundle(gov.exportBundle(), nodeCrypto); // { ok: true, ... }
```

## The rules (the same decision order as the server's `enforce()`)

Checked in order, deny by default:

1. the agent **exists** (`agent_not_found`) and is **active** (`agent_not_active`);
2. the skill **exists** (`skill_not_found`) and is **published** (`skill_deprecated`);
3. the skill is **granted** to the agent's role (`skill_not_granted`);
4. a **high-risk** skill never runs inline — it requires a preceding
   separation-enforcing approval gate decided by a separate party
   (`high_risk_requires_gate`);
5. **separation of duties** — no role in conflict with the agent's role may have
   already acted in this session (`sod_violation`). Conflicts are stored
   symmetrically, so the check fires no matter which side acted first.

## What this is and is not

This package is the same decision rules and the same signed hash-chain **format**
as the full server, held **in memory**, for the single-process case: a script, a
test, a demo, or one agent worker that wants a governance boundary with zero
infrastructure.

It is **not** a drop-in replacement for the server when you need:

- **durability across processes / restarts** — the chain lives in memory here;
  the server co-commits every decision and audit row in one Postgres transaction
  so nothing is lost and nothing can be written after the fact;
- **multi-writer / concurrent agents** sharing one ledger;
- a **persistent signing key** so historic bundles keep verifying (the embedded
  chain mints an **ephemeral** key unless you pass one in — `keyIsEphemeral`
  tells you which you have);
- the approval-gate workflow that lets a named human actually *release* a
  high-risk action (here, high-risk is refused inline — the correct default, but
  there is no in-process gate to approve it through).

Use embedded to get a governance boundary — or just the decision primitive — with
a plain `npm install`; graduate to the server when you need a durable,
multi-writer, tamper-evident system of record.

## API

### `@makerchecker/embedded/policy` — pure

- `definePolicy(spec)` → frozen `Policy` · `policyToSpec(policy)` → plain spec
- `createPolicyBuilder(policy?)` → fluent builder (`.snapshot()` / `.freeze()`)
- `decide(policy, { agent, skill }, { sessionActors?, hasSeparationGate? })` →
  `{ effect, code, reason }` (pure, no side effects)
- `enforce(policy, request, context?)` → allow decision, or throws
  `GovernanceDeniedError`
- `DECISION_CODES`, `GovernanceDeniedError` (`.code`, `.reason`)

### `@makerchecker/embedded/governor` — stateful, no crypto

- `createGovernor({ policy?, onDecision?, clock? })` → governor
- `.defineSkill` / `.defineRole` / `.defineConflict` / `.grant` / `.defineAgent`
- `.decide(agent, skill, opts?)` — dry-run, records nothing
- `.check(agent, skill, opts?)` — records + advances the SoD actor set
- `.wrap(agent, skill, executor, { sessionId? })` → governed async tool
  (per-call `sessionId` / `hasSeparationGate` override as a second argument);
  `.governedTool` is a backward-compatible alias
- `.policy()` → frozen snapshot · `.sessionActors(sessionId?)`

### `@makerchecker/embedded/audit` — optional, signed

- `createAuditChain({ instanceId?, privateKey?, publicKeyPem? })` → chain
- `.append(event)` → row · `.rows()` → rows · `.exportBundle()` → verifier-ready
  bundle · `.keyIsEphemeral` · `.publicKeyPem`
- `genesisPrevHash(instanceId)`, `SCHEMA_VERSION`

### `@makerchecker/embedded` — root

- `createGovernor({ instanceId?, privateKey?, publicKeyPem?, policy?, clock? })` →
  governor with a signed chain attached
- adds `.auditTrail()` → signed rows · `.exportBundle()` → bundle ·
  `.auditChain` (escape hatch) · `.instanceId` · `.publicKeyPem`
- re-exports every symbol from the three tiers (`createGovernorCore` is the
  bare governor without a chain)
