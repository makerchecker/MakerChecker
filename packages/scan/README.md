<div align="center">

# 🔍 mc scan

### Find what your AI agent can do on its own — before anyone can stop it.

`mc scan` reads your agent's tools and source code, classifies every action by its risk, and generates the governance code to lock it down. Zero dependencies, fully offline.

[![npm](https://img.shields.io/npm/v/@makerchecker/scan?color=cb3837&logo=npm)](https://www.npmjs.com/package/@makerchecker/scan)
[![License](https://img.shields.io/badge/license-Apache--2.0-informational)](../../LICENSING.md)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![Offline](https://img.shields.io/badge/telemetry-none-brightgreen)](#)

</div>

> [!TIP]
> **Run it now** — no install, no signup, nothing leaves your machine:
> ```bash
> npx @makerchecker/scan .
> ```

Point it at a JSON file of your agent's tool/function definitions or a whole directory. It reads OpenAI function/tools schemas, Model Context Protocol (MCP) `tools/list` output, and agent **source code** in Python, JavaScript, and TypeScript — LangChain `@tool` decorators, MCP `server.tool()` registrations, and Vercel AI SDK / Genkit `tool({ ... })` definitions. Read-only, offline, no telemetry.

---

## 🔍 How It Works

`mc scan` parses your agent's tools and classifies each capability by risk profile. It then checks these capabilities against the [Agent Incident Database](../../incidents)—a database of 41 real, documented AI agent failures (e.g., data loss, runaway execution, unauthorized financial transactions).

- **CATASTROPHIC:** Actions that cause irreversible harm (e.g., deleting databases, executing arbitrary code, moving funds or on-chain value).
- **HIGH / MEDIUM:** Actions with significant but bounded impact (e.g., sending emails, writing to files, querying databases).

Beyond individual tools, `mc scan` also flags **composition risks** — capabilities that are safe alone but lethal together. A tool that reads untrusted content (a webpage, an inbox, an IPFS document) paired with one that runs a shell command is a remote-code-execution channel; paired with one that moves money or places orders, it is a drain; a sensitive reader paired with an external sender is a zero-click exfiltration path. Each pair is named against the real incident it resembles.

To resolve findings and secure your agent, you can generate a deny-by-default policy file:

```bash
npx @makerchecker/scan init .   # generates mc-policy.json
```

Once a tool is explicitly mapped to a policy rule in `mc-policy.json`, `mc scan` recognizes it as governed. This same configuration file can be ingested by the self-hosted [MakerChecker server](../../README.md) to enforce role-based gates in production.

---

## 🔧 Generate Governance with `--fix`

`init` writes a policy; `--fix` writes the code. It generates a ready-to-run governance scaffold built on the [`@makerchecker/embedded`](../embedded) primitives, tailored to exactly what the scan flagged:

```bash
npx @makerchecker/scan . --fix   # writes mc-governance.mjs
```

The generated module encodes the fix directly: **deny-by-default**, every high-risk capability held by a separate `risk-desk` role (so the agent structurally cannot approve its own dangerous call), and each composition pair enforced as a role conflict so no single role holds both halves of an exfiltration or RCE channel. Install the runtime, replace each executor placeholder with your real tool, and call the governed wrappers instead of the raw ones:

```bash
npm i @makerchecker/embedded
```

A call the agent was not granted is denied before any side effect (`skill_not_granted`); a high-risk call additionally needs a preceding gate decided by a separate party. It is the same enforcement engine the self-hosted [MakerChecker server](../../README.md) runs in production.

---

## 🛠️ CI/CD Integration

You can easily gate pull requests or builds if a new, ungoverned catastrophic capability is introduced:

```bash
npx @makerchecker/scan . --fail-on CATASTROPHIC
```

### GitHub Actions Workflow

Add the composite action directly to your workflow:

```yaml
# .github/workflows/mc-scan.yml
name: mc-scan
on: [push, pull_request]
permissions:
  contents: read
jobs:
  mc-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: makerchecker/scan@v0
        with:
          path: .
          fail-on: CATASTROPHIC
```

Alternatively, run it via a single-line shell step:

```yaml
- run: npx --yes @makerchecker/scan . --fail-on CATASTROPHIC
```

The action generates a clean Markdown summary card in your GitHub step overview.

---

## 🧠 Optional `--llm` Deep Scan (Opt-in)

While the default scan is deterministic and local, you can opt-in to `--llm` mode to perform semantic analysis on ambiguous tool definitions or source files.

- **Tool Re-ranking (Mode A):** Uses an LLM to evaluate ambiguously named tools that static signatures might miss or misclassify. It can escalate risk severity but will *never* lower a deterministic static rating.
- **Source Code Scanner (Mode B):** Scans actual function code to locate latent capabilities that are not formally exposed as schema tools (e.g., helper functions or wrappers). It strictly requires the model to quote exact line numbers and match them against verifiable calls.

### Configuration & Providers

The `--llm` scan supports Anthropic, OpenAI, OpenRouter, Together, Groq, Ollama, and any OpenAI-compatible endpoint. Provider, model, and key are all configurable (via flag, environment variable, or the `mc-policy.json` `llm` block), and pointing it at a local Ollama keeps the analysis fully private:

```bash
# Anthropic (Default)
export ANTHROPIC_API_KEY=sk-...
npx @makerchecker/scan . --llm

# OpenAI
export OPENAI_API_KEY=sk-...
npx @makerchecker/scan . --llm --llm-provider openai --llm-model gpt-4o-mini

# Fully local/private with Ollama
ollama pull qwen2.5-coder:7b
npx @makerchecker/scan . --llm --llm-provider ollama
```

A cloud run prints a one-line notice of where data is being sent before it starts; a local provider (`--llm-provider ollama`) sends nothing off your machine.

*Note: LLM-assessed findings are non-deterministic, so they never affect the `--fail-on` exit-code gate — a run with and without `--llm` returns the same exit code, so CI never goes flaky.*

---

## 📈 Status Badge (Opt-in)

Once your CI workflow is green on your default branch, you can add a status badge to your repository's README to show your agent's governance status:

```markdown
[![mc scan: certified](https://github.com/OWNER/REPO/actions/workflows/mc-scan.yml/badge.svg?branch=main)](https://github.com/OWNER/REPO/actions/workflows/mc-scan.yml)
```
