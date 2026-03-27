import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.DATABASE_PATH || join(__dirname, '../../data/cpm.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('cache_size = -8000'); // 8MB cache

    const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
    db.exec(schema);

    // Migrations
    const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'project_dir')) {
      db.exec("ALTER TABLE tasks ADD COLUMN project_dir TEXT");
    }
    if (!cols.some(c => c.name === 'title')) {
      db.exec("ALTER TABLE tasks ADD COLUMN title TEXT NOT NULL DEFAULT 'Untitled task'");
    }
    if (!cols.some(c => c.name === 'ssh_pid')) {
      db.exec("ALTER TABLE tasks ADD COLUMN ssh_pid INTEGER");
    }
    if (!cols.some(c => c.name === 'verification_url')) {
      db.exec("ALTER TABLE tasks ADD COLUMN verification_url TEXT");
    }
    if (!cols.some(c => c.name === 'deleted_at')) {
      db.exec("ALTER TABLE tasks ADD COLUMN deleted_at TEXT");
    }
    if (!cols.some(c => c.name === 'total_input_tokens')) {
      db.exec("ALTER TABLE tasks ADD COLUMN total_input_tokens INTEGER NOT NULL DEFAULT 0");
    }
    if (!cols.some(c => c.name === 'total_output_tokens')) {
      db.exec("ALTER TABLE tasks ADD COLUMN total_output_tokens INTEGER NOT NULL DEFAULT 0");
    }

    // Migrate tasks CHECK constraint to include 'cancelled' status
    const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string } | undefined;
    if (tableInfo && !tableInfo.sql.includes("'cancelled'")) {
      db.exec("PRAGMA foreign_keys=OFF");
      db.exec(`
        CREATE TABLE tasks_new (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          workspace_name TEXT NOT NULL,
          user_id TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT 'Untitled task',
          prompt TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued'
            CHECK (status IN ('queued', 'working', 'awaiting_feedback', 'completed', 'failed', 'cancelled')),
          position INTEGER NOT NULL,
          project_dir TEXT,
          claude_session_id TEXT,
          failed_reason TEXT,
          verification_url TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          deleted_at TEXT,
          ssh_pid INTEGER,
          total_input_tokens INTEGER NOT NULL DEFAULT 0,
          total_output_tokens INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);
      db.exec("INSERT INTO tasks_new SELECT id, workspace_id, workspace_name, user_id, title, prompt, status, position, project_dir, claude_session_id, failed_reason, verification_url, created_at, updated_at, completed_at, deleted_at, ssh_pid, total_input_tokens, total_output_tokens FROM tasks");
      db.exec("DROP TABLE tasks");
      db.exec("ALTER TABLE tasks_new RENAME TO tasks");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status ON tasks(workspace_id, status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_workspace_position ON tasks(workspace_id, position)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_deleted ON tasks(deleted_at)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_workspace_deleted ON tasks(workspace_id, deleted_at)");
      db.exec("PRAGMA foreign_keys=ON");
    }

    if (!cols.some(c => c.name === 'git_branch')) {
      db.exec("ALTER TABLE tasks ADD COLUMN git_branch TEXT");
    }
    if (!cols.some(c => c.name === 'github_repo_url')) {
      db.exec("ALTER TABLE tasks ADD COLUMN github_repo_url TEXT");
    }

    // Messages migrations
    const msgCols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    if (!msgCols.some(c => c.name === 'username')) {
      db.exec("ALTER TABLE messages ADD COLUMN username TEXT");
    }
  }
  return db;
}
