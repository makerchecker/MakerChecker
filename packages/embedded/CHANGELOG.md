# Changelog

## 0.2.0

Restructured into three composable tiers so the enforcement **primitives can be
imported and used standalone**, without the audit chain or any database.

### Added

- **`@makerchecker/embedded/policy`** — the pure decision core. Zero
  dependencies, no crypto, no clock, no state. `definePolicy`, `decide`,
  `enforce`, `policyToSpec`, `createPolicyBuilder`, `DECISION_CODES`,
  `GovernanceDeniedError`. `decide()` is a pure function; separation-of-duties
  actors are passed in as context.
- **`@makerchecker/embedded/governor`** — the stateful enforcement point
  (`createGovernor`). Wraps tools, tracks who has acted for SoD, emits every
  decision to an optional `onDecision` sink. Never imports crypto.
- **`@makerchecker/embedded/audit`** — the optional signed, hash-chained,
  Ed25519 log (`createAuditChain`, `genesisPrevHash`, `SCHEMA_VERSION`). The only
  tier that touches `node:crypto`. Signing keys are minted **lazily** — appending
  events pulls in no keypair; a key is generated on first `exportBundle()` unless
  you supply one. `keyIsEphemeral` reports which you have.
- New governor methods: `decide()` (dry-run, records nothing) and `check()`
  (records + advances the SoD actor set) alongside `wrap()`.
- Hand-authored TypeScript declarations for every tier and a compile-checked
  types smoke test.
- Test suites for each tier, plus a canonical-JSON drift guard that asserts the
  vendored RFC 8785 serializer stays byte-identical to the verifier's.

### Fixed

- **Separation of duties is now symmetric.** Conflicts are stored both
  directions, so the check fires regardless of which role acted first (the
  previous single-file build could silently allow one ordering).
- **Deprecated skills are refused** with `skill_deprecated` (previously only the
  server enforced skill status).
- **Self-contained packaging.** The RFC 8785 canonical-JSON serializer is now
  vendored under `src/vendor/`, so the package no longer reaches outside its own
  files at runtime.
- Denial events now carry a distinct `enforcement.sod_violation` event type,
  matching the server's audit parity.
- **A supplied `privateKey` with no `publicKeyPem` now derives the PEM** instead
  of exporting a signed-but-unverifiable bundle (`publicKeyPem: null`). The public
  half is determined by the private key, so the exported bundle always verifies.

### Changed

- `createGovernor` keeps its full 0.1.x surface (`defineSkill`/`defineRole`/
  `grant`/`defineConflict`/`defineAgent`/`governedTool`/`auditTrail`/
  `exportBundle`/`instanceId`/`publicKeyPem`), so existing code is unaffected.
- README now documents the tiered imports and the primitives-only path, and
  describes the bundle as "the same chain format and the same verifier" as the
  server rather than byte-for-byte server output.

## 0.1.0

Initial single-file in-process governor with an attached signed audit chain.
