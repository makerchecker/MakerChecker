#!/usr/bin/env node
// Anthropic Project Vend / "Claudius" (2025): an autonomous Claude agent ran a
// small office shop with end-to-end authority over purchasing, pricing and
// discounts and no human approval on individual transactions. Over a month it
// lost money — a below-cost ~40 tungsten-cube buying spree (its steepest one-day
// drop), plus discount codes and free giveaways cajoled out of it over Slack,
// including selling/giving away a drink for free next to a fridge of the same.
//
// The controls that stop it (the entry lists approval_gate + limit_violation):
//   * limit_violation — purchase orders carry a per-order cost ceiling, so the
//     tungsten-cube spree is refused; and discounts/giveaways carry a per-issue
//     dollar ceiling, so a full-price free giveaway is refused before money moves.
//   * deny-by-default — committing a bulk restock is granted to no shopkeeper
//     role, so the agent cannot self-authorize it.
//   * high_risk_requires_gate — the bulk-restock-commit skill is high-risk and is
//     categorically refused inline on the proxy; it must run through a governed
//     flow with a preceding human approval gate (the checker Claudius never had).
//
// Names are prefixed `vend-` so this demo does not collide with other incident
// demos sharing the server.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/anthropic-project-vend-claudius-shop-loss/demo.mjs
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
const inventory = await ensureSkill(client, "vend-inventory-check@1", {
  description: "Read current stock levels and cash balance; commits nothing",
});
const priceSet = await ensureSkill(client, "vend-price-set@1", {
  description: "Set the shelf price for an item (reversible)",
});
const purchase = await ensureSkill(client, "vend-purchase-order@1", {
  description: "Place a restock purchase order with the wholesaler",
});
const discount = await ensureSkill(client, "vend-discount-issue@1", {
  description: "Issue a discount / giveaway against an item",
});
const bulkCommit = await ensureSkill(client, "vend-bulk-restock-commit@1", {
  riskTier: "high",
  description: "Commit a large bulk restock order (consequential spend)",
});

// The shopkeeper agent ("Claudius") may read inventory and set prices freely,
// and may place small restock orders and small discounts — but every purchase
// is bounded by a per-order cost ceiling and every discount by a per-issue
// dollar ceiling. It holds NO grant to commit a bulk restock.
const shopkeeperRole = await ensureRole(client, "vend-shopkeeper-role", {
  description: "Runs the shop day-to-day within spend ceilings; no bulk authority.",
  limits: {
    skills: {
      "vend-purchase-order@1": {
        maxAmountPerInvocation: 200,
        amountField: "costUsd",
      },
      "vend-discount-issue@1": {
        maxAmountPerInvocation: 10,
        amountField: "discountUsd",
      },
    },
  },
});
// The purchasing manager may commit bulk restocks, but that skill is high-risk,
// so even a granted role cannot run it inline — it must pass an approval gate.
const managerRole = await ensureRole(client, "vend-purchasing-manager-role", {
  description: "Commits bulk restocks only through a governed flow with a gate.",
});

await ensureGrant(client, shopkeeperRole, inventory);
await ensureGrant(client, shopkeeperRole, priceSet);
await ensureGrant(client, shopkeeperRole, purchase);
await ensureGrant(client, shopkeeperRole, discount);
await ensureGrant(client, managerRole, bulkCommit);
// vend-bulk-restock-commit@1 is granted to no shopkeeper role.

await ensureAgent(client, "vend-claudius-bot", "vend-shopkeeper-role");
await ensureAgent(client, "vend-manager-bot", "vend-purchasing-manager-role");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "vend-claudius-shop" });
console.log(`proxy session ${session.id} opened\n`);

const checkStock = governedTool(client, session.id, "vend-claudius-bot", "vend-inventory-check@1", async (i) => ({ item: i.item, onHand: 4, cash: 812 }));
const setPrice = governedTool(client, session.id, "vend-claudius-bot", "vend-price-set@1", async (i) => ({ item: i.item, priceUsd: i.priceUsd }));
const placeOrder = governedTool(client, session.id, "vend-claudius-bot", "vend-purchase-order@1", async (i) => ({ item: i.item, qty: i.qty, costUsd: i.costUsd, status: "ordered" }));
const issueDiscount = governedTool(client, session.id, "vend-claudius-bot", "vend-discount-issue@1", async (i) => ({ item: i.item, discountUsd: i.discountUsd, status: "issued" }));
const shopkeeperBulk = governedTool(client, session.id, "vend-claudius-bot", "vend-bulk-restock-commit@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const managerBulk = governedTool(client, session.id, "vend-manager-bot", "vend-bulk-restock-commit@1", async () => { throw new Error("unreachable: high-risk is refused on the proxy"); });

// 1. Claudius reads its own inventory and cash — allowed (reversible read).
console.log("claudius checks stock:", JSON.stringify(await checkStock({ item: "coke-zero" })));

// 2. Claudius sets a sensible shelf price — allowed (reversible, granted).
console.log("claudius sets price:", JSON.stringify(await setPrice({ item: "coke-zero", priceUsd: 3 })));

// 3. Claudius places a small restock order within the cost ceiling — allowed.
console.log("claudius restocks chips $120:", JSON.stringify(await placeOrder({ item: "chips", qty: 24, costUsd: 120 })));

// 4. Claudius issues a small loyalty discount within the ceiling — allowed.
console.log("claudius issues $5 discount:", JSON.stringify(await issueDiscount({ item: "chips", discountUsd: 5 })));

// 5. The tungsten-cube spree: a $900 order for ~40 cubes blows past the per-order
//    cost ceiling — denied (limit_violation) before the money is committed.
try {
  await placeOrder({ item: "tungsten-cube", qty: 40, costUsd: 900 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`tungsten spree $900 order DENIED (${err.code}): ${err.reason}`);
}

// 6. Cajoled over Slack into giving a cube away for free — a $90 giveaway exceeds
//    the per-issue discount ceiling, so it is denied (limit_violation).
try {
  await issueDiscount({ item: "tungsten-cube", discountUsd: 90 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`free-cube giveaway DENIED (${err.code}): ${err.reason}`);
}

// 7. Claudius tries to self-authorize a bulk restock — denied by default; the
//    shopkeeper role holds no bulk-commit grant, so it never reaches a tool body.
try {
  await shopkeeperBulk({ item: "tungsten-cube", qty: 40, costUsd: 900 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`claudius bulk restock DENIED (${err.code}): ${err.reason}`);
}

// 8. Even the purchasing manager, who holds the grant, cannot commit the bulk
//    restock inline: the skill is high-risk and must run through a governed flow
//    with a preceding human approval gate — the checker Claudius never had.
try {
  await managerBulk({ item: "tungsten-cube", qty: 40, costUsd: 900 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`manager inline bulk restock DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
