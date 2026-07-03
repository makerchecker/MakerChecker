// lib/report.mjs — render findings as a terminal card, a JSON object, or a
// shareable Markdown card.
//
// Implements CONTRACTS.md ("lib/report.mjs"). The three exported names and their
// return TYPES are FIXED: renderTerminal -> string, renderJson -> object,
// renderMarkdown -> string.
//
// Zero deps. ANSI colour only when process.stdout.isTTY. No process.exit here.
// Imports the pure-data signature table (no side effects) only to recover the
// ORIGINAL severity of a tool that policy has since governed, so the report can
// honestly render "was CATASTROPHIC — now governed by <gate>".

import { SIGNATURES } from './signatures.mjs';

/**
 * @typedef {import('./classify.mjs').Finding} Finding
 * @typedef {{ target: string, toolCount: number, sourceCount: number, counts: { CATASTROPHIC: number, HIGH: number, MEDIUM: number, OK: number, GOVERNED: number }, policyPath: string|null, failOn: string, scanVersion: string, corpusSize: number, generatedAt: string }} Meta
 */

const SEV_RANK = { OK: 0, MEDIUM: 1, HIGH: 2, CATASTROPHIC: 3 };

/** Original severity by signature id, so governed (now-OK) tools can show what
 *  they were before the gate. Custom signatures fall back gracefully. */
const SIG_SEVERITY = Object.fromEntries(SIGNATURES.map((s) => [s.id, s.severity]));

const INCIDENT_DB_URL =
  'https://github.com/sammysltd/makerchecker/tree/main/incidents';

const WONT_CATCH =
  'mc scan reads tool definitions, not your live runtime. It will not find ' +
  'prompt injection in your data, logic bugs, or a risk in a tool whose shape ' +
  'it has never seen. It finds the actions your agent CAN take that it cannot ' +
  'take back — the thing most teams have never actually looked at.';

// ---- ANSI ------------------------------------------------------------------
const A = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  brightRed: '\x1b[91m',
};

const SEV_ANSI = {
  CATASTROPHIC: [A.bold, A.brightRed],
  HIGH: [A.yellow],
  MEDIUM: [A.cyan],
  OK: [A.dim],
  GOVERNED: [A.green],
};

/** Build a styler that no-ops when colour is disabled (not a TTY). */
function makeStyler(enabled) {
  return (codes, str) => {
    if (!enabled || !codes || (Array.isArray(codes) && codes.length === 0)) {
      return str;
    }
    const open = (Array.isArray(codes) ? codes : [codes]).join('');
    return open + str + A.reset;
  };
}

