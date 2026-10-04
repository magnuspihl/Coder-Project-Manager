/** The auditor's report: tolerant parsing, harness checks layered on the model's words, and when to audit at all. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleReport, auditGate, AUDIT_MIN_CHANGED_LINES, cleanImplementerSummary, findingById, findingTaskPrompt,
  isAuditStale, parseDiscrepancies, parseModelAudit, STALE_LABEL,
} from './audit-report.js';
import type { LineIndex } from './audit-citations.js';
import type { HardFact } from './audit-facts.js';

const REPORT = {
  summary: 'Adds an auditor that reads the diff.',
  structure: { added: [{ path: 'server/services/audits.ts', purpose: 'storage' }], modified: [{ path: 'server/services/claude.ts', change: 'launch hook' }] },
  reuseFindings: [
    { name: 'runAuditProcess', verdict: 'possible_duplicate', new: 'server/services/claude.ts:100', existing: 'server/services/claude.ts:50', note: 'same launch plumbing as executeReviewer' },
    { name: 'auditView', verdict: 'reused', new: 'server/services/audits.ts:10', existing: 'server/services/tasks.ts:5', note: 'uses getTask' },
  ],
  deviations: [{ text: 'new table pattern', cites: ['server/db/schema.sql:3'] }],
  annotations: [{ id: 'h1', note: 'new table is permanent' }],
};
const line = `AUDIT_REPORT: ${JSON.stringify(REPORT)}`;

const index = (base: Record<string, number>, head: Record<string, number>): LineIndex => ({
  base: new Map(Object.entries(base)), head: new Map(Object.entries(head)),
});

test('parses the report from a plain marker line', () => {
  const m = parseModelAudit(`I looked around.\n${line}`)!;
  assert.equal(m.summary, REPORT.summary);
  assert.equal(m.reuseFindings.length, 2);
  assert.equal(m.reuseFindings[0].kind, 'possible_duplicate');
  assert.deepEqual(m.annotations, { h1: 'new table is permanent' });
});

test('parses a report wrapped in markdown, a code fence, or pretty-printed over several lines', () => {
  assert.ok(parseModelAudit(`**AUDIT_REPORT:** ${JSON.stringify(REPORT)}`));
  assert.ok(parseModelAudit('```\nAUDIT_REPORT: ' + JSON.stringify(REPORT, null, 2) + '\n```'));
});

test('a marker token mentioned in prose before the real report does not hide it', () => {
  assert.ok(parseModelAudit(`The format is AUDIT_REPORT: {…} as asked.\n${line}`));
});

test('rejects an echoed template and returns null when there is no report', () => {
  assert.equal(parseModelAudit('AUDIT_REPORT: {"summary": "<3-6 plain sentences: what was built>"}'), null);
  assert.equal(parseModelAudit('no marker here'), null);
});

test('drops reuse entries without a usable verdict or name instead of inventing one', () => {
  const m = parseModelAudit(`AUDIT_REPORT: ${JSON.stringify({ ...REPORT, reuseFindings: [{ name: 'x', verdict: 'maybe' }, { verdict: 'reused' }, ...REPORT.reuseFindings] })}`)!;
  assert.deepEqual(m.reuseFindings.map(r => r.name), ['runAuditProcess', 'auditView']);
});

test('phase 2 accepts only discrepancies; a revised summary or new findings in the same object are ignored', () => {
  const text = 'AUDIT_REPORT: ' + JSON.stringify({
    summary: 'REVISED after seeing the self-report', reuseFindings: [{ name: 'n', verdict: 'reused' }],
    discrepancies: [{ kind: 'unmentioned', text: 'adds a dependency', cites: ['package.json:5'] }, { kind: 'bogus', text: 'claims tests' }],
  });
  const d = parseDiscrepancies(text)!;
  assert.deepEqual(d.map(x => [x.kind, x.text]), [['unmentioned', 'adds a dependency'], ['unsupported_claim', 'claims tests']]);
});

test('phase 2: an empty list means none found; no object means the comparison did not happen', () => {
  assert.deepEqual(parseDiscrepancies('AUDIT_REPORT: {"discrepancies": []}'), []);
  assert.equal(parseDiscrepancies('they agree, nothing to add'), null);
  assert.equal(parseDiscrepancies('AUDIT_REPORT: {"summary": "x"}'), null);
});

const facts: HardFact[] = [{ id: 'h1', kind: 'schema', detail: 'new table', file: 'server/db/schema.sql' }];

test('a possible_duplicate whose existing code is at the merge-base and whose new code exists is verified', () => {
  const model = parseModelAudit(line)!;
  const rep = assembleReport({
    model, facts, addedExports: [], index: index({ 'server/services/claude.ts': 80, 'server/services/tasks.ts': 20 }, { 'server/services/claude.ts': 200, 'server/services/audits.ts': 30, 'server/db/schema.sql': 9 }),
  });
  const dup = rep.reuseFindings.find(f => f.kind === 'possible_duplicate')!;
  assert.equal(dup.verified, true);
  assert.equal(dup.checks!.existing.tree, 'base');
});

test('a possible_duplicate citing a file this task added is flagged, because the existing code is not pre-existing', () => {
  const rep = assembleReport({
    model: parseModelAudit(line)!, facts, addedExports: [],
    index: index({}, { 'server/services/claude.ts': 200, 'server/services/audits.ts': 30 }),
  });
  const dup = rep.reuseFindings[0];
  assert.equal(dup.verified, false);
  assert.match(dup.checks!.existing.reason!, /added by this task/);
});

test('a possible_duplicate that cites only one side is unverified', () => {
  const m = parseModelAudit(`AUDIT_REPORT: ${JSON.stringify({ ...REPORT, reuseFindings: [{ name: 'x', verdict: 'possible_duplicate', new: 'a.ts:1', note: 'n' }] })}`)!;
  const rep = assembleReport({ model: m, facts: [], addedExports: [], index: index({ 'a.ts': 5 }, { 'a.ts': 5 }) });
  assert.equal(rep.reuseFindings[0].verified, false);
});

test('a deviation with no citation, or one that does not resolve, is marked unverified', () => {
  const m = parseModelAudit(`AUDIT_REPORT: ${JSON.stringify({ ...REPORT, reuseFindings: [], deviations: [{ text: 'a' }, { text: 'b', cites: ['ghost.ts:4'] }] })}`)!;
  const rep = assembleReport({ model: m, facts: [], addedExports: [], index: index({}, {}) });
  assert.deepEqual(rep.deviations.map(d => d.verified), [false, false]);
});

test('annotations attach to the harness facts by id and unknown ids are dropped', () => {
  const m = parseModelAudit(`AUDIT_REPORT: ${JSON.stringify({ ...REPORT, annotations: [{ id: 'h1', note: 'permanent' }, { id: 'h99', note: 'invented fact' }] })}`)!;
  const rep = assembleReport({ model: m, facts, addedExports: [], index: index({}, {}) });
  assert.deepEqual(rep.hardToReverse, [{ ...facts[0], note: 'permanent' }]);
});

test('every added export the auditor gave no reuse entry for is listed as unassessed', () => {
  const rep = assembleReport({
    model: parseModelAudit(line)!, facts: [], index: index({}, {}),
    addedExports: [{ path: 'server/services/audits.ts', name: 'auditView' }, { path: 'server/services/audits.ts', name: 'abandonRunningAudits' }],
  });
  assert.deepEqual(rep.unassessedExports, ['abandonRunningAudits (server/services/audits.ts)']);
});

test('discrepancies stay null with a note when phase 2 did not happen', () => {
  const rep = assembleReport({ model: parseModelAudit(line)!, facts: [], addedExports: [], index: index({}, {}), discrepanciesNote: 'no summary' });
  assert.equal(rep.discrepancies, null);
  assert.equal(rep.discrepanciesNote, 'no summary');
});

const diffOf = (path: string, added: number) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${added} @@\n${Array.from({ length: added }, (_, i) => `+line ${i}`).join('\n')}\n`;

test('skips a docs-only change and says so', () => {
  const g = auditGate(diffOf('README.md', 200) + diffOf('docs/x.md', 50));
  assert.deepEqual(g, { run: false, reason: 'audit skipped: docs-only change' });
});

test('skips a change under the line threshold, naming the count', () => {
  const g = auditGate(diffOf('src/a.ts', AUDIT_MIN_CHANGED_LINES - 1));
  assert.deepEqual(g, { run: false, reason: `audit skipped: ${AUDIT_MIN_CHANGED_LINES - 1} changed lines (under ${AUDIT_MIN_CHANGED_LINES})` });
});

test('runs on a code change at the threshold, and lockfile churn does not count toward it', () => {
  assert.deepEqual(auditGate(diffOf('src/a.ts', AUDIT_MIN_CHANGED_LINES)), { run: true });
  assert.equal(auditGate(diffOf('src/a.ts', 3) + diffOf('package-lock.json', 500)).run, false);
});

test('an empty diff is skipped', () => {
  assert.equal(auditGate('').run, false);
});

test('an audit is stale once an implementer turn has run since it started, and not before', () => {
  assert.equal(isAuditStale({ implementer_turns: 2 }, 2), false);
  assert.equal(isAuditStale({ implementer_turns: 2 }, 3), true);
  assert.match(STALE_LABEL, /stale — code changed since this audit/);
});

test('strips WAKE, TASK_REQUEST and marker lines from the implementer summary', () => {
  const out = cleanImplementerSummary('Built the thing.\n\n[WAKE]\n{"after":"5m"}\n[/WAKE]\n[TASK_REQUEST]\n{"prompt":"x"}\n[/TASK_REQUEST]\nNO_REVIEW_NEEDED\nNO_TESTS_NEEDED: docs\n');
  assert.equal(out, 'Built the thing.');
});

test('a finding of any kind can be found by id and turned into a task prompt that says it starts from the default branch', () => {
  const rep = assembleReport({ model: parseModelAudit(line)!, facts, addedExports: [], index: index({}, {}), discrepancies: [{ id: 'x1', kind: 'unmentioned', text: 'adds a table', cites: [] }] });
  assert.equal(findingById(rep, 'r1')?.kind, 'possible duplicate');
  assert.equal(findingById(rep, 'd1')?.kind, "deviation from the repo's conventions");
  assert.equal(findingById(rep, 'h1')?.kind, 'hard to reverse');
  assert.equal(findingById(rep, 'x1')?.kind, 'unmentioned in the summary');
  assert.equal(findingById(rep, 'nope'), null);
  const f = findingById(rep, 'r1')!;
  const prompt = findingTaskPrompt(f.kind, f.text, f.cites, 'My task');
  assert.match(prompt, /My task/);
  assert.match(prompt, /server\/services\/claude\.ts:100/);
  assert.match(prompt, /default branch/);
});
