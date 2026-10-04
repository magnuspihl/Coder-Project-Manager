/**
 * Workspace-side reads of the auditor against a REAL git repository (a local
 * shell stands in for `coder ssh`; output gets PTY-style CRLF line endings).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Exec } from './review-io.js';
import { buildLineIndex, parseSnapshot, readAddedExports, readGuidanceDocs, readPackageJsons, readSnapshot } from './audit-io.js';
import { checkCite } from './audit-citations.js';
import { computeHardToReverse } from './audit-facts.js';

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

/** main has a service; the task branch commits one change, leaves one uncommitted and one untracked. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cpm-audit-io-'));
  git(dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'src/existing.ts'), 'export function helper() { return 1; }\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '^4.0.0' } }));
  writeFileSync(join(dir, 'CLAUDE.md'), '# Rules\nExtend src/existing.ts, do not recreate it.\n');
  writeFileSync(join(dir, 'docs/ARCHITECTURE.md'), 'layers\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'task');
  writeFileSync(join(dir, 'src/existing.ts'), 'export function helper() { return 1; }\nexport function addedToExisting() { return 2; }\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '^4.0.0', zod: '^3.0.0' } }));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'task commit');
  // uncommitted edit + untracked new module
  writeFileSync(join(dir, 'src/existing.ts'), 'export function helper() { return 1; }\nexport function addedToExisting() { return 2; }\nexport const uncommitted = 3;\n');
  writeFileSync(join(dir, 'src/brandnew.ts'), "export class Fresh {}\nexport const process_ = process.env.AUDIT_TEST_VAR;\n");
  return dir;
}

test('the snapshot covers committed, uncommitted and untracked changes against the merge-base, without touching the real index', async () => {
  const dir = makeRepo();
  try {
    const before = git(dir, 'status', '--porcelain');
    const snap = await readSnapshot(exec, dir);
    assert.equal(snap.baseSha, git(dir, 'rev-parse', 'main').trim());
    assert.equal(snap.headSha, git(dir, 'rev-parse', 'HEAD').trim());
    assert.ok(snap.tree);
    assert.deepEqual(snap.files.map(f => `${f.status} ${f.path}`).sort(), ['A src/brandnew.ts', 'M package.json', 'M src/existing.ts']);
    assert.match(snap.diff, /\+export const uncommitted = 3;/);
    assert.match(snap.diff, /\+export class Fresh/);
    assert.equal(git(dir, 'status', '--porcelain'), before, 'the snapshot must not stage anything');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the added-exports checklist has the exports a task adds to an existing module and every export of a new one', async () => {
  const dir = makeRepo();
  try {
    const snap = await readSnapshot(exec, dir);
    const names = (await readAddedExports(exec, dir, snap)).map(e => `${e.path}:${e.name}`).sort();
    assert.deepEqual(names, ['src/brandnew.ts:Fresh', 'src/brandnew.ts:process_', 'src/existing.ts:addedToExisting', 'src/existing.ts:uncommitted']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hard-to-reverse facts computed from a real diff find the new dependency and env var', async () => {
  const dir = makeRepo();
  try {
    const snap = await readSnapshot(exec, dir);
    const facts = computeHardToReverse({ diff: snap.diff, packageJsons: await readPackageJsons(exec, dir, snap) }).map(f => f.detail);
    assert.ok(facts.includes('new dependency zod@^3.0.0'));
    assert.ok(facts.includes('reads env var AUDIT_TEST_VAR'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the citation index tells pre-existing code from code the task added', async () => {
  const dir = makeRepo();
  try {
    const snap = await readSnapshot(exec, dir);
    const cites = ['src/existing.ts:1', 'src/brandnew.ts:2', 'src/ghost.ts:1', 'src/existing.ts:3'];
    const index = await buildLineIndex(exec, dir, snap.baseSha, cites);
    assert.equal(checkCite('src/existing.ts:1', index, 'base').ok, true);
    assert.equal(checkCite('src/existing.ts:3', index, 'base').ok, false, 'line 3 was added after the merge-base');
    assert.equal(checkCite('src/existing.ts:3', index, 'head').ok, true);
    const added = checkCite('src/brandnew.ts:2', index, 'base');
    assert.equal(added.ok, false);
    assert.match(added.reason!, /added by this task/);
    assert.equal(checkCite('src/brandnew.ts:2', index, 'head').ok, true);
    assert.equal(checkCite('src/ghost.ts:1', index, 'either').ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('paths that would need shell quoting tricks are not measured at all', async () => {
  const dir = makeRepo();
  try {
    const snap = await readSnapshot(exec, dir);
    const index = await buildLineIndex(exec, dir, snap.baseSha, ['a;touch pwned.ts:1', '$(id).ts:1']);
    assert.equal(index.head.size + index.base.size, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guidance docs are read from the worktree: CLAUDE.md and docs/', async () => {
  const dir = makeRepo();
  try {
    const docs = await readGuidanceDocs(exec, dir);
    assert.deepEqual(docs.map(d => d.path).sort(), ['CLAUDE.md', 'docs/ARCHITECTURE.md']);
    assert.match(docs.find(d => d.path === 'CLAUDE.md')!.content, /do not recreate it/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parsing a snapshot with a rename reports the new path and remembers the old one', () => {
  const snap = parseSnapshot('@@CPM_BASE@@' + 'a'.repeat(40) + '\n@@CPM_HEAD@@' + 'b'.repeat(40) + '\n@@CPM_TREE@@' + 'c'.repeat(40) + '\n@@CPM_NAMES@@\nR100\told.ts\tnew.ts\nD\tgone.ts\n@@CPM_DIFF@@\n');
  assert.deepEqual(snap.files, [{ status: 'R', path: 'new.ts', oldPath: 'old.ts' }, { status: 'D', path: 'gone.ts' }]);
});

test('a worktree that is not a git repository cannot be snapshotted, and says so instead of returning an empty change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpm-audit-nogit-'));
  try {
    await assert.rejects(() => readSnapshot(exec, dir), /merge-base/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
