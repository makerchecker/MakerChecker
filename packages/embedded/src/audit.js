// @makerchecker/embedded/audit — the OPTIONAL evidentiary layer.
//
// This is the only tier that touches crypto. It turns a stream of governance
// decisions into a genesis-rooted, hash-chained, Ed25519-signed audit log whose
// bundle verifies in the independent @makerchecker/proof-verifier — the same
// bytes, the same crypto, no trust in this process required.
//
// It is deliberately separate from the decision (./policy) and the enforcement
// point (./governor): a consumer who only wants deny-by-default authorization
// never imports this file and never pulls in node:crypto. Plug it into a
// governor as its onDecision sink, or drive it directly.
//
//   import { createAuditChain } from "@makerchecker/embedded/audit";
//   const chain = createAuditChain();
//   chain.append({ eventType: "proxy.check.allowed", actor, entityId: "pay@1",
//                  payload: { ok: true }, occurredAt: new Date().toISOString() });
//   const bundle = chain.exportBundle();   // verifier-ready
//
// The signing key is minted LAZILY — merely creating a chain and appending
// events pulls in no keypair; the Ed25519 pair is generated only the first time
// you export (or sign), unless you pass your own PEMs. A caller can therefore
// record a chain, inspect it, and discard it without ever generating a key.
import { createHash, generateKeyPairSync, sign as edSign, randomUUID } from "node:crypto";

import { canonicalJson } from "./vendor/canonical-json.js";

export const GENESIS_PREFIX = "makerchecker-genesis:";
export const SCHEMA_VERSION = 1;

const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** The genesis root a chain hangs from — instance-specific. */
export function genesisPrevHash(instanceId) {
  return sha256Hex(GENESIS_PREFIX + instanceId);
}

// The event hash covers exactly the camelCase field set the offline verifier
// re-derives from a stored row (verify-core.js#recomputeHash). `seq` is
// deliberately excluded; entityType/entityId/runId are null (not undefined) when
// unset, because canonicalJson drops undefined-valued members and that would
// change the hash.
function hashEvent({ id, occurredAt, actor, eventType, entityType, entityId, runId, payload, prevHash }) {
  return sha256Hex(
    canonicalJson({ id, occurredAt, actor, eventType, entityType, entityId, runId, payload, prevHash }),
  );
}

/**
 * Create an in-memory audit chain.
 *
 * @param opts.instanceId    stable id the genesis root derives from (default: random)
 * @param opts.privateKey    a node:crypto KeyObject (Ed25519) to sign with
 * @param opts.publicKeyPem  the matching SPKI PEM (required if privateKey is given)
 */
export function createAuditChain(opts = {}) {
  const instanceId = opts.instanceId ?? randomUUID();

  // Key provenance is explicit. If the caller supplies a key we use it and the
  // bundle keeps verifying for as long as they keep that key. Otherwise we mint
  // an EPHEMERAL pair on first use and flag it — a bundle it signs stops
  // verifying once this process exits, so it is fine for a demo/test but must
  // never be mistaken for a durable system of record.
  let privateKey = opts.privateKey ?? null;
  let publicKeyPem = opts.publicKeyPem ?? null;
  let keyIsEphemeral = !opts.privateKey;

  function ensureKey() {
    if (privateKey) return;
    const pair = generateKeyPairSync("ed25519");
    privateKey = pair.privateKey;
    publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" });
    keyIsEphemeral = true;
  }

  const events = [];
  let seq = 0;
  let prevHash = genesisPrevHash(instanceId);

  /**
   * Append one event to the chain. `occurredAt` is captured by the caller (the
   * governor's clock) and used for BOTH the hash and the stored row, so the two
   * never diverge. Returns the stored (snake_case) row.
   */
  function append(event) {
    seq += 1;
    const id = event.id ?? randomUUID();
    const occurredAt = event.occurredAt ?? new Date().toISOString();
    const actor = event.actor ?? { type: "system" };
    const eventType = event.eventType;
    const entityType = event.entityType ?? null;
    const entityId = event.entityId ?? null;
    const runId = event.runId ?? null;
    const payload = event.payload ?? {};

    const hash = hashEvent({ id, occurredAt, actor, eventType, entityType, entityId, runId, payload, prevHash });
    const row = {
      seq,
      id,
      occurred_at: occurredAt,
      actor,
      event_type: eventType,
      entity_type: entityType,
      entity_id: entityId,
      run_id: runId,
      payload,
      prev_hash: prevHash,
      hash,
    };
    prevHash = hash;
    events.push(row);
    return row;
  }

  return {
    instanceId,
    get publicKeyPem() {
      return publicKeyPem;
    },
    get keyIsEphemeral() {
      return keyIsEphemeral;
    },
    append,

    /** The raw signed rows (snake_case), for inspection. */
    rows() {
      return events.slice();
    },

    /**
     * A full audit bundle in the exact shape @makerchecker/proof-verifier
     * accepts: genesis-rooted, hash-chained, and Ed25519-signed over the
     * canonical manifest (which excludes publicKeyPem + signature).
     */
    exportBundle() {
      ensureKey();
      const eventHashesDigest = sha256Hex(events.map((e) => e.hash).join("\n"));
      const headHash = events.length ? events[events.length - 1].hash : null;
      const manifestCore = {
        bundleKind: "full",
        schemaVersion: SCHEMA_VERSION,
        instanceId,
        exportedAt: new Date().toISOString(),
        runId: null,
        count: events.length,
        firstSeq: events[0]?.seq ?? null,
        lastSeq: events[events.length - 1]?.seq ?? null,
        headHash,
        eventHashesDigest,
      };
      const signature = edSign(null, Buffer.from(canonicalJson(manifestCore), "utf8"), privateKey).toString(
        "base64",
      );
      return {
        manifest: { ...manifestCore, publicKeyPem, signature },
        events: events.slice(),
      };
    },
  };
}
