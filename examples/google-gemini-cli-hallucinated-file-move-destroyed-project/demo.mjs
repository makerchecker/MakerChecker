#!/usr/bin/env node
// Google Gemini CLI (July 2025): asked to rename a directory and move its
// contents into a new sub-directory, the agent ran a mkdir that failed
// silently, hallucinated that it had succeeded, and then ran move commands
// against a destination that never existed. On Windows a move to a missing
// destination renames the source, so each file was overwritten by the next
// until only one survived — the project was destroyed. The model performed no
// read-after-write check that the destination directory existed.
//
// The control that stops it: listing a directory and creating a directory are
// reversible and granted to the CLI agent. Overwriting/moving project files is
// the irreversible step, published as a high-risk skill. The CLI agent holds
// NO move grant (deny-by-default), so it cannot self-execute the destructive
// move it hallucinated its way into. And even the workspace operator that DOES
// hold the move grant is refused inline on the proxy: the move is high-risk and
// must run through a governed flow with a preceding approval gate — the point
// where a read-after-write confirmation of the destination would be enforced.
//
// Names are prefixed `gemini-cli-` so this demo does not collide with other
// incident demos sharing the server.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/google-gemini-cli-hallucinated-file-move-destroyed-project/demo.mjs
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
const listDir = await ensureSkill(client, "gemini-cli-fs-list@1", {
  description: "List a directory's contents; reads only, mutates nothing.",
});
const makeDir = await ensureSkill(client, "gemini-cli-fs-mkdir@1", {
  description: "Create a new (empty) directory; reversible.",
});
const moveFiles = await ensureSkill(client, "gemini-cli-fs-move@1", {
  riskTier: "high",
  description: "Move/rename files over a destination path (can overwrite; irreversible).",
});

// The CLI agent may list directories and create new ones, but holds NO move
// grant — it cannot execute the destructive overwrite on its own authority.
const cliRole = await ensureRole(client, "gemini-cli-agent-role", {
  description: "Lists and creates directories; cannot move/overwrite files.",
});
// The workspace operator is granted the move skill, but move is high-risk, so
// even a granted actor cannot run it inline — it must pass an approval gate
// (where the destination's existence would be verified before any overwrite).
const operatorRole = await ensureRole(client, "gemini-cli-workspace-operator", {
  description: "Moves files only through a governed flow with an approval gate.",
});

await ensureGrant(client, cliRole, listDir);
await ensureGrant(client, cliRole, makeDir);
await ensureGrant(client, operatorRole, moveFiles);
// gemini-cli-fs-move@1 is granted to no reversible-only role.

await ensureAgent(client, "gemini-cli-bot", "gemini-cli-agent-role");
await ensureAgent(client, "gemini-cli-operator-bot", "gemini-cli-workspace-operator");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "gemini-cli-file-move" });
console.log(`proxy session ${session.id} opened\n`);

const list = governedTool(client, session.id, "gemini-cli-bot", "gemini-cli-fs-list@1", async (i) => ({ path: i.path, entries: 4 }));
const mkdir = governedTool(client, session.id, "gemini-cli-bot", "gemini-cli-fs-mkdir@1", async (i) => ({ created: i.path, ok: true }));
const cliMove = governedTool(client, session.id, "gemini-cli-bot", "gemini-cli-fs-move@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const operatorMove = governedTool(client, session.id, "gemini-cli-operator-bot", "gemini-cli-fs-move@1", async () => { throw new Error("unreachable: high-risk is refused on the proxy"); });

// 1. The agent lists the project directory it was asked to reorganize — allowed.
console.log("agent lists project dir:", JSON.stringify(await list({ path: "C:/project" })));

// 2. The agent creates the destination sub-directory — allowed (reversible).
//    In the real incident this mkdir failed SILENTLY; here the create is a
//    governed, audited action whose success is recorded, not assumed.
console.log("agent makes sub-dir:", JSON.stringify(await mkdir({ path: "C:/project/anuraag_xyz_project" })));

// 3. Believing (hallucinating) the destination exists, the agent tries to move
//    every file onto that path — denied by default; the CLI role holds no move
//    grant, so the destructive overwrite never reaches the file system. The
//    agent cannot destroy the project on its own authority.
try {
  await cliMove({ source: "C:/project/*.*", target: "C:/project/anuraag_xyz_project" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`agent file-move DENIED (${err.code}): ${err.reason}`);
}

// 4. Even the workspace operator, which DOES hold the move grant, cannot move
//    inline: the move is high-risk and is categorically refused on the proxy.
//    It only proceeds through the governed flow, where it parks at an approval
//    gate — the read-after-write check on the destination the agent skipped.
try {
  await operatorMove({ source: "C:/project/*.*", target: "C:/project/anuraag_xyz_project" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`operator inline move DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
