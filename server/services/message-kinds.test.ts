/**
 * System messages in the task timeline: agent-to-agent traffic collapses to a
 * one-line summary, human-facing messages are real markdown, and each message
 * carries a machine-readable kind. The first half is pure; the second runs the
 * real tagging and reading against a temporary database.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opinionIssues } from './review-proof.js';
import {
  formatEscalationMarkdown, formatHandoffIssueTexts, formatHandoffMarkdown, formatPartialMarkdown,
  handoffSummary, inferLegacyKind, isAgentFacingKind, resolveMessageTag, summaryFor, trimFailureOutput,
  fixRequestSummary, numberedList, isFixRequestText,
} from './message-kinds.js';

// ---------------------------------------------------------------------------
// Summary lines
// ---------------------------------------------------------------------------

test('the hand-off summary counts confirmed defects when every finding was confirmed by a failing test', () => {
  assert.equal(handoffSummary(3, 3), 'Review found 3 confirmed defects → sent to implementer');
  assert.equal(handoffSummary(1, 1), 'Review found 1 confirmed defect → sent to implementer');
});

test('the hand-off summary says "issues" rather than "confirmed defects" when some were not proven', () => {
  assert.equal(handoffSummary(2, 1), 'Review found 2 issues → sent to implementer');
  assert.equal(handoffSummary(1, 0), 'Review found 1 issue → sent to implementer');
});

test('the Fix-request summary counts the findings, and still reads sensibly with no count', () => {
  assert.equal(fixRequestSummary(2), 'Fix request: 2 findings → sent to implementer');
  assert.equal(fixRequestSummary(undefined), 'Fix request → sent to implementer');
});

test('only the hand-off and Fix-request kinds are agent-facing', () => {
  assert.ok(isAgentFacingKind('review_handoff'));
  assert.ok(isAgentFacingKind('fix_request'));
  for (const k of ['partial_review', 'review_escalation', 'review_started', 'audit_skipped', 'audit_failed', null, undefined]) {
    assert.equal(isAgentFacingKind(k), false, String(k));
  }
});

test('the summary comes from the structured counts, not from the message text', () => {
  assert.equal(summaryFor('review_handoff', { count: 4, confirmed: 4 }), 'Review found 4 confirmed defects → sent to implementer');
  assert.equal(summaryFor('partial_review', {}), null, 'human-facing kinds have no collapsed row');
});

// ---------------------------------------------------------------------------
// Failure-output trimming
// ---------------------------------------------------------------------------

const stack = (n: number) => Array.from({ length: n }, (_, i) => `    at fn${i} (/repo/src/file${i}.ts:${i + 1}:5)`).join('\n');

test('failure output keeps the assertion line and at most three stack frames', () => {
  const out = trimFailureOutput(`AssertionError: expected 1 to equal 2\n${stack(9)}`);
  const lines = out.split('\n');
  assert.equal(lines[0], 'AssertionError: expected 1 to equal 2');
  assert.equal(lines.filter(l => /^\s+at /.test(l)).length, 3);
  assert.match(out, /6 more lines — full output on the review card/);
  assert.ok(!out.includes('fn8'), 'later frames are dropped');
});

test('failure output with nothing to trim comes back unchanged, with no ellipsis note', () => {
  const short = 'AssertionError: nope\n    at a (/x.ts:1:1)';
  assert.equal(trimFailureOutput(short), short);
});

test('failure output keeps a multi-line assertion message (expected/actual diff) ahead of the frames', () => {
  const out = trimFailureOutput(`AssertionError: values differ\n+ actual\n- expected\n${stack(5)}`);
  assert.match(out, /^AssertionError: values differ\n\+ actual\n- expected\n/);
});

test('failure output without any stack frames is capped rather than dumped whole', () => {
  const out = trimFailureOutput(Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'));
  assert.ok(out.split('\n').length <= 10);
  assert.match(out, /more lines/);
});

test('python tracebacks are trimmed to three frames too', () => {
  const py = ['Traceback (most recent call last):', ...Array.from({ length: 6 }, (_, i) => `  File "m${i}.py", line ${i + 1}, in f\n    x()`), 'AssertionError: bad'].join('\n');
  const out = trimFailureOutput(py);
  assert.equal((out.match(/File "/g) ?? []).length, 3);
});

// ---------------------------------------------------------------------------
// Markdown structure of the stored text
// ---------------------------------------------------------------------------

const finding = {
  ref: 'fa93a9f4', body: 'Off-by-one in paginate()', requirement: 'Page 2 starts at item 11',
  proofPath: 'tests/paginate.test.ts', runCommand: 'npx vitest run tests/paginate.test.ts',
  proofOutput: `AssertionError: expected 10 to equal 11\n${stack(8)}`,
};

test('the hand-off is markdown: bold ref, bullets, code-formatted path and command, fenced trimmed failure output', () => {
  const md = formatHandoffMarkdown([finding]);
  assert.match(md, /\*\*\[fa93a9f4\]\*\* Off-by-one in paginate\(\)/);
  assert.match(md, /^- \*\*Requirement:\*\* Page 2 starts at item 11$/m);
  assert.match(md, /^- \*\*Failing test:\*\* `tests\/paginate\.test\.ts` — run `npx vitest run tests\/paginate\.test\.ts`$/m);
  const fence = md.match(/```text\n([\s\S]*?)\n```/);
  assert.ok(fence, 'failure output is in a fenced block');
  assert.equal(fence![1].split('\n').filter(l => /^\s+at /.test(l)).length, 3);
});

test('a failure output that itself contains backticks cannot break out of its fence', () => {
  const md = formatHandoffMarkdown([{ ...finding, proofOutput: 'Error: ```oops```\n    at a (/x.ts:1:1)' }]);
  assert.match(md, /````text\n[\s\S]*````$/);
});

test('a re-raised finding is labelled, and an unproven one carries no failing-test lines', () => {
  const md = formatHandoffMarkdown([{ ref: 'abcd1234', body: 'still wrong', reraised: true }]);
  assert.match(md, /re-raised/);
  assert.ok(!/Failing test/.test(md));
});

test('a hand-off with only issue texts is a numbered markdown list', () => {
  assert.match(formatHandoffIssueTexts(['one', 'two']), /\n\n1\. one\n2\. two$/);
});

test('the escalation is a numbered list with bold lead-in, and multi-line issues stay inside their item', () => {
  const md = formatEscalationMarkdown(2, ['first\nsecond line', 'other']);
  assert.match(md, /^\*\*Auto-review has spent its fix budget\*\* \(2 automated rounds\)/);
  assert.match(md, /\*\*Your input is needed\.\*\*/);
  assert.match(md, /\n1\. first\n {3}second line\n2\. other$/);
});

