import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Exec } from './review-io.js';
import { readAddedExports, readSnapshot } from './audit-io.js';

const cleanEnv = { ...process.env };
delete cleanEnv.NODE_TEST_CONTEXT;
const exec: Exec = (command, timeout = 60000, maxBuffer = 8 * 1024 * 1024) =>
  new Promise((res, rej) => {
    execFile('bash', ['-c', command], { timeout, maxBuffer, env: cleanEnv }, (err, stdout) => {
      if (err && !stdout) return rej(err);
      res(stdout.trim().replace(/\n/g, '\r\n'));
    });
  });
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });

test('a pure rename adds no exports, so the mandatory checklist stays empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpm-proof-rename-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'old.ts'), 'export function a() { return 1; }\nexport function b() { return 2; }\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    git(dir, 'checkout', '-q', '-b', 'task');
    git(dir, 'mv', 'old.ts', 'renamed.ts');
    const snap = await readSnapshot(exec, dir);
    const added = await readAddedExports(exec, dir, snap);
    assert.deepEqual(added, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