// ---- text helpers ----------------------------------------------------------
function wrapArr(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? line + ' ' + w : w;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function wrap(text, width, indent = '') {
  return wrapArr(text, width)
    .map((l) => indent + l)
    .join('\n');
}

// ---- terminal sections -----------------------------------------------------
function heroPanel(f, style, pad) {
  const sev = f.severity;
  const c = SEV_ANSI[sev] || SEV_ANSI.CATASTROPHIC;
  const W = 74; // interior text width
  const border = (s) => style(c, s);

  const content = [];
  content.push(`${f.tool.name} ${f.action || 'takes an action it cannot undo'}`);
  content.push('');
  if (f.resembles) {
    for (const l of wrapArr(`Resembles ${f.resembles.title}.`, W)) content.push(l);
    content.push(`Incident ${f.resembles.aid} · Agent Incident Database`);
  }
  content.push('');
  content.push(`Fix: ${f.control || 'gate this tool behind a human'}`);
  if (f.why) {
    for (const l of wrapArr(f.why, W)) content.push(l);
  }
  content.push('');
  content.push(`Seen in: ${f.tool.source || 'unknown source'}`);

  const labelStr = `─ ${sev} `;
  const fill = Math.max(0, W + 2 - labelStr.length);
  const top = '┌' + labelStr + '─'.repeat(fill) + '┐';
  const bot = '└' + '─'.repeat(W + 2) + '┘';

  const lines = [];
  lines.push(pad + border(top));
  for (const cl of content) {
    const t = cl.length > W ? cl.slice(0, W) : cl;
    const padded = t + ' '.repeat(W - t.length);
    lines.push(pad + border('│ ') + padded + border(' │'));
  }
  lines.push(pad + border(bot));
  return lines;
}

function severityTable(rows, style, pad) {
  const header = ['SEVERITY', 'TOOL', 'RESEMBLES', 'FIX CONTROL'];
  const data = rows.map((f) => [
    f.severity,
    f.tool.name,
    f.resembles ? f.resembles.aid : '—',
    f.control || '—',
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...data.map((r) => String(r[i]).length)),
  );
  const gap = '   ';
  const lines = [];
  lines.push(
    pad + '  ' + style([A.dim], header.map((h, i) => h.padEnd(widths[i])).join(gap)),
  );
  for (const r of data) {
    const sev = r[0];
    const sevCell = style(SEV_ANSI[sev] || [], sev.padEnd(widths[0]));
    const rest = [1, 2, 3].map((i) => String(r[i]).padEnd(widths[i]));
    lines.push(pad + '  ' + [sevCell, ...rest].join(gap));
  }
  return lines;
}

/**
 * The delightful, honest terminal card. Returns the full string to print.
 * @param {Finding[]} findings
 * @param {Meta} meta
 * @returns {string}
 */
export function renderTerminal(findings, meta) {
  const enabled = !!(process.stdout && process.stdout.isTTY);
  const style = makeStyler(enabled);
  const pad = '  ';
  const out = [];

  const ungoverned = findings
    .filter((f) => !f.governedBy && f.severity !== 'OK')
    .sort(
      (a, b) =>
        SEV_RANK[b.severity] - SEV_RANK[a.severity] ||
        a.tool.name.localeCompare(b.tool.name),
    );
  const governed = findings.filter((f) => f.governedBy);
  const c = meta.counts;

  // header
  out.push('');
  out.push(
    pad + style([A.bold], 'mc scan') + style([A.dim], `  ·  v${meta.scanVersion}`),
  );
  out.push(pad + style([A.dim], `Scanned ${meta.target}`));
  out.push(
    pad +
      style(
        [A.dim],
        `${meta.toolCount} tool${meta.toolCount === 1 ? '' : 's'} across ${meta.sourceCount} source file${meta.sourceCount === 1 ? '' : 's'}, checked against ${meta.corpusSize} real agent incidents.`,
      ),
  );
  out.push('');

  // hero panel: the single worst ungoverned finding, named against its incident
  const worst = ungoverned[0];
  if (worst) {
    for (const l of heroPanel(worst, style, pad)) out.push(l);
  } else {
    out.push(
      pad + style([A.green, A.bold], '✓ Nothing your agent can do that it cannot undo.'),
    );
    out.push(
      pad + style([A.dim], 'Every tool is reversible, ignored, or already behind a gate.'),
    );
  }
  out.push('');

  // inventory table
  if (ungoverned.length) {
    out.push(pad + style([A.bold], `Findings (${ungoverned.length})`));
    for (const l of severityTable(ungoverned, style, pad)) out.push(l);
    out.push('');
  }

  // governed / green section
  if (governed.length) {
    out.push(
      pad +
        style([A.green, A.bold], `Governed (${governed.length})`) +
        style([A.dim], ' — already behind a MakerChecker gate'),
    );
    for (const f of governed) {
      const was = SIG_SEVERITY[f.signature];
      const wasLabel = was ? `was ${was} — ` : '';
      out.push(
        pad +
          style([A.green], '  ✓ ') +
          f.tool.name +
          style([A.dim], `  ${wasLabel}now governed by ${f.governedBy.gate}`),
      );
    }
    out.push('');
  }

  // summary line
  const summary = [
    style(SEV_ANSI.CATASTROPHIC, `${c.CATASTROPHIC} catastrophic`),
    style(SEV_ANSI.HIGH, `${c.HIGH} high`),
    style(SEV_ANSI.MEDIUM, `${c.MEDIUM} medium`),
    style([A.green], `${c.GOVERNED} governed`),
    style([A.dim], `${c.OK} reversible`),
  ].join(style([A.dim], '  ·  '));
  out.push(pad + summary);
  out.push('');

  // fail-on / policy line
  out.push(
    pad +
      style(
        [A.dim],
        `CI fails at or above ${meta.failOn}.` +
          (meta.policyPath
            ? ` Policy: ${meta.policyPath}`
            : ' No mc-policy.json — run `mc scan init` to generate a deny-by-default one.'),
      ),
  );
  out.push('');

  // corpus link
  out.push(
    pad +
      style(
        [A.dim],
        `Every finding names a real incident. Agent Incident Database (${meta.corpusSize}):`,
      ),
  );
  out.push(pad + '  ' + style([A.cyan], INCIDENT_DB_URL));
  out.push('');

  // what this won't catch
  out.push(pad + style([A.bold], "What this won't catch"));
  out.push(
    wrap(WONT_CATCH, 74, pad + '  ')
      .split('\n')
      .map((l) => style([A.dim], l))
      .join('\n'),
  );
  out.push('');

  return out.join('\n') + '\n';
}

/**
 * A stable machine object: { meta, findings, counts }. Pure JSON.
 * @param {Finding[]} findings
 * @param {Meta} meta
 * @returns {object}
 */
export function renderJson(findings, meta) {
  return { meta, findings, counts: meta.counts };
}

/**
 * A shareable Markdown results card.
 * @param {Finding[]} findings
 * @param {Meta} meta
 * @returns {string}
 */
export function renderMarkdown(findings, meta) {
  const ungoverned = findings
    .filter((f) => !f.governedBy && f.severity !== 'OK')
    .sort(
      (a, b) =>
        SEV_RANK[b.severity] - SEV_RANK[a.severity] ||
        a.tool.name.localeCompare(b.tool.name),
    );
  const governed = findings.filter((f) => f.governedBy);
  const c = meta.counts;
  const out = [];

  out.push("## mc scan — what your agent can do that you can't undo");
  out.push('');
  out.push(
    `Scanned \`${meta.target}\`: **${meta.toolCount} tool${meta.toolCount === 1 ? '' : 's'}** across ${meta.sourceCount} source file${meta.sourceCount === 1 ? '' : 's'}, checked against ${meta.corpusSize} real agent incidents.`,
  );
  out.push('');
  out.push(
    `**${c.CATASTROPHIC} catastrophic · ${c.HIGH} high · ${c.MEDIUM} medium** ungoverned · ${c.GOVERNED} governed · ${c.OK} reversible.`,
  );
  out.push('');

  const worst = ungoverned[0];
  if (worst) {
    const inc = worst.resembles
      ? `${worst.resembles.title} (${worst.resembles.aid})`
      : 'a known agent incident';
    out.push(
      `> **Worst finding:** \`${worst.tool.name}\` ${worst.action || 'takes an irreversible action'} — resembles ${inc}.`,
    );
    out.push('');
  }

  if (ungoverned.length) {
    out.push('### Findings');
    out.push('');
    out.push('| Severity | Tool | Resembles (aid) | Fix control |');
    out.push('|---|---|---|---|');
    for (const f of ungoverned) {
      const aid = f.resembles ? f.resembles.aid : '—';
      out.push(
        `| ${f.severity} | \`${f.tool.name}\` | ${aid} | \`${f.control || '—'}\` |`,
      );
    }
    out.push('');
  } else {
    out.push('No ungoverned irreversible tools found — every tool is reversible or already gated.');
    out.push('');
  }

  if (governed.length) {
    out.push('### Governed');
    out.push('');
    for (const f of governed) {
      const was = SIG_SEVERITY[f.signature];
      out.push(
        `- \`${f.tool.name}\` — ${was ? `was ${was}, ` : ''}now governed by \`${f.governedBy.gate}\``,
      );
    }
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push(`**What this won't catch:** ${WONT_CATCH}`);
  out.push('');
  out.push(
    `Generated by [mc scan](${INCIDENT_DB_URL}) against the ${meta.corpusSize}-incident Agent Incident Database. Read-only — nothing left your machine.`,
  );
  out.push('');

  return out.join('\n') + '\n';
}
