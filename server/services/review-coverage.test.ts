import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessCoverage, buildReviewDiff, coverageOutcome, exemptReason, omittedFilesBlock, partialLabel, reviewerTurnCap,
  toolCallsFromContent, type ReviewDiff,
} from './review-coverage.js';
import { parseReviewDecision } from './review-verdict.js';
import { routeReview } from './review-proof.js';

const WT = '/work/tree';

/** A `git diff` section for one file with `hunks` hunks of `lines` added lines each. */
function fileDiff(path: string, hunks = 1, lines = 3, deleted = false): string {
  const head = `diff --git a/${path} b/${path}\n${deleted ? 'deleted file mode 100644\n' : ''}index 111..222 100644\n--- a/${path}\n+++ ${deleted ? '/dev/null' : `b/${path}`}\n`;
  let body = '';
  for (let h = 0; h < hunks; h++) {
    body += `@@ -${h * 10},1 +${h * 10},${lines} @@\n`;
    for (let i = 0; i < lines; i++) body += `+const line${h}_${i} = ${'x'.repeat(40)};\n`;
  }
  return head + body;
}

const read = (p: string) => ({ name: 'Read', input: { file_path: p } });

test('a diff that fits lists no omitted files and shows every changed file', () => {
  const d = buildReviewDiff(fileDiff('a.ts') + fileDiff('b.ts'), [], 32_000);
  assert.deepEqual(d.omitted, []);
  assert.deepEqual(d.shown, ['a.ts', 'b.ts']);
  assert.equal(omittedFilesBlock(d), '');
});

test('a truncated diff lists the files that were left out, and the prompt names each one', () => {
  const raw = fileDiff('small.ts') + fileDiff('big.ts', 40, 20) + fileDiff('other.ts');
  const d = buildReviewDiff(raw, [], 4000);
  assert.deepEqual(d.shown.sort(), ['other.ts', 'small.ts']);
  assert.deepEqual(d.omitted.map(o => o.path), ['big.ts']);
  const block = omittedFilesBlock(d);
  assert.match(block, /THE DIFF ABOVE IS INCOMPLETE/);
  assert.match(block, /- big\.ts — diff cut at a hunk boundary \(\d+ of 40 hunks shown\)/);
  assert.match(block, /MUST open EVERY file/);
  assert.doesNotMatch(block, /small\.ts/);
});

test('a file cut mid-way records which hunks were shown and is never cut inside a hunk', () => {
  const raw = fileDiff('wide.ts', 10, 10);
  const d = buildReviewDiff(raw, [], 5000);
  const o = d.omitted.find(x => x.path === 'wide.ts')!;
  assert.ok(o.hunksShown! > 0 && o.hunksShown! < 10, `shown ${o.hunksShown}`);
  assert.equal(o.hunksTotal, 10);
  assert.ok(d.text.length <= 5000);
  assert.equal(d.text.split('\n').filter(l => l.startsWith('@@ ')).length, o.hunksShown);
  assert.deepEqual(d.shown, [], 'a partly shown file does not count as shown');
  assert.match(omittedFilesBlock(d), new RegExp(`${o.hunksShown} of 10 hunks shown`));
});

test('a second oversized file gets no room at all and is listed as too large', () => {
  const d = buildReviewDiff(fileDiff('big1.ts', 40, 20) + fileDiff('big2.ts', 40, 20), [], 6000);
  assert.deepEqual(d.omitted.map(o => [o.path, o.reason.split(' ')[0]]), [['big1.ts', 'diff'], ['big2.ts', 'too']]);
  assert.match(omittedFilesBlock(d), /- big2\.ts — too large for the diff budget/);
});

test('untracked files carry no diff, so they are listed as omitted and must be read', () => {
  const d = buildReviewDiff(fileDiff('a.ts'), ['new.test.ts'], 32_000);
  assert.deepEqual(d.omitted.map(o => o.path), ['new.test.ts']);
  assert.match(d.omitted[0].reason, /untracked/);
  assert.match(d.text, /Untracked files:\nnew\.test\.ts/);
});

