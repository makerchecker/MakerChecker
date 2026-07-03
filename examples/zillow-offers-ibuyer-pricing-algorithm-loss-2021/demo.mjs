#!/usr/bin/env node
// Zillow Offers iBuyer (2021): an automated home-pricing model extended and
// closed binding cash purchase offers at scale, buying thousands of homes at
// prices above their expected resale value. The offers were committed
// automatically with no per-offer or aggregate spend gate, so a $304M Q3
// write-down and $240M-$265M in further Q4 losses (over $500M total) accrued
// before humans wound the program down.
//
// The control that stops it: estimating resale value and building a candidate
// offer are reversible and stay with the pricing bot. Committing a binding
// purchase offer is the irreversible step, and it carries a per-offer price
// ceiling plus a per-run invocation cap — so an offer priced above the model's
// own resale estimate is refused (limit_violation), and runaway buying beyond
// the run's cap is stopped (limit_violation). Authorizing aggregate spend
// beyond the portfolio threshold is a high-risk skill the proxy refuses inline:
// it must pass a pricing-committee approval gate (high_risk_requires_gate).
//
// Names are prefixed `zillow-` so this demo does not collide with other
// incident demos sharing the server.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/zillow-offers-ibuyer-pricing-algorithm-loss-2021/demo.mjs
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
const estimate = await ensureSkill(client, "zillow-resale-estimate@1", {
  description: "Estimate a home's future resale value; commits no capital.",
});
const buildOffer = await ensureSkill(client, "zillow-offer-price-build@1", {
  description: "Compose a candidate cash offer from the model; binds nothing.",
});
const commitOffer = await ensureSkill(client, "zillow-offer-commit@1", {
  description: "Extend and close a binding cash purchase offer (irreversible).",
});
const authorizeBuy = await ensureSkill(client, "zillow-portfolio-buy-authorize@1", {
  riskTier: "high",
  description: "Authorize aggregate home buying beyond the portfolio spend threshold.",
});

// The pricing bot estimates resale value, builds offers, and may commit
// offers — but every commit is bounded by a per-offer price ceiling and a
// per-run invocation cap, the gate Zillow Offers never had.
const pricingRole = await ensureRole(client, "zillow-pricing-bot-role", {
  description: "Prices homes and commits offers within a per-offer ceiling and a per-run cap.",
  limits: {
    skills: {
      "zillow-offer-commit@1": {
        maxAmountPerInvocation: 1_000_000,
        amountField: "offerPrice",
        maxInvocationsPerRun: 3,
      },
    },
  },
});
// The pricing committee may authorize aggregate buying, but that skill is
// high-risk and is refused on the proxy — it only proceeds through a governed
// flow with a preceding approval gate, never inline by the algorithm.
const committeeRole = await ensureRole(client, "zillow-pricing-committee-role", {
  description: "Authorizes portfolio-scale buying, only through a gated flow.",
});

await ensureGrant(client, pricingRole, estimate);
await ensureGrant(client, pricingRole, buildOffer);
await ensureGrant(client, pricingRole, commitOffer);
await ensureGrant(client, committeeRole, authorizeBuy);

await ensureAgent(client, "zillow-pricing-bot", "zillow-pricing-bot-role");
await ensureAgent(client, "zillow-pricing-committee", "zillow-pricing-committee-role");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "zillow-offers-ibuyer-pricing" });
console.log(`proxy session ${session.id} opened\n`);

const estimateResale = governedTool(client, session.id, "zillow-pricing-bot", "zillow-resale-estimate@1", async (i) => ({ address: i.address, resaleEstimate: i.resaleEstimate }));
const composeOffer = governedTool(client, session.id, "zillow-pricing-bot", "zillow-offer-price-build@1", async (i) => ({ address: i.address, offerPrice: i.offerPrice }));
const closeOffer = governedTool(client, session.id, "zillow-pricing-bot", "zillow-offer-commit@1", async (i) => ({ status: "closed", address: i.address, offerPrice: i.offerPrice }));
const committeeAuthorize = governedTool(client, session.id, "zillow-pricing-committee", "zillow-portfolio-buy-authorize@1", async () => { throw new Error("unreachable: high-risk is refused on the proxy"); });

// 1. The bot estimates a home's resale value — allowed (reversible read).
console.log("bot estimates resale:", JSON.stringify(await estimateResale({ address: "123 Maple St", resaleEstimate: 520_000 })));

// 2. The bot builds a candidate offer — allowed; a draft binds no capital.
console.log("bot builds offer:", JSON.stringify(await composeOffer({ address: "123 Maple St", offerPrice: 600_000 })));

// 3. The bot commits an offer within the per-offer ceiling — allowed.
console.log("bot commits $600k offer:", JSON.stringify(await closeOffer({ address: "123 Maple St", offerPrice: 600_000 })));

// 4. The model overprices a home above the per-offer ceiling — denied; this is
//    exactly the pattern that drove the write-down, an offer priced past what
//    the home could later be sold for.
try {
  await closeOffer({ address: "9 Overpay Ave", offerPrice: 2_500_000 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`overpriced $2.5M offer DENIED (${err.code}): ${err.reason}`);
}

// 5. Two more offers within the ceiling — allowed, filling the per-run cap.
console.log("bot commits $700k offer:", JSON.stringify(await closeOffer({ address: "456 Oak St", offerPrice: 700_000 })));
console.log("bot commits $800k offer:", JSON.stringify(await closeOffer({ address: "789 Pine St", offerPrice: 800_000 })));

// 6. Runaway buying: past the per-run invocation cap, further commits are
//    refused even within the ceiling — the automated buying stream is stopped.
try {
  await closeOffer({ address: "12 Elm St", offerPrice: 500_000 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`buying past the run cap DENIED (${err.code}): ${err.reason}`);
}

// 7. Escalating to portfolio-scale buying cannot run inline: the authorize
//    skill is high-risk and must pass a pricing-committee approval gate, not
//    execute as an automated call.
try {
  await committeeAuthorize({ spend: 2_800_000_000 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`portfolio buy authorize DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
