/**
 * "Send to implementer" against a temporary database: one send is exactly one
 * fix_request message and one queued implementer turn, whichever sources it
 * draws from — and the MCP tool does the same thing.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'cpm-fixsend-'));
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.CODER_WORKSPACE_NAME = 'local-ws';

let T: typeof import('./tasks.js');
let A: typeof import('./audits.js');
let F: typeof import('./fix-send.js');
let M: typeof import('../mcp/index.js');
let getDb: typeof import('../db/index.js').getDb;
let loadError: Error | null = null;

before(async () => {
  try {
    ({ getDb } = await import('../db/index.js'));
    T = await import('./tasks.js');
    A = await import('./audits.js');
    F = await import('./fix-send.js');
    M = await import('../mcp/index.js');
    getDb().prepare("INSERT INTO users (id, username) VALUES ('u', 'tester')").run();
  } catch (err) {
    loadError = err as Error;
  }
});
after(() => rmSync(dir, { recursive: true, force: true }));

const dbTest = (name: string, fn: () => void | Promise<void>) =>
  test(name, async t => { if (loadError) return t.skip(`database unavailable: ${loadError.message.slice(0, 80)}`); await fn(); });

/** A task awaiting feedback with two reviewer findings (one proven) and a finished audit of three findings. */
function setup(ws: string) {
  const t = T.createTask({ workspaceId: ws, workspaceName: 'local-ws', userId: 'u', username: 'tester', prompt: 'p', autoReview: true });
  const impl = T.createTaskTurn({ taskId: t.id, role: 'implementer' });
  const rev = T.createTaskTurn({ taskId: t.id, role: 'reviewer' });
  const [proven, advisory] = T.createReviewFindings(t.id, rev.id, [
    { body: 'null deref in parse', severity: 'blocking', proofStatus: 'confirmed', proofPath: 'p.cpm-proof.test.ts', proofOutput: 'boom' },
    { body: 'naming nit', severity: 'advisory', proofStatus: 'unproven' },
  ]);
  const audit = A.createAudit({ taskId: t.id, trigger: 'manual', implementerTurns: A.countImplementerTurns(t.id) });
  A.finishAudit(audit.id, 'done', {
    report: {
      summary: 's', structure: { added: [], modified: [] }, hardToReverse: [], discrepancies: [], unassessedExports: [],
      reuseFindings: [{ id: 'r1', name: 'helper', kind: 'possible_duplicate', newCite: 'a.ts:3', existingCite: 'c.ts:7', note: 'duplicates util' }],
      deviations: [{ id: 'd1', text: 'raw string where a constant exists', cites: ['a.ts:9'] }, { id: 'd2', text: 'list handling differs', cites: ['a.ts:20'] }],
      ownership: { r1: { owner: 'task', basis: 'lines', reason: 'cites lines this task changed' } },
    },
  });
  T.updateTaskStatus(t.id, 'awaiting_feedback');
  void impl;
  return { task: T.getTask(t.id)!, proven, advisory };
}

const fixMessages = (taskId: string) => T.getMessages(taskId).filter(m => m.kind === 'fix_request');

