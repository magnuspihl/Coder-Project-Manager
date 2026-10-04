/** The hard-to-reverse facts come from the diff and package.json, not from a model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHardToReverse } from './audit-facts.js';

const diffOf = (path: string, added: string[], removed: string[] = []) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n${removed.map(l => `-${l}`).join('\n')}${removed.length ? '\n' : ''}${added.map(l => `+${l}`).join('\n')}\n`;

const facts = (diff: string, packageJsons: Parameters<typeof computeHardToReverse>[0]['packageJsons'] = []) =>
  computeHardToReverse({ diff, packageJsons });

test('reports a new dependency, a version change and a removal from package.json', () => {
  const base = JSON.stringify({ dependencies: { express: '^4.0.0', old: '1.0.0' }, devDependencies: { tsx: '^4.0.0' } });
  const head = JSON.stringify({ dependencies: { express: '^5.0.0', fresh: '^2.1.0' }, devDependencies: { tsx: '^4.0.0' } });
  const out = facts('', [{ path: 'package.json', base, head }]).map(f => f.detail);
  assert.ok(out.includes('new dependency fresh@^2.1.0'));
  assert.ok(out.includes('express ^4.0.0 → ^5.0.0 (dependencies)'));
  assert.ok(out.includes('removed old@1.0.0 (dependencies)'));
  assert.equal(out.length, 3);
});

test('a package.json that is not valid JSON is reported as not enumerated rather than as no change', () => {
  const out = facts('', [{ path: 'package.json', base: '{}', head: '{ nope' }]);
  assert.match(out[0].detail, /could not be parsed/);
});

test('a brand-new package.json lists all of its dependencies as new', () => {
  const out = facts('', [{ path: 'tools/package.json', base: null, head: JSON.stringify({ dependencies: { zod: '^3' } }) }]);
  assert.deepEqual(out.map(f => f.detail), ['new dependency zod@^3']);
});

test('flags schema and migration files and ALTER/CREATE statements added in code', () => {
  const sql = facts(diffOf('server/db/schema.sql', ['CREATE TABLE x (id TEXT);']));
  assert.deepEqual(sql.map(f => [f.kind, f.file]), [['schema', 'server/db/schema.sql']]);
  const code = facts(diffOf('server/db/index.ts', ['  db.exec("ALTER TABLE tasks ADD COLUMN audit INTEGER");']));
  assert.equal(code[0].kind, 'schema');
  assert.match(code[0].detail, /ADD COLUMN|ALTER TABLE/);
});

test('reports routes added and removed, and MCP tools registered', () => {
  const out = facts(
    diffOf('server/routes/tasks.ts', ["router.post('/tasks/:taskId/audit', requireAuth, h);"], ["router.get('/tasks/:taskId/old', h);"]) +
    diffOf('server/mcp/index.ts', ["  server.registerTool(", "    'audit',"]),
  ).map(f => `${f.kind}: ${f.detail}`);
  assert.ok(out.includes('route: route added: POST /tasks/:taskId/audit'));
  assert.ok(out.includes('route: route removed: GET /tasks/:taskId/old'));
  assert.ok(out.includes('mcp_tool: MCP tool registered: audit'));
});

test('reports an env var only when the change introduces it, not when it was already read', () => {
  const out = facts(diffOf('server/x.ts',
    ['const a = process.env.BRAND_NEW;', 'const b = process.env.ALREADY;'],
    ['const b = process.env.ALREADY;'])).filter(f => f.kind === 'env_var');
  assert.deepEqual(out.map(f => f.detail), ['reads env var BRAND_NEW']);
});

test('test files, lockfiles and generated output do not produce route, env or schema facts', () => {
  const out = facts(
    diffOf('server/x.test.ts', ["app.get('/t', h);", 'process.env.ONLY_IN_TEST;', 'CREATE TABLE t (id);']) +
    diffOf('package-lock.json', ['"CREATE TABLE": 1']),
  );
  assert.deepEqual(out, []);
});

test('facts have stable unique ids and come grouped dependency, schema, route, tool, env', () => {
  const out = facts(
    diffOf('a.ts', ['process.env.Z_VAR;', "router.get('/z', h);"]),
    [{ path: 'package.json', base: '{}', head: JSON.stringify({ dependencies: { a: '1' } }) }],
  );
  assert.deepEqual(out.map(f => f.kind), ['dependency', 'route', 'env_var']);
  assert.equal(new Set(out.map(f => f.id)).size, out.length);
});
