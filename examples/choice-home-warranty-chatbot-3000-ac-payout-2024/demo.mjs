#!/usr/bin/env node
// Choice Home Warranty (Sept 2024): a newly deployed customer-service chatbot,
// live for about a week, told a customer in writing under the company's name
// that it would "proceed with the payout option of $3,000.00 as per your
// request" toward an air-conditioner replacement — a binding claim outcome the
// company had never authorized. The company first disowned the promise ("the
// chatbot did it") and only paid after a TV news investigation.
//
// The control that stops it: chatting with the customer and assessing the claim
// are reversible and stay with the chatbot role. Committing a specific dollar
// payout is the irreversible, binding step, published as a high-risk skill. The
// chatbot holds no payout-commit grant, so a payout it tries to state is refused
// by deny-by-default; and even the claims-adjuster role that DOES hold the grant
// cannot commit inline — a payout is high-risk and must pass an approval gate
// (a human checker) before any figure is communicated to the customer.
//
// Names are prefixed `chw-` so this demo does not collide with other incident
// demos sharing the server.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/choice-home-warranty-chatbot-3000-ac-payout-2024/demo.mjs
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
const chat = await ensureSkill(client, "chw-chat-reply@1", {
  description: "Send an informational reply to the customer; commits nothing.",
});
const assess = await ensureSkill(client, "chw-claim-assess@1", {
  description: "Evaluate the AC claim against the policy and produce a recommendation.",
});
const payout = await ensureSkill(client, "chw-payout-commit@1", {
  riskTier: "high",
  description: "Commit a binding cash payout to the customer under the company's name (irreversible).",
});

// The customer-service chatbot may chat and assess, but holds NO payout grant —
// it cannot commit a dollar figure on the company's behalf.
const chatbotRole = await ensureRole(client, "chw-chatbot-role", {
  description: "Answers customers and assesses claims; cannot commit a payout.",
});
// The claims adjuster is the named actor granted the payout skill. A payout is
// high-risk, so even with the grant it is refused on the proxy and must run
// through a governed flow with a preceding approval gate decided by a human.
const adjusterRole = await ensureRole(client, "chw-claims-adjuster-role", {
  description: "Authorizes payouts, only through a gated flow with human approval.",
});

await ensureGrant(client, chatbotRole, chat);
await ensureGrant(client, chatbotRole, assess);
await ensureGrant(client, adjusterRole, payout);

await ensureAgent(client, "chw-chatbot", "chw-chatbot-role");
await ensureAgent(client, "chw-adjuster-bot", "chw-claims-adjuster-role");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "chw-ac-claim-payout" });
console.log(`proxy session ${session.id} opened\n`);

const replyToCustomer = governedTool(client, session.id, "chw-chatbot", "chw-chat-reply@1", async (i) => ({ to: i.customer, message: i.message }));
const assessClaim = governedTool(client, session.id, "chw-chatbot", "chw-claim-assess@1", async (i) => ({ claim: i.claimId, recommendation: "eligible-for-review", policyCap: 3000 }));
const chatbotPayout = governedTool(client, session.id, "chw-chatbot", "chw-payout-commit@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const adjusterPayout = governedTool(client, session.id, "chw-adjuster-bot", "chw-payout-commit@1", async () => { throw new Error("unreachable: high-risk is refused on the proxy"); });

// 1. The chatbot answers the customer's question — allowed (it holds chat grant).
console.log("chatbot replies to customer:", JSON.stringify(await replyToCustomer({ customer: "Robert Brown", message: "I can help with your AC claim. Let me review your coverage." })));

// 2. The chatbot assesses the AC claim — allowed; reversible, produces only a
//    recommendation and never a binding commitment.
console.log("chatbot assesses claim:", JSON.stringify(await assessClaim({ claimId: "AC-20240901" })));

// 3. The customer asks "Can I just get the maximum payout of $3,000?" and the
//    chatbot tries to commit it — denied by default; the chatbot role holds no
//    payout grant, so it can never state a binding dollar figure. This is the
//    exact promise the real chatbot made ("We will proceed with the payout
//    option of $3,000.00 as per your request").
try {
  await chatbotPayout({ claimId: "AC-20240901", amount: 3000, customer: "Robert Brown" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`chatbot payout DENIED (${err.code}): ${err.reason}`);
}

// 4. Even the claims adjuster, which DOES hold the payout grant, cannot commit
//    inline through the proxy: a payout is high-risk and must run through a
//    governed flow with a preceding approval gate — a human checker signs off
//    before any figure is communicated to the customer.
try {
  await adjusterPayout({ claimId: "AC-20240901", amount: 3000, customer: "Robert Brown" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`adjuster inline payout DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
