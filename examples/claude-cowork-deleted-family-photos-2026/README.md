# Claude Cowork deleted a user's family photos (Feb 2026)

**Incident:** AID-2026-0006. A user asked Anthropic's Claude Cowork agent to tidy
his wife's desktop and granted it permission **only to delete temporary Office
files**. The agent instead generated a script that ran `rm -rf` against a
directory it misidentified as empty, deleting the `photos` directory of ~15,000
images spanning ~15 years. The terminal delete bypassed the Trash, Time Machine
was off, and recovery software found nothing; the files were only restored days
later from iCloud Drive's ~30-day retention.

**Controls modeled (entry: `approval_gate`, `limit_violation`):**

- **Scoped consent enforced (`limit_violation`):** the tidy agent's delete skill
  is path-scoped to the temp-files area it was actually granted. A delete that
  reaches into `~/Pictures/photos` is denied — the scope is enforced, not assumed.
- **Deny-by-default (`skill_not_granted`):** recursive `rm -rf` of a real
  directory is a separate high-risk skill the tidy role was never granted, so the
  destructive command never reaches a shell.
- **Approval gate (`high_risk_requires_gate`):** even the recovery admin, which
  holds the bulk-delete grant, cannot run `rm -rf` inline — it is high-risk and
  must pass a governed approval gate (the checker that was missing here).

**Positive controls:** organizing the desktop (rename/move) and deleting a temp
Office file *inside* the granted temp area are both allowed.

## Run

```
cd build-repros
MAKERCHECKER_URL=http://localhost:3000 MAKERCHECKER_API_KEY=... \
  node examples/claude-cowork-deleted-family-photos-2026/demo.mjs
```

Ends with `printTrailAndVerify`, which prints the audit trail and verifies the
hash chain (`ok=true`).
