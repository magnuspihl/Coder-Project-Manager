import test from 'node:test';
import assert from 'node:assert/strict';
import { addedExports, jsExportedNames, jsImports, pythonTopLevelNames } from './added-exports.js';

const sorted = (s: Set<string> | null | undefined) => (s ? [...s].sort() : s);

test('JS exports: declarations, lists, aliases, re-exports, default and TypeScript forms are all found', () => {
  const src = `
    export function a() {}
    export async function b() {}
    export function* c() {}
    export const d = 1;
    export let e = 2;
    export class F {}
    export abstract class G {}
    export enum H { X }
    export const enum I { Y }
    export interface J {}
    export type K = string;
    export { l, m as n };
    export type { O } from './o';
    export { p } from './p';
    export * as q from './q';
    export default function main() {}
  `;
  assert.deepEqual(sorted(jsExportedNames(src)), ['F', 'G', 'H', 'I', 'J', 'K', 'O', 'a', 'b', 'c', 'd', 'default', 'e', 'l', 'n', 'p', 'q'].sort());
});

test('JS exports: CommonJS exports.x, module.exports.x and module.exports = { … } are found', () => {
  assert.deepEqual(sorted(jsExportedNames('exports.a = 1;\nmodule.exports.b = () => 2;\nexports["c"] = 3;')), ['a', 'b', 'c']);
  assert.deepEqual(sorted(jsExportedNames('module.exports = { a, b: 1, c() { return { d: 1 }; }, "e": f(1, 2) };')), ['a', 'b', 'c', 'e']);
});

test('JS exports: text in comments and strings is not mistaken for an export', () => {
  assert.deepEqual(sorted(jsExportedNames('// export function old() {}\n/* export const gone = 1 */\nconst s = "export function fake() {}";\nexport const real = 1;')), ['real']);
});

test('JS exports: a set that cannot be enumerated (export *, destructuring, module.exports = something else) is unknown', () => {
  assert.equal(jsExportedNames("export * from './other';\nexport const a = 1;"), null);
  assert.equal(jsExportedNames('export const { a, b } = obj;'), null);
  assert.equal(jsExportedNames('module.exports = makeApi();'), null);
  assert.equal(jsExportedNames('module.exports = { ...base, a };'), null);
});

test('Python top-level names: defs, classes, assignments and imports, but not nested or keyword lines', () => {
  const src = [
    'import os', 'import a.b as ab', 'from x import (', '    y,', '    z as zz,', ')',
    'CONST = 1', 'typed: int = 2', 'p, q = 1, 2',
    'def f():', '    inner = 1', 'async def g():', '    pass', 'class C:', '    def method(self): pass',
    'if True:', '    hidden = 1', 'else:', '    pass', 'try:', '    pass', 'except Exception:', '    pass',
    '"""', 'def in_docstring():', '"""',
  ].join('\n');
  const r = pythonTopLevelNames(src)!;
  assert.deepEqual(sorted(r.all), ['C', 'CONST', 'ab', 'f', 'g', 'os', 'p', 'q', 'typed', 'y', 'zz']);
  // `from x import …` is a dependency here; only the module's own names are its API.
  assert.deepEqual(sorted(r.defined), ['C', 'CONST', 'f', 'g', 'p', 'q', 'typed']);
  // Relative imports, and absolute ones from the package the file lives in, are re-exports.
  assert.deepEqual(sorted(pythonTopLevelNames('from .impl import a\nfrom pkg.other import b\nfrom typing import C\n', 'src/pkg/__init__.py')!.defined), ['a', 'b']);
});

test('Python top-level names: a star import or a module __getattr__ makes them unknown', () => {
  assert.equal(pythonTopLevelNames('from x import *\ndef f(): pass'), null);
  assert.equal(pythonTopLevelNames('def __getattr__(name): ...'), null);
});

