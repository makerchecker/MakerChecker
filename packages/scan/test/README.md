# Tests — convention

Zero dependencies. Plain Node, using the built-in `node:test` runner and
`node:assert/strict`. No frameworks, no config, no install step.

## Layout

One `*.test.mjs` file per lib module, named after it:

```
test/
  parse.test.mjs        # parseTools: OpenAI, MCP, bare arrays, code discovery, junk-resilience, dedupe
  policy.test.mjs       # loadPolicy up-tree lookup + defaults + validation; mergeSignatures (custom wins)
  classify.test.mjs     # signature matching, strongVerbs, severity pick, ignore/allow downgrade
  report.test.mjs       # renderTerminal (string), renderJson (pure-JSON object), renderMarkdown (string)
  policyInit.test.mjs   # CAT/HIGH -> allow entry, deny-by-default, on-disk shape (no `path`)
  signatures.test.mjs   # every resembles.aid / alsoResembles.aid exists in ../../incidents/entries
  fixtures/             # sample tools.json + tiny .py/.ts snippets for parse
```

## Running

```bash
node --test              # run the whole suite
node --test test/parse.test.mjs
```

Every builder ships the tests for their own module. Assert against the exact
shapes in `CONTRACTS.md` (Tool, Finding, Policy, Meta) so the fixed contract is
enforced by tests, not just documented. Tests must not touch the network or write
outside `test/` (use the OS temp dir for `initPolicy` write tests).

## Example (harness style)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../lib/classify.mjs';
import { SIGNATURES } from '../lib/signatures.mjs';
import { DEFAULT_POLICY } from '../lib/policy.mjs';

test('a delete tool is CATASTROPHIC and names the Replit incident', () => {
  const tool = { name: 'delete_records', description: 'delete rows from a table', params: ['table'], source: 'x.json' };
  const f = classify(tool, SIGNATURES, DEFAULT_POLICY);
  assert.equal(f.severity, 'CATASTROPHIC');
  assert.equal(f.signature, 'destroy-data');
  assert.equal(f.resembles.aid, 'AID-2025-0005');
});
```
