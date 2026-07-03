# Freysa AI agent tricked into releasing $47K prize pool (2024)

**Incident:** AID-2024-0003 · November 2024 · unauthorized-financial-action

Freysa was an autonomous on-chain AI agent on Base, billed as the "first
adversarial agent game." It held a ~13.19 ETH ($47,316) prize pool and was
hard-coded never to send its funds. Players paid a query fee to message it and
try to persuade it to release the pool. On attempt #482, the user `p0pular.eth`
reframed the agent's `approveTransfer` function as handling *incoming* rather
than *outgoing* payments, announced a fake ~$100 donation, and the agent invoked
`approveTransfer` and broadcast its entire balance on-chain to the attacker. The
transfer was final and irreversible.

The root failure: **one actor both decided and executed the payout.** The same
agent that could be talked into releasing funds also held sole authority to sign
and broadcast the transfer, with no independent second control.

## What this demo shows

Maker-checker separates *deciding* from *executing*:

- `freysa-message-score@1` / `freysa-pool-balance-read@1` — reversible reads the
  game agent holds. **Allowed.**
- `freysa-prize-release@1` — the irreversible on-chain transfer, published
  high-risk.
  - The **game agent holds no release grant**, so even a prompt-injected,
    fully-persuaded agent cannot sign its own payout → **DENIED
    (`skill_not_granted`)** — the separation of duties (`sod_violation`) the game
    deliberately lacked.
  - Even the **treasury approver**, which *does* hold the grant, cannot release
    inline: a high-risk release must pass an **approval gate** → **DENIED
    (`high_risk_requires_gate`)**, matching the entry's `approval_gate` control.

The demo ends by printing the audit trail and verifying the hash chain
(`ok=true`).

## Run

```
cd scratchpad/build-repros
MAKERCHECKER_URL=http://localhost:3000 \
MAKERCHECKER_API_KEY=mk_... \
node examples/freysa-ai-agent-tricked-releasing-47k-prize-2024/demo.mjs
```
