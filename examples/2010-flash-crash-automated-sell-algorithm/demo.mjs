#!/usr/bin/env node
// 2010 Flash Crash (May 6, 2010): a fundamental trader launched an automated
// program to sell 75,000 E-mini S&P 500 futures (~$4.1B), configured to
// participate at 9% of the prior minute's volume "without regard to price or
// time." Its own selling raised volume, which made it sell faster in a feedback
// loop, dumping the whole block in ~20 minutes and helping drive the Dow down
// ~998 points before a partial recovery. There was no price limit, no time
// constraint, and no liquidity-tied participation cap.
//
// The controls that stop it (controlsThatBlock: limit_violation,
// high_risk_requires_gate):
//   - The execution algo may work child slices, but each slice is bounded by a
//     per-invocation notional ceiling (limit_violation) AND a per-run invocation
//     cap that acts as a pacing kill switch — the runaway feedback loop is
//     stopped after a bounded number of slices.
//   - Firing the whole $4.1B block at once is a high-risk skill: even the trading
//     desk that holds the grant cannot run it inline through the proxy; an
//     outsized order must pass an approval gate (high_risk_requires_gate).
//   - The execution algo holds no block grant at all (deny-by-default), so it can
//     never self-escalate to a full-block dump.
//
// Names are prefixed `flash-` so this demo does not collide with other incident
// demos sharing the server.
//
// Run: boot the server (`docker compose up`, or locally with
// MAKERCHECKER_AUTH_DISABLED=1), build the SDK, then:
//   node examples/2010-flash-crash-automated-sell-algorithm/demo.mjs
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
const planSlice = await ensureSkill(client, "flash-slice-plan@1", {
  description: "Compute a child order slice from a parent sell program; commits nothing",
});
const executeSlice = await ensureSkill(client, "flash-slice-execute@1", {
  description: "Execute one child slice, bounded by a notional ceiling and a pacing cap",
});
const executeBlock = await ensureSkill(client, "flash-block-execute@1", {
  riskTier: "high",
  description: "Fire the entire multi-billion-dollar sell program at once (irreversible)",
});

// The execution algo plans slices and works them, but every slice is bounded:
// a per-invocation notional ceiling ($100M) and a per-run pacing cap of 3 child
// orders. The cap is the kill switch the flash-crash algorithm lacked — once the
// feedback loop tries to accelerate past the cap, further slices are refused.
// The algo holds NO block-execute grant at all.
const algoRole = await ensureRole(client, "flash-execution-algo", {
  description: "Works a parent order as bounded child slices; cannot fire the full block.",
  limits: {
    skills: {
      "flash-slice-execute@1": {
        maxAmountPerInvocation: 100_000_000,
        amountField: "notional",
        maxInvocationsPerRun: 3,
      },
    },
  },
});
// The trading desk is the named actor that may authorize a full-block execution,
// but that skill is high-risk: even holding the grant, it cannot run inline — an
// outsized $4.1B order must pass an approval gate before it touches the market.
const deskRole = await ensureRole(client, "flash-trading-desk", {
  description: "May authorize a full-block execution, only through a gated flow.",
});

await ensureGrant(client, algoRole, planSlice);
await ensureGrant(client, algoRole, executeSlice);
await ensureGrant(client, deskRole, executeBlock);
// flash-block-execute@1 is granted to no algo — the algo cannot self-escalate.

await ensureAgent(client, "flash-sell-algo-bot", "flash-execution-algo");
await ensureAgent(client, "flash-trading-desk-bot", "flash-trading-desk");

// --- Drive the governed agents through the proxy ---------------------------
const { session } = await client.proxy.openSession({ label: "flash-crash-emini-sell-program" });
console.log(`proxy session ${session.id} opened\n`);

const planChildSlice = governedTool(client, session.id, "flash-sell-algo-bot", "flash-slice-plan@1", async (i) => ({ slice: i.seq, notional: i.notional }));
const workSlice = governedTool(client, session.id, "flash-sell-algo-bot", "flash-slice-execute@1", async (i) => ({ status: "filled", notional: i.notional }));
const algoFireBlock = governedTool(client, session.id, "flash-sell-algo-bot", "flash-block-execute@1", async () => { throw new Error("unreachable: deny-by-default blocks this"); });
const deskFireBlock = governedTool(client, session.id, "flash-trading-desk-bot", "flash-block-execute@1", async () => { throw new Error("unreachable: high-risk is gated"); });

// 1. The algo plans a child slice — allowed (it holds the plan grant).
console.log("algo plans a slice:", JSON.stringify(await planChildSlice({ seq: 1, notional: 60_000_000 })));

// 2. The algo works a slice within the notional ceiling — allowed (positive
//    control: bounded, price-aware execution is exactly what we want).
console.log("algo works slice $60M:", JSON.stringify(await workSlice({ notional: 60_000_000 })));

// 3. The algo tries to slam a slice far above the per-invocation ceiling — the
//    "without regard to price" order — denied by the notional limit.
try {
  await workSlice({ notional: 4_100_000_000 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`oversized $4.1B slice DENIED (${err.code}): ${err.reason}`);
}

// 4. The pacing kill switch: the feedback loop keeps accelerating and works more
//    slices. Within the ceiling they fill until the per-run cap is reached, then
//    the runaway pace is refused — the throttle the flash-crash algo never had.
console.log("algo works slice $80M:", JSON.stringify(await workSlice({ notional: 80_000_000 })));
console.log("algo works slice $90M:", JSON.stringify(await workSlice({ notional: 90_000_000 })));
try {
  await workSlice({ notional: 70_000_000 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`runaway pace past cap DENIED (${err.code}): ${err.reason}`);
}

// 5. The algo tries to escalate straight to a full-block dump — denied by
//    default; it holds no block grant, so it can never fire the whole program.
try {
  await algoFireBlock({ notional: 4_100_000_000 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`algo full-block dump DENIED (${err.code}): ${err.reason}`);
}

// 6. Even the trading desk, which DOES hold the block grant, cannot fire the
//    $4.1B block inline: it is high-risk and must pass an approval gate before
//    an outsized order reaches the market.
try {
  await deskFireBlock({ notional: 4_100_000_000 });
} catch (err) {
  if (!(err instanceof GovernanceDeniedError)) throw err;
  console.log(`desk inline full-block DENIED (${err.code}): ${err.reason}`);
}

await client.proxy.closeSession(session.id);
await printTrailAndVerify(client, session.id);
