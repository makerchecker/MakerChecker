<div align="center">

# 🛡️ MakerChecker

### The open-source security layer for AI agents.

Deny-by-default enforcement, human approvals, and a cryptographically signed audit trail — so your agent runs only what it's granted and **provably can't approve its own work.**

[![CI](https://github.com/sammysltd/makerchecker/actions/workflows/ci.yml/badge.svg)](https://github.com/sammysltd/makerchecker/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/sammysltd/makerchecker?label=release)](https://github.com/sammysltd/makerchecker/releases/latest)
[![License](https://img.shields.io/badge/license-AGPL--3.0%20core%20%2B%20Apache--2.0%20SDK-informational)](LICENSING.md)
[![Stars](https://img.shields.io/github/stars/sammysltd/makerchecker?style=social)](https://github.com/sammysltd/makerchecker)

**[Website](https://makerchecker.ai) · [Live Demo](https://makerchecker.ai/demo/) · [`mc scan`](packages/scan) · [Docs](docs/)**

</div>

Your agents keep running in their existing framework (LangChain, Claude SDK, CrewAI). MakerChecker sits in front of every tool call as a checkpoint and behind it as a signed ledger: an agent acts only through a **role**, runs only the skills it was **granted**, cannot exceed its limits, and cannot approve its own work.

---

## 🚀 Quick Start

### 1 — Scan your code

Find what your agent can already do on its own, classified by risk. No install, nothing leaves your machine:

```bash
npx @makerchecker/scan .
```

It flags every consequential action — deleting data, moving money, running shell commands, exfiltrating secrets — names each against the real incident it resembles, and can write the governance code for you with `--fix`. → [`packages/scan`](packages/scan/README.md)

### 2 — Guarantee its behavior

Import the controls and wrap any tool. The agent can now only run what its role was granted — a call it isn't allowed is denied *before* it executes:

```bash
npm i @makerchecker/embedded
```

```ts
import { createGovernor, GovernanceDeniedError } from "@makerchecker/embedded";

const gov = createGovernor()
  .defineSkill("place-order@1", { riskTier: "high" })
  .defineRole("agent")
  .defineRole("risk-desk")
  .grant("risk-desk", "place-order@1")   // the agent is NOT granted it — deny by default
  .defineAgent("trader", "agent");

// Wrap your tool once. Now the agent structurally can't fire it.
const placeOrder = gov.governedTool("trader", "place-order@1", (order) => broker.submit(order));

try {
  await placeOrder({ symbol: "BTC", qty: 10 });
} catch (err) {
  if (err instanceof GovernanceDeniedError) console.log(err.code); // "skill_not_granted"
}
```

High-risk skills go to a *separate* role, so an agent can never approve its own work — and every decision, allowed or denied, commits to a signed audit log. → [`packages/embedded`](packages/embedded/README.md)

### 3 — Working with auditors?

Step 2 already writes a signed log. When auditors need a durable, queryable, tamper-evident record — plus a human-approval inbox and a review console — run the self-hosted server:

```bash
docker compose up
```

Every decision is Ed25519-signed and hash-chained: change any row and verification breaks. Export a bundle and anyone verifies it offline — no database, no trust in the process that produced it. → [full server setup below](#-self-hosted-server-optional)

> **These are three independent packages** — [`mc scan`](packages/scan), [`@makerchecker/embedded`](packages/embedded), and the [server](packages/server) — that enforce the same controls and write the same signed audit format. Adopt any one on its own.

---

## 🔬 Governed Use Cases

Runnable examples of agents doing consequential work behind a human gate:

- **Pharmacovigilance case processing** — an agent triages adverse-event reports, but a medical reviewer signs before an expedited 15-day regulatory report transmits. [examples/pv-icsr-processing](examples/pv-icsr-processing/README.md)
- **Medical-device (MDR) complaint triage** — a regulatory officer decides reportability behind a gate before draft reports are generated. [examples/mdr-reportability-triage](examples/mdr-reportability-triage/README.md)
- **Oncology patient access** — an agent handles benefit matching but is blocked from submitting copay enrollments without a specialist signing. [examples/oncology-patient-access](examples/oncology-patient-access/README.md)
- **Daily cash reconciliation** — a finance agent reconciles transactions but locks at exception gates until a cash officer signs off. [examples/daily-cash-reconciliation](examples/daily-cash-reconciliation/README.md)

---

## 🔌 Integrate With Your Framework

Drop-in connectors govern the tools you already have:

- **LangChain** → [`packages/connector-langchain`](packages/connector-langchain/README.md)
- **Claude Agent SDK** → [`packages/connector-claude-agent`](packages/connector-claude-agent/README.md)
- **TypeScript / Python SDKs** → [`packages/sdk`](packages/sdk/README.md) · [`packages/sdk-python`](packages/sdk-python/README.md)

When you run the server, the SDK's `governedTool` routes each call through a proxy session for centralized authorization and recording:

```ts
import { createClient, governedTool, GovernanceDeniedError } from "@makerchecker/sdk";

const client = createClient({ baseUrl: "http://localhost:3000", apiKey: "mk_..." });
const { session } = await client.proxy.openSession({ label: "recon-run" });

const match = governedTool(
  client, session.id,
  "recon-preparer",   // agent whose role grants are evaluated
  "txn-match@1",       // skillRef: name@version
  (input) => matchTxns(input),
);

await match({ statement, ledger });   // throws GovernanceDeniedError if denied
await client.proxy.closeSession(session.id);
```

---

## 🖥️ Self-Hosted Server (optional)

Run the full gateway when you need centralized enforcement across many agents, a human-approval inbox, and a review console. `docker compose up` brings up Postgres, the server on `localhost:3000`, and a seeded demo, printing two API keys — an **admin key** (your agent authenticates runs) and an **officer key** (a human reviewer approves gated actions).

The seeded pharmacovigilance flow parks at a medical-review gate where the requester is refused as its own approver:

```bash
export H='authorization: Bearer mk_...'         # admin key
export OFFICER='authorization: Bearer mk_...'   # officer key

curl -X POST localhost:3000/api/flows/pv-icsr-processing/runs -H "$H" -H 'content-type: application/json' -d '{}'
curl localhost:3000/api/approvals -H "$H"

# The requester cannot approve their own run — rejected with 403
curl -X POST localhost:3000/api/approvals/<id>/decision -H "$H" -H 'content-type: application/json' \
  -d '{"decision":"approved","reason":"self-approval attempt"}'

# A separate officer signs; only now does the action proceed
curl -X POST localhost:3000/api/approvals/<id>/decision -H "$OFFICER" -H 'content-type: application/json' \
  -d '{"decision":"approved","reason":"Seriousness confirmed; file 15-day expedited ICSRs."}'

curl localhost:3000/api/audit/verify -H "$H"
```

Full setup, Kubernetes/Helm, and running with live models: [docs/quickstart.md](docs/quickstart.md).

---

## 🔒 Verifiable Audit Trail

Every decision and tool call commits to a hash-chained log — each event a SHA-256 over the RFC 8785 canonical JSON of the event, chained through `prev_hash` from genesis and Ed25519-signed. Change any row and verification breaks. Anyone can verify an exported bundle offline — no database, and no trust in the process that produced it:

```bash
npx @makerchecker/proof-verifier verify bundle.json
```

Spec: [docs/audit-spec.md](docs/audit-spec.md).

---

## 🗂️ Packages

| Package | License | What it is |
|---|---|---|
| [`packages/scan`](packages/scan) | Apache-2.0 | `mc scan` — finds and classifies what your agent can do. |
| [`packages/embedded`](packages/embedded) | Apache-2.0 | Importable enforcement primitives — governance in your code. |
| [`packages/proof-verifier`](packages/proof-verifier) | Apache-2.0 | Independently verify a signed audit bundle offline. |
| [`packages/sdk`](packages/sdk) | Apache-2.0 | TypeScript client + `governedTool` for the server. |
| [`packages/sdk-python`](packages/sdk-python) | Apache-2.0 | Python client + `governed_tool`. |
| [`packages/connector-langchain`](packages/connector-langchain) | Apache-2.0 | Govern LangChain tools. |
| [`packages/connector-claude-agent`](packages/connector-claude-agent) | Apache-2.0 | Govern Claude Agent SDK tools. |
| [`packages/server`](packages/server) | AGPL-3.0 | Self-hosted Fastify + Postgres gateway, flow engine, audit writer. |
| [`packages/web`](packages/web) | AGPL-3.0 | React console: approvals inbox, run log, registry. |
| [`packages/shared`](packages/shared) | AGPL-3.0 | Domain types, canonical JSON, crypto utilities. |

---

## 📄 License & Contributing

- **Server, Web, Shared:** [AGPL-3.0](LICENSE).
- **`mc scan`, `embedded`, SDKs, connectors, examples:** [Apache-2.0](LICENSING.md) — embed them in closed-source agents freely.
- Commercial (non-copyleft) licensing: hello@makerchecker.ai.

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Security: [SECURITY.md](SECURITY.md) · Code of Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
