// lib/parse.mjs — discover agent tool definitions from files, directories, and
// source code. Read-only, resilient to junk. Returns a de-duplicated Tool[].
//
// Handles:
//   - OpenAI tools/function schemas: { type:'function', function:{ name, description, parameters } }
//   - Anthropic tool schemas:        { name, description, input_schema }
//   - MCP tools/list JSON:           { tools: [ { name, description, inputSchema } ] }
//   - bare arrays of                 { name, description, parameters }
//   - code discovery in .py/.ts/.js/.mjs/.cjs/.tsx/.jsx:
//       * LangChain @tool decorators, Tool(...)/StructuredTool(...) definitions
//       * MCP server registrations: server.tool("name", ...), @mcp.tool(), registerTool("name")
//       * function-calling tool object literals { name, description, parameters }
//
// For JSON, `source` is the relative file path. For code, `source` is
// "<relpath>:<line>". Skips node_modules and dotfiles. Never throws on a bad file.
//
// Zero deps, Node >= 18, ESM. Only node:fs / node:path.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative, extname, basename } from 'node:path';

/**
 * @typedef {{ name: string, description: string, params: string[], source: string, body?: string, bodyLine?: number, sandboxed?: boolean }} Tool
 *
 * `body` (code discovery only) is a snippet of the source following the tool
 * definition — up to BODY_MAX_LINES lines — used by classify() for body-signal
 * detection. `bodyLine` is the 1-based line number of the first snippet line.
 * `sandboxed` is set when the file stands up a disposable execution sandbox.
 */

const CODE_EXT = new Set(['.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '__pycache__', 'venv', '.venv']);
// Test and spec directories: a "tool" defined only in a test is a fixture, not a
// capability the agent ships. Flagging one (e.g. a <Rating> tag inside a pytest
// config) is a false positive an outreach PR cannot survive.
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', '__mocks__', 'fixtures', 'testdata']);
const MAX_FILE_BYTES = 4 * 1024 * 1024; // skip pathologically large files

// A test/spec FILE by name: pytest (test_*.py, *_test.py, conftest.py) and
// JS/TS (*.test.*, *.spec.*). Excluded from discovery for the same reason.
function isTestFile(name) {
  const n = name.toLowerCase();
  if (n === 'conftest.py') return true;
  if (/^test_.*\.py$/.test(n) || /_test\.py$/.test(n)) return true;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(n)) return true;
  return false;
}

/**
 * Parse tool definitions from a file or directory.
 * @param {string} path
 * @returns {Tool[]}
 */
export function parseTools(path) {
  let abs, st;
  try {
    abs = resolve(path);
    st = statSync(abs);
  } catch {
    return [];
  }

  const root = st.isDirectory() ? abs : dirname(abs);
  const files = [];
  try {
    if (st.isDirectory()) walk(abs, files);
    else files.push(abs);
  } catch {
    /* stay resilient */
  }

  const tools = [];
  for (const file of files) {
    try {
      collectFromFile(file, relFor(root, file), tools);
    } catch {
      /* never throw on a bad file */
    }
  }
  return dedupe(tools);
}

// ---- directory walk ---------------------------------------------------------

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const name = ent.name;
    if (name.startsWith('.')) continue; // dotfiles / dotdirs
    if (ent.isSymbolicLink()) continue; // avoid symlink loops
    const full = join(dir, name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(name) || TEST_DIRS.has(name.toLowerCase())) continue;
      walk(full, out);
    } else if (ent.isFile()) {
      if (isTestFile(name)) continue;
      const ext = extname(name).toLowerCase();
      if (ext === '.json' || CODE_EXT.has(ext)) out.push(full);
    }
  }
}

function relFor(root, file) {
  const r = relative(root, file);
  return r && !r.startsWith('..') ? r : basename(file);
}

// ---- per-file dispatch ------------------------------------------------------

