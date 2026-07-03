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

test("both reject the same ill-formed input (fail-closed parity)", () => {
  const bad = "\ud800"; // unpaired high surrogate
  assert.throws(() => vendored(bad));
  assert.throws(() => source(bad));
});
