// @makerchecker/embedded/policy — the pure decision core (Policy Decision Point).
//
// This module is deliberately dependency-free: NO node:crypto, NO clock, NO I/O,
// NO hidden mutable state. Import it to answer one question — "is this agent
// allowed to use this skill right now?" — deny-by-default, with a stable machine
// code and a human reason. It runs anywhere JavaScript runs (Node, browser,
// edge, a WASM worker, a hot loop) and a decision is a pure function of its
// inputs, so it is trivially testable and replayable.
//
//   import { definePolicy, decide, enforce } from "@makerchecker/embedded/policy";
//
//   const policy = definePolicy({
//     skills: { "read@1": {}, "pay@1": { riskTier: "high" } },
//     roles:  { "bot": { grants: ["read@1"] } },
//     agents: { "agent-1": { role: "bot" } },
//   });
//
//   decide(policy, { agent: "agent-1", skill: "pay@1" });
//   // -> { effect: "deny", code: "skill_not_granted", reason: "..." }
//
// The decision order and codes mirror the MakerChecker server's enforce()
// (packages/server/src/engine/enforcement.ts) exactly, so the same policy decided
// in-process here and by the server yields the same verdict. The stateful pieces
// the server keeps in Postgres — which roles have already acted this session
// (separation of duties), and whether a preceding approval gate exists — are
// passed IN as `context`, never stored here.

/** The stable set of denial codes. Identical to the server's EnforcementError codes. */
export const DECISION_CODES = Object.freeze({
  AGENT_NOT_FOUND: "agent_not_found",
  AGENT_NOT_ACTIVE: "agent_not_active",
  SKILL_NOT_FOUND: "skill_not_found",
  SKILL_DEPRECATED: "skill_deprecated",
  SKILL_NOT_GRANTED: "skill_not_granted",
  HIGH_RISK_REQUIRES_GATE: "high_risk_requires_gate",
  SOD_VIOLATION: "sod_violation",
});

/** Thrown by enforce() (and by the governor) when a governed call is refused. */
export class GovernanceDeniedError extends Error {
  constructor(code, reason) {
    super(reason);
    this.name = "GovernanceDeniedError";
    this.code = code;
    this.reason = reason;
  }
}

const ALLOW = Object.freeze({ effect: "allow", code: null, reason: null });
const deny = (code, reason) => Object.freeze({ effect: "deny", code, reason });

// ── Policy construction ──────────────────────────────────────────────────
//
// A Policy is a normalized, Map-backed bundle of skills, roles (grants +
// conflicts), and agents. Conflicts are stored SYMMETRICALLY (if maker conflicts
// with checker, checker conflicts with maker) so a separation-of-duties check
// never silently no-ops depending on which role happened to act first — a real
// bug the earlier single-file version had. definePolicy() freezes the result so
// a policy behaves like a reviewable artifact, not mutable global state.

function emptyPolicy() {
  return {
    skills: new Map(), // ref -> { riskTier, status }
    roles: new Map(), // name -> { grants:Set<ref>, conflicts:Set<name> }
    agents: new Map(), // name -> { role, status }
  };
}

/** Ensure a role entry exists so every referenced role participates in SoD. */
function ensureRole(policy, name) {
  let role = policy.roles.get(name);
  if (!role) {
    role = { grants: new Set(), conflicts: new Set() };
    policy.roles.set(name, role);
  }
  return role;
}

function addSkill(policy, ref, { riskTier = "low", status = "published" } = {}) {
  policy.skills.set(ref, { riskTier, status });
}

function addGrant(policy, roleName, skillRef) {
  ensureRole(policy, roleName).grants.add(skillRef);
}

/** Mark two roles mutually exclusive within a session — always both directions. */
function addConflict(policy, roleA, roleB) {
  ensureRole(policy, roleA).conflicts.add(roleB);
  ensureRole(policy, roleB).conflicts.add(roleA);
}

function addAgent(policy, name, roleName, { status = "active", active } = {}) {
  ensureRole(policy, roleName);
  const resolved = active === false ? "suspended" : active === true ? "active" : status;
  policy.agents.set(name, { role: roleName, status: resolved });
}

/**
 * Build an immutable Policy from a plain, serializable spec. The spec can come
 * from a JSON/YAML file so policy is diffable and reviewable.
 *
 *   definePolicy({
 *     skills: { "read@1": {}, "pay@1": { riskTier: "high", status: "published" } },
 *     roles:  { "maker": { grants: ["read@1"], conflicts: ["checker"] },
 *               "checker": { grants: ["pay@1"] } },
 *     agents: { "bot": { role: "maker" }, "officer": { role: "checker" } },
 *     conflicts: [["maker", "checker"]],   // optional extra symmetric pairs
 *   })
 */
export function definePolicy(spec = {}) {
  const policy = emptyPolicy();

  for (const [ref, s] of Object.entries(spec.skills ?? {})) {
    addSkill(policy, ref, typeof s === "string" ? { riskTier: s } : s ?? {});
  }
  for (const [name, r] of Object.entries(spec.roles ?? {})) {
    ensureRole(policy, name);
    for (const ref of r?.grants ?? []) addGrant(policy, name, ref);
    for (const other of r?.conflicts ?? []) addConflict(policy, name, other);
  }
  for (const [a, b] of spec.conflicts ?? []) addConflict(policy, a, b);
  for (const [name, a] of Object.entries(spec.agents ?? {})) {
    if (typeof a === "string") addAgent(policy, name, a);
    else addAgent(policy, name, a.role, a);
  }
  return freezePolicy(policy);
}

