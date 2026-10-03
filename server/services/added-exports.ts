/**
 * Which named exports a task adds to a file that already existed at the
 * merge-base — read from the file's two versions, never from error text.
 *
 * Used by the baseline comparison (verification.ts): a test that fails on the
 * original code only because it imports a function the task added to an
 * existing module proves the same thing as one importing a brand-new module.
 *
 * Lexical, not a parser: it recognises the export forms real code uses and
 * answers `null` ("can't tell") for anything it cannot enumerate — `export *`,
 * a destructured export, `module.exports = <not an object literal>`, a module
 * `__getattr__`. `null` always leads to "could not run", never to a claim.
 *
 * Pure (no IO), like test-runners.ts.
 */

const isPython = (path: string) => /\.pyi?$/.test(path);
const isJs = (path: string) => /\.[cm]?[jt]sx?$/.test(path);

/** Remove comments and blank out string/template contents (keeping quotes), so neither is mistaken for code. */
function stripJs(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; out += ' '; continue; }
    if (c === "'" || c === '"' || c === '`') {
      // Bodies are kept only when they are a single token: import specifiers and
      // `exports['x']` need them; a string full of `export function …` text does not.
      // A '/" string cannot span lines, so one that hasn't closed by the end of the
      // line was never a string — an apostrophe in JSX text (`Don't`) or a regex
      // literal (`/'/`) — and costs at most the rest of that line, not the file.
      let j = i + 1;
      let body = '';
      while (j < src.length && src[j] !== c && (c === '`' || src[j] !== '\n')) { if (src[j] === '\\') { body += src[j]; j++; } body += src[j] ?? ''; j++; }
      if (c !== '`' && src[j] !== c) { out += '\n'; i = j; continue; }
      out += c + (c === '`' || /\s/.test(body) ? '' : body) + c;
      i = j;
      continue;
    }
    out += c;
  }
  return out;
}

/** Split `a, b as c, type D` at top-level commas. */
const splitList = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);

