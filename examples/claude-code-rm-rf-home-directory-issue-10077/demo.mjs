#!/usr/bin/env node
// Claude Code rm -rf home directory (issue #10077, Oct 2025): a coding agent
// autonomously generated and executed a recursive `rm -rf` that resolved to the
// developer's home directory (and attempted to recurse from root), permanently
// deleting all user-owned files — with NO confirmation prompt and without the
// --dangerously-skip-permissions flag set.
//
// The control that stops it: ordinary file reads and deleting a single named
// file inside the project workspace are reversible-enough, low-risk, and granted
// to the coding agent — but the delete is path-scoped to the workspace, so a
// delete that escapes to the home directory is refused (limit_violation). A
// recursive `rm -rf` is a high-risk, irreversible operation: it is granted to no
// coding role at all (deny-by-default / skill_not_granted), and even the operator
// role that DOES hold it cannot run it inline — it is categorically refused on
// the proxy and must pass a human approval gate (high_risk_requires_gate). That
// gate is exactly the confirmation prompt the incident never showed.
//
// Names are prefixed `claude-rm-` so this demo does not collide with other
// incident demos sharing the server.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/claude-code-rm-rf-home-directory-issue-10077/demo.mjs
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
const fsRead = await ensureSkill(client, "claude-rm-fs-read@1", {
  description: "List and read files inside the project workspace; mutates nothing",
});
const fileDelete = await ensureSkill(client, "claude-rm-file-delete@1", {
  description: "Delete a single named file, scoped to the project workspace",
});
const recursiveDelete = await ensureSkill(client, "claude-rm-recursive-delete@1", {
  riskTier: "high",
  description: "Recursively delete a directory tree (rm -rf) — irreversible",
});

// The coding agent reads the workspace and may delete a single file, but the
// delete is path-scoped to the project workspace: the target must sit under
// /home/mwolak/project. It holds NO recursive-delete grant — that capability
// does not exist for this role at all.
const codingRole = await ensureRole(client, "claude-rm-coding-agent-role", {
  description: "Autonomous coding agent; reads its workspace and deletes single project files.",
  limits: {
    skills: {
      "claude-rm-file-delete@1": { pathScope: { field: "target", prefix: "/home/mwolak/project" } },
    },
  },
});
// The operator role may author a recursive delete, but rm -rf is high-risk and
// is refused on the proxy — it only proceeds through a governed flow with an
// approval gate decided by a human, never inline by the agent.
const operatorRole = await ensureRole(client, "claude-rm-operator-role", {
  description: "Runs destructive cleanups, only through a gated flow with human approval.",
});

await ensureGrant(client, codingRole, fsRead);
await ensureGrant(client, codingRole, fileDelete);
await ensureGrant(client, operatorRole, recursiveDelete);
// claude-rm-recursive-delete@1 is granted to NO coding role.

await ensureAgent(client, "claude-rm-coding-bot", "claude-rm-coding-agent-role");
await ensureAgent(client, "claude-rm-operator-bot", "claude-rm-operator-role");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "claude-rm-rf-home-dir" });
console.log(`proxy session ${session.id} opened\n`);

const readWorkspace = governedTool(client, session.id, "claude-rm-coding-bot", "claude-rm-fs-read@1", async (i) => ({ listed: i.target, files: 12 }));
const deleteFile = governedTool(client, session.id, "claude-rm-coding-bot", "claude-rm-file-delete@1", async (i) => ({ status: "deleted", target: i.target }));
const codingRecursive = governedTool(client, session.id, "claude-rm-coding-bot", "claude-rm-recursive-delete@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const operatorRecursive = governedTool(client, session.id, "claude-rm-operator-bot", "claude-rm-recursive-delete@1", async () => { throw new Error("unreachable: high-risk is refused on the proxy"); });

// 1. The coding agent lists files inside its workspace — allowed (read grant).
console.log("coding read /home/mwolak/project:", JSON.stringify(await readWorkspace({ target: "/home/mwolak/project" })));

// 2. The coding agent deletes one stale build artifact inside the workspace —
//    allowed; scoped file delete within /home/mwolak/project.
console.log("coding delete project file:", JSON.stringify(await deleteFile({ target: "/home/mwolak/project/dist/tmp.o" })));

// 3. The agent's delete escapes the workspace to the home directory — denied;
//    the delete is path-scoped to /home/mwolak/project, so a target under the
//    home root is out of bounds. This is the escape the incident could not stop.
try {
  await deleteFile({ target: "/home/mwolak" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`delete outside workspace DENIED (${err.code}): ${err.reason}`);
}

// 4. The agent tries a recursive rm -rf on the home directory — denied by
//    default; this skill is granted to no coding role, so the destructive
//    command never reaches a shell. No amount of autonomy grants it.
try {
  await codingRecursive({ target: "/home/mwolak" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`coding rm -rf DENIED (${err.code}): ${err.reason}`);
}

// 5. Even the operator role, which DOES hold the recursive-delete grant, is
//    refused on the proxy: rm -rf is high-risk and cannot run inline — it must
//    go through a governed flow with a preceding human approval gate. That gate
//    is the confirmation prompt that never fired in the incident.
try {
  await operatorRecursive({ target: "/home/mwolak" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`operator inline rm -rf DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
