// lib/policy.mjs — policy loading, defaults, validation, signature merge.
//
// The mc-policy.json file is BOTH the scan config AND the governance policy: the
// free scan generates it (deny-by-default), and the paid MakerChecker engine
// enforces the very same file. This module resolves and validates that file.
//
// Zero deps, Node >= 18, ESM. Read-only. Never throws on a malformed file: it
// coerces bad/unknown values back to DEFAULT_POLICY values and continues.
// Validation is hand-rolled (no ajv) against mc-policy.schema.json — the enum
// vocabularies (severities, control gates) are read from that schema at load time
// so the validator can never drift from the published contract.

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join, parse as parsePath } from 'node:path';

import { listProviders } from './llmProviders.mjs';

/**
 * @typedef {import('./signatures.mjs').Signature} Signature
 * @typedef {import('./signatures.mjs').Control} Control
 * @typedef {{ version: number, severityThreshold: 'CATASTROPHIC'|'HIGH'|'MEDIUM'|'OK', failOn: 'CATASTROPHIC'|'HIGH'|'MEDIUM'|'OK', ignore: string[], allow: Record<string, { gate: Control, note: string }>, customSignatures: Signature[], path: string|null }} Policy
 */

/** @type {Policy} */
export const DEFAULT_POLICY = {
  version: 1,
  severityThreshold: 'MEDIUM',
  failOn: 'CATASTROPHIC',
  ignore: [],
  allow: {},
  customSignatures: [],
  llm: {},
  path: null,
};

const LLM_MODES = ['tools', 'code', 'both'];

// ---- schema-derived vocabularies -------------------------------------------
// Canonical fallbacks (mirror CONTRACTS.md). We prefer the values pulled from
// mc-policy.schema.json so "validate against the schema" is literal, but if the
// schema cannot be read we still validate against these.
const FALLBACK_SEVERITIES = ['CATASTROPHIC', 'HIGH', 'MEDIUM', 'OK'];
const FALLBACK_CONTROLS = [
  'high_risk_requires_gate',
  'approval_gate',
  'limit_violation',
  'skill_not_granted',
  'sod_violation',
  'independent_citation_verification',
];
const SIG_SEVERITIES = ['CATASTROPHIC', 'HIGH', 'MEDIUM']; // signatures never carry OK

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(HERE, '..', 'mc-policy.schema.json');

function loadSchemaVocab() {
  try {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const sev = schema?.properties?.severityThreshold?.enum;
    const ctl = schema?.properties?.allow?.additionalProperties?.properties?.gate?.enum;
    return {
      severities: Array.isArray(sev) && sev.length ? sev : FALLBACK_SEVERITIES,
      controls: Array.isArray(ctl) && ctl.length ? ctl : FALLBACK_CONTROLS,
    };
  } catch {
    return { severities: FALLBACK_SEVERITIES, controls: FALLBACK_CONTROLS };
  }
}

const { severities: SEVERITIES, controls: CONTROLS } = loadSchemaVocab();
const KNOWN_KEYS = new Set([
  '$schema', 'version', 'severityThreshold', 'failOn',
  'ignore', 'allow', 'customSignatures', 'llm',
]);