function freezePolicy(policy) {
  // Shallow-freeze the container and expose a JSON view; the Maps stay internal.
  const view = {
    skills: policy.skills,
    roles: policy.roles,
    agents: policy.agents,
    toJSON: () => policyToSpec(policy),
  };
  return Object.freeze(view);
}

/** Serialize a policy back to a plain spec (for diffing / persistence). */
export function policyToSpec(policy) {
  const skills = {};
  for (const [ref, s] of policy.skills) skills[ref] = { ...s };
  const roles = {};
  for (const [name, r] of policy.roles) {
    roles[name] = { grants: [...r.grants], conflicts: [...r.conflicts] };
  }
  const agents = {};
  for (const [name, a] of policy.agents) agents[name] = { ...a };
  return { skills, roles, agents };
}

/**
 * A mutable builder for the imperative case (and what the governor uses under
 * the hood). Every method returns the builder for chaining; .snapshot() hands
 * back a live policy object that decide() reads directly.
 */
export function createPolicyBuilder(policy = emptyPolicy()) {
  const builder = {
    defineSkill(ref, opts = {}) {
      addSkill(policy, ref, opts);
      return builder;
    },
    defineRole(name, { grants = [], conflicts = [] } = {}) {
      ensureRole(policy, name);
      for (const ref of grants) addGrant(policy, name, ref);
      for (const other of conflicts) addConflict(policy, name, other);
      return builder;
    },
    defineConflict(a, b) {
      addConflict(policy, a, b);
      return builder;
    },
    grant(roleName, skillRef) {
      addGrant(policy, roleName, skillRef);
      return builder;
    },
    defineAgent(name, roleName, opts = {}) {
      addAgent(policy, name, roleName, opts);
      return builder;
    },
    /** The live, mutable policy this builder writes to. */
    snapshot() {
      return policy;
    },
    /** A frozen, serializable copy. */
    freeze() {
      return definePolicy(policyToSpec(policy));
    },
  };
  return builder;
}

// ── The decision ─────────────────────────────────────────────────────────

/**
 * Decide whether `request.agent` may use `request.skill`, deny-by-default.
 *
 * @param policy   a Policy (from definePolicy or a builder snapshot)
 * @param request  { agent, skill }
 * @param context  { sessionActors?: string[], hasSeparationGate?: boolean }
 *                 sessionActors — roles that have ALREADY acted (been allowed)
 *                   in this session; used for separation of duties.
 *                 hasSeparationGate — whether a preceding separation-enforcing
 *                   approval gate exists (lets a high-risk skill through). In a
 *                   pure in-process context there is no gate, so it defaults
 *                   false and high-risk is refused inline — the safe default.
 * @returns { effect: "allow"|"deny", code, reason }
 */
export function decide(policy, request, context = {}) {
  const { agent: agentName, skill: skillRef } = request ?? {};
  const sessionActors = context.sessionActors ?? [];
  const hasSeparationGate = context.hasSeparationGate === true;

  // 1. agent exists
  const agent = policy.agents.get(agentName);
  if (!agent) {
    return deny(DECISION_CODES.AGENT_NOT_FOUND, `agent "${agentName}" does not exist`);
  }
  // 2. agent active
  if (agent.status !== "active") {
    return deny(DECISION_CODES.AGENT_NOT_ACTIVE, `agent "${agentName}" is ${agent.status}`);
  }
  // 3. skill exists
  const skill = policy.skills.get(skillRef);
  if (!skill) {
    return deny(DECISION_CODES.SKILL_NOT_FOUND, `skill "${skillRef}" does not exist`);
  }
  // 4. skill published
  if (skill.status !== "published") {
    return deny(DECISION_CODES.SKILL_DEPRECATED, `skill "${skillRef}" is ${skill.status}`);
  }
  // 5. granted to the agent's (current) role — deny by default
  const role = policy.roles.get(agent.role);
  if (!role || !role.grants.has(skillRef)) {
    return deny(
      DECISION_CODES.SKILL_NOT_GRANTED,
      `skill "${skillRef}" is not granted to the role of agent "${agentName}"`,
    );
  }
  // 6. high-risk skills need a preceding separation-enforcing gate
  if (skill.riskTier === "high" && !hasSeparationGate) {
    return deny(
      DECISION_CODES.HIGH_RISK_REQUIRES_GATE,
      `skill "${skillRef}" is high-risk and cannot run inline; it requires a preceding approval gate decided by a separate party`,
    );
  }
  // 7. separation of duties — no conflicting role may have already acted
  if (role.conflicts.size && sessionActors.length) {
    for (const actor of sessionActors) {
      if (role.conflicts.has(actor)) {
        return deny(
          DECISION_CODES.SOD_VIOLATION,
          `separation of duties: role "${actor}" already acted in this session and conflicts with "${agent.role}"`,
        );
      }
    }
  }
  return ALLOW;
}

/**
 * Throwing guard form of decide(): returns the (allow) Decision, or throws
 * GovernanceDeniedError before any side effect. For middleware that wants
 * fail-before-execute.
 */
export function enforce(policy, request, context = {}) {
  const decision = decide(policy, request, context);
  if (decision.effect === "deny") throw new GovernanceDeniedError(decision.code, decision.reason);
  return decision;
}
