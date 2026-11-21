import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'cpm-preview-proof-'));
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.CODER_WORKSPACE_NAME = 'local-ws';
process.env.VSCODE_PROXY_URI = 'https://{{port}}--main--local-ws--magnus.coder.test';
process.env.CPM_PORT_RANGE_START = '47000';
process.env.CPM_PREVIEW_HEALTHCHECK_MS = '0';
process.env.CPM_WORKTREE_BASE = join(dir, 'worktrees');
process.env.CPM_CHECKPOINTS_BASE = join(dir, 'checkpoints');
const bin = join(dir, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'coder'), '#!/bin/sh\nexit 1\n');
chmodSync(join(bin, 'coder'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

let T: typeof import('./tasks.js');
let P: typeof import('./preview.js');
let getDb: typeof import('../db/index.js').getDb;

before(async () => {
  ({ getDb } = await import('../db/index.js'));
  T = await import('./tasks.js');
  P = await import('./preview.js');
  getDb().prepare("INSERT INTO users (id, username) VALUES ('u', 'tester')").run();
});
after(() => rmSync(dir, { recursive: true, force: true }));

function decode(cmd: string): string {
  const m = /printf %s '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(cmd);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : cmd;
}

test('a preview is never reported running before its port answers, even with the install health-check delay set to 0', async () => {
  const task = T.createTask({ workspaceId: 'wproof', workspaceName: 'remote-ws', userId: 'u', username: 'tester', prompt: 'p' });
  T.updateTaskStatus(task.id, 'awaiting_feedback');
  getDb().prepare('UPDATE tasks SET worktree_path = ?, project_dir = ?, port_range_start = ? WHERE id = ?')
    .run('/wt/task', '/home/coder/repo', 47010, task.id);
  P.setPreviewCommandSetting(task.workspace_id, 'npm run dev');
  const exec = async (command: string) => {
    const script = decode(command);
    if (script.includes('CPM_PREVIEW_CMD')) return 'cpm-preview-started 4242';
    if (script.includes('kill -0 "$pid"')) return 'cpm-health: alive running closed';
    return '';
  };
  const outcome = await P.restartTaskPreview(task.id, { exec, rangeSize: 10, healthCheckMs: 0, probeIntervalMs: 5, portWaitMs: 50 });
  assert.notEqual(outcome.status, 'running', 'nothing answers on the port, so it must not be running');
  await new Promise(r => setTimeout(r, 300));
  assert.notEqual(T.getTask(task.id)!.preview_status, 'running');
});
