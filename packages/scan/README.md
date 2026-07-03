# mc scan

See what your AI agent can do that you can't undo, in 60 seconds, named against the real disaster it resembles.

```bash
npx @makerchecker/scan <path>
```

`<path>` is a JSON file of your agent's tool/function definitions, or a directory to search. It reads OpenAI function/tools schemas, MCP `tools/list` output, and bare `{ name, description, parameters }` arrays.

It runs read-only. No signup, no server, no telemetry. Nothing leaves your machine, and the source is right here.

## What it does

It classifies every tool your agent exposes by whether the action can be undone and how wide the blast radius is, then cross-references the [Agent Incident Database](../../incidents): 41 real, sourced, reproduced AI-agent disasters. Every finding names the actual incident your setup resembles, not a generic warning.

A `CATASTROPHIC` finding is an irreversible action with a wide blast radius: deleting data, moving money, committing a binding decision. The fix is a deny-by-default gate, which the paid, self-hosted [MakerChecker](https://github.com/sammysltd/makerchecker) enforces in production with an audit a regulator can verify.

## What it won't catch

It reads tool definitions, not your live runtime policy. It does not find prompt-injection in your data or logic bugs. It finds the actions your agent CAN take that it cannot take back, which is the thing most teams have never actually looked at.
