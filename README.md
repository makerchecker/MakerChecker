# MakerChecker

[![CI](https://github.com/sammysltd/makerchecker/actions/workflows/ci.yml/badge.svg)](https://github.com/sammysltd/makerchecker/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/sammysltd/makerchecker?label=release)](https://github.com/sammysltd/makerchecker/releases/latest)
[![License](https://img.shields.io/badge/license-AGPL--3.0%20core%20%2B%20Apache--2.0%20SDK-informational)](LICENSING.md)

**Website: [makerchecker.ai](https://makerchecker.ai)**

MakerChecker is an open-source security and governance toolkit for AI agents. It provides a local static tool scanner (`mc scan`) for identifying risky agent capabilities, and a self-hosted API gateway to enforce role-based access control (RBAC), human-in-the-loop approvals, and cryptographically signed audit trails.

Your agents keep running in their existing frameworks (LangChain, Claude SDK, CrewAI, etc.). MakerChecker acts as a secure checkpoint in front of them and an immutable ledger behind them.

---

## ⚡ Quick Start: Scan an Agent in 5 Seconds

Evaluate your agent's safety profile locally using `mc scan`. It reads your agent's tool definitions and cross-references them against the **Agent Incident Database** (a catalogue of 41 real, documented AI agent failures).

Run it on any directory containing tool definitions, agent source code (Python/JS/TS), or tools JSON:

```bash
npx @makerchecker/scan .
```

*Nothing leaves your machine.* It runs entirely offline and requires no configuration. Add `--fail-on CATASTROPHIC` to enforce this check in your CI/CD pipeline, or `--fix` to generate a ready-to-run governance scaffold from the findings. Detailed documentation is in [`packages/scan`](packages/scan/README.md).

---

## 🏛️ Core Architecture

MakerChecker is designed around two main components:

1. **`mc scan` (CLI):** A zero-dependency static analyzer to discover what tools your agent has access to, classify their risk, and generate either a deny-by-default policy (`mc-policy.json`) or a runnable governance scaffold (`--fix`).
2. **Governance Server (API & Console):** A self-hosted Fastify server backed by Postgres that intercepts agent tool-execution requests, evaluates them against policies, blocks unauthorized actions, routes high-risk tasks to humans for approval, and records an append-only, signed audit trail.

---

## 🚀 Quick Start: Governance Server

To spin up the self-hosted MakerChecker gateway, audit database, and admin console locally:

```bash
docker compose up
```

Postgres and the server will start on `localhost:3000`. The first boot seeds a fully functional pharmacovigilance (drug safety) demo and prints two API keys in the logs (copy both):
- **Admin Key:** Used by your agent's framework to authenticate runs.
- **Officer Key:** Used by a human reviewer to approve gated actions.

### Run a Gated Flow Example

```bash
export H='authorization: Bearer mk_...'         # Replace with DEMO ADMIN API KEY
export OFFICER='authorization: Bearer mk_...'   # Replace with DEMO OFFICER API KEY

# 1. Trigger the seeded flow (representing a drug safety case processor)
curl -X POST localhost:3000/api/flows/pv-icsr-processing/runs -H "$H" -H 'content-type: application/json' -d '{}'

# 2. Inspect the pending medical-review gate
curl localhost:3000/api/approvals -H "$H"

# 3. Try to self-approve the gate (rejected with 403 Forbidden)
curl -X POST localhost:3000/api/approvals/<id>/decision -H "$H" -H 'content-type: application/json' \
  -d '{"decision":"approved","reason":"self-approval attempt"}'

# 4. Approve the gate using the Officer Key (simulating a human reviewer)
curl -X POST localhost:3000/api/approvals/<id>/decision -H "$OFFICER" -H 'content-type: application/json' \
  -d '{"decision":"approved","reason":"Seriousness confirmed; file 15-day expedited ICSRs."}'

# 5. Verify the cryptographic audit chain
curl localhost:3000/api/audit/verify -H "$H"
```

Full local setup and instructions for running with live LLM models are in [docs/quickstart.md](docs/quickstart.md).

---

## 🛠️ Integration & SDKs

MakerChecker integrates seamlessly with your existing agent code. You open a proxy session and wrap your tool functions. Every call is checked against the policy engine before running:

```ts
import { createClient, governedTool, GovernanceDeniedError } from "@makerchecker/sdk";

const client = createClient({ baseUrl: "http://localhost:3000", apiKey: "mk_..." });
const { session } = await client.proxy.openSession({ label: "recon-run" });

const match = governedTool(
  client,
  session.id,
  "recon-preparer",   // Registered agent whose role grants are evaluated
  "txn-match@1",       // skillRef: name@version
  (input: { statement: unknown[]; ledger: unknown[] }) => matchTxns(input),
);

// Throws GovernanceDeniedError if the policy denies execution
await match({ statement, ledger });

await client.proxy.closeSession(session.id);
```

Available SDKs and connectors:
- **TypeScript SDK:** [`packages/sdk`](packages/sdk/README.md)
- **Python SDK:** [`packages/sdk-python`](packages/sdk-python/README.md)
- **LangChain Connector:** [`packages/connector-langchain`](packages/connector-langchain/README.md)
- **Claude Agent SDK Connector:** [`packages/connector-claude-agent`](packages/connector-claude-agent/README.md)

---

## 🔬 Seeded Demo Use Cases

The repository contains several runnable examples demonstrating how to secure complex agent workflows:

- **Pharmacovigilance Case Processing:** An agent triages adverse-event reports, but a medical reviewer must sign off before transmitting expedited 15-day regulatory reports. [examples/pv-icsr-processing](examples/pv-icsr-processing/README.md)
- **MDR Complaint Triage:** An agent triages medical device complaints, but a regulatory officer decides official reportability behind a gate before draft skeletons are generated. [examples/mdr-reportability-triage](examples/mdr-reportability-triage/README.md)
- **Oncology Patient Access:** An agent handles benefit matching, but is blocked from submitting copay enrollments without a human specialist signing. [examples/oncology-patient-access](examples/oncology-patient-access/README.md)
- **Daily Cash Reconciliation:** A financial agent processes transaction reconciliations, but locks up at exception gates until a cash officer reconciles discrepancies. [examples/daily-cash-reconciliation](examples/daily-cash-reconciliation/README.md)

---

## 🔒 Cryptographic Audit Chains

Every state transition and tool execution emits an audit event within the same database transaction. Each event's hash is SHA-256 over the RFC 8785 canonical JSON of the event, chained through `prev_hash` from a genesis event. 

You can verify the database's integrity locally or verify exported bundles offline:

```bash
# Verify against the running database
docker compose exec server node dist/cli.js audit verify

# Export a signed bundle, then verify it with no database
docker compose exec server node dist/cli.js audit export --out bundle.json
node dist/cli.js audit verify-bundle --in bundle.json
```

Detailed audit and cryptographic specifications are documented in [docs/audit-spec.md](docs/audit-spec.md).

---

## 🗂️ Packages in This Monorepo

| Package | License | Description |
|---|---|---|
| [`packages/scan`](packages/scan) | Apache-2.0 | Standalone `mc scan` static analyzer CLI. |
| [`packages/server`](packages/server) | AGPL-3.0 | Fastify API server, flow engine, and database schema. |
| [`packages/web`](packages/web) | AGPL-3.0 | React web application for approvals inbox, run log, and policy console. |
| [`packages/shared`](packages/shared) | AGPL-3.0 | Domain models, validation schemas, and cryptographic utilities. |
| [`packages/sdk`](packages/sdk) | Apache-2.0 | TypeScript SDK for direct integration or API access. |
| [`packages/sdk-python`](packages/sdk-python) | Apache-2.0 | Python SDK. |
| [`packages/connector-langchain`](packages/connector-langchain) | Apache-2.0 | Integration middleware for LangChain frameworks. |
| [`packages/connector-claude-agent`](packages/connector-claude-agent) | Apache-2.0 | Integration middleware for Anthropic's Claude Agent SDK. |

---

## 📄 License & Contributing

- **Server, Web, and Shared:** Licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE).
- **SDKs, Connectors, and Examples:** Licensed under the [Apache License 2.0](LICENSING.md) to support frictionless integration into commercial, closed-source agent frameworks.
- Commercial licensing is available for organisations requiring non-copyleft usage: contact hello@makerchecker.ai.

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Security: [SECURITY.md](SECURITY.md) · Code of Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) · Changelog: [CHANGELOG.md](CHANGELOG.md)