function collectFromFile(file, rel, out) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return;
  }
  if (stat.size > MAX_FILE_BYTES) return;

  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return; // binary / permission / etc.
  }

  const ext = extname(file).toLowerCase();
  if (ext === '.json') {
    let data;
    try {
      data = JSON.parse(content);
    } catch {
      return; // not valid JSON — skip
    }
    extractJson(data, rel, out);
  } else if (CODE_EXT.has(ext)) {
    extractCode(content, rel, out);
  }
}

// ---- JSON extraction --------------------------------------------------------

function extractJson(data, source, out) {
  if (Array.isArray(data)) {
    for (const item of data) itemToTool(item, source, out);
    return;
  }
  if (!data || typeof data !== 'object') return;

  const containers = [
    data.tools,
    data.functions,
    data.result && data.result.tools,
    data.result && data.result.functions,
  ];
  let found = false;
  for (const c of containers) {
    if (Array.isArray(c)) {
      for (const item of c) itemToTool(item, source, out);
      found = true;
    }
  }
  if (found) return;

  // Otherwise treat the object itself as a single tool / function wrapper.
  itemToTool(data, source, out);
}

function itemToTool(item, source, out) {
  if (!item || typeof item !== 'object') return;

  // Unwrap OpenAI { type:'function', function:{...} } and { function:{...} }.
  let obj = item;
  if (item.function && typeof item.function === 'object' && typeof item.function.name === 'string') {
    obj = item.function;
  }

  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (!name) return;

  const description = typeof obj.description === 'string' ? obj.description : '';
  const schema = obj.parameters || obj.inputSchema || obj.input_schema || obj.args_schema || obj.schema;
  out.push({ name, description, params: schemaParamNames(schema), source });
}

function schemaParamNames(schema) {
  if (!schema || typeof schema !== 'object') return [];
  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    return Object.keys(schema.properties);
  }
  // A raw properties map (no JSON Schema wrapper): keys are param names, values objects.
  const keys = Object.keys(schema);
  if (keys.length && keys.every((k) => schema[k] && typeof schema[k] === 'object')) return keys;
  return [];
}

// ---- code discovery ---------------------------------------------------------

const BODY_MAX_LINES = 60;

// Disposable-execution markers: if a file stands up an e2b sandbox, a container,
// or a WASM/RestrictedPython interpreter, code the agent runs is confined to it.
// Kept in sync with classify.mjs SANDBOX_RE.
const SANDBOX_RE = /\be2b\b|@e2b\/|Sandbox\.create|CodeInterpreter|code_interpreter|codeInterpreter|\bpyodide\b|RestrictedPython|\bgvisor\b|\bfirecracker\b|\bnsjail\b|\bbubblewrap\b|\bfirejail\b|dockerode|docker\.from_env|DockerClient|\bwasmer\b|\bwasmtime\b/;

function extractCode(content, rel, out) {
  const lineAt = makeLineAt(content);
  const lines = content.split('\n');
  // A sandbox is usually stood up once at module top (e.g. Sandbox.create()),
  // far from the tool body, so we record it at the file level and carry it onto
  // every tool discovered here — classify() uses it to downgrade a dangerous
  // action that can only reach a disposable VM, not the user's real systems.
  const fileHasSandbox = SANDBOX_RE.test(content);
  const push = (name, description, params, index) => {
    const n = (name || '').trim();
    if (!n) return;
    const line = lineAt(index);
    // Body snippet: up to BODY_MAX_LINES lines following the definition line,
    // truncated at the next top-level definition so one tool's snippet never
    // bleeds into its neighbour's body (and claims its evidence).
    const bodyLine = line + 1;
    const raw = lines.slice(bodyLine - 1, bodyLine - 1 + BODY_MAX_LINES);
    const boundary = raw.findIndex(
      (l, i) => i > 0 && /^(?:@|(?:async\s+)?def |class |function |const |let |var |export )/.test(l),
    );
    const body = (boundary === -1 ? raw : raw.slice(0, boundary)).join('\n');
    const tool = { name: n, description: description || '', params: params || [], source: `${rel}:${line}` };
    if (body.trim()) {
      tool.body = body;
      tool.bodyLine = bodyLine;
    }
    if (fileHasSandbox) tool.sandboxed = true;
    out.push(tool);
  };

  pyDecorators(content, push);
  pyToolConstructors(content, push);
  mcpRegistrations(content, push);
  objectLiteralTools(content, push);
}

