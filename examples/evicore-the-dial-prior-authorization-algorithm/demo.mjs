#!/usr/bin/env node
// eviCore "the dial" (2024): a Cigna-owned prior-authorization contractor used an
// AI screen insiders call "the dial" as the first step on coverage requests. By
// design the algorithm could auto-approve or flag a request for human review, but
// it could not itself deny. The reported harm came from tuning the dial's routing
// threshold to push more requests into human review — raising downstream denials —
// while the doctors who issued the final denials sat inside the same firm that
// profited from them (a conflicted checker, not a missing one).
//
// The controls that stop it (the entry's approval_gate + sod_violation):
//   - The dial (maker) may auto-approve and flag, but holds NO deny grant, so a
//     denial issued directly by the algorithm is refused by deny-by-default —
//     the maker can never also be the party that denies (separation of duties).
//   - Retuning the dial's routing threshold is bounded: a small clinical
//     adjustment is allowed, but a large cost-driven swing to spike denials
//     trips a limit_violation.
//   - The final coverage denial is a high-risk skill: even the medical-reviewer
//     role that holds the grant cannot commit inline — it must run through a
//     governed flow behind an approval gate decided by an INDEPENDENT reviewer,
//     not the conflicted in-house checker.
//
// Names are prefixed `evicore-` so this demo does not collide with the other
// incident demos sharing the server.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/evicore-the-dial-prior-authorization-algorithm/demo.mjs
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
const autoApprove = await ensureSkill(client, "evicore-pa-auto-approve@1", {
  description: "The dial auto-approves a prior-auth request against policy (reversible)",
});
const flagReview = await ensureSkill(client, "evicore-pa-flag-review@1", {
  description: "The dial flags a request for human clinical review (reversible)",
});
const retune = await ensureSkill(client, "evicore-dial-retune@1", {
  description: "Adjust the dial's routing threshold; bounded per adjustment",
});
const denyCommit = await ensureSkill(client, "evicore-pa-deny-commit@1", {
  riskTier: "high",
  description: "Issue a final coverage denial against the member's benefit (irreversible)",
});

// The dial (maker) auto-approves and flags, and may retune the threshold within a
// bounded delta — but holds NO deny grant. By design it can never issue a denial.
const dialRole = await ensureRole(client, "evicore-dial-algorithm", {
  description: "Screens prior-auth requests: auto-approve or flag; cannot deny.",
  limits: {
    skills: {
      // Retuning the routing threshold is capped per adjustment: small clinical
      // tweaks pass, a large cost-driven swing to raise denials is refused.
      "evicore-dial-retune@1": {
        maxAmountPerInvocation: 5,
        amountField: "thresholdDelta",
      },
    },
  },
});
// The in-house medical reviewer holds the deny-commit grant, but the commit skill
// is high-risk, so even a granted reviewer cannot deny inline — it must pass an
// approval gate decided by an independent party (separation of duties).
const reviewerRole = await ensureRole(client, "evicore-medical-reviewer", {
  description: "Finalizes denials only through a gated flow with independent review.",
});

await ensureGrant(client, dialRole, autoApprove);
await ensureGrant(client, dialRole, flagReview);
await ensureGrant(client, dialRole, retune);
await ensureGrant(client, reviewerRole, denyCommit);
// evicore-pa-deny-commit@1 is granted to no maker/dial role.

await ensureAgent(client, "evicore-dial-bot", "evicore-dial-algorithm");
await ensureAgent(client, "evicore-reviewer-bot", "evicore-medical-reviewer");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "evicore-prior-auth-screening" });
console.log(`proxy session ${session.id} opened\n`);

const approve = governedTool(client, session.id, "evicore-dial-bot", "evicore-pa-auto-approve@1", async (i) => ({ request: i.requestId, decision: "approved" }));
const flag = governedTool(client, session.id, "evicore-dial-bot", "evicore-pa-flag-review@1", async (i) => ({ request: i.requestId, routedTo: "human-review" }));
const tune = governedTool(client, session.id, "evicore-dial-bot", "evicore-dial-retune@1", async (i) => ({ thresholdDelta: i.thresholdDelta, applied: true }));
const dialDeny = governedTool(client, session.id, "evicore-dial-bot", "evicore-pa-deny-commit@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const reviewerDeny = governedTool(client, session.id, "evicore-reviewer-bot", "evicore-pa-deny-commit@1", async () => { throw new Error("unreachable: high-risk is refused on the proxy"); });

// 1. The dial auto-approves a clean request — allowed (it holds the approve grant).
console.log("dial auto-approves PA-1001:", JSON.stringify(await approve({ requestId: "PA-1001" })));

// 2. The dial flags a borderline request for human review — allowed; reversible.
console.log("dial flags PA-1002 for review:", JSON.stringify(await flag({ requestId: "PA-1002" })));

// 3. A small clinical retune of the routing threshold — allowed (within the cap).
console.log("dial retune +3 (clinical):", JSON.stringify(await tune({ thresholdDelta: 3 })));

// 4. The dial tries to issue a denial itself — denied by default; the algorithm
//    holds no deny grant, so a denial can never originate from the maker. This is
//    the by-design "the dial cannot deny" boundary, enforced rather than assumed.
try {
  await dialDeny({ requestId: "PA-1002" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`dial issues denial DENIED (${err.code}): ${err.reason}`);
}

// 5. Tuning the dial hard to spike denials for cost reasons — denied; the swing
//    exceeds the per-adjustment cap. This is "the game they would play," bounded.
try {
  await tune({ thresholdDelta: 40 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`dial retune +40 (cost-driven) DENIED (${err.code}): ${err.reason}`);
}

// 6. Even the in-house reviewer, who holds the grant, cannot deny directly through
//    the proxy: the commit is high-risk and must run through a governed flow with a
//    preceding approval gate by an INDEPENDENT party — the separation of duties the
//    conflicted, same-firm checker never had.
try {
  await reviewerDeny({ requestId: "PA-1002" });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`in-house reviewer inline denial DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
