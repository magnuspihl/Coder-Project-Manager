/**
 * The auditor's lifecycle against a temporary database and the real review
 * routing: when it starts, that a user reply cancels it (never leaving it
 * 'running'), that a cancelled audit is redone, and staleness.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'cpm-audits-'));
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.CODER_WORKSPACE_NAME = 'local-ws';
process.env.CPM_CHECKPOINTS_BASE = join(dir, 'checkpoints');

let T: typeof import('./tasks.js');
let C: typeof import('./claude.js');
let A: typeof import('./audits.js');
let getDb: typeof import('../db/index.js').getDb;
let loadError: Error | null = null;

before(async () => {
  try {
    ({ getDb } = await import('../db/index.js'));
    T = await import('./tasks.js');
    C = await import('./claude.js');
    A = await import('./audits.js');
    getDb().prepare("INSERT INTO users (id, username) VALUES ('u', 'tester')").run();
  } catch (err) {
    loadError = err as Error;
  }
});
after(() => rmSync(dir, { recursive: true, force: true }));

const dbTest = (name: string, fn: () => void | Promise<void>) =>
  test(name, async t => { if (loadError) return t.skip(`database unavailable: ${loadError.message.slice(0, 80)}`); await fn(); });

const decision = { outcome: 'pass' as const, summary: 'fine' };
const fullDiff = { text: '', changed: ['a.ts'], shown: ['a.ts'], exempt: [], carried: [], omitted: [] };
const partialDiff = { ...fullDiff, changed: ['a.ts', 'big.ts'], omitted: [{ path: 'big.ts', reason: 'too large' }] };

/** A task with a worktree path that does not exist, so a launched audit fails fast instead of reaching a real workspace. */
function task(workspaceId: string, opts: { autoReview?: boolean } = {}) {
  const t = T.createTask({ workspaceId, workspaceName: 'local-ws', userId: 'u', username: 'tester', prompt: 'p', autoReview: opts.autoReview ?? true });
  getDb().prepare('UPDATE tasks SET worktree_path = ? WHERE id = ?').run(join(dir, 'no-such-worktree'), t.id);
  T.createTaskTurn({ taskId: t.id, role: 'implementer' });
  T.updateTaskStatus(t.id, 'working');
  return T.getTask(t.id)!;
}

/** Settle a review of `t` with a pass (or a partial one) the way the real routing does. */
function settle(t: ReturnType<typeof task>, diff = fullDiff) {
  const turn = T.createTaskTurn({ taskId: t.id, role: 'reviewer' });
  C._reviewContextsForTest.set(turn.id, { mode: 'opinion', profile: null, diff, toolCalls: [] });
  T.updateTaskStatus(t.id, 'working');
  C.routeVerifiedReview(T.getTask(t.id)!, turn.id, decision, 'opinion', [], null);
}

dbTest('the audit switch follows auto-review until it is set explicitly', () => {
  const t = task('w-switch', { autoReview: true });
  assert.equal(A.auditEnabled(t), true);
  A.setTaskAudit(t.id, false);
  assert.equal(A.auditEnabled(T.getTask(t.id)!), false, 'an explicit off wins over auto-review');
  A.setTaskAudit(t.id, null);
  assert.equal(A.auditEnabled(T.getTask(t.id)!), true, 'null follows auto-review again');
  const off = task('w-switch-off', { autoReview: false });
  assert.equal(A.auditEnabled(off), false);
  A.setTaskAudit(off.id, true);
  assert.equal(A.auditEnabled(T.getTask(off.id)!), true);
});

dbTest('a fresh database has the audit column on tasks and the task_audits table', () => {
  const cols = getDb().prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
  assert.ok(cols.some(c => c.name === 'audit'));
  assert.ok(getDb().prepare("SELECT name FROM sqlite_master WHERE name = 'task_audits'").get());
});

dbTest('a review that settles on pass starts an audit', () => {
  const t = task('w-pass');
  settle(t);
  const a = A.getLatestAudit(t.id)!;
  assert.equal(a.status, 'running');
  assert.equal(a.trigger_kind, 'auto');
  C.cancelAudit(t.id);
});

dbTest('a review that settles as partial also starts an audit', () => {
  const t = task('w-partial');
  settle(t, partialDiff);
  assert.equal(T.getTaskTurns(t.id).filter(x => x.role === 'reviewer').pop()!.review_outcome, 'partial');
  assert.equal(A.getLatestAudit(t.id)?.status, 'running');
  C.cancelAudit(t.id);
});

dbTest('no audit starts when auditing is off for the task', () => {
  const t = task('w-off');
  A.setTaskAudit(t.id, false);
  settle(t);
  assert.equal(A.getLatestAudit(t.id), undefined);
});

dbTest('a second settle while an audit is running does not start another', () => {
  const t = task('w-dedupe');
  settle(t);
  settle(T.getTask(t.id)!);
  const rows = getDb().prepare('SELECT id FROM task_audits WHERE task_id = ?').all(t.id);
  assert.equal(rows.length, 1);
  C.cancelAudit(t.id);
});

