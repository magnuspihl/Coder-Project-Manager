import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

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
    if (!cols.some(c => c.name === 'git_provider')) {
      db.exec("ALTER TABLE tasks ADD COLUMN git_provider TEXT");
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
    // Convergence: task_requests may now originate from a task as well as a
    // discussion. Rebuild the table to make discussion_id nullable and add a
    // nullable task_id (SQLite can't relax NOT NULL via ALTER).
    const trColsFull = db.prepare("PRAGMA table_info(task_requests)").all() as Array<{ name: string; notnull: number }>;
    const discIdCol = trColsFull.find(c => c.name === 'discussion_id');
    if (discIdCol && discIdCol.notnull === 1) {
      db.exec("PRAGMA foreign_keys=OFF");
      db.exec(`
        CREATE TABLE task_requests_new (
          id TEXT PRIMARY KEY,
          discussion_id TEXT,
          task_id TEXT,
          prompt TEXT NOT NULL,
          branch TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'created', 'dismissed')),
          created_task_id TEXT,
          target_workspace_id TEXT,
          target_workspace_name TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (discussion_id) REFERENCES discussions(id) ON DELETE CASCADE,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
          FOREIGN KEY (created_task_id) REFERENCES tasks(id)
        )
      `);
      db.exec("INSERT INTO task_requests_new (id, discussion_id, prompt, branch, status, created_task_id, target_workspace_id, target_workspace_name, created_at) SELECT id, discussion_id, prompt, branch, status, created_task_id, target_workspace_id, target_workspace_name, created_at FROM task_requests");
      db.exec("DROP TABLE task_requests");
      db.exec("ALTER TABLE task_requests_new RENAME TO task_requests");
      db.exec("CREATE INDEX IF NOT EXISTS idx_task_requests_discussion ON task_requests(discussion_id, status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_task_requests_task ON task_requests(task_id, status)");
      db.exec("PRAGMA foreign_keys=ON");
    }
    // Create the task_id index once the column exists (fresh DBs get task_id
    // from schema.sql; legacy DBs got it from the rebuild above). Kept out of
    // schema.sql because that runs before migrations add the column.
    const trColsAfter = db.prepare("PRAGMA table_info(task_requests)").all() as Array<{ name: string }>;
    if (trColsAfter.some(c => c.name === 'task_id')) {
      db.exec("CREATE INDEX IF NOT EXISTS idx_task_requests_task ON task_requests(task_id, status)");
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

    // Worktree + parallel execution migrations
    const tasksCols4 = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!tasksCols4.some(c => c.name === 'worktree_path')) {
      db.exec("ALTER TABLE tasks ADD COLUMN worktree_path TEXT");
    }
    if (!tasksCols4.some(c => c.name === 'port_range_start')) {
      db.exec("ALTER TABLE tasks ADD COLUMN port_range_start INTEGER");
    }

    const wsCols2 = db.prepare("PRAGMA table_info(workspace_settings)").all() as Array<{ name: string }>;
    if (!wsCols2.some(c => c.name === 'max_concurrent')) {
      db.exec("ALTER TABLE workspace_settings ADD COLUMN max_concurrent INTEGER NOT NULL DEFAULT 3");
    }

    const discCols3 = db.prepare("PRAGMA table_info(discussions)").all() as Array<{ name: string }>;
    if (!discCols3.some(c => c.name === 'worktree_path')) {
      db.exec("ALTER TABLE discussions ADD COLUMN worktree_path TEXT");
    }

    // Drop the one-working-per-workspace constraint — replaced by configurable max_concurrent
    db.exec("DROP INDEX IF EXISTS idx_tasks_one_working_per_workspace");

    // Demote pre-upgrade working/awaiting_feedback tasks that have no worktree_path
    db.exec(`
      UPDATE tasks
      SET status = 'failed',
          failed_reason = 'Server upgraded to parallel execution. Please retry.'
      WHERE status IN ('working', 'awaiting_feedback')
        AND worktree_path IS NULL
        AND deleted_at IS NULL
    `);
  }

  // Auto-review migrations
  const tasksCols5 = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!tasksCols5.some(c => c.name === 'auto_review')) {
    db.exec("ALTER TABLE tasks ADD COLUMN auto_review INTEGER NOT NULL DEFAULT 1");
  }
  if (!tasksCols5.some(c => c.name === 'review_loop_count')) {
    db.exec("ALTER TABLE tasks ADD COLUMN review_loop_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!tasksCols5.some(c => c.name === 'active_turn_role')) {
    db.exec("ALTER TABLE tasks ADD COLUMN active_turn_role TEXT");
  }

  db.exec(`CREATE TABLE IF NOT EXISTS task_turns (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('implementer', 'reviewer')),
    turn_number INTEGER NOT NULL,
    claude_session_id TEXT,
    review_outcome TEXT CHECK (review_outcome IN ('pass', 'fail', NULL)),
    review_summary TEXT,
    review_issues TEXT,
    files_changed INTEGER,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_turns_task ON task_turns(task_id, turn_number)");

  const msgCols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  if (!msgCols.some(c => c.name === 'turn_id')) {
    db.exec("ALTER TABLE messages ADD COLUMN turn_id TEXT REFERENCES task_turns(id)");
  }

  migrateDiscussionsToTasks(db);

  return db;
}

/**
 * Convergence: Chat (discussions) has been collapsed into Tasks. Convert any
 * still-active discussion with at least one message into a task that carries
 * its session, messages, and participants. Worktree-backed discussions become
 * resumable `awaiting_feedback` tasks; the rest become `completed` (read-only
 * history) since the parallel-execution model requires a worktree to resume.
 *
 * Idempotent: migrated discussions are marked closed and skipped on re-run, and
 * we skip any discussion whose session already backs a task. Discussion tables
 * are intentionally left intact (not dropped) for safety/reversibility.
 */
function migrateDiscussionsToTasks(db: Database.Database): void {
  // Older DBs may predate some discussion columns; guard the whole pass.
  const discCols = db.prepare("PRAGMA table_info(discussions)").all() as Array<{ name: string }>;
  if (discCols.length === 0) return;

  const active = db.prepare(`
    SELECT * FROM discussions d
    WHERE d.status = 'active'
      AND EXISTS (SELECT 1 FROM discussion_messages m WHERE m.discussion_id = d.id)
  `).all() as Array<{
    id: string; workspace_id: string; workspace_name: string; user_id: string;
    claude_session_id: string | null; project_dir: string | null; model: string | null;
    worktree_path: string | null; source: string | null; client_label: string | null;
    created_at: string;
  }>;
  if (active.length === 0) return;

  const run = db.transaction(() => {
    for (const d of active) {
      if (d.claude_session_id) {
        const existing = db.prepare('SELECT id FROM tasks WHERE claude_session_id = ?').get(d.claude_session_id);
        if (existing) {
          db.prepare("UPDATE discussions SET status = 'closed' WHERE id = ?").run(d.id);
          continue;
        }
      }

      const msgs = db.prepare(
        'SELECT * FROM discussion_messages WHERE discussion_id = ? ORDER BY created_at ASC'
      ).all(d.id) as Array<{
        id: string; role: string; content: string; cost: number | null;
        username: string | null; source: string | null; client_label: string | null;
        participant_id: string | null; created_at: string;
      }>;

      const taskId = randomUUID();
      const firstUser = msgs.find(m => m.role === 'user');
      const prompt = (firstUser?.content ?? '(migrated chat)').trim() || '(migrated chat)';
      const title = (prompt.split('\n')[0].slice(0, 200) || 'Migrated chat');
      const pos = (db.prepare(
        'SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tasks WHERE workspace_id = ?'
      ).get(d.workspace_id) as { p: number }).p;
      const status = d.worktree_path ? 'awaiting_feedback' : 'completed';

      db.prepare(`
        INSERT INTO tasks (
          id, workspace_id, workspace_name, user_id, title, prompt, status, position,
          project_dir, claude_session_id, model, worktree_path, source, client_label,
          created_at, updated_at, completed_at, auto_review, session_initialized
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, 0, 1)
      `).run(
        taskId, d.workspace_id, d.workspace_name, d.user_id, title, prompt, status, pos,
        d.project_dir, d.claude_session_id, d.model, d.worktree_path, d.source, d.client_label,
        d.created_at, status === 'completed' ? new Date().toISOString() : null,
      );

      // Recreate participants, mapping old discussion-participant ids → new task ids.
      const participants = db.prepare(
        'SELECT * FROM discussion_participants WHERE discussion_id = ?'
      ).all(d.id) as Array<{
        id: string; workspace_id: string; workspace_name: string;
        claude_session_id: string | null; project_dir: string | null; status: string; created_at: string;
      }>;
      const idMap = new Map<string, string>();
      for (const p of participants) {
        const newId = randomUUID();
        idMap.set(p.id, newId);
        db.prepare(`
          INSERT INTO task_participants (
            id, task_id, workspace_id, workspace_name, claude_session_id, project_dir, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(newId, taskId, p.workspace_id, p.workspace_name, p.claude_session_id, p.project_dir, p.status, p.created_at);
      }

      const insertMsg = db.prepare(`
        INSERT INTO messages (
          id, task_id, role, content, cost, username, source, client_label, participant_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const m of msgs) {
        const mappedParticipant = m.participant_id ? (idMap.get(m.participant_id) ?? null) : null;
        insertMsg.run(
          randomUUID(), taskId, m.role, m.content, m.cost, m.username,
          m.source, m.client_label, mappedParticipant, m.created_at,
        );
      }

      db.prepare("UPDATE discussions SET status = 'closed' WHERE id = ?").run(d.id);
      console.log(`[migration] Converted discussion ${d.id} → task ${taskId} (${status}, ${msgs.length} messages, ${participants.length} participants)`);
    }
  });
  run();
}