// ---- helpers ----------------------------------------------------------------
function clone(obj) {
  return structuredClone(obj);
}

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** Walk UP the tree from `startDir` to the nearest mc-policy.json. */
function findUp(startDir) {
  let cur = resolve(startDir || '.');
  const { root } = parsePath(cur);
  // Guard against pathological loops.
  for (let i = 0; i < 4096; i++) {
    if (isFile(join(cur, 'mc-policy.json'))) return join(cur, 'mc-policy.json');
    if (cur === root) return null;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

/** Reasons a custom signature is invalid, or null if it is well-formed. */
function customSignatureProblem(s) {
  if (!isPlainObject(s)) return 'must be an object';
  if (typeof s.id !== 'string' || !s.id) return 'missing string "id"';
  if (!Array.isArray(s.verbs)) return 'missing "verbs" array';
  if (!SIG_SEVERITIES.includes(s.severity)) {
    return `"severity" must be one of ${SIG_SEVERITIES.join(', ')}`;
  }
  if (typeof s.action !== 'string') return 'missing string "action"';
  if (!isPlainObject(s.resembles) || typeof s.resembles.aid !== 'string' || typeof s.resembles.title !== 'string') {
    return 'missing "resembles" { aid, title }';
  }
  if (!CONTROLS.includes(s.control)) return `"control" must be one of ${CONTROLS.join(', ')}`;
  if (typeof s.why !== 'string') return 'missing string "why"';
  return null;
}

/**
 * Validate a raw parsed policy object against the schema, coercing every invalid
 * or unknown value back to its DEFAULT_POLICY value. Never throws. Returns the
 * coerced policy (WITHOUT `path`) and a list of clear, human-readable errors
 * describing what was wrong. `loadPolicy` uses this internally and ignores the
 * errors (resilient by contract); callers/tests can surface them.
 * @param {unknown} raw
 * @returns {{ policy: Omit<Policy, 'path'>, errors: string[] }}
 */
export function validatePolicy(raw) {
  const errors = [];
  const p = clone(DEFAULT_POLICY);
  delete p.path; // on-disk shape has no `path`

  if (!isPlainObject(raw)) {
    errors.push('mc-policy.json must be a JSON object');
    return { policy: p, errors };
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) errors.push(`unknown property "${key}" (ignored)`);
  }

  if ('version' in raw) {
    if (raw.version !== 1) {
      errors.push(`"version" must be 1 (got ${JSON.stringify(raw.version)}); using 1`);
    }
    p.version = 1;
  }

  if ('severityThreshold' in raw) {
    if (SEVERITIES.includes(raw.severityThreshold)) p.severityThreshold = raw.severityThreshold;
    else errors.push(`"severityThreshold" ${JSON.stringify(raw.severityThreshold)} is not one of ${SEVERITIES.join(', ')}; using ${p.severityThreshold}`);
  }

  if ('failOn' in raw) {
    if (SEVERITIES.includes(raw.failOn)) p.failOn = raw.failOn;
    else errors.push(`"failOn" ${JSON.stringify(raw.failOn)} is not one of ${SEVERITIES.join(', ')}; using ${p.failOn}`);
  }

  // arrays replace
  if ('ignore' in raw) {
    if (Array.isArray(raw.ignore)) {
      const strings = raw.ignore.filter((x) => typeof x === 'string');
      if (strings.length !== raw.ignore.length) errors.push('"ignore" must be an array of strings; dropped non-string entries');
      p.ignore = strings;
    } else {
      errors.push('"ignore" must be an array; using []');
    }
  }

  // objects merge (over the default {}); each entry validated, bad entries dropped
  if ('allow' in raw) {
    if (isPlainObject(raw.allow)) {
      const out = {};
      for (const [name, entry] of Object.entries(raw.allow)) {
        if (!isPlainObject(entry)) { errors.push(`"allow[${JSON.stringify(name)}]" must be an object; dropped`); continue; }
        if (!CONTROLS.includes(entry.gate)) { errors.push(`"allow[${JSON.stringify(name)}].gate" ${JSON.stringify(entry.gate)} is not a valid control; dropped`); continue; }
        if (typeof entry.note !== 'string') { errors.push(`"allow[${JSON.stringify(name)}].note" must be a string; dropped`); continue; }
        out[name] = { gate: entry.gate, note: entry.note };
      }
      p.allow = out;
    } else {
      errors.push('"allow" must be an object; using {}');
    }
  }

  // arrays replace; bad signatures dropped
  if ('customSignatures' in raw) {
    if (Array.isArray(raw.customSignatures)) {
      const out = [];
      raw.customSignatures.forEach((s, i) => {
        const problem = customSignatureProblem(s);
        if (problem) errors.push(`"customSignatures[${i}]" ${problem}; dropped`);
        else out.push(s);
      });
      p.customSignatures = out;
    } else {
      errors.push('"customSignatures" must be an array; using []');
    }
  }

  // optional llm block. Keys are NEVER read from policy (kept secret-free), so a
  // key/apiKey here is a hard drop with a warning.
  if ('llm' in raw) {
    if (isPlainObject(raw.llm)) {
      const L = raw.llm;
      const out = {};
      if ('key' in L || 'apiKey' in L) errors.push('"llm.apiKey"/"llm.key" is not allowed in policy (keys come from env or --llm-key); dropped');
      if ('mode' in L) { if (LLM_MODES.includes(L.mode)) out.mode = L.mode; else errors.push(`"llm.mode" must be one of ${LLM_MODES.join(', ')}; dropped`); }
      if ('provider' in L) { if (listProviders().includes(L.provider)) out.provider = L.provider; else errors.push(`"llm.provider" ${JSON.stringify(L.provider)} is not a known provider; dropped`); }
      if ('model' in L) { if (typeof L.model === 'string') out.model = L.model; else errors.push('"llm.model" must be a string; dropped'); }
      if ('baseUrl' in L) { if (typeof L.baseUrl === 'string') out.baseUrl = L.baseUrl; else errors.push('"llm.baseUrl" must be a string; dropped'); }
      if ('jsonMode' in L) { if (typeof L.jsonMode === 'boolean') out.jsonMode = L.jsonMode; else errors.push('"llm.jsonMode" must be a boolean; dropped'); }
      if ('gateCi' in L) { if (typeof L.gateCi === 'boolean') out.gateCi = L.gateCi; else errors.push('"llm.gateCi" must be a boolean; dropped'); }
      if (isPlainObject(L.codeScan)) {
        const cs = {};
        for (const k of ['maxFiles', 'windowLines', 'maxBytesPerChunk', 'maxChunks', 'maxFindings']) {
          if (k in L.codeScan) {
            const n = Number(L.codeScan[k]);
            if (Number.isFinite(n) && n > 0) cs[k] = Math.min(n, 100000);
            else errors.push(`"llm.codeScan.${k}" must be a positive number; dropped`);
          }
        }
        if (Object.keys(cs).length) out.codeScan = cs;
      }
      p.llm = out;
    } else {
      errors.push('"llm" must be an object; using {}');
    }
  }

  return { policy: p, errors };
}

/**
 * Resolve a policy for a scan.
 * If `explicitPath` is given, load exactly that file. Otherwise walk UP the tree
 * from `dir` to the nearest mc-policy.json. Parse it, deep-merge over
 * DEFAULT_POLICY (arrays replace, objects merge), validate (unknown/invalid ->
 * defaults), and set `path` to the absolute file path used (or null if none was
 * found / could not be read or parsed). Read-only. Never throws.
 * @param {string} dir
 * @param {string} [explicitPath]
 * @returns {Policy}
 */
export function loadPolicy(dir, explicitPath) {
  let file = null;
  if (explicitPath) {
    const abs = resolve(explicitPath);
    if (isFile(abs)) file = abs;
  } else if (dir != null) {
    file = findUp(dir);
  }

  if (!file) {
    return { ...clone(DEFAULT_POLICY), path: null };
  }

  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch { return { ...clone(DEFAULT_POLICY), path: null }; }

  let raw;
  try { raw = JSON.parse(text); }
  catch { return { ...clone(DEFAULT_POLICY), path: null }; }

  const { policy } = validatePolicy(raw);
  return { ...policy, path: file };
}

/**
 * Concatenate builtin signatures with policy.customSignatures. A custom signature
 * with the same `id` as a builtin REPLACES the builtin (custom wins). Defensive:
 * ignores non-array customSignatures and entries without a string id.
 * @param {Signature[]} builtin
 * @param {Policy} policy
 * @returns {Signature[]}
 */
export function mergeSignatures(builtin, policy) {
  const base = Array.isArray(builtin) ? builtin : [];
  const custom = (policy && Array.isArray(policy.customSignatures)) ? policy.customSignatures : [];
  const overriddenIds = new Set(custom.map((s) => s && s.id).filter((id) => typeof id === 'string'));
  return [...base.filter((s) => !overriddenIds.has(s && s.id)), ...custom];
}
