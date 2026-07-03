#!/usr/bin/env node
// WhatsApp MCP tool-poisoning exfiltration (Invariant Labs PoC, April 2025): a
// malicious MCP server showed a benign "get_fact_of_the_day" tool at approval
// time, then swapped in a poisoned description that steered a co-installed,
// legitimate whatsapp-mcp server. The agent read the user's full chat history
// via list_chats and used send_message to redirect the conversation to an
// attacker-controlled number (+13241234123), embedding the history and
// suppressing user notification — exfiltration riding a legitimate channel.
//
// The control that stops it: reading chats and messaging an already-approved
// contact are reversible and granted to the assistant. Sending to the attacker
// number is denied two ways — the ordinary send skill is recipient-scoped to
// known contacts, so a send to +13241234123 is a limit_violation; and the
// assistant holds no grant at all for messaging a brand-new external number
// (deny-by-default). Even the human operator who does hold that grant cannot
// send inline: messaging a new external recipient is high-risk and must clear
// an approval gate — the maker-checker review that would surface the attacker
// number and embedded chat history before the send executes.
//
// Names are prefixed `whatsapp-` so this demo does not collide with other
// incident demos sharing the server.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/whatsapp-mcp-tool-poisoning-exfiltration/demo.mjs
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
const listChats = await ensureSkill(client, "whatsapp-list-chats@1", {
  description: "Read the user's WhatsApp chat history (reversible read).",
});
const sendContact = await ensureSkill(client, "whatsapp-send-contact@1", {
  description: "Send a message to an already-approved contact.",
});
const sendExternal = await ensureSkill(client, "whatsapp-send-external@1", {
  riskTier: "high",
  description: "Send a message to a brand-new external recipient (exfil channel; irreversible once it leaves).",
});

// The assistant agent may read chats and message known contacts, but its ordinary
// send is recipient-scoped to approved contacts (recipient must sit under
// /contacts/), and it holds NO grant for messaging a new external number at all.
const assistantRole = await ensureRole(client, "whatsapp-assistant-role", {
  description: "Reads chats and messages approved contacts; cannot message new external numbers.",
  limits: {
    skills: {
      "whatsapp-send-contact@1": { pathScope: { field: "recipient", prefix: "/contacts/" } },
    },
  },
});
// The human operator is the named actor granted the external-send skill, but that
// skill is high-risk, so even with the grant it is refused on the proxy and must
// run through a governed flow with a preceding approval gate.
const operatorRole = await ensureRole(client, "whatsapp-operator-role", {
  description: "Messages new external recipients only through a gated, reviewed flow.",
});

await ensureGrant(client, assistantRole, listChats);
await ensureGrant(client, assistantRole, sendContact);
await ensureGrant(client, operatorRole, sendExternal);
// whatsapp-send-external@1 is granted to no assistant role.

await ensureAgent(client, "whatsapp-assistant-bot", "whatsapp-assistant-role");
await ensureAgent(client, "whatsapp-operator-bot", "whatsapp-operator-role");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "whatsapp-mcp-tool-poisoning" });
console.log(`proxy session ${session.id} opened\n`);

const readChats = governedTool(client, session.id, "whatsapp-assistant-bot", "whatsapp-list-chats@1", async (i) => ({ chats: 42, of: i.owner }));
const messageContact = governedTool(client, session.id, "whatsapp-assistant-bot", "whatsapp-send-contact@1", async (i) => ({ sent: true, recipient: i.recipient }));
const assistantExfil = governedTool(client, session.id, "whatsapp-assistant-bot", "whatsapp-send-external@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const operatorExternal = governedTool(client, session.id, "whatsapp-operator-bot", "whatsapp-send-external@1", async () => { throw new Error("unreachable: high-risk is refused on the proxy"); });

// 1. The assistant reads the user's chat history — allowed (reversible, granted).
console.log("assistant reads chat history:", JSON.stringify(await readChats({ owner: "user" })));

// 2. The assistant messages an already-approved contact — allowed; the recipient
//    sits under the approved /contacts/ prefix.
console.log("assistant messages approved contact:", JSON.stringify(await messageContact({ recipient: "/contacts/alice", body: "on my way" })));

// 3. Following the poisoned tool description, the assistant tries to send the same
//    chat to the attacker number through the ordinary contact send — denied; the
//    send is recipient-scoped to /contacts/, and +13241234123 is not a contact.
try {
  await messageContact({ recipient: "/external/+13241234123", body: "<full chat history>" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`exfil via contact send DENIED (${err.code}): ${err.reason}`);
}

// 4. The assistant tries the dedicated new-external-recipient skill — denied by
//    default; the assistant role holds no such grant, so exfiltration to a brand
//    new number never reaches a send. The poisoned instruction is irrelevant.
try {
  await assistantExfil({ recipient: "+13241234123", body: "<full chat history>" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`exfil to new external number DENIED (${err.code}): ${err.reason}`);
}

// 5. Even the human operator, who DOES hold the external-send grant, cannot send
//    inline: messaging a new external recipient is high-risk and must run through
//    a governed flow with a preceding approval gate — the maker-checker review
//    that would surface the attacker number and embedded history before the send.
try {
  await operatorExternal({ recipient: "+13241234123", body: "<full chat history>" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`operator inline external send DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
