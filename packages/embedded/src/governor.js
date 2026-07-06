// @makerchecker/embedded/governor — the stateful Policy Enforcement Point.
//
// The governor composes the pure ./policy decision with the one piece of state a
// decision cannot be pure about: which roles have already acted in a session
// (separation of duties). It wraps your tool functions so a call is authorized
// before it runs and refused before any side effect, and it emits every
// decision — allow AND deny — to an optional sink (that is how the ./audit chain
// attaches, without the governor ever importing crypto).
//
//   import { createGovernor } from "@makerchecker/embedded/governor";
//   const gov = createGovernor();
//   gov.defineSkill("pay@1", { riskTier: "high" })
//      .defineRole("bot").defineAgent("agent-1", "bot");
//   const pay = gov.wrap("agent-1", "pay@1", async (i) => rail.wire(i));
//   await pay({ amountUsd: 1_000_000 });   // throws GovernanceDeniedError
//
// No audit chain is attached here — this tier records nothing unless you give it
// an onDecision sink. The batteries-included root export (@makerchecker/embedded)
// wires a signed chain in for you.
import {
  createPolicyBuilder,
  decide as policyDecide,
  definePolicy,
  GovernanceDeniedError,
} from "./policy.js";

function toBuilder(policyOrSpec) {
  const builder = createPolicyBuilder();
  if (!policyOrSpec) return builder;
  const p = policyOrSpec.skills instanceof Map ? policyOrSpec : definePolicy(policyOrSpec);
  for (const [ref, s] of p.skills) builder.defineSkill(ref, { ...s });
  for (const [name, r] of p.roles) {
    builder.defineRole(name, { grants: [...r.grants], conflicts: [...r.conflicts] });
  }
  for (const [name, a] of p.agents) builder.defineAgent(name, a.role, { ...a });
  return builder;
}

/**
 * Create a governor.
 *
 * @param opts.policy      an existing Policy or spec to seed from (optional)
 * @param opts.onDecision  (event) => void, called for every allow and deny
 * @param opts.clock       () => string, the timestamp source (default: ISO now)
 */
export function createGovernor(opts = {}) {
  const builder = toBuilder(opts.policy);
  const onDecision = typeof opts.onDecision === "function" ? opts.onDecision : null;
  const clock = typeof opts.clock === "function" ? opts.clock : () => new Date().toISOString();

  // Per-session record of which roles have already acted (been allowed). This is
  // the impurity lifted out of decide(): it is passed IN to the pure decision.
  const actorsBySession = new Map(); // sessionId -> Set<roleName>

  const policy = () => builder.snapshot();

  function roleOf(agentName) {
    return policy().agents.get(agentName)?.role ?? null;
  }

  function priorActors(sessionId) {
    return [...(actorsBySession.get(sessionId) ?? [])];
  }

  function recordActor(sessionId, roleName) {
    if (!roleName) return;
    if (!actorsBySession.has(sessionId)) actorsBySession.set(sessionId, new Set());
    actorsBySession.get(sessionId).add(roleName);
  }

  // Emit one governance event to the sink. occurredAt is stamped ONCE here (the
  // governor's clock) and used by the audit chain for both the hash and the row.
  function emit(eventType, agentName, roleName, sessionId, skillRef, extra) {
    if (!onDecision) return;
    onDecision({
      eventType,
      actor: { agentName, roleName, sessionId },
      entityType: "skill",
      entityId: skillRef,
      runId: sessionId,
      payload: { skillRef, agentName, ...extra },
      occurredAt: clock(),
    });
  }

  // Shared path for check() and wrap(): decide, record the outcome, and advance
  // the SoD actor set only on an allowed act.
  function authorize(agentName, skillRef, { sessionId, hasSeparationGate, input, emitInput }) {
    const roleName = roleOf(agentName);
    const decision = policyDecide(
      policy(),
      { agent: agentName, skill: skillRef },
      { sessionActors: priorActors(sessionId), hasSeparationGate },
    );
    if (decision.effect === "deny") {
      const eventType =
        decision.code === "sod_violation" ? "enforcement.sod_violation" : "enforcement.blocked";
      emit(eventType, agentName, roleName, sessionId, skillRef, { code: decision.code });
      return decision;
    }
    emit("proxy.check.allowed", agentName, roleName, sessionId, skillRef, emitInput ? { input } : undefined);
    recordActor(sessionId, roleName);
    return decision;
  }

  const api = {
    // ── definition (fluent) ──────────────────────────────────────────────
    defineSkill(ref, opts2 = {}) {
      builder.defineSkill(ref, opts2);
      return api;
    },
    defineRole(name, opts2 = {}) {
      builder.defineRole(name, opts2);
      return api;
    },
    defineConflict(a, b) {
      builder.defineConflict(a, b);
      return api;
    },
    grant(roleName, skillRef) {
      builder.grant(roleName, skillRef);
      return api;
    },
    defineAgent(name, roleName, opts2 = {}) {
      builder.defineAgent(name, roleName, opts2);
      return api;
    },

    /** A frozen, serializable snapshot of the current policy. */
    policy() {
      return builder.freeze();
    },

    /** Roles that have already acted in a session (for inspection). */
    sessionActors(sessionId = "default") {
      return priorActors(sessionId);
    },

    // ── decisions ────────────────────────────────────────────────────────
    /**
     * Dry-run: return the Decision for (agent, skill) with NO recording and NO
     * change to session state. For dashboards, tests, and "may I?" checks.
     */
    decide(agentName, skillRef, { sessionId = "default", hasSeparationGate = false } = {}) {
      return policyDecide(
        policy(),
        { agent: agentName, skill: skillRef },
        { sessionActors: priorActors(sessionId), hasSeparationGate },
      );
    },

    /**
     * Authorize an act: record the decision to the sink and, if allowed, commit
     * the role into the session's SoD actor set. Does NOT execute anything.
     * Returns the Decision.
     */
    check(agentName, skillRef, { sessionId = "default", hasSeparationGate = false, input } = {}) {
      return authorize(agentName, skillRef, {
        sessionId,
        hasSeparationGate,
        input,
        emitInput: input !== undefined,
      });
    },

    /**
     * Wrap a tool so every call is authorized first and recorded either way. A
     * denied call appends a blocked event and throws GovernanceDeniedError — the
     * executor never runs. An allowed call runs the executor and appends a result
     * event. sessionId is bound here but can be overridden per call.
     */
    wrap(agentName, skillRef, executor, { sessionId = "default", hasSeparationGate = false } = {}) {
      return async (input, callOpts = {}) => {
        const sid = callOpts.sessionId ?? sessionId;
        const gate = callOpts.hasSeparationGate ?? hasSeparationGate;
        const roleName = roleOf(agentName);
        const decision = authorize(agentName, skillRef, {
          sessionId: sid,
          hasSeparationGate: gate,
          input,
          emitInput: true,
        });
        if (decision.effect === "deny") {
          throw new GovernanceDeniedError(decision.code, decision.reason);
        }
        const output = await executor(input);
        emit("proxy.result.recorded", agentName, roleName, sid, skillRef, { output });
        return output;
      };
    },
  };
  // Backward-compatible alias.
  api.governedTool = api.wrap;
  return api;
}
