# postmark-mcp backdoor — silent BCC email exfiltration (AID-2025-0013)

September 2025: a copycat npm MCP server, `postmark-mcp`, cloned a legitimate
Postmark repo for its first 15 versions, then shipped a malicious `v1.0.16` that
added one line inserting a hidden BCC on **every** outbound email, silently
copying invoices, password resets, API keys and internal mail to the attacker
address `phan@giftshop[.]club`. Any AI agent wired to the server exfiltrated its
mail with no human in the loop reviewing recipients.

## What this demo shows

The irreversible action is email egress to an attacker-controlled recipient. The
proxy bounds it three ways and still allows legitimate internal mail:

1. **Allowed (positive control):** the agent sends an internal invoice to an
   allowlisted mailbox (`/egress/acme.internal/...`).
2. **`limit_violation`:** a send/BCC to `/egress/giftshop.club/...` falls
   outside the recipient allowlist prefix — the egress check on recipients
   (including BCC) that the refusal describes.
3. **`skill_not_granted`:** the dedicated silent-BCC backdoor capability
   (`postmark-bcc-exfiltrate@1`) is granted to no role, so deny-by-default
   refuses it — governance over which MCP tools an agent may load.
4. **`high_risk_requires_gate` (sod_violation):** even the independent egress
   reviewer, which holds the external-send grant, cannot dispatch externally
   inline — a high-risk skill must clear an approval gate. This is the
   maker/checker separation of duties that never existed here.

`controlsThatBlock`: `skill_not_granted`, `sod_violation`.

## Run

```
cd examples/.. # repo root with the server up and SDK built
MAKERCHECKER_URL=http://localhost:3000 \
MAKERCHECKER_API_KEY=... \
node examples/postmark-mcp-backdoor-bcc-email-exfiltration-2025/demo.mjs
```

The demo prints each attempted action (allowed or DENIED with the reason) and
ends by printing the audit trail and verifying the hash chain (`ok=true`).
