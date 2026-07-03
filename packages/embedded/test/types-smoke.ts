// Compile-only smoke test: exercises every public type surface so `tsc` fails if
// a .d.ts drifts from how the package is actually meant to be used. Not run at
// runtime — it exists purely for `npm run typecheck`.
import {
  createGovernor,
  createGovernorCore,
  createAuditChain,
  definePolicy,
  createPolicyBuilder,
  decide,
  enforce,
  policyToSpec,
  DECISION_CODES,
  GovernanceDeniedError,
} from "../src/index.js";
import type {
  Decision,
  Policy,
  DecisionCode,
} from "../src/policy.js";
import type { EmbeddedGovernor } from "../src/index.js";
import type { Governor } from "../src/governor.js";
import type { AuditBundle } from "../src/audit.js";

// ── Pure tier: definePolicy + decide + enforce ──────────────────────────────
const policy: Policy = definePolicy({
  skills: { "read@1": {}, "pay@1": { riskTier: "high" }, "old@1": "low" },
  roles: { maker: { grants: ["read@1"], conflicts: ["checker"] }, checker: { grants: ["pay@1"] } },
  agents: { bot: { role: "maker" }, officer: "checker" },
  conflicts: [["maker", "checker"]],
});

const d: Decision = decide(policy, { agent: "bot", skill: "read@1" }, { sessionActors: ["checker"], hasSeparationGate: false });
if (d.effect === "deny") {
  const code: DecisionCode = d.code;
  void code;
}
const allowed = enforce(policy, { agent: "bot", skill: "read@1" });
void allowed.effect;

const spec = policyToSpec(policy);
void spec.skills["pay@1"];

const builder = createPolicyBuilder();
builder.defineSkill("x@1").defineRole("r").grant("r", "x@1").defineAgent("a", "r");
const frozen: Policy = builder.freeze();
void decide(frozen, { agent: "a", skill: "x@1" });

const someCode: DecisionCode = DECISION_CODES.SKILL_NOT_GRANTED;
void someCode;

// ── Governor tier (bare, bring-your-own sink) ───────────────────────────────
const bare: Governor = createGovernorCore({ onDecision: (e) => void e.eventType });
bare.defineSkill("read@1").defineRole("bot").defineAgent("a1", "bot").grant("bot", "read@1");
const tool = bare.wrap<{ x: number }, number>("a1", "read@1", async (i) => i.x);
const p: Promise<number> = tool({ x: 1 }, { sessionId: "s1" });
void p;
void bare.decide("a1", "read@1").effect;
void bare.sessionActors("s1");

// ── Root tier (batteries-included) ──────────────────────────────────────────
const gov: EmbeddedGovernor = createGovernor({ instanceId: "fixed" });
gov.defineSkill("pay@1", { riskTier: "high" }).defineRole("bot").defineAgent("a1", "bot");
const bundle: AuditBundle = gov.exportBundle();
void bundle.manifest.signature;
void gov.auditTrail();
void gov.instanceId;

// ── Audit tier standalone ───────────────────────────────────────────────────
const chain = createAuditChain({ instanceId: "fixed" });
chain.append({ eventType: "e", actor: { agentName: "a" }, payload: {} });
void chain.keyIsEphemeral;

function handle(err: unknown): DecisionCode | null {
  return err instanceof GovernanceDeniedError ? err.code : null;
}
void handle;