test('the partial-review message is bullets of code-formatted paths with reasons, and keeps the "Review remaining files" hint', () => {
  const md = formatPartialMarkdown({
    label: 'Partial review — not seen: a.ts, b.ts',
    unreviewed: [{ path: 'a.ts', reason: 'too large' }, { path: 'b.ts', reason: 'binary' }],
    stoppedByTurnCap: true, turnCap: 20,
  });
  assert.match(md, /^\*\*Partial review — not seen: a\.ts, b\.ts\.\*\*/);
  assert.match(md, /^- `a\.ts` — too large$/m);
  assert.match(md, /^- `b\.ts` — binary$/m);
  assert.match(md, /turn limit \(20\)/);
  assert.match(md, /\*\*Review remaining files\*\*/);
});

test('numberedList numbers from 1', () => {
  assert.equal(numberedList(['a', 'b']), '1. a\n2. b');
});

// ---------------------------------------------------------------------------
// Legacy rows
// ---------------------------------------------------------------------------

const legacyHandoff = `Auto-review found issues — resuming implementer:
[fa93a9f4] <defect>
    Requirement: x
    FAILING TEST: t.test.ts  (run: npm test)
    Failure output:
      AssertionError: boom

[0badc0de] second defect`;

test('a legacy hand-off row (no stored kind) is still recognised and counted from its text', () => {
  const t = resolveMessageTag({ role: 'system', content: legacyHandoff });
  assert.equal(t.kind, 'review_handoff');
  assert.equal(t.meta?.count, 2);
  assert.equal(t.meta?.summary, 'Review found 2 issues → sent to implementer');
});

