// The optional ./audit tier: a signed hash-chain that verifies in the
// independent proof-verifier, with LAZY key generation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import { createAuditChain, genesisPrevHash } from "../src/audit.js";
import { verifyBundle } from "../../proof-verifier/src/verify-core.js";
import { nodeCrypto } from "../../proof-verifier/src/node-crypto.js";

function actor() {
  return { agentName: "bot", roleName: "maker", sessionId: "s1" };
}

test("a standalone chain exports a bundle that verifies offline", async () => {
  const chain = createAuditChain();
  chain.append({ eventType: "proxy.check.allowed", actor: actor(), entityType: "skill", entityId: "read@1", runId: "s1", payload: { ok: true } });
  chain.append({ eventType: "proxy.result.recorded", actor: actor(), entityType: "skill", entityId: "read@1", runId: "s1", payload: { output: { n: 1 } } });
  const verdict = await verifyBundle(chain.exportBundle(), nodeCrypto);
  assert.equal(verdict.ok, true, verdict.reason);
  assert.equal(verdict.count, 2);
});

test("key generation is lazy: no key until first export", () => {
  const chain = createAuditChain();
  chain.append({ eventType: "e", actor: actor(), payload: {} });
  assert.equal(chain.publicKeyPem, null, "no key minted merely by appending");
  assert.equal(chain.keyIsEphemeral, true);
  chain.exportBundle();
  assert.match(chain.publicKeyPem, /BEGIN PUBLIC KEY/, "key minted on export");
});

test("a caller-supplied key is used and not flagged ephemeral", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const chain = createAuditChain({ privateKey, publicKeyPem });
  assert.equal(chain.keyIsEphemeral, false);
  chain.append({ eventType: "e", actor: actor(), payload: { a: 1 } });
  const bundle = chain.exportBundle();
  assert.equal(bundle.manifest.publicKeyPem, publicKeyPem);
  assert.equal((await verifyBundle(bundle, nodeCrypto)).ok, true);
});

test("the chain is genesis-rooted at genesisPrevHash(instanceId)", () => {
  const chain = createAuditChain({ instanceId: "fixed-instance" });
  const row = chain.append({ eventType: "e", actor: actor(), payload: {} });
  assert.equal(row.prev_hash, genesisPrevHash("fixed-instance"));
});

test("tampering a recorded value is caught by the verifier", async () => {
  const chain = createAuditChain();
  chain.append({ eventType: "proxy.result.recorded", actor: actor(), entityId: "pay@1", payload: { output: { amountUsd: 240 } } });
  const bundle = chain.exportBundle();
  bundle.events[0].payload.output.amountUsd = 1_000_000;
  const verdict = await verifyBundle(bundle, nodeCrypto);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /tamper|mismatch/i);
});
