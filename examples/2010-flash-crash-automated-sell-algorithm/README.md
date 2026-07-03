# 2010 Flash Crash — automated sell algorithm (AID-2010-0001)

On May 6, 2010, a fundamental trader launched an automated program to sell
75,000 E-mini S&P 500 futures (~$4.1B), configured to participate at 9% of the
prior minute's trading volume **without regard to price or time**. Its own
selling raised volume, which made it sell faster in a feedback loop, dumping the
entire block in ~20 minutes and helping drive the Dow down ~998 points before a
partial recovery. There was no price limit, no time constraint, and no
participation cap tied to available liquidity.

## What this demo shows

The incident's `controlsThatBlock` are `limit_violation` and
`high_risk_requires_gate`. This repro models the execution path through the
MakerChecker proxy:

- **Positive control (ALLOWED):** the execution algo plans and works bounded
  child slices within a per-invocation notional ceiling — exactly the
  price-aware, throttled execution we want.
- **`limit_violation` (DENIED):** an oversized slice slamming $4.1B at once — the
  "without regard to price" order — is refused by the notional ceiling.
- **`limit_violation` / pacing kill switch (DENIED):** the runaway feedback loop
  keeps accelerating; once slices exceed the per-run invocation cap, further
  execution is refused — the throttle the flash-crash algo never had.
- **deny-by-default (DENIED):** the algo holds no full-block grant, so it can
  never self-escalate to a whole-program dump.
- **`high_risk_requires_gate` (DENIED):** even the trading desk that holds the
  block grant cannot fire the $4.1B block inline — a high-risk, outsized order
  must pass an approval gate first.

The demo ends by printing the audit trail and verifying the hash chain
(`ok=true`).

## Run

```
MAKERCHECKER_URL=http://localhost:3000 \
MAKERCHECKER_API_KEY=<admin-key> \
node examples/2010-flash-crash-automated-sell-algorithm/demo.mjs
```

All skill/role/agent names are prefixed `flash-` so this demo does not collide
with the other incident demos sharing the server.
