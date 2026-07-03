// @makerchecker/embedded — in-process MakerChecker governance, no server, no
// Postgres. This root export is batteries-included: it re-exports the three
// composable tiers and gives you a createGovernor() that already has a signed
// audit chain attached, so the simple case stays a one-liner.
//
//   import { createGovernor, GovernanceDeniedError } from "@makerchecker/embedded";
//   const gov = createGovernor();
//   gov.defineSkill("pay@1", { riskTier: "high" })
//      .defineRole("bot").defineAgent("agent-1", "bot");
//   const pay = gov.wrap("agent-1", "pay@1", async (i) => actuallyPay(i));
//   await pay({ amountUsd: 1_000_000 });   // throws GovernanceDeniedError
//   const bundle = gov.exportBundle();      // verifies in @makerchecker/proof-verifier
//
// The three tiers, if you want them à la carte:
//   @makerchecker/embedded/policy    — the pure decision (no crypto, no clock, no state)
//   @makerchecker/embedded/governor  — the stateful enforcement point (no crypto)
//   @makerchecker/embedded/audit     — the optional signed, verifiable chain
//
// Import ./policy alone to get deny-by-default authorization + separation of
// duties with ZERO dependencies and no audit chain at all — the "use the
// primitives without the chain or a database" path.

import { createGovernor as createGovernorPEP } from "./governor.js";
import { createAuditChain } from "./audit.js";

// Pure decision primitives — usable with no chain and no crypto.
export {
  definePolicy,
  policyToSpec,
  createPolicyBuilder,
  decide,
  enforce,
  DECISION_CODES,
  GovernanceDeniedError,
} from "./policy.js";

// The bare enforcement point (no audit), for when you bring your own sink.
export { createGovernor as createGovernorCore } from "./governor.js";

// The optional evidentiary layer.
export { createAuditChain, genesisPrevHash, SCHEMA_VERSION } from "./audit.js";

/**
 * Batteries-included governor: a stateful enforcement point with a signed,
 * offline-verifiable audit chain already attached as its decision sink.
 *
 * @param opts.policy        an existing Policy or spec to seed from (optional)
 * @param opts.clock         () => string timestamp source (default: ISO now)
 * @param opts.instanceId    stable id for the audit chain's genesis root
 * @param opts.privateKey    Ed25519 KeyObject to sign bundles with (optional)
 * @param opts.publicKeyPem  matching SPKI PEM (required if privateKey given)
 */
export function createGovernor(opts = {}) {
  const chain = createAuditChain({
    instanceId: opts.instanceId,
    privateKey: opts.privateKey,
    publicKeyPem: opts.publicKeyPem,
  });
  const gov = createGovernorPEP({
    policy: opts.policy,
    clock: opts.clock,
    onDecision: (event) => chain.append(event),
  });

  // Expose the chain's read/export surface on the governor for the one-liner
  // case (backward compatible with the single-file version's API).
  gov.auditTrail = () => chain.rows();
  gov.exportBundle = () => chain.exportBundle();
  gov.auditChain = chain; // escape hatch for advanced use
  Object.defineProperty(gov, "instanceId", { get: () => chain.instanceId, enumerable: true });
  Object.defineProperty(gov, "publicKeyPem", { get: () => chain.publicKeyPem, enumerable: true });
  return gov;
}
