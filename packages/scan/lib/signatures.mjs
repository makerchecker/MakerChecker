// Risk signatures for mc scan. Each maps a tool "shape" (the verbs + argument
// hints a tool exposes) to the class of irreversible action it can take, the real
// incident from the Agent Incident Database it resembles, and the control that
// would have stopped it. This table is the moat: findings are named against 41
// sourced, reproduced disasters, not generic "misconfiguration" warnings.
//
// severity: CATASTROPHIC (irreversible + wide blast radius), HIGH (irreversible),
// MEDIUM (consequential but recoverable). A tool with no matching signature is
// reported as reversible and not flagged.
//
// This is PURE DATA. No logic, no imports. See CONTRACTS.md for the Signature
// shape and the matching rules classify() applies. Every `aid` referenced here
// exists in incidents/entries.
//
// FALSE-POSITIVE DISCIPLINE: generic read verbs (get/read/list/fetch/http) never
// match on the tool NAME alone — they are kept out of `strongVerbs` and only fire
// when a confirming `argHint` (a sensitive scope, a destination, a secret) is
// present in the params or description. Only genuinely one-way verbs
// (delete/drop/wipe/exec/wire/force-push/...) are trusted as `strongVerbs`.

/**
 * @typedef {'high_risk_requires_gate'|'approval_gate'|'limit_violation'|'skill_not_granted'|'sod_violation'|'independent_citation_verification'} Control
 * @typedef {{ aid: string, title: string }} IncidentRef
 * @typedef {{ id: string, category: string, verbs: string[], argHints?: string[], strongVerbs?: string[], severity: 'CATASTROPHIC'|'HIGH'|'MEDIUM', action: string, resembles: IncidentRef, alsoResembles?: IncidentRef[], control: Control, why: string }} Signature
 */