// LangChain / MCP Python decorators: @tool, @tool("name"), @mcp.tool(), @app.tool()
function pyDecorators(content, push) {
  const re = /@\s*(?:[\w.]+\.)?tool\b\s*(\([^)]*\))?\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(content))) {
    const decArgs = m[1] || '';
    const funcName = m[2];
    const sig = m[3] || '';
    let name = funcName;
    if (decArgs) {
      const explicit = kwString(decArgs, 'name') || firstStringLiteral(decArgs);
      if (explicit) name = explicit;
    }
    push(name, '', pyParams(sig), m.index);
  }
}

// LangChain Tool(...) / StructuredTool(...) / *.from_function(...) constructors.
function pyToolConstructors(content, push) {
  const re = /\b(?:StructuredTool|Tool)\b\s*(?:\.\w+)?\s*\(/g;
  let m;
  while ((m = re.exec(content))) {
    const window = content.slice(m.index, m.index + 600);
    const name = kwString(window, 'name');
    if (!name) continue;
    const description = kwString(window, 'description') || '';
    push(name, description, [], m.index);
  }
}

// MCP server registrations: server.tool("name", ...), registerTool("name", ...), .tool('name', ...)
function mcpRegistrations(content, push) {
  const re = /\b(?:registerTool|tool)\s*\(/g;
  let m;
  while ((m = re.exec(content))) {
    const parenIndex = m.index + m[0].length - 1;
    const argsStr = balancedSlice(content, parenIndex, '(', ')');
    if (argsStr == null) continue;
    const args = splitTopLevel(argsStr.slice(1, -1));
    const first = (args[0] || '').trim();
    const nameLit = /^(['"`])([^'"`]+)\1$/.exec(first);
    if (!nameLit) continue; // not a string-named registration (e.g. @tool def form)
    const name = nameLit[2];

    let description = '';
    let params = [];
    for (let k = 1; k < args.length; k++) {
      const a = args[k].trim();
      const strLit = /^(['"`])([\s\S]*)\1$/.exec(a);
      if (strLit && !description) {
        description = strLit[2];
        continue;
      }
      if (a.startsWith('{')) {
        if (/\b(description|inputSchema|input_schema|parameters|schema)\b/.test(a)) {
          if (!description) description = kwString(a, 'description') || '';
          const keys = schemaKeys(a);
          if (keys.length) params = keys;
        } else {
          const keys = objectKeys(a);
          if (keys.length && !params.length) params = keys;
        }
      }
    }
    push(name, description, params, m.index);
  }
}

// Function-calling tool object literals: { name: "x", description: "...", parameters: {...} }
function objectLiteralTools(content, push) {
  const re = /\bname\s*[:=]\s*(['"`])([^'"`]+)\1/g;
  let m;
  while ((m = re.exec(content))) {
    const obj = enclosingObject(content, m.index);
    if (!obj) continue;
    // Require a tool-shaped sibling key to avoid matching arbitrary objects.
    if (!/\b(description|parameters|inputSchema|input_schema|schema)\b/.test(obj.text)) continue;
    const name = m[2];
    const description = kwString(obj.text, 'description') || '';
    push(name, description, schemaKeys(obj.text), obj.start);
  }
}

// ---- text helpers -----------------------------------------------------------

// Match `key: "value"` or `key = 'value'` (multiline value ok). `key` is a literal word.
function kwString(text, key) {
  try {
    const re = new RegExp('\\b' + key + "\\s*[:=]\\s*(['\"`])((?:\\\\.|(?!\\1)[\\s\\S])*)\\1");
    const m = re.exec(text);
    return m ? m[2] : null;
  } catch {
    return null;
  }
}

function firstStringLiteral(text) {
  const m = /(['"`])([^'"`]+)\1/.exec(text);
  return m ? m[2] : null;
}

// Parse a Python parameter signature into identifier names.
function pyParams(sig) {
  return splitTopLevel(sig)
    .map((p) => p.trim().replace(/^\*+/, ''))
    .map((p) => p.split(/[:=]/)[0].trim())
    .filter((p) => p && p !== 'self' && p !== 'cls' && p !== '/' && p !== '*');
}

// Find a `parameters`/`inputSchema`/`schema` key in `text` and return its keys
// (digging into JSON-Schema `properties` when present).
function schemaKeys(text) {
  const m = /\b(parameters|inputSchema|input_schema|args_schema|schema)\b\s*[:=]/.exec(text);
  if (!m) return [];
  const braces = sliceBraces(text, m.index + m[0].length);
  if (!braces) return [];
  const propsM = /\bproperties\b\s*[:=]/.exec(braces);
  if (propsM) {
    const pb = sliceBraces(braces, propsM.index + propsM[0].length);
    if (pb) return objectKeys(pb);
  }
  return objectKeys(braces);
}

// Top-level keys of an object-literal string (leading/trailing braces optional).
function objectKeys(objStr) {
  if (!objStr) return [];
  const s = objStr.replace(/^\s*\{/, '').replace(/\}\s*$/, '');
  const keys = [];
  for (const seg of splitTopLevel(s)) {
    const m = /^\s*(?:(['"`])([\w-]+)\1|([A-Za-z_$][\w$]*))\s*:/.exec(seg);
    if (m) keys.push(m[2] || m[3]);
  }
  return keys;
}

// Split a string on top-level commas, respecting quotes and bracket nesting.
function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let last = 0;
  let inStr = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === inStr && s[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(s.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(s.slice(last));
  return parts;
}

// Return the balanced `{...}` substring starting at/after `from` (incl. braces).
function sliceBraces(text, from) {
  const start = text.indexOf('{', from);
  if (start === -1) return '';
  return balancedSlice(text, start, '{', '}') || '';
}

// Return the balanced substring from an opening delimiter at `openIndex`.
function balancedSlice(text, openIndex, open, close) {
  if (text[openIndex] !== open) {
    openIndex = text.indexOf(open, openIndex);
    if (openIndex === -1) return null;
  }
  let depth = 0;
  let inStr = null;
  for (let i = openIndex; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === inStr && text[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(openIndex, i + 1);
    }
  }
  return null;
}

// Find the innermost `{...}` object enclosing `index`.
function enclosingObject(content, index) {
  let depth = 0;
  let start = -1;
  for (let i = index; i >= 0; i--) {
    const c = content[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start === -1) return null;
  const text = balancedSlice(content, start, '{', '}');
  if (!text) return null;
  return { text, start };
}

// Precompute a fast char-index -> 1-based line-number lookup.
function makeLineAt(content) {
  const offsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') offsets.push(i + 1);
  }
  return (index) => {
    let lo = 0;
    let hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// ---- dedupe -----------------------------------------------------------------

// Dedupe by name: first occurrence wins, but prefer a non-empty description and
// fill in params if the first sighting had none.
function dedupe(tools) {
  const map = new Map();
  for (const t of tools) {
    const existing = map.get(t.name);
    if (!existing) {
      map.set(t.name, t);
      continue;
    }
    if (!existing.description && t.description) existing.description = t.description;
    if ((!existing.params || existing.params.length === 0) && t.params && t.params.length) {
      existing.params = t.params;
    }
    if (!existing.body && t.body) {
      existing.body = t.body;
      existing.bodyLine = t.bodyLine;
    }
  }
  return [...map.values()];
}
