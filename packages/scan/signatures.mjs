// Risk signatures for mc scan. Each maps a tool "shape" (verbs + argument hints
// a tool exposes) to the class of irreversible action it can take, the real
// incident from the Agent Incident Database it resembles, and the control that
// would have stopped it. This table is the moat: the findings are named against
// 41 sourced, reproduced disasters, not generic "misconfiguration" warnings.
//
// severity: CATASTROPHIC (irreversible + wide blast radius), HIGH (irreversible),
// MEDIUM (consequential but recoverable). A tool with no matching signature is
// reported as reversible/low and not flagged.

/** @typedef {{ id: string, verbs: string[], argHints?: string[], severity: 'CATASTROPHIC'|'HIGH'|'MEDIUM', action: string, resembles: { aid: string, title: string }, control: string, why: string }} Signature */

/** @type {Signature[]} */
export const SIGNATURES = [
  {
    id: 'destroy-data',
    verbs: ['delete', 'drop', 'destroy', 'wipe', 'truncate', 'purge', 'rm', 'remove', 'erase', 'unlink'],
    argHints: ['table', 'database', 'db', 'record', 'row', 'file', 'path', 'volume', 'bucket', 'collection', 'index'],
    severity: 'CATASTROPHIC',
    action: 'destroys data that cannot be recovered',
    resembles: { aid: 'AID-2025-0005', title: 'the Replit agent that deleted a production database during a code freeze' },
    control: 'high_risk_requires_gate',
    why: 'A delete/drop is irreversible. If the agent can call this directly, one bad turn wipes production. This needs deny-by-default plus a named-human approval gate before it runs.',
  },
  {
    id: 'force-rewrite-history',
    verbs: ['force-push', 'forcepush', 'reset', 'rebase', 'revert', 'rollback', 'overwrite'],
    argHints: ['git', 'repo', 'branch', 'commit', 'ref', 'HEAD', 'main', 'master'],
    severity: 'CATASTROPHIC',
    action: 'rewrites or destroys version history',
    resembles: { aid: 'AID-2026-0001', title: 'the Claude Code agent that force-pushed over a private repo and destroyed commit history' },
    control: 'high_risk_requires_gate',
    why: 'Force-pushing or resetting rewrites history that others depend on. It should be gated behind a human, never a default grant.',
  },
  {
    id: 'move-money',
    verbs: ['pay', 'transfer', 'wire', 'send', 'withdraw', 'charge', 'refund', 'swap', 'trade', 'buy', 'sell', 'checkout', 'purchase', 'payout'],
    argHints: ['amount', 'usd', 'eth', 'wallet', 'account', 'card', 'invoice', 'price', 'quantity', 'notional', 'balance'],
    severity: 'CATASTROPHIC',
    action: 'moves money out of your control',
    resembles: { aid: 'AID-2026-0004', title: 'the Grok-connected wallet drained of $150K by a hidden prompt injection' },
    control: 'limit_violation',
    why: 'A payment or transfer is a one-way door. It needs a hard per-transaction cap, a per-run invocation cap (the kill switch Knight Capital lacked), and a human on anything over the line.',
  },
  {
    id: 'exfiltrate',
    verbs: ['fetch', 'get', 'http', 'request', 'post', 'upload', 'export', 'read', 'download', 'curl', 'webhook', 'render'],
    argHints: ['url', 'secret', 'token', 'key', 'credential', 'password', 'env', 'source', 'private', 'repo', 'file', 'image'],
    severity: 'HIGH',
    action: 'can carry private data out to an attacker-controlled destination',
    resembles: { aid: 'AID-2025-0001', title: 'CamoLeak, where GitHub Copilot Chat exfiltrated private source code through the image proxy' },
    control: 'high_risk_requires_gate',
    why: 'A tool that can read secrets or source and also reach the network is an exfiltration path via prompt injection. Reading sensitive scopes should be gated and egress restricted.',
  },
  {
    id: 'provision-infra',
    verbs: ['provision', 'deploy', 'scale', 'launch', 'create', 'terraform', 'apply', 'spin', 'start', 'run'],
    argHints: ['instance', 'server', 'cluster', 'node', 'aws', 'gcp', 'cloud', 'compute', 'vm', 'container', 'infra'],
    severity: 'HIGH',
    action: 'spends money or provisions infrastructure with no cap',
    resembles: { aid: 'AID-2026-0003', title: 'the DN42 scan agent that ran up a $6,531 AWS bill through uncontrolled provisioning' },
    control: 'limit_violation',
    why: 'Provisioning in a loop with no invocation or spend cap is a runaway. It needs a windowed quota and a ceiling that fails closed.',
  },
  {
    id: 'commit-decision',
    verbs: ['approve', 'deny', 'decide', 'adjudicate', 'submit', 'file', 'finalize', 'sign', 'authorize', 'reject', 'close', 'commit', 'grant', 'revoke'],
    argHints: ['claim', 'case', 'report', 'decision', 'coverage', 'eligibility', 'reportability', 'e2b', 'mdr', 'filing', 'iam', 'permission', 'access', 'patient', 'record'],
    severity: 'CATASTROPHIC',
    action: 'commits a binding decision a human is accountable for',
    resembles: { aid: 'AID-2022-0002', title: 'Cigna PxDx, where an automated system committed batch coverage denials with no human on the call' },
    control: 'approval_gate',
    why: 'Committing a denial, a filing, or an access grant is a decision a named person must own, and the agent that prepared it must not be the one that signs it. This needs an approval gate plus segregation of duties.',
  },
  {
    id: 'send-message',
    verbs: ['email', 'message', 'post', 'publish', 'tweet', 'notify', 'reply', 'comment', 'dm', 'slack'],
    argHints: ['to', 'recipient', 'channel', 'body', 'subject', 'audience', 'customer', 'public'],
    severity: 'HIGH',
    action: 'makes a binding or public statement on your behalf',
    resembles: { aid: 'AID-2022-0001', title: "Air Canada, held liable for its chatbot's misstatement of a fare policy" },
    control: 'high_risk_requires_gate',
    why: 'A message an agent sends can bind you (a promise, a commitment) or leak. Outbound to customers or the public should pass a gate, not go out on a default grant.',
  },
];

/** The verb set that makes an action irreversible, used as a fallback when no
 *  named signature matches but the tool clearly does something it cannot undo. */
export const IRREVERSIBLE_VERBS = new Set(
  SIGNATURES.flatMap((s) => s.verbs),
);
