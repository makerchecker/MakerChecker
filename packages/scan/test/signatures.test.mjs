// Tests for lib/signatures.mjs — the corpus-backed risk table.
//
// Zero deps (node:test + node:assert). Two guarantees:
//   1. CORPUS INTEGRITY: every aid a signature cites (resembles + alsoResembles)
//      actually exists as a file in incidents/entries. The moat is that findings
//      name real, sourced incidents — a dangling aid would break that promise.
//   2. CLASSIFICATION: known dangerous tool names resolve to the right severity,
//      and generic read-only tools stay OK. classify.mjs is still a stub, so we
//      replicate the CONTRACTS.md matching rule here to test the DATA directly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SIGNATURES, IRREVERSIBLE_VERBS } from '../lib/signatures.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRIES_DIR = join(__dirname, '..', '..', '..', 'incidents', 'entries');

// The set of aids that physically exist in the corpus (from AID-*.json files).
const REAL_AIDS = new Set(
  readdirSync(ENTRIES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, '')),
);

const SEV_RANK = { OK: 0, MEDIUM: 1, HIGH: 2, CATASTROPHIC: 3 };
const CONTROLS = new Set([
  'high_risk_requires_gate', 'approval_gate', 'limit_violation',
  'skill_not_granted', 'sod_violation', 'independent_citation_verification',
]);
const CATEGORIES = new Set([
  'data-loss', 'data-exfiltration', 'unauthorized-financial-action',
  'runaway-execution', 'wrongful-automated-decision', 'binding-commitment',
  'fabrication',
]);

// --- Local matcher: mirrors classify()'s rule from CONTRACTS.md exactly. ---
function tokens(tool) {
  const blob = [tool.name, tool.description || '', ...(tool.params || [])]
    .join(' ')
    .toLowerCase();
  return new Set(blob.split(/[^a-z0-9]+/).filter(Boolean));
}
function matches(sig, tool) {
  const name = (tool.name || '').toLowerCase();
  const toks = tokens(tool);
  const argHits = (sig.argHints || []).some((h) => toks.has(h.toLowerCase()));
  const strong = new Set((sig.strongVerbs || []).map((v) => v.toLowerCase()));
  for (const raw of sig.verbs) {
    const v = raw.toLowerCase();
    const verbPresent = toks.has(v) || name.includes(v);
    if (!verbPresent) continue;
    if (argHits) return true;
    if (strong.has(v) && name.includes(v)) return true;
  }
  return false;
}
function bestSeverity(tool) {
  let best = 'OK';
  for (const sig of SIGNATURES) {
    if (matches(sig, tool) && SEV_RANK[sig.severity] > SEV_RANK[best]) {
      best = sig.severity;
    }
  }
  return best;
}
const t = (name, params = [], description = '') => ({ name, description, params, source: 'test' });

// ---------------------------------------------------------------------------

test('the corpus has all 41 incidents on disk', () => {
  assert.equal(REAL_AIDS.size, 41);
});

test('every signature.resembles.aid exists in incidents/entries', () => {
  for (const sig of SIGNATURES) {
    assert.ok(
      REAL_AIDS.has(sig.resembles.aid),
      `signature '${sig.id}' cites a non-existent aid: ${sig.resembles.aid}`,
    );
    assert.ok(sig.resembles.title && sig.resembles.title.length > 0, `signature '${sig.id}' resembles has no title`);
  }
});

test('every signature.alsoResembles[].aid exists in incidents/entries', () => {
  for (const sig of SIGNATURES) {
    for (const ref of sig.alsoResembles || []) {
      assert.ok(
        REAL_AIDS.has(ref.aid),
        `signature '${sig.id}' alsoResembles a non-existent aid: ${ref.aid}`,
      );
      assert.ok(ref.title && ref.title.length > 0, `signature '${sig.id}' alsoResembles ${ref.aid} has no title`);
    }
  }
});

test('signatures use only the allowed control + severity + category vocabulary', () => {
  for (const sig of SIGNATURES) {
    assert.ok(CONTROLS.has(sig.control), `signature '${sig.id}' has bad control: ${sig.control}`);
    assert.ok(sig.severity in SEV_RANK && sig.severity !== 'OK', `signature '${sig.id}' has bad severity: ${sig.severity}`);
    assert.ok(CATEGORIES.has(sig.category), `signature '${sig.id}' has bad category: ${sig.category}`);
  }
});

test('signature ids are unique and every signature has verbs + action + why', () => {
  const ids = new Set();
  for (const sig of SIGNATURES) {
    assert.ok(!ids.has(sig.id), `duplicate signature id: ${sig.id}`);
    ids.add(sig.id);
    assert.ok(Array.isArray(sig.verbs) && sig.verbs.length > 0, `signature '${sig.id}' has no verbs`);
    assert.ok(sig.action && sig.action.length > 0, `signature '${sig.id}' has no action`);
    assert.ok(sig.why && sig.why.length > 20, `signature '${sig.id}' has no meaningful why`);
    // strongVerbs, when present, must be a subset of verbs
    for (const sv of sig.strongVerbs || []) {
      assert.ok(sig.verbs.map((v) => v.toLowerCase()).includes(sv.toLowerCase()),
        `signature '${sig.id}' strongVerb '${sv}' is not in verbs`);
    }
  }
});