dbTest('a user reply cancels a running audit and records why: it never stays running', () => {
  const t = task('w-cancel');
  settle(t);
  const running = A.getLatestAudit(t.id)!;
  assert.equal(running.status, 'running');

  assert.equal(C.cancelAudit(t.id, 'code is changing'), true);
  const after = A.getAudit(running.id)!;
  assert.equal(after.status, 'cancelled');
  assert.equal(after.reason, 'code is changing');
  assert.ok(after.completed_at);
  assert.equal(A.getRunningAudit(t.id), undefined);
  assert.equal(C.cancelAudit(t.id), false, 'nothing left to cancel');
});

dbTest('a cancelled audit is retried at the next pass, rather than sitting stale', () => {
  const t = task('w-retry');
  settle(t);
  const first = A.getLatestAudit(t.id)!;
  C.cancelAudit(t.id, 'code is changing');
  assert.equal(A.getAudit(first.id)!.status, 'cancelled');

  settle(T.getTask(t.id)!);
  const second = A.getLatestAudit(t.id)!;
  assert.notEqual(second.id, first.id, 'a new audit was started');
  assert.equal(second.status, 'running');
  assert.equal(A.getAudit(first.id)!.status, 'cancelled', 'the cancelled one is left as the record of what happened');
  C.cancelAudit(t.id);
});

dbTest('a result arriving after cancellation cannot overwrite it', () => {
  const t = task('w-late');
  const row = A.createAudit({ taskId: t.id, trigger: 'auto', implementerTurns: 1 });
  A.finishAudit(row.id, 'cancelled', { reason: 'code is changing' });
  assert.equal(A.finishAudit(row.id, 'done', {}), false);
  assert.equal(A.getAudit(row.id)!.status, 'cancelled');
});

dbTest('a server restart marks audits that were running as cancelled', () => {
  const t = task('w-restart');
  const row = A.createAudit({ taskId: t.id, trigger: 'auto', implementerTurns: 1 });
  assert.ok(A.abandonRunningAudits() >= 1);
  const after = A.getAudit(row.id)!;
  assert.equal(after.status, 'cancelled');
  assert.equal(after.reason, 'server restarted');
});

dbTest('an audit is due once per implementer-turn count, and again after a new implementer turn', () => {
  assert.equal(A.auditDue(undefined, 1), true);
  assert.equal(A.auditDue({ status: 'running', implementer_turns: 1 }, 1), false);
  assert.equal(A.auditDue({ status: 'done', implementer_turns: 1 }, 1), false);
  assert.equal(A.auditDue({ status: 'skipped', implementer_turns: 1 }, 1), false, 'a skip is not re-evaluated every pass');
  assert.equal(A.auditDue({ status: 'failed', implementer_turns: 1 }, 1), false, 'a failure is retried by hand, not in a loop');
  assert.equal(A.auditDue({ status: 'done', implementer_turns: 1 }, 2), true);
  assert.equal(A.auditDue({ status: 'cancelled', implementer_turns: 1 }, 1), true);
});

dbTest('a skipped audit records its reason on the task', () => {
  const t = task('w-skip');
  const row = A.createAudit({ taskId: t.id, trigger: 'auto', implementerTurns: 1 });
  assert.equal(A.skipAudit(row.id, 'audit skipped: docs-only change'), true);
  const back = A.getAudit(row.id)!;
  assert.equal(back.status, 'skipped');
  assert.equal(back.reason, 'audit skipped: docs-only change');
  assert.equal(A.auditView(back, 1).report, null);
});

const REPORT = { summary: 'built it', structure: { added: [], modified: [] }, reuseFindings: [], deviations: [], hardToReverse: [], discrepancies: [], unassessedExports: [] };

dbTest('a finished audit is marked stale once an implementer turn runs after it, and carries the label', () => {
  const t = task('w-stale');
  const row = A.createAudit({ taskId: t.id, trigger: 'manual', implementerTurns: A.countImplementerTurns(t.id) });
  A.setAuditSnapshot(row.id, { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), tree: 'c'.repeat(40) }, 'sess');
  A.finishAudit(row.id, 'done', { report: REPORT as never });

  const fresh = A.auditView(A.getAudit(row.id)!, A.countImplementerTurns(t.id));
  assert.equal(fresh.stale, false);
  assert.equal(fresh.stale_label, null);
  assert.equal(fresh.head_sha, 'b'.repeat(40));

  T.createTaskTurn({ taskId: t.id, role: 'implementer' });
  const stale = A.auditView(A.getAudit(row.id)!, A.countImplementerTurns(t.id));
  assert.equal(stale.stale, true);
  assert.equal(stale.stale_label, 'stale — code changed since this audit');
  assert.equal(A.auditSummary(A.getAudit(row.id)!, A.countImplementerTurns(t.id))!.stale_label, 'stale — code changed since this audit');
});

dbTest('the get_task summary carries counts and points at get_audit instead of embedding the report', () => {
  const t = task('w-summary');
  const row = A.createAudit({ taskId: t.id, trigger: 'manual', implementerTurns: 1 });
  A.finishAudit(row.id, 'done', { report: { ...REPORT, reuseFindings: [{ id: 'r1', name: 'n', kind: 'possible_duplicate', newCite: null, existingCite: null, note: '' }], discrepancies: null } as never });
  const s = A.auditSummary(A.getAudit(row.id)!, 1)!;
  assert.equal(s.possible_duplicates, 1);
  assert.equal(s.discrepancies, null);
  assert.equal(s.summary, 'built it');
  assert.equal('report' in s, false);
  assert.match(String(s.detail), /get_audit/);
  assert.equal(A.auditSummary(undefined, 1), null);
});
