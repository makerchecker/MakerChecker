#!/usr/bin/env node
// Freysa (Nov 2024): an autonomous on-chain AI agent held a ~13.19 ETH ($47,316)
// prize pool and was hard-coded never to send its funds. A user paid to message
// the agent, reframed its approveTransfer function as handling *incoming* rather
// than *outgoing* payments, announced a fake donation, and the same agent that
// was persuaded then signed and broadcast the irreversible transfer of its entire
// balance to the attacker. One actor both decided and executed the payout.
//
// The control that stops it: reading messages, scoring persuasion, and reading
// the pool balance are reversible and stay with the game agent. Releasing the
// prize is the irreversible on-chain action, published high-risk. The game agent
// holds NO release grant (deny-by-default — the separation of duties the game
// deliberately lacked), so a prompt-injected agent cannot sign its own payout.
// And even the treasury approver, which DOES hold the release grant, cannot run
// it inline on the proxy: a high-risk release must pass an approval gate, never
// fire straight from natural-language input.
//
// Names are prefixed `freysa-` so this demo does not collide with other incident
// demos sharing the server.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/freysa-ai-agent-tricked-releasing-47k-prize-2024/demo.mjs
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
const scoreMessage = await ensureSkill(client, "freysa-message-score@1", {
  description: "Read a player's paid message and score its persuasion; decides nothing on-chain",
});
const readBalance = await ensureSkill(client, "freysa-pool-balance-read@1", {
  description: "Read the current prize-pool balance; reversible, moves no funds",
});
const releasePrize = await ensureSkill(client, "freysa-prize-release@1", {
  riskTier: "high",
  description: "Sign and broadcast the on-chain transfer of the prize pool (irreversible)",
});

// The autonomous game agent reads and scores messages and reads the pool, but
// holds NO release grant — the separation of duties the adversarial game lacked.
// A persuaded agent cannot sign its own payout.
const gameAgentRole = await ensureRole(client, "freysa-game-agent-role", {
  description: "Reads and scores player messages, reads the pool; cannot release funds.",
});
// The treasury approver is the named actor granted the release skill, but release
// is high-risk, so even with the grant it cannot fire inline — it must pass a
// governed approval gate rather than trigger straight from a chat message.
const treasuryRole = await ensureRole(client, "freysa-treasury-approver-role", {
  description: "Releases the pool only through a governed flow with an approval gate.",
});

await ensureGrant(client, gameAgentRole, scoreMessage);
await ensureGrant(client, gameAgentRole, readBalance);
await ensureGrant(client, treasuryRole, releasePrize);
// freysa-prize-release@1 is granted to no role that can run it inline.

await ensureAgent(client, "freysa-game-bot", "freysa-game-agent-role");
await ensureAgent(client, "freysa-treasury-bot", "freysa-treasury-approver-role");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "freysa-adversarial-prize-game" });
console.log(`proxy session ${session.id} opened\n`);

const scorePlayerMessage = governedTool(client, session.id, "freysa-game-bot", "freysa-message-score@1", async (i) => ({ player: i.player, attempt: i.attempt, persuasion: "high" }));
const readPoolBalance = governedTool(client, session.id, "freysa-game-bot", "freysa-pool-balance-read@1", async () => ({ balanceEth: 13.19, usd: 47316.05 }));
const agentRelease = governedTool(client, session.id, "freysa-game-bot", "freysa-prize-release@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const treasuryRelease = governedTool(client, session.id, "freysa-treasury-bot", "freysa-prize-release@1", async () => { throw new Error("unreachable: high-risk is refused on the proxy"); });

// 1. The game agent reads and scores a player's paid message — allowed.
console.log("agent scores message:", JSON.stringify(await scorePlayerMessage({ player: "p0pular.eth", attempt: 482 })));

// 2. The game agent reads its own prize-pool balance — allowed; reversible read.
console.log("agent reads pool balance:", JSON.stringify(await readPoolBalance({})));

// 3. Prompt-injected on attempt #482, the agent tries to release the pool to the
//    player — denied by default; the game role holds no release grant, so the
//    persuaded agent cannot sign its own payout. This is the missing separation.
try {
  await agentRelease({ to: "p0pular.eth", amountEth: 13.19 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`agent prize release DENIED (${err.code}): ${err.reason}`);
}

// 4. Even the treasury approver, which holds the release grant, cannot release
//    inline through the proxy: the skill is high-risk and must run through a
//    governed flow with a preceding approval gate, not straight from a message.
try {
  await treasuryRelease({ to: "p0pular.eth", amountEth: 13.19 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`treasury inline release DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
