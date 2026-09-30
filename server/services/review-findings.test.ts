/**
 * Data-layer behaviour of evidence-based review: severity, proof metadata and the
 * rules that keep advisory findings from holding a task back. Runs against a real
 * (temporary) SQLite database.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'cpm-findings-'));
process.env.DATABASE_PATH = join(dir, 'test.db');

type Tasks = typeof import('./tasks.js');
let T: Tasks;
let getDb: typeof import('../db/index.js').getDb;
let loadError: Error | null = null;

before(async () => {
  try {
    ({ getDb } = await import('../db/index.js'));
    T = await import('./tasks.js');
    getDb();
  } catch (err) {
    loadError = err as Error; // e.g. better-sqlite3's native module isn't built in this checkout
  }
});
after(() => rmSync(dir, { recursive: true, force: true }));

function newTask(id: string): { taskId: string; turnId: string } {
  getDb().prepare("INSERT OR IGNORE INTO users (id, username) VALUES ('u', 'tester')").run();
  getDb().prepare(
    "INSERT INTO tasks (id, workspace_id, workspace_name, user_id, prompt, position) VALUES (?, 'w', 'w', 'u', 'p', 1)"
  ).run(id);
  const turn = T.createTaskTurn({ taskId: id, role: 'reviewer' });
  return { taskId: id, turnId: turn.id };
}

const skipIfNoDb = (name: string, fn: () => void | Promise<void>) =>
  test(name, async t => { if (loadError) return t.skip(`database unavailable: ${loadError.message.slice(0, 80)}`); await fn(); });

skipIfNoDb('createReviewFindings stores severity and proof metadata; plain strings stay blocking with no proof', () => {
  const { taskId, turnId } = newTask('t1');
  const rows = T.createReviewFindings(taskId, turnId, [
    'plain opinion',
    { body: 'proven', severity: 'blocking', proofStatus: 'confirmed', requirement: 'task says X', proofPath: 'a.cpm-proof.test.ts', proofOutput: 'boom' },
    { body: 'unproven', severity: 'advisory', proofStatus: 'unproven', proofOutput: 'could not run' },
  ]);
  assert.deepEqual(rows.map(r => [r.severity, r.proof_status]), [['blocking', null], ['blocking', 'confirmed'], ['advisory', 'unproven']]);
  assert.equal(rows[1].requirement, 'task says X');
  assert.equal(rows[1].proof_path, 'a.cpm-proof.test.ts');
});

skipIfNoDb('a re-finalized turn replaces its own findings, not other turns\'', () => {
  const { taskId, turnId } = newTask('t2');
  const other = T.createTaskTurn({ taskId, role: 'reviewer' });
  T.createReviewFindings(taskId, other.id, ['keep me']);
  T.createReviewFindings(taskId, turnId, ['a', 'b']);
  T.createReviewFindings(taskId, turnId, ['c']);
  assert.deepEqual(T.getReviewFindings(taskId).map(f => f.body).sort(), ['c', 'keep me']);
});

skipIfNoDb('advisory findings do not count as open blocking work', () => {
  const { taskId, turnId } = newTask('t3');
  T.createReviewFindings(taskId, turnId, [{ body: 'just a note', severity: 'advisory', proofStatus: 'unproven' }]);
  assert.equal(T.hasOpenBlockingFindings(taskId), false);
  T.createReviewFindings(taskId, turnId, [{ body: 'just a note', severity: 'advisory' }, { body: 'real', severity: 'blocking', proofStatus: 'confirmed' }]);
  assert.equal(T.hasOpenBlockingFindings(taskId), true);
});

skipIfNoDb('a passing review closes outstanding blocking findings but leaves advisory ones alone', () => {
  const { taskId, turnId } = newTask('t4');
  const rows = T.createReviewFindings(taskId, turnId, [
    { body: 'blocking', severity: 'blocking', proofStatus: 'confirmed' },
    { body: 'advisory', severity: 'advisory', proofStatus: 'unproven' },
  ]);
  assert.equal(T.closeOutstandingOnPass(taskId), 1);
  const after = Object.fromEntries(T.getReviewFindings(taskId).map(f => [f.body, f.state]));
  assert.deepEqual(after, { blocking: 'verified', advisory: 'open' });
  assert.equal(rows.length, 2);
});

skipIfNoDb('setFindingProof turns a re-raised finding into a confirmed blocking one', () => {
  const { taskId, turnId } = newTask('t5');
  const [f] = T.createReviewFindings(taskId, turnId, [{ body: 'x', severity: 'advisory', proofStatus: 'unproven', requirement: 'old' }]);
  T.setFindingProof(f.id, { proofStatus: 'confirmed', proofPath: 'p.cpm-proof.test.ts', proofOutput: 'out' });
  const got = T.getReviewFinding(f.id)!;
  assert.deepEqual([got.severity, got.proof_status, got.proof_path, got.requirement], ['blocking', 'confirmed', 'p.cpm-proof.test.ts', 'old']);
});

skipIfNoDb('setTurnReview records the mode and the proofs on the turn', () => {
  const { taskId, turnId } = newTask('t6');
  T.setTurnReview(turnId, 'proof', JSON.stringify({ mode: 'proof', proofs: [] }));
  const turn = T.getTaskTurns(taskId).find(t => t.id === turnId)!;
  assert.equal(turn.review_mode, 'proof');
  assert.deepEqual(JSON.parse(turn.review_proofs!), { mode: 'proof', proofs: [] });
});

skipIfNoDb('setTaskVerification round-trips through the task row', () => {
  const { taskId } = newTask('t7');
  T.setTaskVerification(taskId, '{"runner":"jest"}');
  assert.equal(T.getTask(taskId)!.verification, '{"runner":"jest"}');
});

skipIfNoDb('test profile: stored per workspace; detection beats an implementer report but not a user setting', async () => {
  const P = await import('./test-profile.js');
  const exec = async () => `package.json\n@@CPM_PACKAGE_JSON@@\n{"devDependencies":{"vitest":"1"}}`;
  assert.equal(P.getStoredTestProfile('ws-1'), null);

  P.setStoredTestProfile('ws-1', { runner: 'jest', source: 'implementer' });
  assert.equal((await P.resolveTestProfile('ws-1', '/wt', exec))?.runner, 'vitest', 'what the repo says now wins over a past report');

  P.setStoredTestProfile('ws-1', { runner: 'pytest', source: 'user' });
  assert.equal((await P.resolveTestProfile('ws-1', '/wt', exec))?.runner, 'pytest', 'a user setting always wins');

  P.setStoredTestProfile('ws-1', null);
  assert.equal(P.getStoredTestProfile('ws-1'), null);
});

skipIfNoDb('test profile: falls back to the implementer\'s report when nothing is detectable or the workspace is unreachable', async () => {
  const P = await import('./test-profile.js');
  P.setStoredTestProfile('ws-2', { runner: 'go', source: 'implementer' });
  assert.equal((await P.resolveTestProfile('ws-2', '/wt', async () => 'README.md\n@@CPM_PACKAGE_JSON@@\n'))?.runner, 'go');
  assert.equal((await P.resolveTestProfile('ws-2', '/wt', async () => { throw new Error('ssh down'); }))?.runner, 'go');
  assert.equal(await P.resolveTestProfile('ws-none', '/wt', async () => { throw new Error('ssh down'); }), null);
});

skipIfNoDb('test obligation: the decision table (auto follows the tooling; only an explicit "on" may ask for a framework)', async () => {
  const P = await import('./test-profile.js');
  const table: Array<[Parameters<typeof P.decideTestObligation>[0], boolean, string]> = [
    ['auto', true, 'existing'], ['auto', false, 'off'],   // Godot/Unity: nothing detected → left alone
    ['on', true, 'existing'], ['on', false, 'setup'],
    ['off', true, 'off'], ['off', false, 'off'],
  ];
  for (const [setting, hasProfile, expected] of table) {
    assert.equal(P.decideTestObligation(setting, hasProfile), expected, `${setting} / profile=${hasProfile}`);
  }
});

skipIfNoDb('test obligation: stored per workspace, defaults to auto, junk values read as auto', async () => {
  const P = await import('./test-profile.js');
  assert.equal(P.getTestObligationSetting('ob-1'), 'auto');
  P.setTestObligationSetting('ob-1', 'off');
  assert.equal(P.getTestObligationSetting('ob-1'), 'off');
  P.setTestObligationSetting('ob-1', 'on');
  assert.equal(P.getTestObligationSetting('ob-1'), 'on');
  P.setTestObligationSetting('ob-1', 'auto');
  assert.equal(P.getTestObligationSetting('ob-1'), 'auto');
  getDb().prepare("UPDATE workspace_settings SET test_obligation = 'bogus' WHERE workspace_id = 'ob-1'").run();
  assert.equal(P.getTestObligationSetting('ob-1'), 'auto');
  assert.equal(P.getTestObligationSetting('never-seen'), 'auto');
});

skipIfNoDb('test obligation: a Godot-style workspace (no runner) gets nothing in auto; detection turns it on', async () => {
  const P = await import('./test-profile.js');
  const godot = async () => 'project.godot\nscenes\n@@CPM_PACKAGE_JSON@@\n';
  const node = async () => 'package.json\n@@CPM_PACKAGE_JSON@@\n{"devDependencies":{"vitest":"1"}}';
  assert.equal((await P.resolveTestObligation('ob-2', '/wt', godot)).obligation, 'off');
  assert.equal((await P.resolveTestObligation('ob-3', '/wt', node)).obligation, 'existing');
  P.setTestObligationSetting('ob-2', 'on');
  assert.equal((await P.resolveTestObligation('ob-2', '/wt', godot)).obligation, 'setup');
});

skipIfNoDb('test obligation: "off" never touches the workspace, even one with a runner', async () => {
  const P = await import('./test-profile.js');
  P.setTestObligationSetting('ob-4', 'off');
  let asked = false;
  const r = await P.resolveTestObligation('ob-4', '/wt', async () => { asked = true; return ''; });
  assert.deepEqual([r.obligation, r.profile, asked], ['off', null, false]);
});

