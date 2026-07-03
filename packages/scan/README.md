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

## Run it in CI

Fail the build the moment your agent gains a `CATASTROPHIC` capability that no gate protects. Copy [`.github-workflow-template.yml`](./.github-workflow-template.yml) to `.github/workflows/mc-scan.yml`, or add the composite action directly:

```yaml
# .github/workflows/mc-scan.yml
name: mc scan
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
          path: .                 # your tool/function definitions
          fail-on: CATASTROPHIC   # exit non-zero on ungoverned catastrophic tools
```

No install and nothing to configure — the action runs the same `npx @makerchecker/scan` you run locally, read-only, on the runner. Prefer no action at all? One line works:

```yaml
- run: npx --yes @makerchecker/scan . --fail-on CATASTROPHIC
```

The job also writes a shareable Markdown results card to the GitHub Step Summary. To turn a red build green, generate a deny-by-default policy and commit it:

```bash
npx @makerchecker/scan init .   # writes mc-policy.json
```

Every irreversible tool starts gated. The scan reads that file and shows those tools as governed (green); the self-hosted [MakerChecker](https://github.com/sammysltd/makerchecker) engine enforces the *exact same file* in production. One file is both your scan config and your governance policy.

## The status badge (opt-in)

Once the workflow above is green on your default branch, add a badge that says your agent has **zero ungoverned catastrophic capabilities**. It is opt-in and driven entirely by your own CI run — there is no MakerChecker server involved, nothing phones home, and the badge only turns green when *your* `mc scan` job passes.

Markdown:

```markdown
[![mc scan: 0 CATASTROPHIC](https://github.com/OWNER/REPO/actions/workflows/mc-scan.yml/badge.svg?branch=main)](https://github.com/OWNER/REPO/actions/workflows/mc-scan.yml)
```

Replace `OWNER/REPO` with your repository. The badge is GitHub's native workflow-status badge for the `mc scan` job: green means the latest run found no `CATASTROPHIC`, ungoverned tool (i.e. every irreversible action is gated by an `mc-policy.json` entry); red means one slipped in. It is a claim you can back — the run log shows exactly which tools were scanned and which incident each resembles.
