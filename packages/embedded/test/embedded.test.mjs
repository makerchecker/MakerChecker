import { test } from "node:test";
import assert from "node:assert/strict";

import { createGovernor, GovernanceDeniedError } from "../src/index.js";
import { verifyBundle } from "../../proof-verifier/src/verify-core.js";
import { nodeCrypto } from "../../proof-verifier/src/node-crypto.js";

function base() {
  const gov = createGovernor();
  gov.defineSkill("read@1")
    .defineSkill("propose@1")
    .defineSkill("pay@1", { riskTier: "high" })
    .defineRole("maker")
    .defineRole("checker")
    .grant("maker", "read@1")
    .grant("maker", "propose@1")
    .grant("checker", "pay@1")
    .defineAgent("bot", "maker")
    .defineAgent("officer", "checker");
  return gov;
}

test("allows a granted low-risk skill and returns the executor result", async () => {
  const gov = base();
  const read = gov.governedTool("bot", "read@1", async (i) => ({ echoed: i.x }));
  assert.deepEqual(await read({ x: 1 }), { echoed: 1 });
});

test("deny-by-default: ungranted skill is refused before the executor runs", async () => {
  const gov = base();
  let ran = false;
  const pay = gov.governedTool("bot", "pay@1", async () => {
    ran = true;
  });
  await assert.rejects(pay({ amountUsd: 1_000_000 }), (e) => {
    assert.ok(e instanceof GovernanceDeniedError);
    assert.equal(e.code, "skill_not_granted");
    return true;
  });
  assert.equal(ran, false, "executor must not run on denial");
});

test("high-risk skill cannot run inline even for a granted role", async () => {
  const gov = base();
  const pay = gov.governedTool("officer", "pay@1", async () => ({ released: true }));
  await assert.rejects(pay({ amountUsd: 240 }), (e) => e.code === "high_risk_requires_gate");
});

test("unknown agent is refused", async () => {
  const gov = base();
  const t = gov.governedTool("ghost", "read@1", async () => 1);
  await assert.rejects(t({}), (e) => e.code === "agent_not_found");
});

test("separation of duties: a conflicting role that already acted blocks the second", async () => {
  const gov = createGovernor();
  gov.defineSkill("draft@1")
    .defineSkill("approve@1")
    .defineConflict("author", "approver")
    .grant("author", "draft@1")
    .grant("approver", "approve@1")
    .defineAgent("a1", "author")
    .defineAgent("a2", "approver");
  await gov.governedTool("a1", "draft@1", async () => "drafted")({});
  const approve = gov.governedTool("a2", "approve@1", async () => "approved");
  await assert.rejects(approve({}), (e) => e.code === "sod_violation");
});

test("exported bundle verifies in the independent offline verifier", async () => {
  const gov = base();
  await gov.governedTool("bot", "read@1", async () => ({ ok: true }))({});
  try {
    await gov.governedTool("bot", "pay@1", async () => {})({});
  } catch {
    /* recorded as blocked */
  }
  const bundle = gov.exportBundle();
  const verdict = await verifyBundle(bundle, nodeCrypto);
  assert.equal(verdict.ok, true, verdict.reason);
  assert.equal(verdict.count, 3); // allow + result + blocked
});

test("tampering a recorded value is caught by the verifier", async () => {
  const gov = base();
  await gov.governedTool("bot", "propose@1", async () => ({ amountUsd: 240 }))({});
  const bundle = gov.exportBundle();
  bundle.events[1].payload.output.amountUsd = 1_000_000;
  const verdict = await verifyBundle(bundle, nodeCrypto);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /tampered|mismatch/);
});
