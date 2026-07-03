// The ./governor tier: stateful enforcement with a pluggable decision sink and
// NO crypto. Uses the bare createGovernorCore so we can observe the sink.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createGovernorCore } from "../src/index.js";
import { GovernanceDeniedError } from "../src/policy.js";

function withSink() {
  const events = [];
  const gov = createGovernorCore({ onDecision: (e) => events.push(e) });
  gov.defineSkill("read@1")
    .defineSkill("pay@1", { riskTier: "high" })
    .defineRole("maker")
    .defineRole("checker")
    .grant("maker", "read@1")
    .grant("checker", "pay@1")
    .defineAgent("bot", "maker")
    .defineAgent("officer", "checker");
  return { gov, events };
}

test("wrap runs the executor on allow and records allow + result", async () => {
  const { gov, events } = withSink();
  const read = gov.wrap("bot", "read@1", async (i) => ({ echoed: i.x }));
  assert.deepEqual(await read({ x: 7 }), { echoed: 7 });
  assert.deepEqual(
    events.map((e) => e.eventType),
    ["proxy.check.allowed", "proxy.result.recorded"],
  );
});

test("wrap throws before the executor runs on deny", async () => {
  const { gov, events } = withSink();
  let ran = false;
  const pay = gov.wrap("bot", "pay@1", async () => {
    ran = true;
  });
  await assert.rejects(pay({}), (e) => e instanceof GovernanceDeniedError && e.code === "skill_not_granted");
  assert.equal(ran, false);
  assert.equal(events[0].eventType, "enforcement.blocked");
});

test("decide() is a dry-run: no sink event, no actor recorded", () => {
  const { gov, events } = withSink();
  const d = gov.decide("bot", "read@1");
  assert.equal(d.effect, "allow");
  assert.equal(events.length, 0);
  assert.deepEqual(gov.sessionActors(), []);
});

test("check() records the decision and commits the actor on allow", () => {
  const { gov, events } = withSink();
  const d = gov.check("bot", "read@1");
  assert.equal(d.effect, "allow");
  assert.equal(events.length, 1);
  assert.deepEqual(gov.sessionActors(), ["maker"]);
});

test("SoD is symmetric even when only one role declares the conflict (bug fix)", async () => {
  const events = [];
  const gov = createGovernorCore({ onDecision: (e) => events.push(e) });
  // Only `author` declares the conflict; `approver` does not.
  gov.defineSkill("draft@1")
    .defineSkill("approve@1")
    .defineRole("author", { conflicts: ["approver"] })
    .defineRole("approver")
    .grant("author", "draft@1")
    .grant("approver", "approve@1")
    .defineAgent("a1", "author")
    .defineAgent("a2", "approver");
  // author acts first (the direction that used to silently allow)...
  await gov.wrap("a1", "draft@1", async () => "drafted")({});
  // ...then approver must be blocked by SoD.
  const approve = gov.wrap("a2", "approve@1", async () => "approved");
  await assert.rejects(approve({}), (e) => e.code === "sod_violation");
  assert.ok(events.some((e) => e.eventType === "enforcement.sod_violation"));
});

test("per-call sessionId isolates separate SoD sessions", async () => {
  const gov = createGovernorCore();
  gov.defineSkill("draft@1")
    .defineSkill("approve@1")
    .defineConflict("author", "approver")
    .grant("author", "draft@1")
    .grant("approver", "approve@1")
    .defineAgent("a1", "author")
    .defineAgent("a2", "approver");
  const draft = gov.wrap("a1", "draft@1", async () => "d");
  const approve = gov.wrap("a2", "approve@1", async () => "a");
  await draft({}, { sessionId: "run-A" });
  // same run: conflict blocks
  await assert.rejects(approve({}, { sessionId: "run-A" }), (e) => e.code === "sod_violation");
  // different run: no prior actor, so it is allowed
  assert.equal(await approve({}, { sessionId: "run-B" }), "a");
});

test("deprecated skill is refused with skill_deprecated", () => {
  const gov = createGovernorCore();
  gov.defineSkill("old@1", { status: "deprecated" })
    .defineRole("bot")
    .grant("bot", "old@1")
    .defineAgent("agent-1", "bot");
  assert.equal(gov.decide("agent-1", "old@1").code, "skill_deprecated");
});
