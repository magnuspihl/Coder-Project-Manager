-- Users table: caches Coder user info for display purposes
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  email TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
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
  branch TEXT,
  model TEXT,
  claude_account_id TEXT,
  pending_complete INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  client_label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status ON tasks(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace_position ON tasks(workspace_id, position);

-- Task turns table: tracks each implementer/reviewer turn within a task
CREATE TABLE IF NOT EXISTS task_turns (
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
);

CREATE INDEX IF NOT EXISTS idx_task_turns_task ON task_turns(task_id, turn_number);

-- Review findings: one row per issue in a reviewer's fail verdict, so each can
-- be triaged individually. task_turns.review_issues remains the verbatim
-- verdict payload; this is the actionable copy. 'dismissed' rows are replayed
-- into every later reviewer prompt as a waiver list — the reviewer runs a fresh
-- session each pass, so this table is its only memory of the user's decisions.
CREATE TABLE IF NOT EXISTS review_findings (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES task_turns(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'fixing', 'dismissed', 'resolved')),
  note TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_review_findings_task ON review_findings(task_id);
CREATE INDEX IF NOT EXISTS idx_review_findings_turn ON review_findings(turn_id, position);

-- Messages table: conversation history per task
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  cost REAL,
  username TEXT,
  source TEXT,
  client_label TEXT,
  turn_id TEXT REFERENCES task_turns(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, created_at);

-- Token events table: one row per token-usage delta as a Claude session
-- streams, so consumers can attribute tokens to a rolling time window instead
-- of only the cumulative per-task totals on the tasks row.
CREATE TABLE IF NOT EXISTS token_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_creation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_token_events_workspace ON token_events(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_token_events_task ON token_events(task_id, created_at);

-- Stream log table: persisted Claude output log per task
CREATE TABLE IF NOT EXISTS stream_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_stream_log_task ON stream_log(task_id, id);

-- Discussions table: persistent per-workspace chat sessions
CREATE TABLE IF NOT EXISTS discussions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  claude_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  project_dir TEXT,
  full_access INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  ssh_pid INTEGER,
  source TEXT,
  client_label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_discussions_workspace ON discussions(workspace_id, status);

-- Discussion messages table: conversation history per discussion
CREATE TABLE IF NOT EXISTS discussion_messages (
  id TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  cost REAL,
  username TEXT,
  source TEXT,
  client_label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (discussion_id) REFERENCES discussions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_discussion_messages ON discussion_messages(discussion_id, created_at);

-- Task requests: proposed tasks emitted from a discussion OR a task session.
-- Exactly one of discussion_id / task_id identifies the origin.
CREATE TABLE IF NOT EXISTS task_requests (
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
);

CREATE INDEX IF NOT EXISTS idx_task_requests_discussion ON task_requests(discussion_id, status);
-- idx_task_requests_task is created in the migration code (db/index.ts) after
-- task_id is guaranteed to exist: on legacy DBs the column is added by a later
-- migration, and schema.sql runs before migrations — indexing it here would
-- throw "no such column: task_id" and abort startup.

-- Discussion participants: additional workspace agents in a discussion
CREATE TABLE IF NOT EXISTS discussion_participants (
  id TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  claude_session_id TEXT,
  project_dir TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (discussion_id) REFERENCES discussions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_disc_participants ON discussion_participants(discussion_id, status);

-- Task participants: additional workspace agents invited to a task (advisory only)
CREATE TABLE IF NOT EXISTS task_participants (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  claude_session_id TEXT,
  project_dir TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_participants ON task_participants(task_id, status);

-- Workspace settings: persistent per-workspace configuration
CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id TEXT PRIMARY KEY,
  discussion_full_access INTEGER NOT NULL DEFAULT 0,
  preview_url TEXT,
  max_concurrent INTEGER NOT NULL DEFAULT 3,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Claude accounts: subscription credentials CPM can inject into a task, so the
-- Claude subscription a task burns is chosen by CPM rather than being fixed by
-- whatever `claude login` the target workspace happens to hold. Tokens are
-- minted with `claude setup-token` and stored encrypted (see services/secrets.ts).
-- Accounts are per-user and never shared: a token here is a bearer credential for
-- someone's paid subscription, and injecting one into a workspace hands it to
-- anyone with a shell there. Every query scopes by user_id for that reason.
CREATE TABLE IF NOT EXISTS claude_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL,
  token_enc TEXT NOT NULL,
  token_hint TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_claude_accounts_user ON claude_accounts(user_id);

-- Sessions table: server-side session storage
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  coder_access_token TEXT NOT NULL,
  coder_refresh_token TEXT,
  token_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_task_cost ON messages(task_id, cost) WHERE cost IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_deleted ON tasks(deleted_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace_deleted ON tasks(workspace_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Attachments: files uploaded with task prompts/replies ('user'), or produced
-- by an agent via an [OUTPUT_FILE] block for the user to download ('agent').
-- user_id is set at creation time (the uploader, or the task owner for an
-- agent-produced file) so /api/uploads/:id can enforce ownership even during
-- the brief window before task_id is linked — see the download route.
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  user_id TEXT,
  -- The message this file was attached to (a user upload) or produced by (an
  -- agent's [OUTPUT_FILE] block). Deliberately NOT a foreign key: a
  -- reconnect-after-restart replay deletes and recreates the current turn's
  -- assistant messages (see deleteCurrentSessionAssistantMessages), and an
  -- attachment must survive that — hasAgentOutputAttachment re-points it at
  -- the replayed message's new id rather than losing the link. NULL for
  -- attachments predating this column, or if somehow never associated.
  message_id TEXT,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user',
  -- sha256 of an agent-produced file's bytes (NULL for user uploads). Used to
  -- dedupe [OUTPUT_FILE] recaptures on the exact content, not just size — see
  -- hasAgentOutputAttachment in uploads.ts.
  content_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id);

-- Rate limit tracking, keyed by the SUBSCRIPTION the usage was billed to
-- (persists across server restarts). Session (five_hour) and weekly (seven_day)
-- limits are tracked separately.
--
-- subscription_key is 'acct:<claude_account_id>' when the task ran on a
-- CPM-held subscription, or 'ws:<workspace_name>' when it used the workspace's
-- own `claude login`. It was previously just the workspace name, which assumed
-- one subscription per workspace — no longer true now that a task can pick its
-- subscription, and two tasks on one workspace using different subscriptions
-- would otherwise overwrite each other's utilization.
CREATE TABLE IF NOT EXISTS rate_limits (
  subscription_key TEXT NOT NULL,
  type TEXT NOT NULL,
  utilization REAL NOT NULL DEFAULT 0,
  resets_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (subscription_key, type)
);