dbTest('one send across reviewer and audit findings is one fix_request message and one queued turn', () => {
  const { task, proven, advisory } = setup('ws-both');
  const launched: string[] = [];
  const res = F.sendFindingsToImplementer({
    task, reviewIds: [proven.id, advisory.id], auditIds: ['r1', 'd1'], note: 'use the existing constant; ignore the list one',
    actor: { username: 'tester', source: 'ui' },
  }, ws => launched.push(ws));

  assert.equal(res.ok, true);
  assert.deepEqual(launched, ['ws-both'], 'the workspace queue is started exactly once');
  assert.equal(T.getTask(task.id)!.status, 'queued');
  const msgs = fixMessages(task.id);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'user');
  assert.deepEqual(
    { count: msgs[0].meta?.count, confirmed: msgs[0].meta?.confirmed, bySource: msgs[0].meta?.bySource, hasNote: msgs[0].meta?.hasNote },
    { count: 4, confirmed: 1, bySource: { review: 2, audit: 2 }, hasNote: true },
  );
  assert.equal(msgs[0].meta?.summary, 'Fix request: 4 findings (2 review, 2 audit) → sent to implementer');
  // The prompt carries every selected item from both sources, the note, and the right wording per source.
  const body = msgs[0].content;
  assert.match(body, /null deref in parse/);
  assert.match(body, /naming nit/);
  assert.match(body, /helper — duplicates util|\(possible duplicate\) helper: duplicates util/);
  assert.match(body, /raw string where a constant exists/);
  assert.doesNotMatch(body, /list handling differs/, 'an unselected audit finding is not sent');
  assert.match(body, /use the existing constant; ignore the list one/);
  assert.match(body, /FAILING TEST: p\.cpm-proof\.test\.ts/);
  assert.match(body, /JUDGEMENT CALLS/);
  // Reviewer findings move to 'fixing'; audit findings have no state.
  assert.deepEqual(T.getReviewFindings(task.id).map(f => f.state), ['fixing', 'fixing']);
});

dbTest('an audit-only send works, with no reviewer findings involved', () => {
  const { task } = setup('ws-audit-only');
  const res = F.sendFindingsToImplementer({ task, auditIds: ['d2'], actor: {} }, () => {});
  assert.equal(res.ok, true);
  const [m] = fixMessages(task.id);
  assert.deepEqual(m.meta?.bySource, { review: 0, audit: 1 });
  assert.equal(m.meta?.hasNote, undefined);
  assert.deepEqual(T.getReviewFindings(task.id).map(f => f.state), ['open', 'open'], 'untouched reviewer findings stay open');
});

dbTest('refuses an empty selection, unknown ids and a task that is not awaiting feedback, and sends nothing', () => {
  const { task } = setup('ws-refuse');
  const launched: string[] = [];
  const launch = (w: string) => launched.push(w);
  const empty = F.sendFindingsToImplementer({ task, actor: {} }, launch);
  const unknown = F.sendFindingsToImplementer({ task, reviewIds: ['nope'], auditIds: ['zz9'], actor: {} }, launch);
  T.updateTaskStatus(task.id, 'working');
  const busy = F.sendFindingsToImplementer({ task: T.getTask(task.id)!, auditIds: ['r1'], actor: {} }, launch);
  assert.deepEqual([empty, unknown, busy].map(r => r.ok ? 0 : r.status), [400, 404, 400]);
  assert.deepEqual(launched, []);
  assert.equal(fixMessages(task.id).length, 0);
});

dbTest('tells the implementer when the audit predates its latest changes', () => {
  const { task } = setup('ws-stale');
  T.createTaskTurn({ taskId: task.id, role: 'implementer' }); // a newer implementer turn than the audit saw
  F.sendFindingsToImplementer({ task: T.getTask(task.id)!, auditIds: ['r1'], actor: {} }, () => {});
  assert.match(fixMessages(task.id)[0].content, /predates your latest changes/);
});

dbTest('the MCP tool sends the selected findings exactly as the UI does, and only for the caller\'s own tasks', () => {
  const { task, proven } = setup('ws-mcp');
  const ctx = { token: 't', userId: 'u', username: 'tester', authSource: 'api' as const, clientLabel: 'mimir' };
  const launched: string[] = [];
  const res = M.runSendFindings(ctx, { task_id: task.id, review_finding_ids: [proven.id], audit_finding_ids: ['r1'], note: 'be brief' }, w => launched.push(w));
  assert.equal((res as { isError?: boolean }).isError, undefined);
  assert.deepEqual(launched, ['ws-mcp']);
  const [m] = fixMessages(task.id);
  assert.deepEqual(m.meta?.bySource, { review: 1, audit: 1 });
  assert.match(m.content, /be brief/);

  const other = M.runSendFindings({ ...ctx, userId: 'someone-else' }, { task_id: task.id, audit_finding_ids: ['r1'] }, () => assert.fail('must not launch'));
  assert.equal((other as { isError?: boolean }).isError, true);
});