test('lockfiles and generated files are exempt: left out of the diff, listed as exempt, never required', () => {
  const raw = fileDiff('package-lock.json', 1, 500) + fileDiff('dist/app.js') + fileDiff('src/a.ts');
  const d = buildReviewDiff(raw, [], 32_000);
  assert.deepEqual(d.changed, ['src/a.ts']);
  assert.deepEqual(d.exempt.map(e => e.path).sort(), ['dist/app.js', 'package-lock.json']);
  assert.ok(!d.text.includes('diff --git a/package-lock.json') && !d.text.includes('diff --git a/dist/app.js'));
  assert.equal(exemptReason('yarn.lock'), 'lockfile');
  assert.equal(exemptReason('src/a.ts'), null);
  assert.equal(coverageOutcome('pass', assessCoverage({ diff: d, worktree: WT, toolCalls: [] })), 'pass', 'exempt files never make a review partial');
});

test('a deleted file that did not fit is flagged so the prompt points at git, not Read', () => {
  const raw = fileDiff('gone.ts', 60, 20, true) + fileDiff('a.ts');
  const d = buildReviewDiff(raw, [], 3000);
  assert.match(omittedFilesBlock(d), /gone\.ts.*deleted: inspect with `git diff`/);
});

test('"review remaining files" scope drops everything else from the diff and from the obligations', () => {
  const d = buildReviewDiff(fileDiff('a.ts') + fileDiff('b.ts'), ['c.ts'], 32_000, { onlyFiles: ['b.ts'] });
  assert.deepEqual(d.changed, ['b.ts']);
  assert.deepEqual(d.omitted, []);
});

test('renamed files are recorded under their new path', () => {
  const raw = 'diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n@@ -1 +1 @@\n-a\n+b\n';
  assert.deepEqual(buildReviewDiff(raw, [], 32_000).changed, ['new.ts']);
});

// --- coverage from tool calls ------------------------------------------------

function truncated(): ReviewDiff {
  return buildReviewDiff(fileDiff('seen.ts') + fileDiff('core.ts', 40, 20) + fileDiff('tests.ts', 40, 20), [], 4000);
}

test('coverage is derived from the reviewer\'s tool calls: Read, Grep on the file, and Bash naming it', () => {
  const d = truncated();
  assert.deepEqual(d.omitted.map(o => o.path), ['core.ts', 'tests.ts']);
  const none = assessCoverage({ diff: d, worktree: WT, toolCalls: [] });
  assert.deepEqual(none.unreviewed.map(u => u.path), ['core.ts', 'tests.ts']);

  const r = assessCoverage({ diff: d, worktree: WT, toolCalls: [read(`${WT}/core.ts`), { name: 'Grep', input: { pattern: 'x', path: 'tests.ts' } }] });
  assert.deepEqual(r.unreviewed, []);
  assert.deepEqual(r.readViaTool.sort(), ['core.ts', 'tests.ts']);

  const viaBash = assessCoverage({ diff: d, worktree: WT, toolCalls: [{ name: 'Bash', input: { command: `sed -n 1,80p ${WT}/core.ts` } }, read('./tests.ts')] });
  assert.deepEqual(viaBash.unreviewed, []);
});

test('a Grep over a directory is a search, not a read, and does not cover the files in it', () => {
  const d = buildReviewDiff(fileDiff('seen.ts') + fileDiff('src/core.ts', 40, 20), [], 3500);
  const r = assessCoverage({ diff: d, worktree: WT, toolCalls: [{ name: 'Grep', input: { pattern: 'x', path: `${WT}/src` } }] });
  assert.deepEqual(r.unreviewed.map(u => u.path), ['src/core.ts']);
});

test('the reviewer claiming it read a file does not count — only tool calls do', () => {
  const d = truncated();
  const claimed = { reviewed: ['seen.ts', 'core.ts', 'tests.ts'], notReviewed: [] };
  const r = assessCoverage({ diff: d, worktree: WT, toolCalls: [], claimed });
  assert.deepEqual(r.unreviewed.map(u => u.path), ['core.ts', 'tests.ts']);
  assert.equal(r.claimUnverified, false);
});

test('a file the reviewer admits it did not read counts as unreviewed even though it was in the diff', () => {
  const d = truncated();
  const r = assessCoverage({
    diff: d, worktree: WT, toolCalls: [read(`${WT}/core.ts`), read(`${WT}/tests.ts`)],
    claimed: { reviewed: [], notReviewed: [{ file: 'seen.ts', reason: 'skimmed only' }, { file: 'unrelated.ts', reason: 'x' }] },
  });
  assert.deepEqual(r.unreviewed, [{ path: 'seen.ts', reason: 'skimmed only' }]);
});

