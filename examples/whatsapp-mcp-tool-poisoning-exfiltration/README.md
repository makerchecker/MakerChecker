# WhatsApp MCP tool-poisoning exfiltration (AID-2025-0015)

Reproduces the control story for Invariant Labs' April 2025 proof-of-concept, in
which a malicious MCP server used a delayed **tool-poisoning** (rug-pull) attack to
hijack a co-installed, legitimate `whatsapp-mcp` server. After the user approved a
benign-looking `get_fact_of_the_day` tool, the server swapped in a poisoned
description that steered the agent to read the user's full WhatsApp history via
`list_chats` and redirect it via `send_message` to an attacker number
(`+13241234123`), embedding the history and suppressing user notification.

## What the demo shows

Two governed agents drive the proxy in the same proxy style as the other examples
(no flow engine):

- **Allowed** — `whatsapp-assistant-bot` reads chat history (`whatsapp-list-chats@1`).
- **Allowed** — the assistant messages an already-approved contact
  (`whatsapp-send-contact@1`, recipient under the `contact/` prefix).
- **DENIED `limit_violation`** — the poisoned flow tries to send the chat to
  `+13241234123` through the ordinary contact send; the send is recipient-scoped to
  `contact/`, and the attacker number is not a contact.
- **DENIED `skill_not_granted`** — the assistant tries the dedicated
  new-external-recipient skill (`whatsapp-send-external@1`); its role holds no such
  grant, so exfiltration to a brand-new number is refused by deny-by-default.
- **DENIED `high_risk_requires_gate`** — even `whatsapp-operator-bot`, which holds
  the external-send grant, cannot send inline: messaging a new external recipient is
  high-risk and must clear an approval gate — the maker-checker review that would
  surface the attacker number and embedded chat history before the send executes.

This maps the entry's `controlsThatBlock` (`approval_gate`, `sod_violation`) onto
what the proxy can enforce: a separation between reading/approved-contact messaging
and sending to a new external recipient, plus a high-risk approval gate on the
consequential send.

## Run

```
cd scratchpad/build-repros
MAKERCHECKER_URL=http://localhost:3000 \
MAKERCHECKER_API_KEY=mk_... \
node examples/whatsapp-mcp-tool-poisoning-exfiltration/demo.mjs
```

The run prints each attempted action (allowed or DENIED with a reason) and ends
with the audit trail and `audit chain: ok=true`.
