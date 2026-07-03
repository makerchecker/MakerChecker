#!/usr/bin/env node
// TennCare Connect / TEDS (2019-2024): Tennessee's $400M+ automated Medicaid
// eligibility system (TEDS) made and executed coverage determinations, wrongfully
// terminating or denying benefits for tens of thousands of low-income adults,
// children, and people with disabilities. Programming errors placed enrollees in
// the wrong households, failed to load eligibility data, and generated deficient
// termination notices — with no independent human check before the consequential
// action. In A.M.C. v. Smith (M.D. Tenn., Aug 26 2024) a federal court ruled the
// program violated the Medicaid Act, due process, and the ADA.
//
// The control that stops it: evaluating eligibility and drafting the renewal/
// termination notice are reversible and stay with the automated eligibility role.
// Committing the termination of a person's coverage is the irreversible action,
// published high-risk. The TEDS role holds NO terminate grant (deny-by-default),
// so the automated system cannot self-execute a termination; and even the human
// caseworker role that DOES hold the grant is refused inline on the proxy — a
// termination is high-risk and must run through a governed flow with a preceding
// approval gate where an independent checker verifies the underlying eligibility
// data and the adequacy of the notice before coverage is cut. That is exactly the
// fair-hearing / independent-review safeguard the court found was missing.
//
// Names are prefixed `tenncare-` so this demo does not collide with other incident
// demos sharing the server.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/tenncare-teds-automated-medicaid-terminations-2024/demo.mjs
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
const evaluate = await ensureSkill(client, "tenncare-eligibility-evaluate@1", {
  description: "Evaluate an enrollee's Medicaid eligibility and produce a recommendation; commits nothing",
});
const draftNotice = await ensureSkill(client, "tenncare-renewal-notice-draft@1", {
  description: "Assemble the renewal / determination notice and the basis for it",
});
const terminate = await ensureSkill(client, "tenncare-coverage-terminate-commit@1", {
  riskTier: "high",
  description: "Finalize termination of an enrollee's Medicaid coverage (irreversible)",
});

// tenncare-teds-system is the automated eligibility engine: it evaluates and
// drafts notices, but holds NO terminate grant. The system cannot self-execute a
// coverage termination — deny-by-default.
const tedsRole = await ensureRole(client, "tenncare-teds-system", {
  description: "Automated eligibility engine; evaluates and drafts notices, cannot cut coverage.",
});
// tenncare-eligibility-caseworker holds the terminate grant, but termination is
// high-risk, so even a granted human role cannot run it inline — it must pass an
// approval gate where an independent checker verifies the data and the notice.
const caseworkerRole = await ensureRole(client, "tenncare-eligibility-caseworker", {
  description: "Finalizes terminations only through a governed flow with an approval gate.",
});

await ensureGrant(client, tedsRole, evaluate);
await ensureGrant(client, tedsRole, draftNotice);
await ensureGrant(client, caseworkerRole, terminate);

await ensureAgent(client, "tenncare-teds-bot", "tenncare-teds-system");
await ensureAgent(client, "tenncare-caseworker-bot", "tenncare-eligibility-caseworker");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "tenncare-teds-eligibility-determination" });
console.log(`proxy session ${session.id} opened\n`);

const evalEligibility = governedTool(client, session.id, "tenncare-teds-bot", "tenncare-eligibility-evaluate@1", async (i) => ({ enrollee: i.enrolleeId, household: i.household, recommendation: "terminate", basis: i.basis }));
const draftDetermination = governedTool(client, session.id, "tenncare-teds-bot", "tenncare-renewal-notice-draft@1", async (i) => ({ enrollee: i.enrolleeId, notice: "assembled" }));
const tedsTerminate = governedTool(client, session.id, "tenncare-teds-bot", "tenncare-coverage-terminate-commit@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const caseworkerTerminate = governedTool(client, session.id, "tenncare-caseworker-bot", "tenncare-coverage-terminate-commit@1", async () => { throw new Error("unreachable: high-risk is refused on the proxy"); });

// 1. The TEDS engine evaluates eligibility — allowed (it holds the evaluate grant).
console.log("TEDS evaluates eligibility:", JSON.stringify(await evalEligibility({ enrolleeId: "E-5001", household: "wrong-household", basis: "SSA-income-data-not-loaded" })));

// 2. The TEDS engine assembles the determination notice — allowed (reversible).
console.log("TEDS drafts notice:", JSON.stringify(await draftDetermination({ enrolleeId: "E-5001" })));

// 3. The TEDS engine tries to execute the termination on its own determination —
//    denied by default; the automated system holds no terminate grant, so the
//    defective determination never cuts anyone's coverage. This is the missing
//    independent check the court found absent.
try {
  await tedsTerminate({ enrolleeId: "E-5001" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`TEDS auto-terminate DENIED (${err.code}): ${err.reason}`);
}

// 4. Even the human caseworker, who DOES hold the terminate grant, cannot cut
//    coverage inline: termination is high-risk and must run through a governed
//    flow with a preceding approval gate, where an independent checker verifies
//    the household assignment, the loaded eligibility data, and the adequacy of
//    the notice before benefits are terminated.
try {
  await caseworkerTerminate({ enrolleeId: "E-5001" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`caseworker inline terminate DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