test('an admission cannot undo a tool call that proves the file was opened', () => {
  const d = truncated();
  const r = assessCoverage({
    diff: d, worktree: WT, toolCalls: [read(`${WT}/core.ts`), read(`${WT}/tests.ts`)],
    claimed: { reviewed: [], notReviewed: [{ file: 'core.ts', reason: 'ran out of time' }] },
  });
  assert.deepEqual(r.unreviewed, []);
});

test('tool_use blocks are extracted from an assistant message and malformed ones are ignored', () => {
  const calls = toolCallsFromContent([
    { type: 'text', text: 'hi' },
    { type: 'tool_use', name: 'Read', input: { file_path: '/a' } },
    { type: 'tool_use', input: {} },
    null,
  ]);
  assert.deepEqual(calls, [{ name: 'Read', input: { file_path: '/a' } }]);
  assert.deepEqual(toolCallsFromContent('nope'), []);
});

// --- outcome ----------------------------------------------------------------

const passDecision = (extra = '') => parseReviewDecision(`REVIEW_DECISION: {"outcome":"pass","summary":"fine"${extra}}`)!;

test('a pass with an unread file becomes a partial review', () => {
  const d = truncated();
  const report = assessCoverage({ diff: d, worktree: WT, toolCalls: [read(`${WT}/core.ts`)], claimed: passDecision().coverage });
  const routed = routeReview('proof', passDecision(), []);
  assert.equal(routed.outcome, 'pass');
  assert.equal(coverageOutcome(routed.outcome, report), 'partial');
  assert.equal(partialLabel(report), 'Partial review — not seen: tests.ts');
});

test('a pass with everything covered stays a pass', () => {
  const d = truncated();
  const report = assessCoverage({ diff: d, worktree: WT, toolCalls: [read(`${WT}/core.ts`), read(`${WT}/tests.ts`)] });
  assert.equal(coverageOutcome('pass', report), 'pass');
});

test('a pass on a diff that fit in full stays a pass without any tool calls', () => {
  const d = buildReviewDiff(fileDiff('a.ts') + fileDiff('b.ts'), [], 32_000);
  assert.equal(coverageOutcome('pass', assessCoverage({ diff: d, worktree: WT, toolCalls: [] })), 'pass');
});

test('a fail with a confirmed proof stays a fail whatever the coverage', () => {
  const d = truncated();
  const report = assessCoverage({ diff: d, worktree: WT, toolCalls: [] });
  assert.ok(report.unreviewed.length > 0);
  const confirmed = [{
    issue: { text: 'broken', proofPath: 'x.cpm-proof.test.ts' },
    proof: { status: 'confirmed' as const, reason: '', failedTests: ['t'], passedTests: 0, output: 'boom', repairable: false },
  }];
  const decision = parseReviewDecision('REVIEW_DECISION: {"outcome":"fail","summary":"s","findings":[{"defect":"broken","requirement":"r","proof":"x.cpm-proof.test.ts"}]}')!;
  const routed = routeReview('proof', decision, confirmed);
  assert.equal(routed.outcome, 'fail');
  assert.equal(coverageOutcome(routed.outcome, report), 'fail');
});

test('with no coverage information at all (e.g. the server restarted mid-review) a pass stays a pass', () => {
  assert.equal(coverageOutcome('pass', null), 'pass');
});

test('a missing coverage field is unverified and falls back to the tool-call evidence', () => {
  const d = truncated();
  const decision = passDecision();
  assert.equal(decision.coverage, undefined);
  const report = assessCoverage({ diff: d, worktree: WT, toolCalls: [read(`${WT}/core.ts`), read(`${WT}/tests.ts`)], claimed: decision.coverage });
  assert.equal(report.claimUnverified, true);
  assert.equal(coverageOutcome('pass', report), 'pass');
  const unread = assessCoverage({ diff: d, worktree: WT, toolCalls: [], claimed: decision.coverage });
  assert.equal(coverageOutcome('pass', unread), 'partial');
});

// --- budget ------------------------------------------------------------------

test('the turn cap grows with the number of omitted files, and the bonus is bounded', () => {
  assert.equal(reviewerTurnCap(40, 0), 40);
  assert.equal(reviewerTurnCap(40, 2), 46);
  assert.equal(reviewerTurnCap(40, 500), 64);
});

test('the report records that the turn cap stopped the reviewer', () => {
  const r = assessCoverage({ diff: truncated(), worktree: WT, toolCalls: [], stoppedByTurnCap: true, turnCap: 46 });
  assert.equal(r.stoppedByTurnCap, true);
  assert.equal(r.turnCap, 46);
});
