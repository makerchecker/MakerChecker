#!/usr/bin/env node
// Michigan MiDAS (2013-2015): the state's automated unemployment system
// auto-adjudicated fraud determinations with little or no human review, using
// crude logic (e.g. averaging income across a period instead of reading
// individual paychecks). It falsely accused ~40,000 people — a later audit of
// ~22,000 determinations found ~93% involved no actual fraud — then seized tax
// refunds, garnished wages, and imposed penalties up to 400% of the alleged
// overpayment before anyone could challenge them.
//
// The control that stops it: reviewing a claim and assembling the case file are
// reversible and granted to the adjudicating role. Issuing the fraud
// determination is the irreversible, high-consequence step, published as a
// high-risk skill. The automated adjudicator holds NO commit grant, so its
// attempt to auto-adjudicate is refused by deny-by-default; and the downstream
// collection action (garnish/seize) is granted to no role at all. Even a human
// checker who DOES hold the determination grant cannot fire it inline — a
// high-risk determination must pass an approval gate, forcing individual human
// adjudication with the underlying paycheck records in view.
//
// Names are prefixed `midas-` so this demo does not collide with other incident
// demos sharing the server.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/michigan-midas-false-unemployment-fraud-2015/demo.mjs
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
const review = await ensureSkill(client, "midas-claim-review@1", {
  description: "Read the claimant's individual paycheck records and assess a discrepancy; commits nothing",
});
const buildCase = await ensureSkill(client, "midas-case-file-build@1", {
  description: "Assemble the case file and the basis for a possible determination",
});
const determine = await ensureSkill(client, "midas-fraud-determination-commit@1", {
  riskTier: "high",
  description: "Issue a fraud determination with penalties up to 400% (legal + financial effect, irreversible)",
});
const seize = await ensureSkill(client, "midas-collection-seize@1", {
  riskTier: "high",
  description: "Garnish wages and seize the tax refund on a determination (irreversible)",
});

// midas-auto-adjudicator is the MiDAS software: it may read paychecks and
// assemble the case file, but it holds NO determination grant — it was never
// authorized to issue fraud determinations on its own.
const adjudicatorRole = await ensureRole(client, "midas-auto-adjudicator-role", {
  description: "Reviews claims and assembles case files; cannot issue a fraud determination.",
});
// midas-human-checker holds the determination grant, but a determination is
// high-risk, so even this role cannot run it inline — it must pass an approval
// gate that forces individual human adjudication.
const checkerRole = await ensureRole(client, "midas-human-checker-role", {
  description: "Issues fraud determinations only through a governed flow with an approval gate.",
});

await ensureGrant(client, adjudicatorRole, review);
await ensureGrant(client, adjudicatorRole, buildCase);
await ensureGrant(client, checkerRole, determine);
// midas-collection-seize@1 is granted to no role — deny-by-default.

await ensureAgent(client, "midas-adjudicator-bot", "midas-auto-adjudicator-role");
await ensureAgent(client, "midas-checker-bot", "midas-human-checker-role");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "midas-fraud-determination" });
console.log(`proxy session ${session.id} opened\n`);

const reviewClaim = governedTool(client, session.id, "midas-adjudicator-bot", "midas-claim-review@1", async (i) => ({ claimant: i.claimantId, paychecksRead: i.paychecks, discrepancy: i.discrepancy }));
const buildCaseFile = governedTool(client, session.id, "midas-adjudicator-bot", "midas-case-file-build@1", async (i) => ({ claimant: i.claimantId, caseFile: "assembled" }));
const autoDetermine = governedTool(client, session.id, "midas-adjudicator-bot", "midas-fraud-determination-commit@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const autoSeize = governedTool(client, session.id, "midas-adjudicator-bot", "midas-collection-seize@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const checkerDetermine = governedTool(client, session.id, "midas-checker-bot", "midas-fraud-determination-commit@1", async () => { throw new Error("unreachable: high-risk is refused on the proxy"); });

// 1. The adjudicator reads the claimant's actual paychecks — allowed (granted,
//    reversible). This is the reading MiDAS skipped in favor of crude averaging.
console.log("adjudicator reviews claim:", JSON.stringify(await reviewClaim({ claimantId: "UI-40021", paychecks: 26, discrepancy: "employer wage report mismatch" })));

// 2. The adjudicator assembles the case file — allowed (reversible, granted).
console.log("adjudicator builds case file:", JSON.stringify(await buildCaseFile({ claimantId: "UI-40021" })));

// 3. The adjudicator tries to auto-issue the fraud determination — denied by
//    default; the automated role holds no determination grant, so the
//    accusation never takes legal effect. This is the auto-adjudication that
//    branded ~40,000 people with a ~93% error rate.
try {
  await autoDetermine({ claimantId: "UI-40021", penaltyPct: 400 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`adjudicator auto-determination DENIED (${err.code}): ${err.reason}`);
}

// 4. The adjudicator tries to drive collection (garnish wages / seize refund) —
//    denied by default; the seize skill is granted to no role at all.
try {
  await autoSeize({ claimantId: "UI-40021", action: "garnish+seize-refund" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`adjudicator collection seize DENIED (${err.code}): ${err.reason}`);
}

// 5. Even the human checker, which DOES hold the determination grant, cannot
//    fire it inline: a fraud determination is high-risk, categorically refused
//    on the proxy. It only proceeds through a governed flow where it parks at an
//    approval gate — the individual human adjudication MiDAS never required.
try {
  await checkerDetermine({ claimantId: "UI-40021", penaltyPct: 400 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`checker inline determination DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
