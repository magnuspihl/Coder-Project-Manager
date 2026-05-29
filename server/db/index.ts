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

    if (!cols.some(c => c.name === 'branch')) {
      db.exec("ALTER TABLE tasks ADD COLUMN branch TEXT");
    }
    if (!cols.some(c => c.name === 'git_branch')) {
      db.exec("ALTER TABLE tasks ADD COLUMN git_branch TEXT");
    }
    if (!cols.some(c => c.name === 'github_repo_url')) {
      db.exec("ALTER TABLE tasks ADD COLUMN github_repo_url TEXT");
    }
    if (!cols.some(c => c.name === 'model')) {
      db.exec("ALTER TABLE tasks ADD COLUMN model TEXT");
    }

    // Discussions migrations
    const discCols = db.prepare("PRAGMA table_info(discussions)").all() as Array<{ name: string }>;
    if (!discCols.some(c => c.name === 'full_access')) {
      db.exec("ALTER TABLE discussions ADD COLUMN full_access INTEGER NOT NULL DEFAULT 0");
    }
    if (!discCols.some(c => c.name === 'model')) {
      db.exec("ALTER TABLE discussions ADD COLUMN model TEXT");
    }

    // Messages migrations
    const msgCols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    if (!msgCols.some(c => c.name === 'username')) {
      db.exec("ALTER TABLE messages ADD COLUMN username TEXT");
    }
    if (!msgCols.some(c => c.name === 'participant_id')) {
      db.exec("ALTER TABLE messages ADD COLUMN participant_id TEXT");
    }

    if (!cols.some(c => c.name === 'caveman')) {
      db.exec("ALTER TABLE tasks ADD COLUMN caveman TEXT");
    }

    // Workspace settings migrations
    const wsCols = db.prepare("PRAGMA table_info(workspace_settings)").all() as Array<{ name: string }>;
    if (!wsCols.some(c => c.name === 'git_push_enabled')) {
      db.exec("ALTER TABLE workspace_settings ADD COLUMN git_push_enabled INTEGER NOT NULL DEFAULT 1");
    }

    if (!wsCols.some(c => c.name === 'last_active_task_id')) {
      db.exec("ALTER TABLE workspace_settings ADD COLUMN last_active_task_id TEXT");
    }

    if (!wsCols.some(c => c.name === 'voice_ids')) {
      db.exec("ALTER TABLE workspace_settings ADD COLUMN voice_ids TEXT");
    }

    if (!wsCols.some(c => c.name === 'preview_url')) {
      db.exec("ALTER TABLE workspace_settings ADD COLUMN preview_url TEXT");
    }

    if (!wsCols.some(c => c.name === 'default_voice_id')) {
      db.exec("ALTER TABLE workspace_settings ADD COLUMN default_voice_id TEXT");
      // Migrate: single-kokoro voice_ids entries were auto-assigned defaults —
      // move them to default_voice_id and clear voice_ids so they don't show
      // as user selections.
      db.exec(`
        UPDATE workspace_settings
        SET default_voice_id = json_extract(voice_ids, '$[0]'),
            voice_ids = NULL
        WHERE voice_ids IS NOT NULL
          AND json_array_length(voice_ids) = 1
          AND json_extract(voice_ids, '$[0]') LIKE 'kokoro:%'
      `);
    }

    // Discussion messages migrations
    const dmCols = db.prepare("PRAGMA table_info(discussion_messages)").all() as Array<{ name: string }>;
    if (!dmCols.some(c => c.name === 'participant_id')) {
      db.exec("ALTER TABLE discussion_messages ADD COLUMN participant_id TEXT");
    }

    // Task requests migrations: cross-workspace task suggestions
    const trCols = db.prepare("PRAGMA table_info(task_requests)").all() as Array<{ name: string }>;
    if (!trCols.some(c => c.name === 'target_workspace_id')) {
      db.exec("ALTER TABLE task_requests ADD COLUMN target_workspace_id TEXT");
    }
    if (!trCols.some(c => c.name === 'target_workspace_name')) {
      db.exec("ALTER TABLE task_requests ADD COLUMN target_workspace_name TEXT");
    }

    // Play-on-open: track last time each discussion/task was opened
    if (!discCols.some(c => c.name === 'last_opened_at')) {
      db.exec("ALTER TABLE discussions ADD COLUMN last_opened_at TEXT");
    }

    // Re-read tasks cols in case they were modified above
    const tasksCols2 = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!tasksCols2.some(c => c.name === 'last_opened_at')) {
      db.exec("ALTER TABLE tasks ADD COLUMN last_opened_at TEXT");
    }
    if (!tasksCols2.some(c => c.name === 'pending_complete')) {
      db.exec("ALTER TABLE tasks ADD COLUMN pending_complete INTEGER NOT NULL DEFAULT 0");
    }
    // session_initialized: 1 when the current claude_session_id has been used by
    // Claude (so --resume works); 0 immediately after a session reset, before
    // the first launch. Default 1 so pre-existing tasks behave as before.
    if (!tasksCols2.some(c => c.name === 'session_initialized')) {
      db.exec("ALTER TABLE tasks ADD COLUMN session_initialized INTEGER NOT NULL DEFAULT 1");
    }

    // Provenance migrations — track which client originated each row (UI vs. API).
    const tasksCols3 = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!tasksCols3.some(c => c.name === 'source')) {
      db.exec("ALTER TABLE tasks ADD COLUMN source TEXT");
    }
    if (!tasksCols3.some(c => c.name === 'client_label')) {
      db.exec("ALTER TABLE tasks ADD COLUMN client_label TEXT");
    }
    const discCols2 = db.prepare("PRAGMA table_info(discussions)").all() as Array<{ name: string }>;
    if (!discCols2.some(c => c.name === 'source')) {
      db.exec("ALTER TABLE discussions ADD COLUMN source TEXT");
    }
    if (!discCols2.some(c => c.name === 'client_label')) {
      db.exec("ALTER TABLE discussions ADD COLUMN client_label TEXT");
    }
    const msgCols2 = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    if (!msgCols2.some(c => c.name === 'source')) {
      db.exec("ALTER TABLE messages ADD COLUMN source TEXT");
    }
    if (!msgCols2.some(c => c.name === 'client_label')) {
      db.exec("ALTER TABLE messages ADD COLUMN client_label TEXT");
    }
    const dmCols2 = db.prepare("PRAGMA table_info(discussion_messages)").all() as Array<{ name: string }>;
    if (!dmCols2.some(c => c.name === 'source')) {
      db.exec("ALTER TABLE discussion_messages ADD COLUMN source TEXT");
    }
    if (!dmCols2.some(c => c.name === 'client_label')) {
      db.exec("ALTER TABLE discussion_messages ADD COLUMN client_label TEXT");
    }

    // Enforce one-working-task-per-workspace at the DB level. If the DB is
    // inconsistent (leftover working tasks from a crash), mark all but the
    // most recent as failed so the unique index can apply cleanly.
    try {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_one_working_per_workspace
          ON tasks(workspace_id)
          WHERE status = 'working' AND deleted_at IS NULL
      `);
    } catch {
      console.warn('[db] Duplicate working tasks detected — demoting older ones to failed.');
      db.exec(`
        UPDATE tasks SET status = 'failed', failed_reason = 'Orphaned: multiple working tasks on same workspace detected at startup.'
        WHERE id IN (
          SELECT id FROM tasks t1
          WHERE status = 'working' AND deleted_at IS NULL
            AND EXISTS (
              SELECT 1 FROM tasks t2
              WHERE t2.workspace_id = t1.workspace_id
                AND t2.status = 'working' AND t2.deleted_at IS NULL
                AND t2.updated_at > t1.updated_at
            )
        )
      `);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_one_working_per_workspace
          ON tasks(workspace_id)
          WHERE status = 'working' AND deleted_at IS NULL
      `);
    }
  }
  return db;
}
