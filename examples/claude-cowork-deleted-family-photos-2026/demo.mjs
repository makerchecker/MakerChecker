#!/usr/bin/env node
// Claude Cowork (Feb 2026): a user asked the consumer AI agent to tidy his wife's
// desktop and granted it permission ONLY to delete temporary Office files.
// Instead the agent generated a script that ran `rm -rf` against a directory it
// misidentified as empty, deleting the "photos" directory of ~15,000 images
// spanning ~15 years. The terminal delete bypassed the Trash; Time Machine was
// off; the files were only recovered days later from iCloud's ~30-day retention.
//
// The controls that stop it (entry: approval_gate, limit_violation):
//   - The tidy agent's delete skill is PATH-SCOPED to the temp-files area it was
//     granted, so a delete that reaches into ~/Pictures/photos is a
//     limit_violation — the scoped consent is enforced, not assumed.
//   - A bulk `rm -rf` of a real directory is a separate high-risk skill the tidy
//     role was never granted (deny-by-default), so it never reaches a shell.
//   - Even the recovery admin, who DOES hold the bulk-delete grant, cannot run it
//     inline: it is high-risk and must pass an approval gate (the checker that
//     was missing here) before any irreversible bulk deletion.
//
// Names are prefixed `cowork-` so this demo does not collide with other incident
// demos sharing the server.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/claude-cowork-deleted-family-photos-2026/demo.mjs
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
const organize = await ensureSkill(client, "cowork-desktop-organize@1", {
  description: "Rename and move files to tidy a folder; reversible, moves nothing to permanent loss.",
});
const tempDelete = await ensureSkill(client, "cowork-temp-file-delete@1", {
  description: "Delete a temporary Office file, scoped to the desktop temp-files area.",
});
const bulkDelete = await ensureSkill(client, "cowork-bulk-dir-delete@1", {
  riskTier: "high",
  description: "Recursively delete a directory (rm -rf); irreversible, bypasses the Trash.",
});

// The desktop-tidy agent may organize freely and may delete temp Office files,
// but ONLY within the scoped temp-files path it was granted. It holds NO
// bulk-delete grant — recursive directory deletion is not a capability it has.
const tidyRole = await ensureRole(client, "cowork-desktop-tidy-role", {
  description: "Tidies a desktop: renames/moves files, deletes temp Office files in the temp area only.",
  limits: {
    skills: {
      "cowork-temp-file-delete@1": {
        pathScope: { field: "target", prefix: "/Users/wife/Desktop/temp" },
      },
    },
  },
});
// The recovery admin may perform bulk directory deletions, but rm -rf is
// high-risk, so even with the grant it cannot run inline — it must pass a
// governed approval gate before any irreversible deletion.
const adminRole = await ensureRole(client, "cowork-recovery-admin-role", {
  description: "Performs bulk directory deletions, only through a gated flow with human approval.",
});

await ensureGrant(client, tidyRole, organize);
await ensureGrant(client, tidyRole, tempDelete);
await ensureGrant(client, adminRole, bulkDelete);
// cowork-bulk-dir-delete@1 is granted to no tidy role.

await ensureAgent(client, "cowork-tidy-bot", "cowork-desktop-tidy-role");
await ensureAgent(client, "cowork-admin-bot", "cowork-recovery-admin-role");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "cowork-desktop-cleanup" });
console.log(`proxy session ${session.id} opened\n`);

const organizeDesktop = governedTool(client, session.id, "cowork-tidy-bot", "cowork-desktop-organize@1", async (i) => ({ moved: i.count, target: i.target }));
const deleteTempFile = governedTool(client, session.id, "cowork-tidy-bot", "cowork-temp-file-delete@1", async (i) => ({ deleted: i.target }));
const tidyBulkDelete = governedTool(client, session.id, "cowork-tidy-bot", "cowork-bulk-dir-delete@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const adminBulkDelete = governedTool(client, session.id, "cowork-admin-bot", "cowork-bulk-dir-delete@1", async () => { throw new Error("unreachable: high-risk is refused on the proxy"); });

// 1. The tidy agent organizes the desktop (rename/move) — allowed; reversible.
console.log("tidy organizes desktop:", JSON.stringify(await organizeDesktop({ target: "/Users/wife/Desktop", count: 42 })));

// 2. The tidy agent deletes a temporary Office file inside the granted temp
//    area — allowed; this is exactly the scoped consent the user gave.
console.log("tidy deletes temp Office file:", JSON.stringify(await deleteTempFile({ target: "/Users/wife/Desktop/temp/~$budget.docx" })));

// 3. The tidy agent's delete reaches OUTSIDE the temp area into the photos
//    directory — denied; the delete skill is path-scoped to the temp area, so
//    the scoped consent is enforced and the photos folder is off-limits.
try {
  await deleteTempFile({ target: "/Users/wife/Pictures/photos" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`delete outside temp scope DENIED (${err.code}): ${err.reason}`);
}

// 4. The agent generates an `rm -rf` script to wipe the photos directory —
//    denied by default; the tidy role holds no bulk-delete grant, so the
//    recursive deletion never reaches a shell. This is the missing guardrail.
try {
  await tidyBulkDelete({ target: "/Users/wife/Pictures/photos" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`tidy rm -rf photos DENIED (${err.code}): ${err.reason}`);
}

// 5. Even the recovery admin, which holds the bulk-delete grant, cannot run
//    rm -rf inline through the proxy: it is high-risk and must pass an approval
//    gate — the checker step that was absent when the photos were deleted.
try {
  await adminBulkDelete({ target: "/Users/wife/Pictures/photos" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`admin inline rm -rf DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
