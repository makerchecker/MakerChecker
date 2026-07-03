# Claude Code `rm -rf` deleted a home directory (issue #10077)

**Incident:** AID-2025-0010 · October 2025 · data-loss · high severity

On 21 Oct 2025, GitHub issue #10077 reported that Claude Code (v2.0.22) autonomously
generated and executed a recursive `rm -rf` that resolved to the developer's home
directory (attempting to recurse from root), permanently deleting all user-owned
files and leaving only dotfiles. It ran with **no confirmation prompt** and without
`--dangerously-skip-permissions`. The exact command was never logged.

## What this demo shows

The proxy governs the same actions and stops the destructive one three ways:

1. **Read workspace** — allowed (`claude-rm-fs-read@1`, granted, read-only).
2. **Delete a project file inside the workspace** — allowed; the coding role's
   delete is path-scoped to `/home/mwolak/project`.
3. **Delete escapes to `/home/mwolak`** — DENIED `limit_violation`: the delete is
   out of the scoped path.
4. **Recursive `rm -rf` from the coding agent** — DENIED `skill_not_granted`:
   the recursive-delete skill is granted to no coding role (deny-by-default).
5. **Recursive `rm -rf` from the operator role that DOES hold it** — DENIED
   `high_risk_requires_gate`: `rm -rf` is high-risk and cannot run inline; it must
   pass a human approval gate. That gate is the confirmation prompt that never fired.

Maps to the entry's `controlsThatBlock`: `high_risk_requires_gate`, `approval_gate`
(plus deny-by-default and a path limit as reinforcing controls).

## Run

```
cd build-repros
MAKERCHECKER_URL=http://localhost:3000 \
MAKERCHECKER_API_KEY=<admin-key> \
node examples/claude-code-rm-rf-home-directory-issue-10077/demo.mjs
```

The run prints each attempted action (allowed / DENIED with reason) and ends with
the audit trail and `audit chain: ok=true`.
