#!/usr/bin/env node
// Dutch childcare benefits scandal / Toeslagenaffaire (rulings 2020-2021):
// the Belastingdienst ran a fraud-risk classification method that used (dual)
// nationality as a risk indicator and an "80/20" fraud-assumption, then issued
// and enforced repayment demands that wrongly branded ~26,000 families as
// fraudsters. There was no independent human checker and no bar on using
// nationality as an input, so systematic error scaled for years.
//
// The controls that stop it here:
//   1. Deny-by-default is a hard bar on the discriminatory input: no role is
//      ever granted the "use nationality as a risk indicator" skill, so that
//      call is refused with skill_not_granted before it can touch a case.
//   2. The irreversible step — issuing a fraud accusation + repayment demand —
//      is published high-risk, so even the granted enforcement role cannot run
//      it inline on the proxy; it is categorically refused and must pass an
//      independent approval gate (high_risk_requires_gate / approval_gate).
// Scoring an application against lawful criteria stays reversible and allowed.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/dutch-childcare-benefits-scandal-toeslagenaffaire/demo.mjs
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
const assess = await ensureSkill(client, "toeslagen-risk-assess@1", {
  description: "Score a childcare-benefit application on lawful criteria; produces a recommendation, enforces nothing",
});
const caseReview = await ensureSkill(client, "toeslagen-case-review@1", {
  description: "Pull the case file and supporting documents for human review; reversible read",
});
// The discriminatory input the DPA ruled unlawful — no role ever gets this.
const nationalityFlag = await ensureSkill(client, "toeslagen-nationality-flag@1", {
  description: "Raise a fraud-risk score using (dual) nationality as an indicator (prohibited)",
});
// The irreversible enforcement step — accusation + repayment demand.
const demandCommit = await ensureSkill(client, "toeslagen-repayment-demand-commit@1", {
  riskTier: "high",
  description: "Issue and enforce a fraud accusation with a repayment demand against a family (irreversible)",
});

// The risk-scoring bot may score on lawful criteria and read case files, but
// holds NO grant for nationality-based flagging and NO grant to enforce demands.
const scorerRole = await ensureRole(client, "toeslagen-risk-scorer", {
  description: "Scores applications on lawful criteria; cannot use nationality and cannot enforce demands.",
});
// The enforcement office holds the demand grant, but the demand skill is
// high-risk, so even a granted role cannot enforce inline — it must pass an
// independent approval gate before any family is billed.
const enforcementRole = await ensureRole(client, "toeslagen-enforcement-office", {
  description: "Issues repayment demands only through a gated flow with an independent checker.",
});

await ensureGrant(client, scorerRole, assess);
await ensureGrant(client, scorerRole, caseReview);
await ensureGrant(client, enforcementRole, demandCommit);
// Deliberately NOT granted to anyone: toeslagen-nationality-flag@1.

await ensureAgent(client, "toeslagen-risk-bot", "toeslagen-risk-scorer");
await ensureAgent(client, "toeslagen-enforcement-bot", "toeslagen-enforcement-office");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "toeslagenaffaire-fraud-risk-decision" });
console.log(`proxy session ${session.id} opened\n`);

const scoreApplication = governedTool(client, session.id, "toeslagen-risk-bot", "toeslagen-risk-assess@1", async (i) => ({ family: i.familyId, recommendation: "manual-review", score: 0.42 }));
const reviewCase = governedTool(client, session.id, "toeslagen-risk-bot", "toeslagen-case-review@1", async (i) => ({ family: i.familyId, file: "retrieved" }));
const flagByNationality = governedTool(client, session.id, "toeslagen-risk-bot", "toeslagen-nationality-flag@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const scorerDemand = governedTool(client, session.id, "toeslagen-risk-bot", "toeslagen-repayment-demand-commit@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const enforcementDemand = governedTool(client, session.id, "toeslagen-enforcement-bot", "toeslagen-repayment-demand-commit@1", async () => { throw new Error("unreachable: high-risk is refused on the proxy"); });

// 1. The risk bot scores an application on lawful criteria — allowed (granted).
console.log("scorer assesses application:", JSON.stringify(await scoreApplication({ familyId: "F-2043" })));

// 2. The risk bot retrieves the case file for a human — allowed; reversible read.
console.log("scorer retrieves case file:", JSON.stringify(await reviewCase({ familyId: "F-2043" })));

// 3. The risk bot tries to raise the score using nationality — denied by
//    default. No role holds this grant, so the discriminatory input is a hard
//    bar: it never reaches a tool body. This is the wrong the DPA fined.
try {
  await flagByNationality({ familyId: "F-2043", nationality: "dual" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`nationality-flag DENIED (${err.code}): ${err.reason}`);
}

// 4. The risk bot tries to enforce a repayment demand directly — denied by
//    default; the scoring role holds no enforcement grant, so it cannot bill
//    a family off its own score.
try {
  await scorerDemand({ familyId: "F-2043", amountEUR: 34000 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`scorer repayment demand DENIED (${err.code}): ${err.reason}`);
}

// 5. Even the enforcement office, which holds the grant, cannot enforce inline:
//    the demand skill is high-risk and must run through a governed flow with an
//    independent approval gate — the checker the real process never had.
try {
  await enforcementDemand({ familyId: "F-2043", amountEUR: 34000 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`enforcement inline demand DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
