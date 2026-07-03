#!/usr/bin/env node
// Robert Williams / Detroit (January 2020): Detroit police ran a blurry
// surveillance still through a Michigan State Police facial recognition system,
// which falsely matched it to Williams' expired driver's-license photo. Officers
// acted on the unverified match and wrongfully arrested Williams in front of his
// family, detaining him for ~30 hours — the first publicly reported US wrongful
// arrest from a false facial recognition match. The reform Detroit later adopted
// requires face-recognition results to be corroborated with independent evidence
// before an arrest.
//
// This is a hypothetical maker-checker framing: the real arrest was carried out
// by human officers, not an automated system. But the fix maps cleanly onto the
// proxy — the facial recognition match is the "maker", and issuing an arrest
// warrant is the irreversible "checker" action that must not fire off a raw match.
//
// The control that stops it: running the match and pulling corroborating evidence
// are reversible and granted to the identification role; issuing an arrest warrant
// is the irreversible step. The identification role holds NO warrant grant, so a
// warrant off a raw match is refused by deny-by-default (skill_not_granted). And
// the warrant skill is published high-risk, so even the granted warrant role
// cannot issue it inline — it must run through a governed flow behind an approval
// gate where the match is corroborated with independent evidence first.
//
// Names are prefixed `rw-detroit-` so this demo does not collide with the other
// incident demos sharing the server.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/robert-williams-detroit-facial-recognition-wrongful-arrest-2020/demo.mjs
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
const faceMatch = await ensureSkill(client, "rw-detroit-face-match@1", {
  description: "Run a surveillance still through facial recognition; returns candidate matches only.",
});
const corroborate = await ensureSkill(client, "rw-detroit-evidence-corroborate@1", {
  description: "Check a candidate against independent evidence (alibi, location, witness); commits nothing.",
});
const warrant = await ensureSkill(client, "rw-detroit-arrest-warrant@1", {
  riskTier: "high",
  description: "Issue an arrest warrant and detain the suspect (irreversible).",
});

// The identification role runs the match and pulls corroborating evidence, but
// holds NO warrant grant — it cannot turn a candidate match into an arrest.
const identificationRole = await ensureRole(client, "rw-detroit-identification-role", {
  description: "Runs facial recognition and corroborates candidates; cannot issue arrest warrants.",
});
// The warrant role may issue warrants, but a warrant is high-risk and is refused
// on the proxy — it only proceeds through a governed flow with an approval gate
// where the match is corroborated with independent evidence first.
const warrantRole = await ensureRole(client, "rw-detroit-warrant-role", {
  description: "Issues arrest warrants, only through a gated flow with independent corroboration.",
});

await ensureGrant(client, identificationRole, faceMatch);
await ensureGrant(client, identificationRole, corroborate);
await ensureGrant(client, warrantRole, warrant);

await ensureAgent(client, "rw-detroit-facerec-bot", "rw-detroit-identification-role");
await ensureAgent(client, "rw-detroit-warrant-bot", "rw-detroit-warrant-role");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "rw-detroit-facial-recognition-arrest" });
console.log(`proxy session ${session.id} opened\n`);

const runMatch = governedTool(client, session.id, "rw-detroit-facerec-bot", "rw-detroit-face-match@1", async (i) => ({ probe: i.probe, candidate: "Robert Williams (expired DL photo)", confidence: "low", note: "blurry low-quality still" }));
const checkEvidence = governedTool(client, session.id, "rw-detroit-facerec-bot", "rw-detroit-evidence-corroborate@1", async (i) => ({ candidate: i.candidate, corroborated: false, reason: "alibi places suspect elsewhere; not near store" }));
const facerecWarrant = governedTool(client, session.id, "rw-detroit-facerec-bot", "rw-detroit-arrest-warrant@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const warrantInline = governedTool(client, session.id, "rw-detroit-warrant-bot", "rw-detroit-arrest-warrant@1", async () => { throw new Error("unreachable: high-risk is gated"); });

// 1. The identification agent runs the surveillance still through the matcher —
//    allowed (it holds the match grant). It returns a low-confidence candidate.
console.log("facerec runs match:", JSON.stringify(await runMatch({ probe: "shinola-surveillance-still.jpg" })));

// 2. The agent pulls independent corroborating evidence — allowed; a reversible
//    read. The check finds the match is NOT corroborated (wrong person).
console.log("facerec corroborates:", JSON.stringify(await checkEvidence({ candidate: "Robert Williams" })));

// 3. The identification agent tries to issue an arrest warrant straight off the
//    raw match — denied by default; the identification role holds no warrant
//    grant, so a face match can never itself become an arrest.
try {
  await facerecWarrant({ suspect: "Robert Williams", basis: "facial-recognition match only" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`facerec issue warrant DENIED (${err.code}): ${err.reason}`);
}

// 4. Even the warrant role, which DOES hold the grant, is refused on the proxy:
//    the warrant skill is high-risk and cannot run inline — it must go through a
//    governed flow with a preceding approval gate where the match is corroborated
//    with independent evidence before anyone is arrested.
try {
  await warrantInline({ suspect: "Robert Williams", basis: "facial-recognition match only" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`warrant inline issue DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
