/**
 * The "hard to reverse" facts of a change, computed from the diff — not asked of
 * the model. Facts come from the harness; the auditor may only annotate them.
 *
 * Lexical and best-effort (regexes over added/removed diff lines, JSON for
 * package.json), so each fact is "detected from the diff", never a guarantee that
 * nothing else changed. Pure: the diff and the package.json texts come in as data.
 */

import { exemptReason, splitDiff } from './review-coverage.js';

export type FactKind = 'dependency' | 'schema' | 'route' | 'mcp_tool' | 'env_var';

export interface HardFact {
  /** Stable within a report; the auditor's annotations refer to it. */
  id: string;
  kind: FactKind;
  detail: string;
  file: string | null;
  /** The auditor's one-line comment, attached by the harness. Never the fact itself. */
  note?: string;
}

export interface PackageJsonPair {
  path: string;
  base: string | null;
  head: string | null;
}

export interface FactInput {
  /** Unified diff of the whole change against the merge-base (untracked files included as additions). */
  diff: string;
  packageJsons: PackageJsonPair[];
}

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

function depsOf(json: string | null): Map<string, string> | null {
  if (json === null) return new Map();
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const out = new Map<string, string>();
    for (const section of DEP_SECTIONS) {
      const deps = parsed[section];
      if (!deps || typeof deps !== 'object') continue;
      for (const [name, range] of Object.entries(deps as Record<string, unknown>)) out.set(`${section}:${name}`, String(range));
    }
    return out;
  } catch {
    return null;
  }
}

function dependencyFacts(pairs: PackageJsonPair[]): Array<Omit<HardFact, 'id'>> {
  const out: Array<Omit<HardFact, 'id'>> = [];
  for (const { path, base, head } of pairs) {
    const before = depsOf(base);
    const after = depsOf(head);
    if (!before || !after) {
      out.push({ kind: 'dependency', detail: `${path} changed but could not be parsed as JSON — dependency changes not enumerated`, file: path });
      continue;
    }
    for (const [key, range] of after) {
      const [section, name] = key.split(':');
      const was = before.get(key);
      if (was === undefined) out.push({ kind: 'dependency', detail: `new ${section === 'dependencies' ? 'dependency' : section.replace(/ies$/, 'y')} ${name}@${range}`, file: path });
      else if (was !== range) out.push({ kind: 'dependency', detail: `${name} ${was} → ${range} (${section})`, file: path });
    }
    for (const [key, range] of before) {
      if (after.has(key)) continue;
      const [section, name] = key.split(':');
      out.push({ kind: 'dependency', detail: `removed ${name}@${range} (${section})`, file: path });
    }
  }
  return out;
}

const ROUTE_RE = /\b(?:router|app|r|api)\.(get|post|put|patch|delete|all|use)\(\s*(['"`])([^'"`]+)\2/g;
const MCP_TOOL_RE = /\b(?:registerTool|tool)\(\s*(['"`])([\w.-]+)\1/g;
const ENV_RES = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /\bos\.environ(?:\.get)?[(\[]\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /\bos\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
];
const SCHEMA_RE = /\b(ALTER\s+TABLE|CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)|DROP\s+(?:TABLE|INDEX|COLUMN)|ADD\s+COLUMN|RENAME\s+(?:TO|COLUMN))\b/i;
/** Test files exercise routes and env vars; they do not define them. */
const TEST_FILE = /(\.|\/)(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|tests?)\//i;
const SQL_FILE = /\.sql$|(^|\/)migrations?\//i;

function addedAndRemoved(sectionText: string): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of sectionText.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }
  return { added, removed };
}

function matches(re: RegExp, text: string, group: number): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(re.source, re.flags))) out.push(m[group]);
  return out;
}

/** Names in `added` that the file did not already use: present in `+` lines, absent from `-` lines. */
function newNames(added: string, removed: string, find: (text: string) => string[]): string[] {
  const before = new Set(find(removed));
  return [...new Set(find(added))].filter(n => !before.has(n));
}

function sourceFacts(diff: string): Array<Omit<HardFact, 'id'>> {
  const out: Array<Omit<HardFact, 'id'>> = [];
  for (const section of splitDiff(diff)) {
    if (section.binary || exemptReason(section.path)) continue;
    const { path } = section;
    const { added, removed } = addedAndRemoved(section.text);
    const addedText = added.join('\n');
    const removedText = removed.join('\n');
    const isTest = TEST_FILE.test(path);

    if (SQL_FILE.test(path)) {
      out.push({ kind: 'schema', detail: `${section.deleted ? 'deleted' : 'changed'} schema/migration file`, file: path });
    }
    // Statements inside code (db/index.ts migrations) — SQL files are already one fact above.
    if (!SQL_FILE.test(path) && !isTest) {
      const stmts = [...new Set(added.map(l => SCHEMA_RE.exec(l)?.[1].replace(/\s+/g, ' ').toUpperCase()).filter((s): s is string => !!s))];
      if (stmts.length) out.push({ kind: 'schema', detail: `schema statements added in code: ${stmts.join(', ')}`, file: path });
    }
    if (isTest) continue;

    const routeKey = (text: string) => [...text.matchAll(new RegExp(ROUTE_RE.source, ROUTE_RE.flags))].map(m => `${m[1].toUpperCase()} ${m[3]}`);
    for (const r of newNames(addedText, removedText, routeKey)) out.push({ kind: 'route', detail: `route added: ${r}`, file: path });
    for (const r of newNames(removedText, addedText, routeKey)) out.push({ kind: 'route', detail: `route removed: ${r}`, file: path });

    const toolKey = (text: string) => matches(MCP_TOOL_RE, text, 2);
    for (const t of newNames(addedText, removedText, toolKey)) out.push({ kind: 'mcp_tool', detail: `MCP tool registered: ${t}`, file: path });
    for (const t of newNames(removedText, addedText, toolKey)) out.push({ kind: 'mcp_tool', detail: `MCP tool removed: ${t}`, file: path });

    const envKey = (text: string) => ENV_RES.flatMap(re => matches(re, text, 1));
    for (const v of newNames(addedText, removedText, envKey)) out.push({ kind: 'env_var', detail: `reads env var ${v}`, file: path });
  }
  return out;
}

/** Every fact, in a stable order (dependencies, schema, routes, MCP tools, env vars), with ids. */
export function computeHardToReverse(input: FactInput): HardFact[] {
  const raw = [...dependencyFacts(input.packageJsons), ...sourceFacts(input.diff)];
  const order: FactKind[] = ['dependency', 'schema', 'route', 'mcp_tool', 'env_var'];
  raw.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  // The same env var read in two files is two facts, but an exact duplicate is noise.
  const seen = new Set<string>();
  const facts: HardFact[] = [];
  for (const f of raw) {
    const key = `${f.kind}|${f.file}|${f.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({ ...f, id: `h${facts.length + 1}` });
  }
  return facts;
}
