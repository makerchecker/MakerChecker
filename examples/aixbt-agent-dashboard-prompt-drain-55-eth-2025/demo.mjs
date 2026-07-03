#!/usr/bin/env node
// aixbt agent dashboard prompt drain (18 March 2025): an attacker who reached
// the authenticated dashboard of the aixbt autonomous crypto agent queued two
// fraudulent prompts. The agent executed them and moved 55.5 ETH (~$104k-$106k)
// out of its Simulacrum wallet to an attacker address; the funds were never
// recovered. The dashboard was one surface that could both propose AND settle a
// transfer, so a credential compromise turned straight into an on-chain drain.
//
// The control that stops it: analyzing markets and drafting/queuing a transfer
// proposal are reversible and stay with the dashboard-driven agent. Settling the
// on-chain transfer is the irreversible action. The dashboard agent holds NO
// settle grant (deny-by-default), so attacker-queued prompts can propose but
// never execute — maker and checker are split (sod_violation is refused). And the
// on-chain settle skill is published high-risk, so even the separate treasury
// signer cannot fire it inline: it must run through a governed flow behind an
// approval gate where a human can reject a transfer to an unknown address.
//
// Names are prefixed `aixbt-` so this demo does not collide with other incident
// demos sharing the server.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/aixbt-agent-dashboard-prompt-drain-55-eth-2025/demo.mjs
import {
  connect,
  ensureSkill,
  ensureRole,
  ensureAgent,
  ensureGrant,
  governedTool,
  GovernanceDeniedError,
  printTrailAndVerify,
} from "../lib/scenario.mjs";

const client = connect();

// --- Configure MakerChecker for the scenario -------------------------------
const analyze = await ensureSkill(client, "aixbt-market-analyze@1", {
  description: "Read market data and social signals; produces analysis, moves no funds.",
});
const propose = await ensureSkill(client, "aixbt-transfer-propose@1", {
  description: "Queue a proposed outbound transfer (the maker step); settles nothing on-chain.",
});
const settle = await ensureSkill(client, "aixbt-wallet-settle@1", {
  riskTier: "high",
  description: "Execute an on-chain transfer out of the Simulacrum wallet (irreversible).",
});

// The dashboard-driven agent analyzes markets and can queue transfer proposals,
// but holds NO settle grant — attacker-queued prompts can propose a transfer,
// yet the agent that took the prompt cannot also settle it on-chain.
const dashboardRole = await ensureRole(client, "aixbt-dashboard-agent", {
  description: "Executes dashboard prompts: analyzes markets and queues transfer proposals; cannot settle on-chain.",
});
// The treasury signer is the separate checker granted the settle skill. Settling
// is high-risk, so even with the grant it is refused on the proxy and must run
// through a governed flow with a preceding approval gate.
const signerRole = await ensureRole(client, "aixbt-treasury-signer", {
  description: "Settles approved transfers, only through a gated flow with a human checker.",
});

await ensureGrant(client, dashboardRole, analyze);
await ensureGrant(client, dashboardRole, propose);
await ensureGrant(client, signerRole, settle);

await ensureAgent(client, "aixbt-dashboard-bot", "aixbt-dashboard-agent");
await ensureAgent(client, "aixbt-signer-bot", "aixbt-treasury-signer");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "aixbt-dashboard-prompt-drain" });
console.log(`proxy session ${session.id} opened\n`);

const analyzeMarket = governedTool(client, session.id, "aixbt-dashboard-bot", "aixbt-market-analyze@1", async (i) => ({ pair: i.pair, signal: "neutral" }));
const proposeTransfer = governedTool(client, session.id, "aixbt-dashboard-bot", "aixbt-transfer-propose@1", async (i) => ({ to: i.to, eth: i.eth, status: "queued" }));
const dashboardSettle = governedTool(client, session.id, "aixbt-dashboard-bot", "aixbt-wallet-settle@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const signerSettle = governedTool(client, session.id, "aixbt-signer-bot", "aixbt-wallet-settle@1", async () => { throw new Error("unreachable: high-risk is refused on the proxy"); });

// 1. The agent analyzes the market from a dashboard prompt — allowed.
console.log("agent analyzes market:", JSON.stringify(await analyzeMarket({ pair: "ETH/USD" })));

// 2. A dashboard prompt queues a transfer proposal — allowed; reversible maker
//    step, nothing settles on-chain, a checker can still reject it.
console.log("agent queues transfer proposal:", JSON.stringify(await proposeTransfer({ to: "0xFungusMan", eth: 55.5 })));

// 3. The attacker's queued prompt tells the agent to settle the 55.5 ETH
//    on-chain — DENIED by default; the dashboard role holds no settle grant, so
//    the drain never reaches the wallet. Maker cannot also be the checker.
try {
  await dashboardSettle({ to: "0xFungusMan", eth: 55.5 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`attacker-prompted settle DENIED (${err.code}): ${err.reason}`);
}

// 4. Even the treasury signer, which holds the grant, cannot settle inline: the
//    skill is high-risk and must run through a governed flow with a preceding
//    approval gate, where a human can reject a transfer to an unknown address.
try {
  await signerSettle({ to: "0xFungusMan", eth: 55.5 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`signer inline settle DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