/** @type {Signature[]} */
export const SIGNATURES = [
  {
    id: 'destroy-data',
    category: 'data-loss',
    verbs: ['delete', 'drop', 'destroy', 'wipe', 'truncate', 'purge', 'rm', 'remove', 'erase', 'unlink', 'del', 'shred', 'clobber', 'overwrite', 'format', 'flush'],
    argHints: ['table', 'database', 'db', 'record', 'row', 'file', 'path', 'volume', 'bucket', 'collection', 'index', 'directory', 'dir', 'blob', 'object', 'key', 'namespace', 'snapshot', 'backup', 'disk', 'drive', 'store', 'photos', 'home'],
    strongVerbs: ['delete', 'drop', 'destroy', 'wipe', 'truncate', 'purge', 'shred'],
    severity: 'CATASTROPHIC',
    action: 'destroys data that cannot be recovered',
    resembles: { aid: 'AID-2025-0005', title: 'the Replit agent that deleted a production database during a code freeze' },
    alsoResembles: [
      { aid: 'AID-2026-0002', title: 'the Cursor agent that deleted a production database and its backups via an over-privileged Railway token' },
      { aid: 'AID-2025-0003', title: "the Google Antigravity agent that permanently deleted a developer's entire D drive" },
      { aid: 'AID-2026-0006', title: "the Claude Cowork agent that ran rm -rf and deleted ~15 years of a family's photos" },
      { aid: 'AID-2025-0012', title: "the Google Gemini CLI that hallucinated a mkdir and overwrote a user's project files" },
    ],
    control: 'high_risk_requires_gate',
    why: 'A delete/drop/wipe is a one-way door. If the agent can call this directly, one bad turn or one injected instruction wipes production. This needs deny-by-default plus a named-human approval gate before it runs.',
  },
  {
    id: 'run-shell',
    category: 'data-loss',
    verbs: ['exec', 'execute', 'shell', 'bash', 'sh', 'spawn', 'system', 'eval', 'run', 'command', 'subprocess', 'popen', 'rmdir'],
    argHints: ['command', 'cmd', 'script', 'code', 'shell', 'args', 'argv', 'bash', 'stdin', 'entrypoint'],
    strongVerbs: ['exec', 'shell', 'bash', 'eval', 'spawn'],
    severity: 'CATASTROPHIC',
    action: 'runs arbitrary shell commands (it can do anything the process can, including rm -rf)',
    resembles: { aid: 'AID-2025-0010', title: "the Claude Code agent that ran rm -rf and deleted a developer's home directory (issue #10077)" },
    alsoResembles: [
      { aid: 'AID-2025-0008', title: 'the Amazon Q Developer VS Code extension that shipped with a data-wiping prompt injection' },
    ],
    control: 'high_risk_requires_gate',
    why: 'A generic shell/exec tool has unbounded blast radius: it can delete files, exfiltrate secrets, or spend money regardless of what the prompt intended. Arbitrary execution must be gated, sandboxed, and deny-by-default.',
  },
  {
    id: 'force-rewrite-history',
    category: 'data-loss',
    verbs: ['force-push', 'forcepush', 'reset', 'rebase', 'revert', 'rollback', 'overwrite', 'push'],
    argHints: ['git', 'repo', 'branch', 'commit', 'ref', 'head', 'main', 'master', 'force', 'origin', 'remote'],
    strongVerbs: ['force-push', 'forcepush'],
    severity: 'CATASTROPHIC',
    action: 'rewrites or destroys version history',
    resembles: { aid: 'AID-2026-0001', title: 'the Claude Code agent that force-pushed over a private repo and destroyed commit history' },
    control: 'high_risk_requires_gate',
    why: 'Force-pushing or resetting rewrites history that others depend on and is not recoverable from the remote. It should be gated behind a human, never a default grant.',
  },
  {
    id: 'destroy-infra',
    category: 'data-loss',
    verbs: ['terraform', 'destroy', 'teardown', 'deprovision', 'decommission', 'nuke', 'drop'],
    argHints: ['infra', 'cluster', 'stack', 'environment', 'env', 'namespace', 'resource', 'terraform', 'production', 'prod', 'workspace', 'state'],
    strongVerbs: ['destroy', 'terraform', 'teardown', 'nuke'],
    severity: 'CATASTROPHIC',
    action: 'tears down infrastructure and the state that lived on it',
    resembles: { aid: 'AID-2026-0007', title: 'the Claude Code agent that ran terraform destroy and wiped DataTalks.Club production' },
    control: 'high_risk_requires_gate',
    why: 'Destroying infrastructure takes the data on it with it. A single destroy command against the wrong environment is unrecoverable. It needs a human gate and a hard scope on which environments the agent can touch.',
  },
  {
    id: 'move-money',
    category: 'unauthorized-financial-action',
    verbs: ['pay', 'transfer', 'wire', 'send', 'withdraw', 'charge', 'refund', 'swap', 'payout', 'remit', 'disburse', 'approvetransfer'],
    argHints: ['amount', 'usd', 'eth', 'btc', 'wallet', 'account', 'card', 'invoice', 'price', 'notional', 'balance', 'iban', 'recipient', 'payee', 'token', 'address', 'sum'],
    strongVerbs: ['wire', 'withdraw', 'payout', 'remit', 'disburse'],
    severity: 'CATASTROPHIC',
    action: 'moves money out of your control',
    resembles: { aid: 'AID-2026-0004', title: 'the Grok-connected wallet drained of $150K by a Morse-code prompt injection' },
    alsoResembles: [
      { aid: 'AID-2025-0007', title: 'the aixbt autonomous crypto agent drained of 55.5 ETH via injected dashboard prompts' },
      { aid: 'AID-2024-0003', title: 'the Freysa autonomous agent tricked into releasing a $47K crypto prize pool' },
      { aid: 'AID-2022-0003', title: 'the Citigroup $444B basket where hard blocks caught ~$248B but no notional ceiling caught the rest' },
    ],
    control: 'limit_violation',
    why: 'A payment or transfer is a one-way door. It needs a hard per-transaction cap, a per-run invocation cap (the kill switch), and a human on anything over the line. An agent that can move money and read untrusted input is a drain waiting for a prompt injection.',
  },
  {
    id: 'execute-trade',
    category: 'runaway-execution',
    verbs: ['trade', 'buy', 'sell', 'order', 'execute', 'submit', 'place', 'short', 'long', 'purchase'],
    argHints: ['quantity', 'qty', 'shares', 'notional', 'ticker', 'symbol', 'side', 'price', 'contract', 'lot', 'position', 'market', 'limit', 'volume'],
    strongVerbs: [],
    severity: 'CATASTROPHIC',
    action: 'places market orders that execute at machine speed with no ceiling',
    resembles: { aid: 'AID-2012-0001', title: 'the Knight Capital runaway that lost ~$440M in 45 minutes with no kill switch' },
    alsoResembles: [
      { aid: 'AID-2010-0001', title: 'the 2010 Flash Crash, a $4.1B automated sell program run without regard to price or time' },
      { aid: 'AID-2013-0001', title: 'the Everbright Securities arbitrage system that fired runaway orders' },
    ],
    control: 'limit_violation',
    why: 'An order-placement tool with no notional ceiling and no per-session invocation cap is a runaway. It needs fail-closed limits and a circuit breaker that halts the stream, which is exactly what Knight Capital lacked.',
  },
  {
    id: 'autonomous-spend',
    category: 'runaway-execution',
    verbs: ['purchase', 'order', 'buy', 'restock', 'reorder', 'checkout', 'subscribe', 'procure', 'stock', 'discount'],
    argHints: ['inventory', 'stock', 'sku', 'supplier', 'vendor', 'cart', 'product', 'catalog', 'price', 'discount', 'quantity', 'budget'],
    strongVerbs: ['restock', 'reorder', 'procure'],
    severity: 'HIGH',
    action: 'commits real spend (buys stock, sets prices, gives discounts) with no per-transaction cap',
    resembles: { aid: 'AID-2025-0009', title: "Anthropic's Claudius shopkeeper (Project Vend), which placed real orders, priced below cost, and gave inventory away" },
    alsoResembles: [
      { aid: 'AID-2026-0003', title: 'the DN42 network-scan agent that ran up a $6,531 AWS bill through an uncontrolled provisioning loop' },
    ],
    control: 'limit_violation',
    why: 'An agent that can purchase stock, set prices, and issue discounts on its own authority bleeds money one small transaction at a time. It needs a per-transaction cap, a windowed budget that fails closed, and a human on anything below cost.',
  },
  {
    id: 'provision-infra',
    category: 'runaway-execution',
    verbs: ['provision', 'deploy', 'scale', 'launch', 'create', 'apply', 'spin', 'start', 'boot', 'allocate'],
    argHints: ['instance', 'server', 'cluster', 'node', 'aws', 'gcp', 'azure', 'cloud', 'compute', 'vm', 'container', 'infra', 'region', 'gpu', 'lambda', 'loadbalancer'],
    strongVerbs: [],
    severity: 'HIGH',
    action: 'spends money or provisions infrastructure with no cap',
    resembles: { aid: 'AID-2026-0003', title: 'the DN42 network-scan agent that ran up a $6,531 AWS bill through an uncontrolled provisioning loop' },
    control: 'limit_violation',
    why: 'Provisioning in a loop with no invocation or spend cap is a runaway bill. It needs a windowed quota and a ceiling that fails closed before the third redundant cluster spins up.',
  },
  {
    id: 'exfiltrate',
    category: 'data-exfiltration',
    verbs: ['fetch', 'get', 'http', 'request', 'post', 'upload', 'export', 'read', 'download', 'curl', 'webhook', 'render', 'proxy', 'browse'],
    argHints: ['url', 'secret', 'token', 'apikey', 'api_key', 'credential', 'password', 'env', 'source', 'private', 'repo', 'image', 'markdown', 'endpoint', 'host', 'attachment', 'chat', 'history', 'mailbox', 'conversation', 'contact', 'sharepoint', 'onedrive'],
    strongVerbs: [],
    severity: 'HIGH',
    action: 'can carry private data out to an attacker-controlled destination',
    resembles: { aid: 'AID-2025-0001', title: 'CamoLeak, where GitHub Copilot Chat exfiltrated private source code through the image proxy' },
    alsoResembles: [
      { aid: 'AID-2025-0002', title: 'the Microsoft 365 Copilot zero-click exfiltration via prompt injection (CVE-2025-32711)' },
      { aid: 'AID-2025-0006', title: 'ShadowLeak, zero-click Gmail exfiltration via the ChatGPT Deep Research agent' },
      { aid: 'AID-2025-0011', title: 'GitLab Duo remote prompt injection that exfiltrated private source code' },
      { aid: 'AID-2025-0015', title: 'the WhatsApp MCP tool-poisoning proof-of-concept that exfiltrated full chat history via send_message' },
      { aid: 'AID-2026-0008', title: 'ShareLeak, indirect prompt injection in Microsoft Copilot Studio that exfiltrated customer records (CVE-2026-21520)' },
    ],
    control: 'high_risk_requires_gate',
    why: 'A tool that can read secrets or source and also reach the network is an exfiltration path via prompt injection. Reading sensitive scopes should be gated and egress restricted to an allowlist.',
  },
  {
    id: 'send-message',
    category: 'binding-commitment',
    verbs: ['email', 'message', 'post', 'publish', 'tweet', 'notify', 'reply', 'comment', 'dm', 'slack', 'sms', 'call'],
    argHints: ['to', 'recipient', 'channel', 'body', 'subject', 'audience', 'customer', 'public', 'cc', 'bcc', 'phone', 'address'],
    strongVerbs: [],
    severity: 'HIGH',
    action: 'makes a binding or public statement on your behalf',
    resembles: { aid: 'AID-2022-0001', title: "Air Canada, held liable for its chatbot's misstatement of a fare policy" },
    alsoResembles: [
      { aid: 'AID-2025-0013', title: 'the malicious postmark-mcp npm package that silently BCCd agent emails to an attacker' },
    ],
    control: 'high_risk_requires_gate',
    why: 'A message an agent sends can bind you (a promise, a commitment) or leak. Outbound to customers or the public should pass a gate, not go out on a default grant.',
  },
  {
    id: 'bind-commitment',
    category: 'binding-commitment',
    verbs: ['quote', 'offer', 'promise', 'agree', 'commit', 'confirm', 'price', 'discount', 'refund', 'honor'],
    argHints: ['price', 'quote', 'offer', 'policy', 'contract', 'customer', 'deal', 'terms', 'discount', 'payout', 'amount'],
    strongVerbs: [],
    severity: 'HIGH',
    action: 'agrees to prices, refunds, or terms a court can hold you to',
    resembles: { aid: 'AID-2023-0001', title: 'the prompt-injected Chevrolet of Watsonville chatbot that agreed to sell a car for $1' },
    alsoResembles: [
      { aid: 'AID-2024-0001', title: 'the Choice Home Warranty chatbot that committed a $3,000 AC payout the company had not authorized' },
      { aid: 'AID-2021-0002', title: 'the Zillow Offers pricing algorithm that drove a $500M+ loss and wind-down' },
    ],
    control: 'high_risk_requires_gate',
    why: 'When an agent can state a price or agree to terms in conversation, those statements can be legally binding. Anything that commits the business needs a human gate before it is offered.',
  },
  {
    id: 'commit-decision',
    category: 'wrongful-automated-decision',
    verbs: ['approve', 'deny', 'decide', 'adjudicate', 'finalize', 'reject', 'close', 'determine', 'authorize', 'terminate', 'flag', 'match', 'identify', 'profile', 'score', 'classify'],
    argHints: ['claim', 'case', 'coverage', 'eligibility', 'benefit', 'authorization', 'prior-auth', 'preauth', 'patient', 'applicant', 'fraud', 'debt', 'medicaid', 'medicare', 'decision', 'suspect', 'identity', 'biometric', 'facial', 'risk'],
    strongVerbs: ['adjudicate'],
    severity: 'CATASTROPHIC',
    action: 'commits a binding decision about a person that a human is accountable for',
    resembles: { aid: 'AID-2023-0003', title: 'UnitedHealth nH Predict, which denied Medicare post-acute care without clinician authorization' },
    alsoResembles: [
      { aid: 'AID-2022-0002', title: 'Cigna PxDx, which committed batch coverage denials with no human on the call' },
      { aid: 'AID-2015-0002', title: 'the Michigan MiDAS system that auto-adjudicated tens of thousands of false fraud determinations' },
      { aid: 'AID-2024-0004', title: 'the TennCare Connect / TEDS automated Medicaid terminations' },
      { aid: 'AID-2021-0001', title: 'the Dutch childcare-benefits scandal that wrongly accused ~26,000 families' },
      { aid: 'AID-2015-0001', title: "Australia's Robodebt unlawful automated welfare-debt calculation" },
      { aid: 'AID-2024-0002', title: 'the eviCore "dial" prior-authorization algorithm tuned to increase denials' },
      { aid: 'AID-2020-0001', title: 'the Detroit facial-recognition false match that led to Robert Williams’ wrongful arrest' },
    ],
    control: 'approval_gate',
    why: 'Committing a denial, a termination, or an eligibility decision about a person is a call a named human must own, and the agent that prepared it must not be the one that signs it. This needs an approval gate plus segregation of duties.',
  },
  {
    id: 'grant-access',
    category: 'wrongful-automated-decision',
    verbs: ['grant', 'revoke', 'assign', 'provision', 'authorize', 'add', 'remove', 'invite', 'elevate', 'escalate'],
    argHints: ['iam', 'permission', 'role', 'access', 'scope', 'policy', 'user', 'group', 'privilege', 'admin', 'credential', 'token', 'key'],
    strongVerbs: [],
    severity: 'HIGH',
    action: 'changes who can access what, expanding privilege',
    resembles: { aid: 'AID-2026-0005', title: 'the Meta AI agent that skipped required human review and whose flawed guidance led to broad data access' },
    control: 'approval_gate',
    why: 'Granting a role or widening a scope is a privilege change that a human must review; an agent that can hand out access can quietly expand its own blast radius. It needs an approval gate and segregation of duties.',
  },
  {
    id: 'file-external',
    category: 'fabrication',
    verbs: ['file', 'submit', 'cite', 'report', 'publish', 'register', 'lodge', 'serve'],
    argHints: ['court', 'citation', 'filing', 'brief', 'motion', 'regulator', 'e2b', 'mdr', 'report', 'reportability', 'reference', 'record', 'submission'],
    strongVerbs: [],
    severity: 'HIGH',
    action: 'submits a filing to a court or regulator that may contain fabricated content',
    resembles: { aid: 'AID-2023-0002', title: 'the attorneys who filed ChatGPT-hallucinated case citations to federal court' },
    alsoResembles: [
      { aid: 'AID-2025-0004', title: 'the MyPillow attorney filings with fabricated citations and a repeat miscitation' },
      { aid: 'AID-2025-0014', title: 'Wadsworth v. Walmart, AI-fabricated case citations in a federal court filing' },
    ],
    control: 'independent_citation_verification',
    why: 'A tool that files to a court or regulator can submit content the model hallucinated. Every external claim or citation must be independently verified before it is filed, with a human who signs the submission.',
  },
];

/** The union of every signature verb, lowercased. Used as a fast irreversibility
 *  pre-filter and as a fallback when no named signature matches but a tool clearly
 *  does something it cannot undo. */
export const IRREVERSIBLE_VERBS = new Set(
  SIGNATURES.flatMap((s) => s.verbs.map((v) => v.toLowerCase())),
);
