// Guard: the vendored RFC 8785 serializer must stay byte-for-byte identical to
// MakerChecker's source of truth, or an embedded-produced hash stops matching
// what the server and the offline verifier compute. If this ever fails, re-sync
// src/vendor/canonical-json.js from packages/shared/src/canonical-json.ts.
import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalJson as vendored } from "../src/vendor/canonical-json.js";
import { canonicalJson as source } from "../../proof-verifier/src/canonical-json.js";

const FIXTURES = [
  null,
  true,
  false,
  0,
  -0,
  1.5,
  1e21,
  "hello",
  "unicode: café ☕ 𝄞",
  [],
  [1, 2, 3],
  [null, undefined, 3], // holes/undefined -> null
  {},
  { b: 1, a: 2, c: 3 }, // key sort
  { z: { y: 1, x: 2 }, a: [3, 2, 1] }, // nested sort
  { keep: 1, drop: undefined }, // undefined members omitted
  {
    id: "abc",
    occurredAt: "2026-07-04T00:00:00.000Z",
    actor: { agentName: "bot", roleName: "maker", sessionId: "s1" },
    eventType: "proxy.check.allowed",
    entityType: "skill",
    entityId: "pay@1",
    runId: "s1",
    payload: { skillRef: "pay@1", agentName: "bot", input: { amountUsd: 1000000 } },
    prevHash: "0".repeat(64),
  },
];

test("vendored canonicalJson matches the source serializer on every fixture", () => {
  for (const f of FIXTURES) {
    assert.equal(vendored(f), source(f), `mismatch for ${JSON.stringify(f)}`);
  }
});

// Inputs both serializers must REJECT — one per throwing branch. The plain
// value-fixtures above only exercise the happy paths, so a divergence in an
// error branch (a vendored copy that silently coerced NaN, or accepted a lone
// surrogate) would pass unnoticed and let a bundle sign under one serializer yet
// fail — or falsely verify — under the other. Confirmed both throw for each.
const REJECTED = [
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["-Infinity", -Infinity],
  ["BigInt", 5n],
  ["function", () => {}],
  ["symbol", Symbol("x")],
  ["Date (non-plain object)", new Date(0)],
  ["class instance (non-plain object)", new (class C { constructor() { this.a = 1; } })()],
  ["lone surrogate as a value", "\ud800"],
  ["lone surrogate in a key", { "\ud800": 1 }],
  ["lone surrogate nested in an array", ["\ud800"]],
  ["lone surrogate nested in an object value", { k: "\ud800" }],
];

test("vendored and source reject the same inputs (fail-closed parity on every throwing branch)", () => {
  for (const [name, input] of REJECTED) {
    assert.throws(() => vendored(input), undefined, `vendored should reject ${name}`);
    assert.throws(() => source(input), undefined, `source should reject ${name}`);
  }
});

test("both accept a null-prototype object as a plain property bag", () => {
  // Object.create(null) is NOT a class instance — it must serialize like a plain
  // object (sorted keys), not be rejected as a non-plain object.
  const bag = Object.assign(Object.create(null), { b: 2, a: 1 });
  assert.equal(vendored(bag), source(bag));
  assert.equal(vendored(bag), '{"a":1,"b":2}');
});
