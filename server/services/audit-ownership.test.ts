/** Whose code an audit finding is about, and what a later audit no longer reports. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCites, classifyReport, defaultSelected, parseChangeMap, resolvedSince } from './audit-ownership.js';
import { checkCite, type CheckedCite, type LineIndex } from './audit-citations.js';
import type { AuditReport } from './audit-report.js';

// a.ts: lines 3-4 are new (the task added `const b`/`const c` after line 2); b.ts is wholly new; c.ts is untouched.
const DIFF = [
  'diff --git a/a.ts b/a.ts',
  'index 111..222 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,3 +1,5 @@',
  ' const a = 1;',
  ' const a2 = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' const d = 5;',
  'diff --git a/b.ts b/b.ts',
  'new file mode 100644',
  'index 0000000..333',
  '--- /dev/null',
  '+++ b/b.ts',
  '@@ -0,0 +1,3 @@',
  '+x',
  '+y',
  '+z',
  '',
].join('\n');

const index: LineIndex = {
  base: new Map([['a.ts', 3], ['c.ts', 50], ['b.ts', null]]),
  head: new Map([['a.ts', 5], ['b.ts', 3], ['c.ts', 50]]),
};
const ok = (cite: string, expect: 'base' | 'head' | 'either' = 'either'): CheckedCite => checkCite(cite, index, expect);
const changes = parseChangeMap(DIFF);

test('reads which lines of a file the task changed, and which files it added', () => {
  assert.deepEqual(changes.get('a.ts'), { added: false, newLines: [[3, 4]], oldLines: [] });
  assert.equal(changes.get('b.ts')!.added, true);
  assert.equal(changes.has('c.ts'), false);
});

test('a citation on lines the task changed is task-owned (line-level)', () => {
  assert.deepEqual(classifyCites([ok('a.ts:3-4')], changes), { owner: 'task', basis: 'lines', reason: 'cites lines this task changed' });
});

test('a citation in a changed file but on lines the task left alone is pre-existing', () => {
  assert.equal(classifyCites([ok('a.ts:1')], changes).owner, 'pre_existing');
});

test('a citation in a file the task added is task-owned even without a changed-line match', () => {
  assert.equal(classifyCites([ok('b.ts:2')], changes).basis, 'lines');
  // An added file with no hunk overlap (e.g. an empty-diff rename) still counts at file level.
  const addedOnly = new Map(changes).set('n.ts', { added: true, newLines: [], oldLines: [] });
  const idx: LineIndex = { base: new Map(), head: new Map([['n.ts', 9]]) };
  assert.equal(classifyCites([checkCite('n.ts:5', idx, 'either')], addedOnly).basis, 'added_file');
});

test('a citation in a file the task never touched is pre-existing', () => {
  const r = classifyCites([ok('c.ts:10')], changes);
  assert.deepEqual([r.owner, r.basis], ['pre_existing', 'untouched']);
});

test('one task-owned citation among pre-existing ones makes the finding task-owned', () => {
  assert.equal(classifyCites([ok('c.ts:10'), ok('a.ts:4')], changes).owner, 'task');
});

test('a finding with no verified citation is treated as task-owned, and says why — never as a new task', () => {
  const bad = ok('nope.ts:1');
  assert.equal(bad.ok, false);
  const r = classifyCites([bad], changes);
  assert.deepEqual([r.owner, r.basis], ['task', 'unverified']);
  assert.match(r.reason, /no citation could be verified/);
  assert.equal(classifyCites([], changes).basis, 'unverified');
});

test('an unverified citation does not outweigh a verified pre-existing one', () => {
  assert.equal(classifyCites([ok('nope.ts:1'), ok('c.ts:1')], changes).owner, 'pre_existing');
});

function report(over: Partial<AuditReport>): AuditReport {
  return { summary: 's', structure: { added: [], modified: [] }, reuseFindings: [], deviations: [], hardToReverse: [], discrepancies: [], unassessedExports: [], ...over };
}

test('classifies every kind of finding in a report; hard-to-reverse facts are the task\'s by construction', () => {
  const r = report({
    reuseFindings: [{ id: 'r1', name: 'helper', kind: 'possible_duplicate', newCite: 'a.ts:3', existingCite: 'c.ts:7', note: 'dup', checks: { new: ok('a.ts:3', 'head'), existing: ok('c.ts:7', 'base') }, verified: true }],
    deviations: [{ id: 'd1', text: 'old habit', cites: ['c.ts:2'], checks: [ok('c.ts:2')], verified: true }],
    discrepancies: [{ id: 'x1', kind: 'unsupported_claim', text: 'claims tests', cites: ['zzz.ts:1'], checks: [ok('zzz.ts:1')], verified: false }],
    hardToReverse: [{ id: 'h1', kind: 'schema', detail: 'new column', file: 'a.ts' }],
  });
  const o = classifyReport(r, changes);
  assert.equal(o.r1.owner, 'task');
  assert.equal(o.d1.owner, 'pre_existing');
  assert.deepEqual([o.x1.owner, o.x1.basis], ['task', 'unverified']);
  assert.deepEqual([o.h1.owner, o.h1.basis], ['task', 'harness']);
});

test('a reuse finding that cites nothing existing is judged by the one citation it has', () => {
  const r = report({ reuseFindings: [{ id: 'r1', name: 'n', kind: 'possible_duplicate', newCite: 'c.ts:3', existingCite: null, note: '', checks: { new: ok('c.ts:3'), existing: ok('') }, verified: false }] });
  assert.equal(classifyReport(r, changes).r1.owner, 'pre_existing');
});

test('lists what the previous audit reported that the new one no longer does', () => {
  const dup = { id: 'r1', name: 'helper', kind: 'possible_duplicate' as const, newCite: 'a.ts:3', existingCite: 'c.ts:7', note: 'dup' };
  const prev = report({
    reuseFindings: [dup, { ...dup, id: 'r2', name: 'other', newCite: 'b.ts:1' }],
    deviations: [{ id: 'd1', text: 'Uses a raw string where a constant exists', cites: ['a.ts:3'] }],
  });
  // The new audit numbers its ids afresh and still reports `other`; identity is name + kind + cited path, not the id.
  const cur = report({ reuseFindings: [{ ...dup, id: 'r1', name: 'other', newCite: 'b.ts:1' }] });
  const gone = resolvedSince(prev, cur);
  assert.deepEqual(gone.map(g => g.label), ['possible duplicate', 'deviation']);
  assert.match(gone[0].text, /^helper/);
});

test('nothing is resolved when the new audit still reports everything', () => {
  const r = report({ deviations: [{ id: 'd1', text: 'same', cites: ['a.ts:1'] }] });
  assert.deepEqual(resolvedSince(r, report({ deviations: [{ id: 'd9', text: 'Same', cites: ['a.ts:2'] }] })), []);
});

test('task-owned and unclassified findings start ticked; pre-existing ones start unticked', () => {
  assert.equal(defaultSelected({ owner: 'task' }), true);
  assert.equal(defaultSelected(classifyCites([ok('nope.ts:1')], changes)), true, 'unverified citations: the task\'s own');
  assert.equal(defaultSelected(undefined), true, 'an older audit with no classification');
  assert.equal(defaultSelected(classifyCites([ok('c.ts:10')], changes)), false);
});