test('addedExports: a function added to an existing module is reported, and nothing else', () => {
  const base = 'export function parseDuration(s: string) { return 1; }\n';
  const now = base + 'export function formatDuration(ms: number) { return `${ms}`; }\n';
  assert.deepEqual(sorted(addedExports('src/dur.ts', base, now)), ['formatDuration']);
  const pyBase = 'def parse_duration(s):\n    return 1\n';
  assert.deepEqual(sorted(addedExports('pkg/dur.py', pyBase, pyBase + '\ndef format_duration(ms):\n    return str(ms)\n')), ['format_duration']);
});

test('addedExports: a renamed export is not "added" — a name that disappears alongside a new one could be a rename', () => {
  assert.equal(addedExports('src/dur.ts', 'export function fmt() {}\n', 'export function formatDuration() {}\n'), null);
  assert.equal(addedExports('pkg/dur.py', 'def fmt():\n    pass\n', 'def format_duration():\n    pass\n'), null);
});

test('addedExports: a changed signature adds no name', () => {
  assert.deepEqual(sorted(addedExports('src/dur.ts', 'export function f(a: number) {}\n', 'export function f(a: number, b: number) {}\n')), []);
  assert.deepEqual(sorted(addedExports('pkg/dur.py', 'def f(a):\n    pass\n', 'def f(a, b):\n    pass\n')), []);
});

test('addedExports: dropping a dependency import is not a removal, but a removed def or re-export is', () => {
  assert.deepEqual(sorted(addedExports('m.py', 'import os\ndef a(): pass\n', 'def a(): pass\ndef b(): pass\n')), ['b']);
  assert.deepEqual(sorted(addedExports('pkg/m.py', 'from typing import Optional\ndef a(): pass\n', 'def a(): pass\ndef b(): pass\n')), ['b']);
  assert.equal(addedExports('pkg/__init__.py', 'from pkg.impl import old_name\n', 'from pkg.impl import new_name\n'), null);
  assert.equal(addedExports('m.py', 'def a(): pass\ndef old(): pass\n', 'def a(): pass\ndef b(): pass\n'), null);
  // A package __init__ renaming what it re-exports is a rename, not new code.
  assert.equal(addedExports('pkg/__init__.py', 'from .impl import old_name\n', 'from .impl import new_name\n'), null);
  assert.deepEqual(sorted(addedExports('pkg/__init__.py', 'from .impl import a\n', 'from .impl import a, b\n')), ['b']);
});

test('JS exports: an apostrophe in JSX text or a regex literal does not hide the exports after it', () => {
  assert.deepEqual(sorted(jsExportedNames("export function Badge() { return <p>Don't panic</p>; }\nexport function size() {}\n")), ['Badge', 'size']);
  assert.deepEqual(sorted(jsExportedNames("const APOS = /'/g;\nexport function clean() {}\nexport const q = \"it's\";\n")), ['clean', 'q']);
});

test('addedExports: unsupported languages and unknowable export sets give no answer', () => {
  assert.equal(addedExports('pkg/dur.go', 'func A() {}', 'func A() {}\nfunc B() {}'), null);
  assert.equal(addedExports('src/index.ts', "export * from './a';", "export * from './a';\nexport const b = 1;"), null);
});

test('jsImports: named, aliased, default, namespace and require bindings, with their specifiers', () => {
  const src = [
    "import def, { a, b as c, type T } from './one.js';",
    "import * as ns from '../two';",
    "import type { Only } from './types';",
    "const { d, e: f } = require('./three');",
    "const whole = require('./four');",
    "import 'side-effect';",
  ].join('\n');
  assert.deepEqual(jsImports(src), [
    { local: 'def', imported: 'default', spec: './one.js' },
    { imported: 'a', local: 'a', spec: './one.js' },
    { imported: 'b', local: 'c', spec: './one.js' },
    { imported: 'T', local: 'T', spec: './one.js' },
    { local: 'ns', imported: '*', spec: '../two' },
    { imported: 'd', local: 'd', spec: './three' },
    { imported: 'e', local: 'f', spec: './three' },
    { local: 'whole', imported: '*', spec: './four' },
  ]);
});
