/**
 * task_turns.review_outcome gained 'partial'. Pins the table rebuild on a legacy
 * database (rows, indexes and dependent findings survive), a fresh bootstrap, and
 * that the two end up with the same shape.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'cpm-migrations-'));
process.env.DATABASE_PATH = join(dir, 'fresh.db');

let Database: typeof import('better-sqlite3');
let mod: typeof import('./index.js');
let loadError: Error | null = null;

before(async () => {
  try {
    Database = (await import('better-sqlite3')).default as unknown as typeof import('better-sqlite3');
    mod = await import('./index.js');
    new Database(':memory:').close(); // fails here if the native module isn't built
  } catch (err) {
    loadError = err as Error;
  }
});
after(() => rmSync(dir, { recursive: true, force: true }));

const dbTest = (name: string, fn: () => void | Promise<void>) =>
  test(name, async t => { if (loadError) return t.skip(`database unavailable: ${loadError.message.slice(0, 80)}`); await fn(); });

/** A database as it was before 'partial': the old CHECK, with a finding hanging off a turn. */
function legacyDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY);
    CREATE TABLE task_turns (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('implementer', 'reviewer')),
      turn_number INTEGER NOT NULL,
      claude_session_id TEXT,
      review_outcome TEXT CHECK (review_outcome IN ('pass', 'fail', NULL)),
      review_summary TEXT,
      review_issues TEXT,
      review_mode TEXT,
      review_proofs TEXT,
      files_changed INTEGER,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX idx_task_turns_task ON task_turns(task_id, turn_number);
    CREATE TABLE review_findings (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES task_turns(id) ON DELETE CASCADE,
      body TEXT NOT NULL
    );
    INSERT INTO tasks (id) VALUES ('t1');
    INSERT INTO task_turns (id, task_id, role, turn_number, review_outcome, review_summary, review_issues, review_mode, review_proofs, files_changed, completed_at) VALUES
      ('impl', 't1', 'implementer', 1, NULL, NULL, NULL, NULL, NULL, 2, '2026-01-01T00:00:00Z'),
      ('pass', 't1', 'reviewer', 2, 'pass', 'fine', NULL, 'proof', '{"mode":"proof","proofs":[]}', 1, '2026-01-01T00:01:00Z'),
      ('fail', 't1', 'reviewer', 3, 'fail', 'bad', '["x"]', 'opinion', NULL, 1, '2026-01-01T00:02:00Z'),
      ('open', 't1', 'reviewer', 4, NULL, NULL, NULL, NULL, NULL, 1, NULL);
    INSERT INTO review_findings (id, task_id, turn_id, body) VALUES ('f1', 't1', 'fail', 'x');
  `);
  return db;
}

dbTest('migrates an existing database: pass/fail/unfinished rows and their findings survive the rebuild', () => {
  const db = legacyDb();
  const before = db.prepare('SELECT * FROM task_turns ORDER BY turn_number').all();
  // (The old `IN ('pass','fail',NULL)` check is NULL for any other value, so it never enforced anything.)
  db.prepare("UPDATE task_turns SET review_outcome = 'bogus' WHERE id = 'open'").run();
  db.prepare("UPDATE task_turns SET review_outcome = NULL WHERE id = 'open'").run();

  assert.equal(mod.widenTaskTurnOutcome(db), true);

  assert.deepEqual(db.prepare('SELECT * FROM task_turns ORDER BY turn_number').all(), before, 'every row copied verbatim');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM review_findings').get() as { n: number }).n, 1, 'findings were not cascade-deleted');
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='task_turns' AND name NOT LIKE 'sqlite_%'").all(), [{ name: 'idx_task_turns_task' }]);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'enforcement is back on');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.prepare("UPDATE task_turns SET review_outcome = 'partial' WHERE id = 'pass'").run();
  assert.equal((db.prepare("SELECT review_outcome AS o FROM task_turns WHERE id = 'pass'").get() as { o: string }).o, 'partial');
  assert.throws(() => db.prepare("UPDATE task_turns SET review_outcome = 'bogus' WHERE id = 'pass'").run(), /CHECK/, 'the rebuilt constraint really enforces the three values');
  db.close();
});

dbTest('running the migration again changes nothing', () => {
  const db = legacyDb();
  assert.equal(mod.widenTaskTurnOutcome(db), true);
  const snapshot = db.prepare('SELECT * FROM task_turns').all();
  assert.equal(mod.widenTaskTurnOutcome(db), false);
  assert.deepEqual(db.prepare('SELECT * FROM task_turns').all(), snapshot);
  db.close();
});

dbTest('a rebuild that fails rolls back and leaves the original table in place', () => {
  const db = legacyDb();
  db.exec('ALTER TABLE task_turns DROP COLUMN review_proofs'); // the rebuild refuses to guess
  assert.throws(() => mod.widenTaskTurnOutcome(db), /missing review_proofs/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM task_turns').get() as { n: number }).n, 4);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  db.close();
});

dbTest('a fresh install bootstraps and allows partial without any rebuild', () => {
  const db = mod.getDb();
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='task_turns'").get() as { sql: string }).sql;
  assert.match(sql, /'partial'/);
  assert.equal(mod.widenTaskTurnOutcome(db), false);
  db.prepare("INSERT INTO users (id, username) VALUES ('u', 'x')").run();
  db.prepare("INSERT INTO tasks (id, workspace_id, workspace_name, user_id, prompt, position) VALUES ('t', 'w', 'w', 'u', 'p', 1)").run();
  db.prepare("INSERT INTO task_turns (id, task_id, role, turn_number, review_outcome) VALUES ('x', 't', 'reviewer', 1, 'partial')").run();
  assert.throws(() => db.prepare("INSERT INTO task_turns (id, task_id, role, turn_number, review_outcome) VALUES ('y', 't', 'reviewer', 2, 'bogus')").run(), /CHECK/);
});

dbTest('a migrated database ends up with the same task_turns shape as a fresh one', () => {
  const shape = (db: import('better-sqlite3').Database) => ({
    columns: db.prepare("SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info('task_turns') ORDER BY name").all(),
    indexes: db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='task_turns' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(),
    outcomeCheck: ((db.prepare("SELECT sql FROM sqlite_master WHERE name='task_turns'").get() as { sql: string }).sql.match(/review_outcome[^,]*CHECK \([^)]*\)/) ?? [''])[0].replace(/\s+/g, ' '),
  });
  const migrated = legacyDb();
  mod.widenTaskTurnOutcome(migrated);
  assert.deepEqual(shape(migrated), shape(mod.getDb()));
  migrated.close();
});
