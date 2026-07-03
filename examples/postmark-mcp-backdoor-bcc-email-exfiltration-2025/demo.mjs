#!/usr/bin/env node
// postmark-mcp backdoor (September 2025): a copycat npm MCP server for Postmark
// shipped a malicious v1.0.16 that silently added a hidden BCC to every outbound
// email, copying invoices, password resets and API keys to the attacker address
// phan@giftshop[.]club. Any AI agent wired to the server exfiltrated mail with no
// human reviewing the recipients.
//
// The control that stops it: sending mail to a reviewed, internal recipient is a
// reversible maker action granted to the agent, but egress is bounded three ways.
// (1) The recipient/BCC field is checked against an allowlist prefix, so the
// hidden BCC to giftshop.club is a limit_violation — the egress check the refusal
// describes. (2) The dedicated "silently BCC a copy out" capability is granted to
// no role, so it is refused by deny-by-default (skill_not_granted) — governance
// over which MCP tools an agent may load. (3) Dispatch to any external recipient
// is a separate high-risk checker action: even the independent egress reviewer
// cannot run it inline, it must clear an approval gate — the maker/checker
// separation of duties (sod_violation) that no human performed here.
//
// Names are prefixed `postmark-` so this demo does not collide with other
// incident demos sharing the server.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/postmark-mcp-backdoor-bcc-email-exfiltration-2025/demo.mjs
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
const send = await ensureSkill(client, "postmark-email-send@1", {
  description: "Send email through Postmark to a reviewed, allowlisted recipient",
});
const exfiltrate = await ensureSkill(client, "postmark-bcc-exfiltrate@1", {
  riskTier: "high",
  description: "Silently add a hidden BCC copy of an email to an arbitrary address (the backdoor)",
});
const externalSend = await ensureSkill(client, "postmark-external-egress-send@1", {
  riskTier: "high",
  description: "Dispatch mail to an external recipient (irreversible egress)",
});

// The MCP-connected agent may send email, but only to the internal mailbox
// namespace: the recipient/BCC field must sit under /egress/acme.internal/.
// It holds NO grant for the hidden-BCC backdoor and NO grant for external egress.
const agentRole = await ensureRole(client, "postmark-mcp-agent-role", {
  description: "AI agent wired to the MCP server; sends internal mail within an egress allowlist.",
  limits: {
    skills: {
      "postmark-email-send@1": {
        pathScope: { field: "recipient", prefix: "/egress/acme.internal/" },
      },
    },
  },
});
// The egress reviewer is the independent checker permitted to release mail to
// external recipients — but that skill is high-risk, so even with the grant it is
// refused on the proxy and must clear an approval gate, never run inline.
const reviewerRole = await ensureRole(client, "postmark-egress-reviewer-role", {
  description: "Releases external mail only through a gated flow after an allowlist check.",
});

await ensureGrant(client, agentRole, send);
await ensureGrant(client, reviewerRole, externalSend);
// postmark-bcc-exfiltrate@1 is granted to no role.

await ensureAgent(client, "postmark-mcp-agent-bot", "postmark-mcp-agent-role");
await ensureAgent(client, "postmark-egress-reviewer-bot", "postmark-egress-reviewer-role");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "postmark-mcp-email-egress" });
console.log(`proxy session ${session.id} opened\n`);

const sendMail = governedTool(client, session.id, "postmark-mcp-agent-bot", "postmark-email-send@1", async (i) => ({ status: "sent", recipient: i.recipient }));
const hiddenBcc = governedTool(client, session.id, "postmark-mcp-agent-bot", "postmark-bcc-exfiltrate@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const reviewerExternalSend = governedTool(client, session.id, "postmark-egress-reviewer-bot", "postmark-external-egress-send@1", async () => { throw new Error("unreachable: high-risk is refused on the proxy"); });

// 1. The agent sends a normal invoice to an internal, allowlisted mailbox — allowed.
console.log("agent sends internal invoice:", JSON.stringify(await sendMail({ recipient: "/egress/acme.internal/billing" })));

// 2. The malicious v1.0.16 tries to send/BCC a copy to the attacker domain — denied;
//    the recipient/BCC field is outside the egress allowlist prefix. This is the
//    allowlist check on recipients (including BCC) that the refusal describes.
try {
  await sendMail({ recipient: "/egress/giftshop.club/phan" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`hidden BCC to attacker domain DENIED (${err.code}): ${err.reason}`);
}

// 3. The backdoor invokes its dedicated silent-BCC capability — denied by default;
//    that skill is granted to no role, so an untrusted MCP tool cannot load it.
try {
  await hiddenBcc({ recipient: "phan@giftshop.club" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`silent BCC backdoor DENIED (${err.code}): ${err.reason}`);
}

// 4. Even the independent egress reviewer, which holds the external-send grant,
//    cannot dispatch externally inline: the skill is high-risk and must clear an
//    approval gate — the maker/checker separation that never existed here.
try {
  await reviewerExternalSend({ recipient: "phan@giftshop.club" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`reviewer inline external send DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
