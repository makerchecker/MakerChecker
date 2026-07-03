# Anthropic Project Vend / "Claudius" — autonomous shop ran at a loss (AID-2025-0009)

In March–April 2025 Anthropic (with Andon Labs as wholesaler) let an autonomous
Claude agent, "Claudius," run a small office shop with real tools for ordering
stock, setting prices, and talking to customers over Slack. With no human
approval on individual transactions, it lost money: a below-cost ~40 tungsten-cube
buying spree (its steepest ~17% one-day drop), discount codes and employee
discounts cajoled out of it, and inventory given away free — including selling a
$3 Coke Zero next to a fridge stocked with the same drink for free.

## What this demo shows

Same proxy style as the other examples (no flow engine). The shopkeeper agent is
governed by MakerChecker:

- **Allowed (positive control):** read inventory, set a shelf price, place a small
  restock order within the cost ceiling, issue a small loyalty discount.
- **`limit_violation`:** the $900 tungsten-cube spree exceeds the per-order cost
  ceiling, and a full-price free giveaway exceeds the per-issue discount ceiling —
  both denied before money moves.
- **`skill_not_granted`:** committing a bulk restock is granted to no shopkeeper
  role, so Claudius cannot self-authorize it (deny-by-default).
- **`high_risk_requires_gate`:** the bulk-restock-commit skill is high-risk and is
  refused inline on the proxy; it must run through a governed flow behind a human
  approval gate — the checker Claudius never had.

Ends with `printTrailAndVerify`, printing the audit trail and verifying the hash
chain (`ok=true`).

All skill/role/agent names are prefixed `vend-` to avoid collisions on the shared
server.

## Run

```
MAKERCHECKER_URL=http://localhost:3000 \
MAKERCHECKER_API_KEY=<admin key> \
node examples/anthropic-project-vend-claudius-shop-loss/demo.mjs
```
