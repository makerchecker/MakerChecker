// lib/llmScan.mjs — the opt-in --llm deep scan.
//
// The default scan is deterministic and sends nothing anywhere. This tier is
// the explicit opposite: when the operator passes --llm, the AMBIGUOUS tools —
// the ones static signatures could not confidently place — are sent to the
// Anthropic API for a probabilistic second opinion. An LLM verdict may RAISE
// or annotate a finding; it never lowers a static severity, so the
// deterministic floor stands. Findings the LLM touched carry
// `assessedBy: 'llm'` and render as "LLM-assessed" so a reader always knows
// which claims are reproducible and which are a model's judgment.
//
// Zero deps: plain fetch. Every network/parse failure degrades to the static
// finding, untouched — the deep scan can only ever add information.

/**
 * @typedef {import('./classify.mjs').Finding} Finding
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const SEV_RANK = { OK: 0, MEDIUM: 1, HIGH: 2, CATASTROPHIC: 3 };
const SEVERITIES = new Set(Object.keys(SEV_RANK));

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
    'You classify one AI-agent tool by how much harm it can do if the agent',
    'calls it on its own, with no human checking. Respond with ONLY a JSON',
    'object, no prose, of the shape:',
    '{"severity":"CATASTROPHIC"|"HIGH"|"MEDIUM"|"OK","action":"<the unchecked action this tool enables>","why":"<one sentence>"}',
    'CATASTROPHIC = serious, often unrecoverable harm (destroys data, moves',
    'money, commits a binding decision). HIGH = serious harm. MEDIUM =',
    'consequential but recoverable. OK = read-only or reversible.',
    '',
    `Tool name: ${t.name}`,
    `Description: ${t.description || '(none)'}`,
    `Parameters: ${(t.params || []).join(', ') || '(none)'}`,
    t.body ? `Function body:\n${t.body}` : 'Function body: (not available)',
  ].join('\n');
}

/** Extract the first JSON object from a model reply; null when unparseable. */
function parseVerdict(text) {
  const m = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let v;
  try { v = JSON.parse(m[0]); } catch { return null; }
  if (!v || typeof v !== 'object' || !SEVERITIES.has(v.severity)) return null;
  return v;
}

/**
 * Deep-scan the ambiguous findings via the Anthropic API. Returns a NEW array;
 * untouched findings are passed through by reference. Never throws for a
 * single tool — a failed call leaves that finding static. Throws only when the
 * API key is missing, before anything is sent.
 * @param {Finding[]} findings
 * @param {{ fetchImpl?: typeof fetch, apiKey?: string }} [opts]
 * @returns {Promise<Finding[]>}
 */
export async function llmScan(findings, { fetchImpl = fetch, apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  if (!apiKey) {
    throw new Error('--llm requires ANTHROPIC_API_KEY. The default scan (no --llm) sends nothing anywhere.');
  }

  return Promise.all(findings.map(async (f) => {
    if (!isAmbiguous(f)) return f;

    let verdict = null;
    try {
      const res = await fetchImpl(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 512,
          messages: [{ role: 'user', content: prompt(f) }],
        }),
      });
      if (!res.ok) return f;
      const data = await res.json();
      verdict = parseVerdict(data?.content?.[0]?.text);
    } catch {
      return f; // network/parse failure: the static finding stands
    }
    if (!verdict) return f;

    // The LLM may raise, never lower: the deterministic floor stands.
    const raised = SEV_RANK[verdict.severity] > SEV_RANK[f.severity];
    return {
      ...f,
      severity: raised ? verdict.severity : f.severity,
      action: verdict.action || f.action,
      why: verdict.why || f.why,
      assessedBy: 'llm',
    };
  }));
}
