// Type declarations for @makerchecker/embedded — the batteries-included root.
export * from "./policy.js";

export { createAuditChain, genesisPrevHash, GENESIS_PREFIX, SCHEMA_VERSION } from "./audit.js";
export type {
  AuditChain,
  AuditChainOptions,
  AuditBundle,
  AuditRow,
  AppendInput,
  BundleManifest,
} from "./audit.js";

export { createGovernor as createGovernorCore } from "./governor.js";
export type {
  Governor,
  GovernorOptions,
  GovernanceEvent,
  GovernedTool,
  CallOptions,
  DecideOptions,
  CheckOptions,
  WrapOptions,
} from "./governor.js";

import type { Governor, GovernorOptions } from "./governor.js";
import type { AuditChain, AuditBundle, AuditRow } from "./audit.js";

export interface EmbeddedGovernorOptions extends GovernorOptions {
  /** Stable id for the audit chain's genesis root. */
  instanceId?: string;
  /** Ed25519 KeyObject to sign bundles with. */
  privateKey?: unknown;
  /** Matching SPKI PEM (required if privateKey given). */
  publicKeyPem?: string;
}

/** A Governor with a signed, offline-verifiable audit chain already attached. */
export interface EmbeddedGovernor extends Governor {
  auditTrail(): AuditRow[];
  exportBundle(): AuditBundle;
  /** Escape hatch: the underlying chain for advanced use. */
  auditChain: AuditChain;
  readonly instanceId: string;
  readonly publicKeyPem: string | null;
}

export function createGovernor(opts?: EmbeddedGovernorOptions): EmbeddedGovernor;
