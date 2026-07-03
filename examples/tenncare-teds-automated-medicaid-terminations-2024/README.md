# TennCare Connect / TEDS automated Medicaid terminations (AID-2024-0004)

Tennessee's $400M+ automated Medicaid eligibility system (TEDS, built by Deloitte,
launched 2019) made and executed coverage determinations, wrongfully terminating or
denying benefits for tens of thousands of low-income adults, children, and people
with disabilities. Programming errors placed enrollees in the wrong households,
failed to load eligibility data (SSA receipt, disability status, marital status),
sent renewal notices to wrong addresses, and generated deficient termination
notices — with no independent human check before coverage was cut. In
A.M.C. v. Smith (M.D. Tenn., Aug 26 2024) a federal court ruled the program
violated the Medicaid Act, the Fourteenth Amendment's Due Process Clause, and the
ADA.

## What the demo shows

The irreversible action is committing a coverage termination. The controls:

- **skill_not_granted (deny-by-default):** the automated `tenncare-teds-system`
  role holds no terminate grant, so the system cannot self-execute a termination on
  its own defective determination — the call never cuts anyone's coverage.
- **high_risk_requires_gate / approval_gate:** even the human
  `tenncare-eligibility-caseworker` role, which *does* hold the terminate grant, is
  refused inline because `tenncare-coverage-terminate-commit@1` is published
  high-risk. A termination only proceeds through a governed flow with a preceding
  approval gate, where an independent checker verifies the household assignment,
  the loaded eligibility data, and the adequacy of the notice before benefits end.
  That is exactly the fair-hearing / independent-review safeguard the court found
  was missing.

Positive control: evaluating eligibility and drafting the determination notice are
reversible and stay granted to the TEDS role, so those steps are allowed.

## Run

```
cd build-repros
MAKERCHECKER_URL=http://localhost:3000 \
MAKERCHECKER_API_KEY=<admin-key> \
node examples/tenncare-teds-automated-medicaid-terminations-2024/demo.mjs
```

The demo ends by printing the audit trail and verifying the hash chain (`ok=true`).
