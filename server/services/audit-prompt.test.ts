/** What the auditor is told: guidance given explicitly, and nothing of the implementer's before phase 2. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleGuidance, buildPhase1Prompt, buildPhase2Prompt } from './audit-prompt.js';

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
  const p2 = buildPhase2Prompt({ implementerSummary: secret });
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
