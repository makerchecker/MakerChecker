// lib/llmScan.mjs — the opt-in --llm deep scan, Mode A (re-rank ambiguous tools).
//
// The default scan is deterministic and sends nothing anywhere. This tier is the
// explicit opposite: when --llm is on, the AMBIGUOUS tools — the ones static
// signatures could not confidently place — are sent to the configured provider
// (see lib/llmProviders.mjs: Anthropic / OpenAI / OpenAI-compatible / local
// Ollama) for a probabilistic second opinion. An LLM verdict may RAISE or
// annotate a finding; it never lowers a static severity, so the deterministic
// floor stands. Every touched finding records staticSeverity (what static said,
// for the CI gate) and assessedBy:'llm', and renders "LLM-assessed".
//
// Zero deps: transport is llmProviders. Every network/parse failure degrades to
// the static finding, untouched — the deep scan can only ever add information.

import { callModel, extractFirstJson, pMap } from './llmProviders.mjs';

/**
 * @typedef {import('./classify.mjs').Finding} Finding
 */

const SEV_RANK = { OK: 0, MEDIUM: 1, HIGH: 2, CATASTROPHIC: 3 };
const SEVERITIES = new Set(Object.keys(SEV_RANK));

const SYSTEM =
  'You are a security reviewer classifying one AI-agent tool by how much harm it ' +
  'can do if the agent calls it on its own, with no human checking. Respond with ' +
  'ONLY a JSON object, no prose.';

/** A finding is ambiguous when static analysis had little to say: MEDIUM, or
 *  OK-with-a-body it could not read meaning from, or no signature matched. */
export function isAmbiguous(f) {
  if (f.governedBy) return false;
  if (f.severity === 'MEDIUM') return true;
  if (f.severity === 'OK' && typeof f.tool.body === 'string' && f.tool.body.trim()) return true;
  return !f.signature;
}

function prompt(f) {
  const t = f.tool;
  return [
    'Classify this tool. Respond with ONLY a JSON object of the shape:',
    '{"severity":"CATASTROPHIC"|"HIGH"|"MEDIUM"|"OK","action":"<the unchecked action this tool enables>","why":"<one sentence>"}',
    'CATASTROPHIC = serious, often unrecoverable harm (destroys data, moves money,',
    'commits a binding decision). HIGH = serious harm. MEDIUM = consequential but',
    'recoverable. OK = read-only or reversible.',
    '',
    `Tool name: ${t.name}`,
    `Description: ${t.description || '(none)'}`,
    `Parameters: ${(t.params || []).join(', ') || '(none)'}`,
    t.body ? `Function body:\n${t.body}` : 'Function body: (not available)',
  ].join('\n');
}

/** Extract a validated verdict from a model reply; null when unusable. */
function parseVerdict(text) {
  const v = extractFirstJson(text);
  if (!v || typeof v !== 'object' || !SEVERITIES.has(v.severity)) return null;
  return v;
}

/**
 * Deep-scan the ambiguous findings via the configured provider. Returns a NEW
 * array; untouched findings are passed through by reference. Never throws for a
 * single tool — a failed call leaves that finding static. Config comes from
 * resolveLlmConfig() (which already threw if the key was missing).
 * @param {Finding[]} findings
 * @param {{ config: object, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<Finding[]>}
 */
export async function llmScan(findings, { config, fetchImpl = fetch } = {}) {
  if (!config) throw new Error('llmScan requires a resolved config (see resolveLlmConfig)');

  return pMap(
    findings,
    async (f) => {
      if (!isAmbiguous(f)) return f;

      const { text } = await callModel(config, { system: SYSTEM, user: prompt(f), maxTokens: 512 }, { fetchImpl });
      const verdict = text ? parseVerdict(text) : null;
      if (!verdict) return f; // network/parse failure or unusable: static stands

      // The LLM may raise, never lower: the deterministic floor stands.
      const raised = SEV_RANK[verdict.severity] > SEV_RANK[f.severity];
      return {
        ...f,
        staticSeverity: f.severity,
        severity: raised ? verdict.severity : f.severity,
        action: verdict.action || f.action,
        why: verdict.why || f.why,
        assessedBy: 'llm',
      };
    },
    config.concurrency,
  );
}
