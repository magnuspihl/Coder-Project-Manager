/** The auditor's citations are checked against the repository, never trusted. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCite, citedPaths, parseCite, type LineIndex } from './audit-citations.js';

const index = (base: Record<string, number | null>, head: Record<string, number | null>): LineIndex => ({
  base: new Map(Object.entries(base)),
  head: new Map(Object.entries(head)),
});

test('reads file:line, file:start-end, #L anchors and backticked citations', () => {
  assert.deepEqual(parseCite('src/a.ts:12'), { path: 'src/a.ts', start: 12, end: 12 });
  assert.deepEqual(parseCite('src/a.ts:12-30'), { path: 'src/a.ts', start: 12, end: 30 });
  assert.deepEqual(parseCite('`src/a.ts:12–30`'), { path: 'src/a.ts', start: 12, end: 30 });
  assert.deepEqual(parseCite('src/a.ts#L5-L9'), { path: 'src/a.ts', start: 5, end: 9 });
});

test('strips the worktree prefix so an absolute citation resolves to a repo path', () => {
  assert.equal(parseCite('/wt/task/src/a.ts:3', '/wt/task')?.path, 'src/a.ts');
});

test('rejects citations that are not a file and a line, or that escape the repository', () => {
  for (const bad of ['src/a.ts', 'just words', '../etc/passwd:1', '/etc/passwd:1', 'a.ts:0', 'a.ts:9-3', '']) {
    assert.equal(parseCite(bad), null, bad);
  }
});

test('collects the distinct paths of all parseable citations', () => {
  assert.deepEqual(citedPaths(['a.ts:1', 'a.ts:9', 'b.ts:2', null, 'nonsense']).sort(), ['a.ts', 'b.ts']);
});

test('a line inside the file resolves, and says which tree it resolved in', () => {
  const idx = index({ 'a.ts': 50 }, { 'a.ts': 60, 'new.ts': 10 });
  assert.deepEqual(checkCite('a.ts:55', idx, 'head'), { cite: 'a.ts:55', ok: true, tree: 'head' });
  assert.deepEqual(checkCite('a.ts:40', idx, 'base'), { cite: 'a.ts:40', ok: true, tree: 'base' });
});

test('flags a line range that runs past the end of the cited file', () => {
  const r = checkCite('a.ts:40-90', index({ 'a.ts': 50 }, { 'a.ts': 50 }), 'either');
  assert.equal(r.ok, false);
  assert.match(r.reason!, /50 lines.*line 90/);
});

test('flags a file that does not exist anywhere', () => {
  const r = checkCite('ghost.ts:1', index({}, {}), 'either');
  assert.equal(r.ok, false);
  assert.match(r.reason!, /does not exist/);
});

test('code that exists only in the current tree is not pre-existing, so a base citation fails and says why', () => {
  const r = checkCite('added-by-task.ts:3', index({ 'added-by-task.ts': null }, { 'added-by-task.ts': 20 }), 'base');
  assert.equal(r.ok, false);
  assert.match(r.reason!, /added by this task/);
});

test('an empty or missing citation is unverified, not verified', () => {
  assert.equal(checkCite(null, index({}, {}), 'either').ok, false);
  assert.equal(checkCite('  ', index({}, {}), 'either').ok, false);
});