test('a legacy user Fix prompt is recognised as a Fix request', () => {
  const content = 'Please apply fixes for the issues the reviewer found:\n\n1. a\n2. b';
  assert.ok(isFixRequestText(content));
  const t = resolveMessageTag({ role: 'user', content });
  assert.equal(t.kind, 'fix_request');
  assert.equal(t.meta?.summary, 'Fix request: 2 findings → sent to implementer');
});

test('legacy partial, escalation and manual-review rows are recognised; an ordinary message is not', () => {
  assert.equal(inferLegacyKind('system', 'Partial review — not seen: a.ts.')?.kind, 'partial_review');
  assert.equal(inferLegacyKind('system', 'Auto-review has spent its fix budget for this task (2 automated rounds)')?.kind, 'review_escalation');
  assert.equal(inferLegacyKind('system', 'Manual review requested — launching the reviewer.')?.kind, 'review_started');
  assert.equal(inferLegacyKind('system', 'Error: something broke'), null);
  assert.equal(inferLegacyKind('assistant', 'Auto-review found issues — resuming implementer'), null, 'only the role that CPM writes as');
  assert.equal(inferLegacyKind('user', 'Please can you fix the login bug'), null);
});

test('a stored kind always wins over what the text looks like', () => {
  const t = resolveMessageTag({ role: 'system', content: legacyHandoff, kind: 'partial_review', meta: '{}' });
  assert.equal(t.kind, 'partial_review');
});

test('unreadable stored meta is treated as no meta rather than failing the read', () => {
  const t = resolveMessageTag({ role: 'system', content: 'x', kind: 'review_handoff', meta: '{not json' });
  assert.equal(t.kind, 'review_handoff');
  assert.equal(t.meta?.summary, 'Review found 0 issues → sent to implementer');
});

// ---------------------------------------------------------------------------
// Against a real temporary database
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'cpm-msg-kinds-'));
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.CODER_WORKSPACE_NAME = 'local-ws';
process.env.CPM_CHECKPOINTS_BASE = join(dir, 'checkpoints');

let T: typeof import('./tasks.js');
let C: typeof import('./claude.js');
let getDb: typeof import('../db/index.js').getDb;
let loadError: Error | null = null;

before(async () => {
  try {
    ({ getDb } = await import('../db/index.js'));
    T = await import('./tasks.js');
    C = await import('./claude.js');
    getDb().prepare("INSERT INTO users (id, username) VALUES ('u', 'tester')").run();
  } catch (err) {
    loadError = err as Error;
  }
});
after(() => rmSync(dir, { recursive: true, force: true }));

const dbTest = (name: string, fn: () => void | Promise<void>) =>
  test(name, async t => { if (loadError) return t.skip(`database unavailable: ${loadError.message.slice(0, 80)}`); await fn(); });

const newTask = (ws: string) => T.createTask({ workspaceId: ws, workspaceName: 'local-ws', userId: 'u', username: 'tester', prompt: 'p' });

