// The pure ./policy tier: deny-by-default authorization + separation of duties
// with NO chain, NO crypto, NO clock, NO state. This is the "use the primitives
// without the chain or a database" path.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  definePolicy,
  decide,
  enforce,
  policyToSpec,
  DECISION_CODES,
  GovernanceDeniedError,
} from "../src/policy.js";

function samplePolicy() {
  return definePolicy({
    skills: {
      "read@1": {},
      "propose@1": {},
      "pay@1": { riskTier: "high" },
      "old@1": { status: "deprecated" },
    },
    roles: {
      maker: { grants: ["read@1", "propose@1", "old@1"], conflicts: ["checker"] },
      checker: { grants: ["pay@1"] },
    },
    agents: {
      bot: { role: "maker" },
      officer: { role: "checker" },
      retired: { role: "maker", status: "suspended" },
    },
  });
}

test("allows a granted low-risk skill", () => {
  const d = decide(samplePolicy(), { agent: "bot", skill: "read@1" });
  assert.equal(d.effect, "allow");
  assert.equal(d.code, null);
});

test("deny-by-default: an ungranted skill is refused", () => {
  const d = decide(samplePolicy(), { agent: "bot", skill: "pay@1" });
  assert.equal(d.effect, "deny");
  assert.equal(d.code, DECISION_CODES.SKILL_NOT_GRANTED);
});

test("unknown agent and inactive agent", () => {
  assert.equal(decide(samplePolicy(), { agent: "ghost", skill: "read@1" }).code, "agent_not_found");
  const inactive = decide(samplePolicy(), { agent: "retired", skill: "read@1" });
  assert.equal(inactive.code, "agent_not_active");
  assert.match(inactive.reason, /suspended/);
});

test("unknown skill and deprecated skill", () => {
  assert.equal(decide(samplePolicy(), { agent: "bot", skill: "nope@1" }).code, "skill_not_found");
  assert.equal(decide(samplePolicy(), { agent: "bot", skill: "old@1" }).code, "skill_deprecated");
});

test("skill_deprecated fires for ANY non-published status, not just 'deprecated'", () => {
  // The rule is "publishable == status 'published'", so every other status —
  // draft, archived, or an unknown one — must be refused. Guards against a
  // regression that only special-cased the literal string 'deprecated'.
  for (const status of ["draft", "archived", "in-review", "retired", "totally-made-up"]) {
    const p = definePolicy({
      skills: { "s@1": { status } },
      roles: { r: { grants: ["s@1"] } },
      agents: { a: { role: "r" } },
    });
    const d = decide(p, { agent: "a", skill: "s@1" });
    assert.equal(d.code, "skill_deprecated", `status "${status}" should be refused as non-published`);
    assert.ok(d.reason.includes(status), `reason should name the status "${status}"`);
  }
  // and 'published' is the single status that passes the gate
  const ok = definePolicy({
    skills: { "s@1": { status: "published" } },
    roles: { r: { grants: ["s@1"] } },
    agents: { a: { role: "r" } },
  });
  assert.equal(decide(ok, { agent: "a", skill: "s@1" }).effect, "allow");
});

test("high-risk is refused inline but allowed with a separation gate", () => {
  const p = samplePolicy();
  assert.equal(decide(p, { agent: "officer", skill: "pay@1" }).code, "high_risk_requires_gate");
  const gated = decide(p, { agent: "officer", skill: "pay@1" }, { hasSeparationGate: true });
  assert.equal(gated.effect, "allow");
});

test("separation of duties fires regardless of declaration direction", () => {
  const p = samplePolicy(); // only `maker` declares the conflict with `checker`
  // checker acts first, then maker (the direction the old single-file bug allowed):
  const makerAfterChecker = decide(p, { agent: "bot", skill: "read@1" }, { sessionActors: ["checker"] });
  assert.equal(makerAfterChecker.code, "sod_violation");
  // maker acts first, then checker (needs the gate too, but SoD must also hold):
  const checkerAfterMaker = decide(
    p,
    { agent: "officer", skill: "pay@1" },
    { sessionActors: ["maker"], hasSeparationGate: true },
  );
  assert.equal(checkerAfterMaker.code, "sod_violation");
});

test("decide is pure: same inputs, same result, no side effects", () => {
  const p = samplePolicy();
  const a = decide(p, { agent: "bot", skill: "read@1" });
  const b = decide(p, { agent: "bot", skill: "read@1" });
  assert.deepEqual(a, b);
  // the policy is unchanged and still answers identically
  assert.equal(decide(p, { agent: "bot", skill: "read@1" }).effect, "allow");
});

test("enforce() throws GovernanceDeniedError carrying the code", () => {
  const p = samplePolicy();
  assert.doesNotThrow(() => enforce(p, { agent: "bot", skill: "read@1" }));
  assert.throws(
    () => enforce(p, { agent: "bot", skill: "pay@1" }),
    (e) => e instanceof GovernanceDeniedError && e.code === "skill_not_granted",
  );
});

test("policyToSpec round-trips a policy back to a serializable spec", () => {
  const spec = policyToSpec(samplePolicy());
  assert.equal(spec.skills["pay@1"].riskTier, "high");
  assert.deepEqual(spec.roles.checker.conflicts.sort(), ["maker"]); // mirrored
  assert.equal(spec.agents.bot.role, "maker");
  // and the round-tripped spec decides identically
  const p2 = definePolicy(spec);
  assert.equal(decide(p2, { agent: "bot", skill: "pay@1" }).code, "skill_not_granted");
});
