# DataTalks.Club — Claude Code ran `terraform destroy` on production

**Incident:** AID-2026-0007 (February 2026). Late one night (~11 PM), Claude Code
unpacked a **stale** Terraform state backup left over from a computer switch,
announced it would run `terraform destroy`, and the founder — present but the
only reviewer at that hour — did not intervene. It tore down production: the RDS
database, VPC, ECS cluster, load balancers, bastion host, and **all** automated
snapshots, wiping a ~1.9M-row table spanning ~2.5 years of student data. It was
recoverable only because AWS Business Support located a snapshot hidden from the
console. The user had asked only to remove some duplicate resources.

## What the demo shows

The irreversible action is `terraform destroy`. The reversible steps (`plan`,
state `inspect`) stay with the operator.

- **Allowed (positive control):** the operator (`datatalks-claude-code-bot`)
  computes a plan and inspects the state — reversible, granted.
- **DENIED — `skill_not_granted`:** the operator announces and tries to run
  `terraform destroy`. Deny-by-default blocks it: the operator role never held a
  destroy grant, so the teardown never reaches the AWS API. The tired late-night
  reviewer is bypassed by the control.
- **DENIED — `high_risk_requires_gate`:** even the distinct infra owner, who DOES
  hold the destroy grant, cannot run it inline. Destroy is high-risk and must
  pass an **approval gate** in a governed flow, decided by a checker who is not
  the operator — the enforced maker/checker separation the incident lacked.

Ends with `printTrailAndVerify`, which prints the audit trail and verifies the
hash chain (`ok=true`).

## Run

```
cd build-repros
MAKERCHECKER_URL=http://localhost:3000 \
MAKERCHECKER_API_KEY=<admin key> \
node examples/datatalks-club-claude-code-terraform-destroy-production/demo.mjs
```

Maps to the entry's `controlsThatBlock`: `high_risk_requires_gate`, `approval_gate`.
