/** What the auditor is told: guidance given explicitly, and nothing of the implementer's before phase 2. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleGuidance, buildPhase1Prompt, buildPhase2Prompt, collectTurnSummaries, formatTurnSummaries } from './audit-prompt.js';
import { cleanImplementerSummary, parseDiscrepancies } from './audit-report.js';

const base = {
  taskTitle: 'Add thing', taskPrompt: 'Please add the thing.', diff: 'diff --git a/x b/x', diffNote: '', stat: 'M x',
  guidance: 'GUIDANCE', facts: [{ id: 'h1', kind: 'env_var' as const, detail: 'reads env var FOO', file: 'a.ts' }],
  addedExports: [{ path: 'src/thing.ts', name: 'makeThing' }],
};

test('phase 1 carries the task, the diff, the guidance, the mechanical facts and the mandatory export checklist', () => {
  const p = buildPhase1Prompt(base);
  for (const needle of ['Please add the thing.', 'diff --git a/x b/x', 'GUIDANCE', 'h1: [env_var] reads env var FOO', '- makeThing  (src/thing.ts)']) {
    assert.ok(p.includes(needle), needle);
  }
});

test('phase 1 never contains the implementer summary, which only phase 2 introduces', () => {
  const secret = 'IMPLEMENTER-SELF-REPORT-TEXT';
  assert.ok(!buildPhase1Prompt(base).includes(secret));
  const p2 = buildPhase2Prompt({ turnSummaries: [{ turn: 1, text: secret }] });
  assert.ok(p2.includes(secret));
  assert.match(p2, /cannot be changed/);
  assert.match(p2, /only discrepancies/);
});

test('guidance puts CLAUDE.md first, then ARCHITECTURE.md, then docs alphabetically', () => {
  const g = bundleGuidance([
    { path: 'docs/b.md', content: 'B' }, { path: 'docs/a.md', content: 'A' },
    { path: 'ARCHITECTURE.md', content: 'ARCH' }, { path: 'CLAUDE.md', content: 'CLAUDE' },
  ]);
  const order = ['CLAUDE.md', 'ARCHITECTURE.md', 'docs/a.md', 'docs/b.md'].map(p => g.indexOf(`===== ${p} =====`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every(i => i >= 0));
});

test('guidance over budget names the files it left out instead of silently dropping them', () => {
  const g = bundleGuidance([{ path: 'CLAUDE.md', content: 'x'.repeat(60) }, { path: 'docs/big.md', content: 'y'.repeat(60) }], 100);
  assert.ok(g.includes('===== CLAUDE.md ====='));
  assert.ok(!g.includes('yyyy'));
  assert.match(g, /Not included above[\s\S]*docs\/big\.md/);
});

test('an oversized CLAUDE.md is truncated with a note rather than dropped', () => {
  const g = bundleGuidance([{ path: 'CLAUDE.md', content: 'z'.repeat(500) }], 100);
  assert.match(g, /CLAUDE\.md truncated/);
});

test('a repo with no guidance says so, so the auditor judges conventions from the code', () => {
  assert.match(bundleGuidance([]), /no documented guidance/);
});

test('phase 1 asks for exactly one reuse entry per checklist export, by exact name', () => {
  assert.match(buildPhase1Prompt(base), /EXACTLY ONE entry whose "name" is that export's exact name/);
});

// A two-turn task: turn 1 built the feature, turn 2 only fixed something.
const turns = [{ id: 't1', role: 'implementer' }, { id: 'r1', role: 'reviewer' }, { id: 't2', role: 'implementer' }];
const msgs = [
  { role: 'assistant', turn_id: 't1', content: 'working…' },
  { role: 'assistant', turn_id: 't1', content: 'Added the new columns and the collapse UI.\n\nNO_TESTS_NEEDED: demo' },
  { role: 'assistant', turn_id: 'r1', content: 'reviewer prose' },
  { role: 'assistant', turn_id: 't2', content: 'Fixed the off-by-one in the collapse UI.\n[WAKE]{"after":"1m"}[/WAKE]' },
];

test('collects the last message of every implementer turn, oldest first, markers stripped, reviewers excluded', () => {
  const got = collectTurnSummaries(turns, msgs, cleanImplementerSummary);
  assert.deepEqual(got, [
    { turn: 1, text: 'Added the new columns and the collapse UI.' },
    { turn: 2, text: 'Fixed the off-by-one in the collapse UI.' },
  ]);
});

test('phase 2 shows the auditor the turn-1 description of the feature as well as the turn-2 fix, and says later turns need not repeat earlier claims', () => {
  const p = buildPhase2Prompt({ turnSummaries: collectTurnSummaries(turns, msgs, cleanImplementerSummary) });
  assert.match(p, /--- Implementer turn 1 ---\nAdded the new columns and the collapse UI\./);
  assert.match(p, /--- Implementer turn 2 ---\nFixed the off-by-one/);
  assert.ok(p.indexOf('turn 1') < p.indexOf('turn 2'));
  assert.match(p, /SUCCESSIVE turn summaries/);
  assert.match(p, /NOT a discrepancy/);
  assert.match(p, /NONE of the turn summaries mentions/);
  // With the feature described in turn 1, an auditor that follows this finds nothing unmentioned.
  assert.deepEqual(parseDiscrepancies('AUDIT_REPORT: {"discrepancies": []}'), []);
});

test('over budget the most recent summaries are kept and the omission is named', () => {
  const many = [1, 2, 3, 4].map(turn => ({ turn, text: `T${turn}:` + 'x'.repeat(3000) }));
  const out = formatTurnSummaries(many, 7000);
  assert.ok(!out.includes('Implementer turn 1 ---') && !out.includes('Implementer turn 2 ---'));
  assert.ok(out.includes('Implementer turn 3 ---') && out.includes('Implementer turn 4 ---'));
  assert.match(out, /2 earliest turn summaries were left out.*turns 1-2/);
});

test('the newest summary is always kept, even when it alone exceeds the budget', () => {
  assert.match(formatTurnSummaries([{ turn: 1, text: 'old' }, { turn: 2, text: 'y'.repeat(9000) }], 100), /Implementer turn 2 ---/);
});
