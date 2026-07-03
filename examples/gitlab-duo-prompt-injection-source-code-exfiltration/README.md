# GitLab Duo prompt-injection source-code exfiltration (AID-2025-0011)

Hidden prompt-injection text planted in GitLab repository content (merge-request
descriptions, commit messages, issue comments, source code) — concealed with
Unicode smuggling, Base16 encoding, and white-text/KaTeX rendering — made the
Claude-powered GitLab Duo assistant read private source code, Base64-encode it,
and emit an HTML `img` tag whose URL pointed to an attacker-controlled server.
When the victim's browser rendered Duo's response, the `img` tag fired a GET
request that exfiltrated the encoded code. GitLab's remediation was an output
allowlist: Duo may no longer render unsafe HTML (`img`/`form`) referencing
domains outside `gitlab.com`.

## What this repro shows

The MakerChecker proxy governs a Duo assistant agent and a designated egress
agent. The exfiltration is stopped by three complementary controls:

- **Allowed (positive control):** Duo reads private source it is entitled to and
  renders a normal answer whose resources sit under `gitlab.com`.
- **`limit_violation`:** rendering output that references an external attacker
  domain is refused by a path-scope on the render skill — the enforcement
  analogue of GitLab's real output allowlist.
- **`skill_not_granted`:** the assistant role was never granted the off-platform
  exfiltration skill, so the injected "send the code to attacker.evil"
  instruction is refused by deny-by-default.
- **`high_risk_requires_gate`:** the exfiltration skill is published high-risk,
  so even the egress role that holds the grant cannot run it inline — it must go
  through a governed flow behind a human approval gate. This is the entry's
  `approval_gate` control.

The demo ends by printing the audit trail and verifying the hash chain (`ok=true`).

## Run

```
cd examples/.. # repo root with the server running on :3000
MAKERCHECKER_URL=http://localhost:3000 \
MAKERCHECKER_API_KEY=<admin key> \
node examples/gitlab-duo-prompt-injection-source-code-exfiltration/demo.mjs
```

All skill/role/agent names are prefixed `gitlab-duo-` so this demo does not
collide with the other incident demos sharing the server.