test('all seven corpus categories are covered', () => {
  const covered = new Set(SIGNATURES.map((s) => s.category));
  for (const cat of CATEGORIES) {
    assert.ok(covered.has(cat), `no signature covers category: ${cat}`);
  }
});

test('IRREVERSIBLE_VERBS is the lowercased union of every signature verb', () => {
  const expected = new Set(SIGNATURES.flatMap((s) => s.verbs.map((v) => v.toLowerCase())));
  assert.deepEqual([...IRREVERSIBLE_VERBS].sort(), [...expected].sort());
  assert.ok(IRREVERSIBLE_VERBS.has('delete'));
  assert.ok(IRREVERSIBLE_VERBS.has('wire'));
});

// --- Classification: known dangerous tools -> right severity ---------------

test('known CATASTROPHIC tools classify as CATASTROPHIC', () => {
  const cases = [
    t('delete_database', ['table', 'db']),          // destroy-data
    t('dropTable', ['table']),                        // destroy-data (strong verb on name)
    t('rm', ['path']),                                // destroy-data
    t('exec', ['command']),                           // run-shell
    t('run_bash', ['script']),                        // run-shell
    t('git_force_push', ['branch', 'force']),         // force-rewrite-history
    t('terraform_destroy', ['workspace']),            // destroy-infra
    t('wire_funds', ['amount', 'iban']),              // move-money
    t('withdraw', ['amount']),                        // move-money (strong verb)
    t('place_order', ['ticker', 'quantity', 'side']), // execute-trade
    t('adjudicate_claim', ['claim', 'patient']),      // commit-decision
    t('deny_prior_auth', ['coverage', 'patient']),    // commit-decision
  ];
  for (const tool of cases) {
    assert.equal(bestSeverity(tool), 'CATASTROPHIC', `${tool.name} should be CATASTROPHIC`);
  }
});

test('known HIGH tools classify as HIGH', () => {
  const cases = [
    t('provision_cluster', ['region', 'gpu']),        // provision-infra
    t('restock_inventory', ['sku', 'supplier']),      // autonomous-spend
    t('fetch_url', ['url', 'secret']),                // exfiltrate
    t('send_email', ['to', 'body']),                  // send-message
    t('quote_price', ['price', 'customer']),          // bind-commitment
    t('grant_iam_role', ['role', 'user']),            // grant-access
    t('file_court_brief', ['citation', 'court']),     // file-external
  ];
  for (const tool of cases) {
    assert.equal(bestSeverity(tool), 'HIGH', `${tool.name} should be HIGH`);
  }
});

test('generic read-only tools stay OK (no false positives)', () => {
  const cases = [
    t('get_weather', ['city']),
    t('list_files', ['directory']),          // 'list' is not a verb; 'directory' argHint alone must not fire
    t('read_config', ['key']),
    t('search_docs', ['query']),
    t('get_user_profile', ['userId']),
    t('summarize_text', ['text']),
    t('translate', ['text', 'lang']),
    t('ping', ['host']),
  ];
  for (const tool of cases) {
    assert.equal(bestSeverity(tool), 'OK', `${tool.name} should be OK (false positive!)`);
  }
});

test('a bare read verb needs a confirming argHint to fire (strong-verb discipline)', () => {
  // 'read' is a verb on exfiltrate but NOT a strongVerb: name alone must not match.
  assert.equal(bestSeverity(t('read_document', ['docId'])), 'OK');
  // Same verb + a sensitive scope in params DOES fire.
  assert.equal(bestSeverity(t('read_document', ['secret', 'url'])), 'HIGH');
});

test('the four previously-unmapped incidents are now cited somewhere', () => {
  const cited = new Set();
  for (const sig of SIGNATURES) {
    cited.add(sig.resembles.aid);
    for (const r of sig.alsoResembles || []) cited.add(r.aid);
  }
  for (const aid of ['AID-2020-0001', 'AID-2025-0009', 'AID-2025-0012', 'AID-2025-0015']) {
    assert.ok(cited.has(aid), `expected corpus incident ${aid} to be cited by a signature`);
  }
});

test('the table cites a broad slice of the corpus (>= 35 of 41 incidents)', () => {
  const cited = new Set();
  for (const sig of SIGNATURES) {
    cited.add(sig.resembles.aid);
    for (const r of sig.alsoResembles || []) cited.add(r.aid);
  }
  for (const aid of cited) assert.ok(REAL_AIDS.has(aid), `cited aid not in corpus: ${aid}`);
  assert.ok(cited.size >= 35, `only ${cited.size} incidents cited`);
});
