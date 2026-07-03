# Michigan MiDAS false unemployment fraud determinations (2013-2015)

**Incident:** AID-2015-0002. Michigan's MiDAS (Michigan Integrated Data
Automated System) auto-adjudicated unemployment-insurance fraud determinations
with little or no human review. It treated any data discrepancy as fraud (e.g.
averaging income across a period instead of reading individual paychecks),
falsely accusing roughly 40,000 people. A later Auditor General review of about
22,000 determinations found roughly 93% involved no actual fraud. The state
seized tax refunds, garnished wages, and imposed penalties up to 400% of the
alleged overpayment before people could challenge them. Bauserman v. State of
Michigan ended in a $20M class settlement granted final approval Jan 30, 2024.

## What the demo shows

A governed proxy session with two agents:

- **midas-adjudicator-bot** (`midas-auto-adjudicator-role`) — the automated
  system. Granted `midas-claim-review@1` and `midas-case-file-build@1` only.
- **midas-checker-bot** (`midas-human-checker-role`) — holds
  `midas-fraud-determination-commit@1` (a high-risk skill).

Actions and outcomes:

1. Adjudicator reviews the claim (reads the actual paychecks) — **allowed**.
2. Adjudicator assembles the case file — **allowed**.
3. Adjudicator tries to **auto-issue** the fraud determination — **DENIED**
   (`skill_not_granted`): the automated role was never granted the determination
   skill. This is the auto-adjudication at the heart of the incident.
4. Adjudicator tries to garnish wages / seize the refund — **DENIED**
   (`skill_not_granted`): `midas-collection-seize@1` is granted to no role.
5. The human checker, who *does* hold the determination grant, tries to fire it
   inline — **DENIED** (`high_risk_requires_gate`): a high-risk determination
   must pass an approval gate, forcing individual human adjudication with the
   paycheck records in view.

Controls mapped from the entry: `high_risk_requires_gate` and `approval_gate`
(shown via the high-risk inline refusal), plus deny-by-default
(`skill_not_granted`) for the automated system's ungranted actions.

## Run

```
cd build-repros
MAKERCHECKER_URL=http://localhost:3000 \
MAKERCHECKER_API_KEY=mk_... \
node examples/michigan-midas-false-unemployment-fraud-2015/demo.mjs
```

Ends with `printTrailAndVerify`, which prints the audit trail and verifies the
hash chain (`ok=true`).
