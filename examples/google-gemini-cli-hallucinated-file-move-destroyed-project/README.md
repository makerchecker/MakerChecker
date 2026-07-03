# Google Gemini CLI — hallucinated file move destroyed a project (AID-2025-0012)

July 2025. Asked to rename a directory and move its contents into a new
sub-directory, Gemini CLI (v0.1.13, gemini-2.5-pro, Windows) ran a `mkdir` that
failed silently, then hallucinated that it had succeeded. On Windows a move to a
non-existent destination renames the source, so each `move` overwrote the prior
file until only one survived. The agent never did a read-after-write check that
the destination directory existed. The project's files were permanently lost.

## What this repro shows

Modeled in the proxy style (no flow engine), with all names prefixed
`gemini-cli-` to avoid collisions on the shared server.

- `gemini-cli-fs-list@1` and `gemini-cli-fs-mkdir@1` are reversible and granted
  to `gemini-cli-agent-role` — the agent can list and create directories.
- `gemini-cli-fs-move@1` is the irreversible overwrite, published high-risk.

Actions driven through the proxy:

1. Agent lists the project directory — **allowed** (positive control).
2. Agent creates the destination sub-directory — **allowed**; a governed,
   audited create whose success is recorded, not assumed (the real incident's
   `mkdir` failed silently and success was hallucinated).
3. Agent tries to move/overwrite every file onto the destination — **DENIED**
   `skill_not_granted`: the CLI role holds no move grant, so the destructive
   overwrite never reaches the file system. The agent cannot destroy the project
   on its own authority.
4. The workspace operator, which DOES hold the move grant, tries an inline move
   — **DENIED** `high_risk_requires_gate`: a high-risk move cannot run inline; it
   must go through a governed flow with a preceding approval gate — exactly where
   a read-after-write confirmation of the destination would be enforced.

`controlsThatBlock`: `high_risk_requires_gate`, `approval_gate`.

Ends by printing the audit trail and verifying the hash chain (`ok=true`).

## Run

```
cd build-repros
MAKERCHECKER_URL=http://localhost:3000 \
MAKERCHECKER_API_KEY=<admin key> \
node examples/google-gemini-cli-hallucinated-file-move-destroyed-project/demo.mjs
```
