# aixbt agent dashboard prompt drain — 55.5 ETH (2025)

**Incident AID-2025-0007.** On 18 March 2025 an attacker reached the
authenticated dashboard of the aixbt autonomous crypto agent and queued two
fraudulent prompts. The agent executed them and transferred 55.5 ETH
(~$104k–$106k) out of its Simulacrum wallet to an attacker address. The funds
were never recovered. The dashboard was a single surface that could both propose
and settle a transfer, so a credential compromise turned directly into an
on-chain drain.

## What the demo shows

Two governed agents run through the MakerChecker proxy:

- **`aixbt-dashboard-bot`** (role `aixbt-dashboard-agent`) executes dashboard
  prompts: it may analyze markets and queue transfer *proposals*, but holds no
  grant to settle on-chain.
- **`aixbt-signer-bot`** (role `aixbt-treasury-signer`) is the separate checker
  that holds the settle grant.

Actions:

1. Analyze market — **allowed** (positive control).
2. Queue a transfer proposal — **allowed** (reversible maker step).
3. Attacker-prompted on-chain settle by the dashboard agent — **DENIED**
   `skill_not_granted` (deny-by-default; maker cannot also be the checker —
   models the `sod_violation` control).
4. Even the granted treasury signer settling inline — **DENIED**
   `high_risk_requires_gate` (the settle skill is high-risk; it must run behind
   an approval gate — models the `approval_gate` control).

The run ends by printing the audit trail and verifying the hash chain
(`ok=true`).

## Run

```
cd examples/../..  # repo root
MAKERCHECKER_URL=http://localhost:3000 \
MAKERCHECKER_API_KEY=<admin key> \
node examples/aixbt-agent-dashboard-prompt-drain-55-eth-2025/demo.mjs
```
