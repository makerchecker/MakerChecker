// Type declarations for @makerchecker/embedded/governor — the stateful PEP.
import type {
  AgentSpec,
  Decision,
  NormalizedPolicy,
  Policy,
  PolicySpec,
  RoleSpec,
  SkillSpec,
} from "./policy.js";

/** A governance decision as emitted to an onDecision sink. */
export interface GovernanceEvent {
  eventType: string;
  actor: { agentName: string; roleName: string | null; sessionId: string };
  entityType: "skill";
  entityId: string;
  runId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface GovernorOptions {
  /** An existing Policy or spec to seed from. */
  policy?: NormalizedPolicy | PolicySpec;
  /** Called for every decision — allow AND deny. This is how ./audit attaches. */
  onDecision?: (event: GovernanceEvent) => void;
  /** Timestamp source; defaults to () => new Date().toISOString(). */
  clock?: () => string;
}

export interface DecideOptions {
  sessionId?: string;
  hasSeparationGate?: boolean;
}

export interface CheckOptions extends DecideOptions {
  input?: unknown;
}

export interface WrapOptions extends DecideOptions {}

/** Per-call overrides accepted by a wrapped tool as its second argument. */
export interface CallOptions {
  sessionId?: string;
  hasSeparationGate?: boolean;
}

export type GovernedTool<I = unknown, O = unknown> = (input: I, callOpts?: CallOptions) => Promise<O>;

export interface Governor {
  defineSkill(ref: string, opts?: SkillSpec): Governor;
  defineRole(name: string, opts?: RoleSpec): Governor;
  defineConflict(a: string, b: string): Governor;
  grant(roleName: string, skillRef: string): Governor;
  defineAgent(name: string, roleName: string, opts?: Omit<AgentSpec, "role">): Governor;

  /** A frozen, serializable snapshot of the current policy. */
  policy(): Policy;
  /** Roles that have already acted in a session (for inspection). */
  sessionActors(sessionId?: string): string[];

  /** Dry-run: decide with NO recording and NO change to session state. */
  decide(agent: string, skill: string, opts?: DecideOptions): Decision;
  /** Authorize an act: record it and, if allowed, commit the SoD actor. */
  check(agent: string, skill: string, opts?: CheckOptions): Decision;

  /** Wrap a tool so every call is authorized first and recorded either way. */
  wrap<I = unknown, O = unknown>(
    agent: string,
    skill: string,
    executor: (input: I) => O | Promise<O>,
    opts?: WrapOptions,
  ): GovernedTool<I, O>;
  /** Backward-compatible alias for wrap(). */
  governedTool<I = unknown, O = unknown>(
    agent: string,
    skill: string,
    executor: (input: I) => O | Promise<O>,
    opts?: WrapOptions,
  ): GovernedTool<I, O>;
}

export function createGovernor(opts?: GovernorOptions): Governor;
