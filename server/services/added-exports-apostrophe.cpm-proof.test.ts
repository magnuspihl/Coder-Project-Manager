import test from 'node:test';
import assert from 'node:assert/strict';
import { addedExports } from './added-exports.js';

test('a function added to a .tsx module whose JSX text contains an apostrophe is found as added', () => {
  const base = "export function Badge() { return <p>Don't panic</p>; }\nexport function size() { return 1; }\n";
  const now = base + 'export function formatLabel(s: string) { return s; }\n';
  const added = addedExports('src/Badge.tsx', base, now);
  assert.ok(added?.has('formatLabel'), `got ${added ? JSON.stringify([...added]) : added}`);
});

test('a function added to a module containing a regex literal with a quote is found as added', () => {
  const base = "const APOS = /'/g;\nexport function clean(s: string) { return s; }\n";
  const now = base + 'export function quote(s: string) { return s; }\n';
  const added = addedExports('src/clean.ts', base, now);
  assert.ok(added?.has('quote'), `got ${added ? JSON.stringify([...added]) : added}`);
});