dbTest('a tagged message is stored with its kind and counts and read back with a computed summary', () => {
  const task = newTask('k1');
  T.addMessage(task.id, 'system', legacyHandoff, undefined, undefined, undefined, undefined, undefined, undefined,
    { kind: 'review_handoff', meta: { count: 3, confirmed: 3 } });
  const back = T.getMessages(task.id).find(m => m.role === 'system')!;
  assert.equal(back.kind, 'review_handoff');
  assert.equal(back.meta?.count, 3);
  assert.equal(back.meta?.summary, 'Review found 3 confirmed defects → sent to implementer');
  assert.equal(back.content, legacyHandoff, 'the full text is returned untouched, not a collapsed version');
});

dbTest('an untagged row written before kinds existed reads back with a best-effort kind from its text', () => {
  const task = newTask('k2');
  T.addMessage(task.id, 'system', legacyHandoff); // no tag: exactly what an old row looks like
  const back = T.getMessages(task.id).find(m => m.role === 'system')!;
  assert.equal(back.kind, 'review_handoff');
  assert.equal(back.meta?.count, 2);
  const plain = T.addMessage(task.id, 'system', 'Error: nope');
  assert.equal(T.getMessages(task.id).find(m => m.id === plain.id)!.kind, null);
});

dbTest('the kind and meta columns exist and are nullable, so old databases migrate by ALTER', () => {
  const cols = getDb().prepare('PRAGMA table_info(messages)').all() as Array<{ name: string; notnull: number }>;
  for (const name of ['kind', 'meta']) {
    const c = cols.find(x => x.name === name);
    assert.ok(c, `${name} column`);
    assert.equal(c!.notnull, 0);
  }
});

dbTest('a partial review is posted tagged partial_review as bullets, with the count of unseen files', () => {
  const task = newTask('k4');
  T.updateTaskStatus(task.id, 'working');
  const turn = T.createTaskTurn({ taskId: task.id, role: 'reviewer' });
  const diff = {
    text: '', changed: ['seen.ts', 'core.ts'], shown: ['seen.ts'], exempt: [], carried: [],
    omitted: [{ path: 'core.ts', reason: 'too large for the diff budget' }],
  };
  C._reviewContextsForTest.set(turn.id, { mode: 'opinion', profile: null, diff, toolCalls: [] } as never);
  C.routeVerifiedReview(T.getTask(task.id)!, turn.id, { outcome: 'pass', summary: 'fine' } as never, 'opinion', [], null);
  const msg = T.getMessages(task.id).find(m => m.kind === 'partial_review')!;
  assert.ok(msg, 'the partial-review message is tagged');
  assert.equal(msg.meta?.count, 1);
  assert.match(msg.content, /^- `core\.ts` — too large for the diff budget/m);
});

dbTest('spending the fix budget posts a tagged, numbered escalation instead of handing back to the implementer', () => {
  const task = newTask('k5');
  T.setTaskAutoReview(task.id, true); // with it off, a failing review stops before the loop budget is even consulted
  T.updateTaskStatus(task.id, 'working');
  for (let i = 0; i < C.MAX_REVIEW_LOOPS - 1; i++) T.incrementReviewLoopCount(task.id);
  const turn = T.createTaskTurn({ taskId: task.id, role: 'reviewer' });
  C._reviewContextsForTest.set(turn.id, {
    mode: 'opinion', profile: null, toolCalls: [],
    diff: { text: '', changed: ['a.ts'], shown: ['a.ts'], exempt: [], carried: [], omitted: [] },
  } as never);
  const decision = { outcome: 'fail', summary: 'broken', issues: [{ text: 'first problem' }, { text: 'second problem' }] } as never;
  C.routeVerifiedReview(T.getTask(task.id)!, turn.id, decision, 'opinion', opinionIssues(decision), null);
  const msg = T.getMessages(task.id).find(m => m.kind === 'review_escalation')!;
  assert.ok(msg, 'escalation message is tagged');
  assert.equal(msg.meta?.count, 2);
  assert.match(msg.content, /^1\. first problem$/m);
  assert.match(msg.content, /^2\. second problem$/m);
  assert.equal(T.getTask(task.id)!.status, 'awaiting_feedback');
});
