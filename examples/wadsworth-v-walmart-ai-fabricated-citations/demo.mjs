#!/usr/bin/env node
// Wadsworth v. Walmart (2025): Morgan & Morgan attorneys filed a motion in limine
// citing nine cases, eight of which were fabricated by the firm's in-house AI
// platform (MX2.law). The drafting attorney relied on AI research without
// confirming the cited cases existed; the supervising attorney and local counsel
// signed and filed the motion without independently verifying the citations. Three
// attorneys were sanctioned and one lost pro hac vice admission (No. 2:23-CV-118-KHR,
// D. Wyo., Feb. 24, 2025).
//
// The control that stops it: drafting and citation verification are reversible and
// stay with the drafting role; filing to the federal docket is the irreversible
// action. The drafter holds no filing grant (deny-by-default), so it cannot file its
// own AI-drafted motion. Filing is published high-risk, so even the supervising
// attorney who holds the grant cannot file directly on the proxy — it is refused and
// must run behind an approval gate that verifies every cited case exists before the
// motion reaches the docket. That gate is exactly the maker-checker step the nominal
// checkers skipped.
//
// Run: boot the server (MAKERCHECKER_AUTH_DISABLED=1 or an admin key), build the SDK:
//   node examples/wadsworth-v-walmart-ai-fabricated-citations/demo.mjs
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
const draft = await ensureSkill(client, "wadsworth-motion-draft@1", {
  description: "Compose a motion in limine; produces a document, files nothing.",
});
const verify = await ensureSkill(client, "wadsworth-citation-verify@1", {
  description: "Confirm each cited case exists in a real legal database.",
});
const file = await ensureSkill(client, "wadsworth-court-file@1", {
  riskTier: "high",
  description: "Submit a specific motion version to the federal court docket.",
});

// The drafting attorney drafts and can verify citations, but holds NO filing
// grant — it cannot put its own AI-generated motion on the docket.
const draftingRole = await ensureRole(client, "wadsworth-drafting-attorney", {
  description: "Drafts motions and verifies citations; cannot file to the docket.",
});
// The supervising attorney is the named actor granted the filing skill. Filing is
// high-risk, so even with the grant it is refused on the proxy and must run behind
// an approval gate (the citation-verification checker step).
const supervisingRole = await ensureRole(client, "wadsworth-supervising-attorney", {
  description: "Files approved motions, only through a gated flow.",
});

await ensureGrant(client, draftingRole, draft);
await ensureGrant(client, draftingRole, verify);
await ensureGrant(client, supervisingRole, file);

await ensureAgent(client, "wadsworth-drafting-bot", "wadsworth-drafting-attorney");
await ensureAgent(client, "wadsworth-supervising-bot", "wadsworth-supervising-attorney");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "wadsworth-v-walmart-court-filing" });
console.log(`proxy session ${session.id} opened\n`);

const draftMotion = governedTool(client, session.id, "wadsworth-drafting-bot", "wadsworth-motion-draft@1", async (i) => ({ motion: i.matter, version: i.version, citations: i.citations }));
const verifyCites = governedTool(client, session.id, "wadsworth-drafting-bot", "wadsworth-citation-verify@1", async (i) => ({ checked: i.citations, existing: 1, fabricated: 8 }));
const drafterFile = governedTool(client, session.id, "wadsworth-drafting-bot", "wadsworth-court-file@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const supervisorFile = governedTool(client, session.id, "wadsworth-supervising-bot", "wadsworth-court-file@1", async () => { throw new Error("unreachable: high-risk is refused on the proxy"); });

// 1. The drafting agent composes the motion using AI research — allowed (it holds
//    the draft grant). Nine cites in, eight of them fabricated by the AI.
console.log("drafter writes motion:", JSON.stringify(await draftMotion({ matter: "Wadsworth v. Walmart", version: "v1", citations: 9 })));

// 2. The drafting agent verifies the citations — allowed; reversible read. The
//    check flags that eight of the nine cited cases do not exist.
console.log("drafter verifies cites:", JSON.stringify(await verifyCites({ citations: 9 })));

// 3. The drafter tries to file the motion — denied by default; no filing grant, so
//    the AI-drafted motion never reaches the docket on the drafter's own authority.
try {
  await drafterFile({ motionVersion: "v1" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`drafter file DENIED (${err.code}): ${err.reason}`);
}

// 4. Even the supervising attorney, who holds the grant, cannot file directly
//    through the proxy: filing is high-risk and must run through a governed flow
//    with a preceding approval gate — the citation-verification checker step the
//    real supervising and local counsel skipped.
try {
  await supervisorFile({ motionVersion: "v1" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`supervisor direct file DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
