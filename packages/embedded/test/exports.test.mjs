// tsc runs with skipLibCheck and no .js files in the program, so it cannot catch
// a .d.ts that has drifted from the runtime exports. This pins the ACTUAL
// runtime export surface of every tier and the root, so adding, removing, or
// renaming an export without updating this list (and its matching .d.ts) fails
// CI instead of silently misleading TypeScript consumers.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as policy from "../src/policy.js";
import * as governor from "../src/governor.js";
import * as audit from "../src/audit.js";
import * as root from "../src/index.js";

const keys = (m) => Object.keys(m).sort();

test("./policy exports exactly the pure primitives", () => {
  assert.deepEqual(keys(policy), [
    "DECISION_CODES",
    "GovernanceDeniedError",
    "createPolicyBuilder",
    "decide",
    "definePolicy",
    "enforce",
    "policyToSpec",
  ]);
});

test("./governor exports exactly the enforcement point", () => {
  assert.deepEqual(keys(governor), ["createGovernor"]);
});

test("./audit exports exactly the evidentiary layer", () => {
  assert.deepEqual(keys(audit), [
    "GENESIS_PREFIX",
    "SCHEMA_VERSION",
    "createAuditChain",
    "genesisPrevHash",
  ]);
});

test("root re-exports every symbol from the three tiers (governor aliased)", () => {
  const surface = new Set(keys(root));
  for (const k of keys(policy)) assert.ok(surface.has(k), `root is missing policy export ${k}`);
  for (const k of keys(audit)) assert.ok(surface.has(k), `root is missing audit export ${k}`);
  // the governor tier's createGovernor is surfaced as createGovernorCore, and the
  // root adds its own batteries-included createGovernor (chain attached).
  assert.ok(surface.has("createGovernorCore"), "root is missing createGovernorCore");
  assert.ok(surface.has("createGovernor"), "root is missing createGovernor");
});
