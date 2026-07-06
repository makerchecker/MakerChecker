// Type declarations for @makerchecker/embedded/policy — the pure decision core.

export type DecisionCode =
  | "agent_not_found"
  | "agent_not_active"
  | "skill_not_found"
  | "skill_deprecated"
  | "skill_not_granted"
  | "high_risk_requires_gate"
  | "sod_violation";

export const DECISION_CODES: {
  readonly AGENT_NOT_FOUND: "agent_not_found";
  readonly AGENT_NOT_ACTIVE: "agent_not_active";
  readonly SKILL_NOT_FOUND: "skill_not_found";
  readonly SKILL_DEPRECATED: "skill_deprecated";
  readonly SKILL_NOT_GRANTED: "skill_not_granted";
  readonly HIGH_RISK_REQUIRES_GATE: "high_risk_requires_gate";
  readonly SOD_VIOLATION: "sod_violation";
};

/** Thrown by enforce() (and the governor) before any side effect on a deny. */
export class GovernanceDeniedError extends Error {
  constructor(code: DecisionCode, reason: string);
  readonly code: DecisionCode;
  readonly reason: string;
}

// `(string & {})` keeps literal autocomplete while still allowing custom values.
export type RiskTier = "low" | "high" | (string & {});
export type SkillStatus = "published" | "deprecated" | "draft" | (string & {});
export type AgentStatus = "active" | "suspended" | "disabled" | (string & {});

export interface SkillSpec {
  riskTier?: RiskTier;
  status?: SkillStatus;
}

export interface RoleSpec {
  grants?: string[];
  conflicts?: string[];
}

export interface AgentSpec {
  role: string;
  /** Explicit status; ignored if `active` is provided. */
  status?: AgentStatus;
  /** Convenience: true -> "active", false -> "suspended". */
  active?: boolean;
}

/** A plain, serializable policy definition (loadable from JSON/YAML). */
export interface PolicySpec {
  skills?: Record<string, SkillSpec | RiskTier>;
  roles?: Record<string, RoleSpec>;
  agents?: Record<string, AgentSpec | string>;
  /** Extra symmetric conflict pairs, applied in addition to role.conflicts. */
  conflicts?: Array<[string, string]>;
}

/** The normalized, Map-backed form that decide() reads. */
export interface NormalizedPolicy {
  skills: Map<string, { riskTier: RiskTier; status: SkillStatus }>;
  roles: Map<string, { grants: Set<string>; conflicts: Set<string> }>;
  agents: Map<string, { role: string; status: AgentStatus }>;
}

/** A frozen, reviewable policy artifact produced by definePolicy(). */
export interface Policy extends NormalizedPolicy {
  toJSON(): PolicySpec;
}

export interface DecisionRequest {
  agent: string;
  skill: string;
}

export interface DecisionContext {
  /** Roles that have already been allowed to act in this session (for SoD). */
  sessionActors?: string[];
  /** Whether a preceding separation-enforcing approval gate exists. */
  hasSeparationGate?: boolean;
}

export interface AllowDecision {
  readonly effect: "allow";
  readonly code: null;
  readonly reason: null;
}

export interface DenyDecision {
  readonly effect: "deny";
  readonly code: DecisionCode;
  readonly reason: string;
}

export type Decision = AllowDecision | DenyDecision;

export interface PolicyBuilder {
  defineSkill(ref: string, opts?: SkillSpec): PolicyBuilder;
  defineRole(name: string, opts?: RoleSpec): PolicyBuilder;
  defineConflict(a: string, b: string): PolicyBuilder;
  grant(roleName: string, skillRef: string): PolicyBuilder;
  defineAgent(name: string, roleName: string, opts?: Omit<AgentSpec, "role">): PolicyBuilder;
  /** The live, mutable policy this builder writes to. */
  snapshot(): NormalizedPolicy;
  /** A frozen, serializable copy. */
  freeze(): Policy;
}

export function definePolicy(spec?: PolicySpec): Policy;
export function policyToSpec(policy: NormalizedPolicy): Required<Pick<PolicySpec, "skills" | "roles" | "agents">>;
export function createPolicyBuilder(policy?: NormalizedPolicy): PolicyBuilder;

/** Decide whether an agent may use a skill, deny-by-default. Pure. */
export function decide(policy: NormalizedPolicy, request: DecisionRequest, context?: DecisionContext): Decision;

/** Throwing guard form of decide(): returns the allow Decision or throws. */
export function enforce(policy: NormalizedPolicy, request: DecisionRequest, context?: DecisionContext): AllowDecision;
