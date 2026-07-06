// Type declarations for @makerchecker/embedded/audit — the optional signed chain.

export const GENESIS_PREFIX: string;
export const SCHEMA_VERSION: number;

/** The genesis root a chain hangs from — instance-specific. */
export function genesisPrevHash(instanceId: string): string;

export interface AuditChainOptions {
  /** Stable id the genesis root derives from (default: random UUID). */
  instanceId?: string;
  /** A node:crypto Ed25519 KeyObject to sign with. */
  privateKey?: unknown;
  /** The matching SPKI PEM (required if privateKey is given). */
  publicKeyPem?: string;
}

export interface AppendInput {
  eventType: string;
  actor?: Record<string, unknown>;
  entityType?: string | null;
  entityId?: string | null;
  runId?: string | null;
  payload?: Record<string, unknown>;
  /** Caller-captured timestamp; defaults to now if omitted. */
  occurredAt?: string;
  /** Explicit event id; defaults to a random UUID. */
  id?: string;
}

/** A stored, hash-chained row (snake_case, matching the server/verifier shape). */
export interface AuditRow {
  seq: number;
  id: string;
  occurred_at: string;
  actor: Record<string, unknown>;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  run_id: string | null;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export interface BundleManifest {
  bundleKind: "full";
  schemaVersion: number;
  instanceId: string;
  exportedAt: string;
  runId: string | null;
  count: number;
  firstSeq: number | null;
  lastSeq: number | null;
  headHash: string | null;
  eventHashesDigest: string;
  publicKeyPem: string;
  signature: string;
}

export interface AuditBundle {
  manifest: BundleManifest;
  events: AuditRow[];
}

export interface AuditChain {
  readonly instanceId: string;
  readonly publicKeyPem: string | null;
  readonly keyIsEphemeral: boolean;
  append(event: AppendInput): AuditRow;
  /** The raw signed rows (snake_case), for inspection. */
  rows(): AuditRow[];
  /** A full, verifier-ready bundle. Mints an ephemeral key on first call. */
  exportBundle(): AuditBundle;
}

export function createAuditChain(opts?: AuditChainOptions): AuditChain;