/** The top-level keys of an object literal starting at `src[open] === '{'`; null for a spread or computed key. */
function objectKeys(src: string, open: number): string[] | null {
  let depth = 0;
  let item = '';
  const items: string[] = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{' || c === '(' || c === '[') { depth++; if (depth === 1) continue; }
    if (c === '}' || c === ')' || c === ']') { depth--; if (depth === 0) { items.push(item); break; } }
    if (depth === 1 && c === ',') { items.push(item); item = ''; continue; }
    if (depth >= 1) item += c;
  }
  const keys: string[] = [];
  for (const raw of items.map(x => x.trim()).filter(Boolean)) {
    if (raw.startsWith('...') || raw.startsWith('[')) return null;
    const m = /^(?:async\s+)?\*?\s*(?:get\s+|set\s+)?(?:([\w$]+)|'([^']*)'|"([^"]*)")/.exec(raw);
    if (!m) return null;
    keys.push(m[1] ?? m[2] ?? m[3]);
  }
  return keys;
}

/**
 * The names a JS/TS module exports (ESM and the common CommonJS forms), or null
 * when the set cannot be enumerated from the text.
 */
export function jsExportedNames(source: string): Set<string> | null {
  const src = stripJs(source);
  const names = new Set<string>();
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void) => { let m; while ((m = re.exec(src)) !== null) fn(m); };

  if (/\bexport\s*\*\s*from\b/.test(src)) return null;
  if (/\bexport\s+(?:declare\s+)?(?:const|let|var)\s*[{[]/.test(src)) return null;

  if (/\bexport\s+default\b/.test(src)) names.add('default');
  each(/\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function\s*\*?\s*|(?:abstract\s+)?class\s+|(?:const\s+)?enum\s+|interface\s+|type\s+(?=[\w$]+\s*[=<])|namespace\s+|(?:const|let|var)\s+)([\w$]+)/g, m => names.add(m[1]));
  each(/\bexport\s*\*\s*as\s+([\w$]+)/g, m => names.add(m[1]));
  // `export { a, b as c }`, `export type { T }`, optionally `from '…'`.
  each(/\bexport\s+(?:type\s+)?\{([^}]*)\}/g, m => {
    for (const item of splitList(m[1])) {
      const parts = item.replace(/^type\s+/, '').split(/\s+as\s+/);
      names.add((parts[1] ?? parts[0]).replace(/^['"]|['"]$/g, ''));
    }
  });
  // CommonJS.
  each(/(?<![\w$.])(?:module\.)?exports\.([\w$]+)\s*=(?!=)/g, m => names.add(m[1]));
  each(/(?<![\w$.])(?:module\.)?exports\[\s*['"]([^'"]+)['"]\s*\]\s*=(?!=)/g, m => names.add(m[1]));
  let assigned: RegExpExecArray | null;
  const whole = /(?<![\w$.])module\.exports\s*=(?!=)\s*/g;
  while ((assigned = whole.exec(src)) !== null) {
    const at = assigned.index + assigned[0].length;
    if (src[at] !== '{') return null;
    const keys = objectKeys(src, at);
    if (!keys) return null;
    for (const k of keys) names.add(k);
  }
  return names;
}

const PY_KEYWORDS = new Set(['else', 'try', 'finally', 'except', 'elif', 'if', 'while', 'for', 'with', 'match', 'case', 'lambda']);

export interface PythonNames {
  /** Every name bound at module level (defs, classes, assignments, imports). */
  all: Set<string>;
  /**
   * The ones that can be the module's API — what a rename would remove: its own
   * defs/classes/assignments, and names it re-exports from its OWN project:
   * `from .impl import x`, or `from pkg.impl import x` inside `pkg/` (how a package
   * `__init__` re-exports). Imports from elsewhere (`from typing import Optional`,
   * `import os`) are dependencies, which code tidying drops freely.
   */
  defined: Set<string>;
}

/** Names bound at the top level of a Python module, or null when they cannot be enumerated. */
export function pythonTopLevelNames(source: string, path = ''): PythonNames | null {
  // The packages `path` lives in (`src/pkg/sub/m.py` → src, pkg, sub): an absolute import from one is a project re-export.
  const ownPackages = new Set(path.split('/').slice(0, -1));
  const isOwnModule = (mod: string) => mod.startsWith('.') || ownPackages.has(mod.split('.')[0]);
  const all = new Set<string>();
  const defined = new Set<string>();
  // Blank out triple-quoted strings so a docstring line starting with `def ` is not code.
  const src = source.replace(/("""|''')[\s\S]*?\1/g, s => s.replace(/[^\n]/g, ' '));
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/#.*$/, '');
    if (!line || /^\s/.test(line)) continue;
    let m: RegExpExecArray | null;
    if ((m = /^(?:async\s+)?def\s+(\w+)/.exec(line)) || (m = /^class\s+(\w+)/.exec(line))) {
      all.add(m[1]); defined.add(m[1]);
      if (m[1] === '__getattr__') return null;
    } else if ((m = /^from\s+([\w.]+)\s+import\s+(.*)$/.exec(line))) {
      const reexport = isOwnModule(m[1]);
      let list = m[2];
      if (list.trim().startsWith('(')) {
        while (!list.includes(')') && i + 1 < lines.length) list += ' ' + lines[++i].replace(/#.*$/, '');
        list = list.replace(/[()]/g, '');
      }
      for (const item of splitList(list.replace(/\\$/, ''))) {
        if (item === '*') return null;
        const parts = item.split(/\s+as\s+/);
        const name = (parts[1] ?? parts[0]).trim();
        all.add(name);
        if (reexport) defined.add(name);
      }
    } else if ((m = /^import\s+(.*)$/.exec(line))) {
      for (const item of splitList(m[1])) {
        const parts = item.split(/\s+as\s+/);
        all.add(parts[1] ? parts[1].trim() : parts[0].trim().split('.')[0]);
      }
    } else if ((m = /^([\w\s,()]+?)\s*(?::[^=]*)?=(?!=)/.exec(line))) {
      for (const n of m[1].replace(/[()]/g, '').split(',').map(x => x.trim()).filter(x => /^\w+$/.test(x))) {
        all.add(n); defined.add(n);
      }
    } else if ((m = /^(\w+)\s*:/.exec(line)) && !PY_KEYWORDS.has(m[1])) {
      all.add(m[1]); defined.add(m[1]);
    }
  }
  return { all, defined };
}

/**
 * Names `path` exports now that it did not at the merge-base — but only when the
 * task removed none: a name that disappeared alongside a new one is
 * indistinguishable from a rename, which is a changed API, not new code. Null
 * when either version's exports can't be enumerated or the language isn't
 * supported.
 */
export function addedExports(path: string, baseSource: string, currentSource: string): Set<string> | null {
  if (isPython(path)) {
    const before = pythonTopLevelNames(baseSource, path);
    const after = pythonTopLevelNames(currentSource, path);
    if (!before || !after) return null;
    // A dropped dependency import is tidying; a dropped def/class/assignment or project re-export is a removal.
    for (const n of before.defined) if (!after.all.has(n)) return null;
    return new Set([...after.all].filter(n => !before.all.has(n)));
  }
  if (isJs(path)) {
    const before = jsExportedNames(baseSource);
    const after = jsExportedNames(currentSource);
    if (!before || !after) return null;
    for (const n of before) if (!after.has(n)) return null;
    return new Set([...after].filter(n => !before.has(n)));
  }
  return null;
}

/** One binding a JS test file imports. `imported` is `*` for a namespace / whole-module binding. */
export interface ImportBinding {
  local: string;
  imported: string;
  spec: string;
}

/** The bindings a JS/TS file imports, ESM or `require`. */
export function jsImports(source: string): ImportBinding[] {
  const src = stripJs(source);
  const out: ImportBinding[] = [];
  const named = (list: string, spec: string, sep: RegExp) => {
    for (const item of splitList(list)) {
      const parts = item.replace(/^type\s+/, '').split(sep);
      const imported = parts[0].trim().replace(/^['"]|['"]$/g, '');
      out.push({ imported, local: (parts[1] ?? imported).trim(), spec });
    }
  };
  let m: RegExpExecArray | null;
  const esm = /\bimport\s+(?!type\s)([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  while ((m = esm.exec(src)) !== null) {
    const clause = m[1].trim();
    const spec = m[2];
    const def = /^([\w$]+)\s*(?:,|$)/.exec(clause);
    if (def) out.push({ local: def[1], imported: 'default', spec });
    const ns = /\*\s*as\s+([\w$]+)/.exec(clause);
    if (ns) out.push({ local: ns[1], imported: '*', spec });
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) named(braces[1], spec, /\s+as\s+/);
  }
  const req = /\b(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = req.exec(src)) !== null) {
    if (m[1].startsWith('{')) named(m[1].slice(1, -1), m[2], /\s*:\s*/);
    else out.push({ local: m[1], imported: '*', spec: m[2] });
  }
  return out;
}
