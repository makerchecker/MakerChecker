# Dutch childcare benefits scandal / Toeslagenaffaire (AID-2021-0001)

Between roughly 2005 and 2019 the Dutch Tax Administration (Belastingdienst) ran
a fraud-risk classification method that used (dual) nationality as a risk
indicator and an "80/20" fraud-assumption, then issued and enforced repayment
demands that wrongly branded about 26,000 families as fraudsters. The Dutch DPA
ruled the methods unlawful and discriminatory (2020) and issued a record 2.75M
euro fine (2021). There was no independent checker and no bar on the
discriminatory input, so systematic error scaled for years.

## What this repro shows

A proxy-governed reproduction (no flow engine) with two controls:

- **Deny-by-default as a hard bar on the discriminatory input.** The skill
  `toeslagen-nationality-flag@1` (raising a score using nationality) is granted
  to no role, so the risk bot's attempt is refused with `skill_not_granted`
  before it can touch a case. The scoring role also holds no enforcement grant,
  so it cannot bill a family off its own score.
- **High-risk requires an approval gate.** Issuing a repayment demand
  (`toeslagen-repayment-demand-commit@1`) is the irreversible step, published
  `high` risk. Even the granted enforcement office cannot run it inline on the
  proxy — it is categorically refused and must pass an independent approval gate
  (`high_risk_requires_gate` / `approval_gate`).

A legitimate, reversible action (scoring on lawful criteria, retrieving a case
file for human review) is **allowed**, proving the controls are selective.

## Run

```
cd build-repros
MAKERCHECKER_URL=http://localhost:3000 \
MAKERCHECKER_API_KEY=<admin key> \
node examples/dutch-childcare-benefits-scandal-toeslagenaffaire/demo.mjs
```

Ends by printing the audit trail and verifying the hash chain (`ok=true`).
