# Wadsworth v. Walmart — AI-fabricated case citations filed (AID-2025-0014)

In February 2025, Morgan & Morgan attorneys filed a motion in limine in
*Wadsworth v. Walmart Inc.* (No. 2:23-CV-118-KHR, D. Wyo.) that cited nine cases,
eight of which had been fabricated by the firm's in-house AI platform, MX2.law. The
drafting attorney relied on the AI research without confirming the cases existed,
and the supervising attorney and local counsel signed and filed the motion without
independently verifying the citations. Judge Rankin sanctioned three attorneys and
revoked one attorney's pro hac vice admission.

## What the demo shows

Modeled in the proxy style (no flow engine), with names prefixed `wadsworth-`:

- **Drafting** the motion and **verifying** citations are reversible and stay with
  the `wadsworth-drafting-attorney` role — both ALLOWED (positive control).
- **Filing to the docket** is the irreversible action. The drafter holds no filing
  grant, so its attempt is DENIED by deny-by-default (`skill_not_granted`).
- Filing is published **high-risk**, so even the `wadsworth-supervising-attorney`
  who holds the grant is DENIED a direct call (`high_risk_requires_gate`): filing
  must run behind an approval gate — the citation-verification checker step the
  nominal checkers skipped.

The run ends by printing the audit trail and verifying the hash chain (`ok=true`).

## Run

```
cd build-repros
MAKERCHECKER_URL=http://localhost:3000 \
MAKERCHECKER_API_KEY=mk_... \
node examples/wadsworth-v-walmart-ai-fabricated-citations/demo.mjs
```
