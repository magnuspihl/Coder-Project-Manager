# Coder Project Manager — Technical Specification

## 1. Overview

Coder Project Manager is a web application that provides a task queue and conversational interface for Claude Code agents running inside Coder workspaces. It acts as a thin orchestration layer: users queue tasks, the app executes them via Claude Code inside the appropriate workspace, and users can review results and iterate conversationally.

### Core User Flow

1. User logs in via Coder OAuth2
2. User sees a list of their Coder workspaces
3. User navigates into a workspace and sees its task queue
4. User creates a new task (e.g., "Fix the flaky test in auth_test.go")
5. The app executes the task by running Claude Code inside that workspace via SSH
6. Claude works autonomously; output streams to the UI in real-time
7. When Claude finishes, the task enters "awaiting feedback" state
8. User reviews the result and either:
   - Replies with feedback (e.g., "There's not enough margin on the left") — Claude resumes with full context
   - Marks the task as complete — the next queued task starts
9. This cycle repeats until the queue is empty

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Browser (React)                    │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ Workspace   │  │  Task Queue  │  │   Task      │  │
│  │ List        │→ │  View        │→ │   Chat View │  │
│  └─────────────┘  └──────────────┘  └────────────┘  │
│          │                │                │          │
│          └────────────────┼────────────────┘          │
│                      WebSocket + REST                 │
└──────────────────────────┬────────────────────────────┘
                           │
┌──────────────────────────┴────────────────────────────┐
│                Express Server (Node.js)                │
│  ┌──────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ Auth     │  │ Task Queue   │  │ Claude Executor  │  │
│  │ (OAuth2) │  │ Service      │  │ Service          │  │
│  └────┬─────┘  └──────┬───────┘  └────────┬────────┘  │
│       │               │                    │           │
│  ┌────┴───────────────┴────────────────────┴────────┐  │
│  │              SQLite Database                      │  │
│  └───────────────────────────────────────────────────┘  │
└──────────┬────────────────────────────────┬────────────┘
           │                                │
    ┌──────┴──────┐                  ┌──────┴──────────┐
    │  Coder API  │                  │  Coder SSH      │
    │  (REST)     │                  │  (workspace     │
    │             │                  │   exec)         │
    └─────────────┘                  └────────┬────────┘
                                              │
                                     ┌────────┴────────┐
                                     │  Claude Code    │
                                     │  (inside        │
                                     │   workspace)    │
                                     └─────────────────┘
```

### Component Responsibilities

| Component | Responsibility |
|---|---|
| **React Client** | UI for workspace selection, task management, and chat-style task interaction |
| **Express Server** | API routes, OAuth2 flow, task queue orchestration, WebSocket management |
| **Auth Service** | Handles Coder OAuth2 login, token storage (in-memory/session), token refresh |
| **Task Queue Service** | CRUD for tasks, ordering, state transitions, auto-advancing to next task |
| **Claude Executor Service** | Spawns `coder ssh` processes to run Claude Code, streams output, manages sessions |
| **SQLite Database** | Persists tasks, conversation messages, and user sessions |
| **Coder API** | Lists workspaces, provides workspace metadata (status, agents, etc.) |
| **Coder SSH** | Executes Claude Code commands inside target workspaces |

---

## 3. Task State Machine

```
                    ┌──────────┐
                    │  queued   │
                    └────┬─────┘
                         │ (previous task completes or queue is empty)
                         ▼
                    ┌──────────┐
              ┌────→│ working   │←────────────┐
              │     └────┬─────┘              │
              │          │ (claude finishes)   │
              │          ▼                     │
              │  ┌───────────────────┐         │
              │  │ awaiting_feedback │         │
              │  └───────┬──────────┘         │
              │          │                     │
              │    ┌─────┴──────┐              │
              │    ▼            ▼              │
              │  (user       (user marks       │
              │  replies)    complete)          │
              │    │            │               │
              │    │            ▼               │
              └────┘     ┌───────────┐         │
                         │ completed  │         │
                         └────────────┘         │
                                                │
                    ┌──────────┐                │
                    │  failed   │ (error during execution)
                    └──────────┘
```

### State Definitions

| State | Description |
|---|---|
| `queued` | Task is waiting to be executed. Ordered by position in queue. |
| `working` | Claude Code is actively running for this task. |
| `awaiting_feedback` | Claude finished. User can reply or mark complete. |
| `completed` | Task is done. No further action needed. |
| `failed` | Execution failed (SSH error, workspace offline, Claude error). Can be retried. |

### Rules

- Only **one task per workspace** can be in `working` state at a time.
- When a task transitions to `completed`, the queue service automatically starts the next `queued` task for that workspace (if any).
- When a user replies to an `awaiting_feedback` task, it transitions back to `working` and Claude resumes the session.
- A `failed` task can be retried (re-queued) by the user.
- Users can reorder `queued` tasks.
- Users can cancel a `queued` task (deletes it) or cancel a `working` task (kills the process, sets to `failed`).

### Scheduled wake-ups (long-running work)

A turn *is* the process: `claude -p` exits when the agent stops writing, so anything still attached to that
session (background shells, subagents) dies with it, and a finished turn is the agent's last word until
someone speaks to it. That made "I'll report back when the build finishes" impossible to honour — the user
had to poll, and every poll cost a full resume turn.

An agent can therefore schedule its own resume by emitting a `[WAKE]` block (see `BACKGROUND_WORK_PROMPT`):

```
[WAKE]
{"after": "15m", "when_file": "/tmp/job.done", "note": "read /tmp/job.log and report to the user"}
[/WAKE]
```

- Parsed out of the agent's own output into `tasks.wake_at` / `wake_note` / `wake_file`.
- `processPendingWakes` (every `CPM_WAKE_POLL_INTERVAL_MS`, default 30s) resumes the task from
  `awaiting_feedback` once `wake_file` exists on the workspace, or `wake_at` passes — whichever is first.
  A failed sentinel probe (workspace stopped) backs off for 5 minutes; the `after` deadline still applies.
- The wake is **not sticky**: it is cleared when the turn starts, so the agent must re-emit it each turn it
  wants another. `wake_count` additionally caps consecutive wake-ups taken without user input
  (`CPM_MAX_AUTO_WAKES`, default 12) and is reset whenever the user replies.
- Replying implicitly cancels a pending wake-up. The user can also fire it early or cancel it outright
  (`POST` / `DELETE /api/tasks/:taskId/wake`).
- Work that must survive the turn has to be detached with `setsid` — `nohup` alone leaves it in the SSH
  session's process group, which is torn down when the turn ends.

---

## 4. Coder API Integration

### Authentication: OAuth2

Coder supports acting as an OAuth2 authorization server (experimental feature — must be enabled with `--experiments oauth2` on the Coder deployment).

#### Setup (One-Time, by Coder Admin)

1. Enable the OAuth2 experiment on the Coder server
2. Register this app as an OAuth2 client:
   ```
   POST /api/v2/oauth2-provider/apps
   {
     "name": "Coder Project Manager",
     "callback_url": "https://<app-host>/auth/callback"
   }
   ```
3. Create a client secret:
   ```
   POST /api/v2/oauth2-provider/apps/{app_id}/secrets
   ```
4. Store the `client_id` and `client_secret` as environment variables for this app

#### OAuth2 Flow

1. **Login**: Redirect user to:
   ```
   GET {CODER_URL}/oauth2/authorize?
     client_id={CLIENT_ID}&
     response_type=code&
     redirect_uri={CALLBACK_URL}&
     code_challenge={PKCE_CHALLENGE}&
     code_challenge_method=S256
   ```
2. **Callback**: Exchange the authorization code for tokens:
   ```
   POST {CODER_URL}/oauth2/tokens
   Content-Type: application/x-www-form-urlencoded
   Authorization: Basic base64(CLIENT_ID:CLIENT_SECRET)

   grant_type=authorization_code&
   code={AUTH_CODE}&
   code_verifier={PKCE_VERIFIER}&
   redirect_uri={CALLBACK_URL}
   ```
3. **Response**:
   ```json
   {
     "access_token": "...",
     "refresh_token": "...",
     "token_type": "Bearer",
     "expires_in": 86400
   }
   ```
4. **Store**: Keep the access token and refresh token in an encrypted HTTP-only session cookie. Never persist tokens to the database.
5. **Use**: All subsequent Coder API calls include `Coder-Session-Token: {access_token}` header.
6. **Refresh**: When the access token expires, use the refresh token to obtain a new one.

#### Important Note on OAuth2 Scope

Coder's OAuth2 implementation currently does **not support scopes** — all tokens grant full API access for the authenticated user. This is fine for our use case since we want the same permissions the user already has.

### Fallback: API Token Authentication

If Coder OAuth2 is not available (experiment not enabled), provide a fallback flow:

1. User pastes their Coder API token into the login page
2. App validates the token by calling `GET {CODER_URL}/api/v2/users/me`
3. Token is stored in an encrypted HTTP-only session cookie

This is simpler but less user-friendly. Support both flows.

### Listing Workspaces

```
GET {CODER_URL}/api/v2/workspaces
Headers:
  Coder-Session-Token: {access_token}

Response:
{
  "count": 3,
  "workspaces": [
    {
      "id": "uuid",
      "name": "my-project",
      "owner_name": "magnus",
      "template_name": "claude-dev",
      "latest_build": {
        "status": "running",
        "resources": [
          {
            "agents": [
              {
                "id": "agent-uuid",
                "name": "main",
                "status": "connected"
              }
            ]
          }
        ]
      },
      "last_used_at": "2026-03-18T10:00:00Z"
    }
  ]
}
```

Key fields to display:
- `name` — workspace name
- `template_name` — which template it's based on
- `latest_build.status` — running, stopped, starting, etc.
- Agent status — whether the workspace agent is connected (needed for SSH)
- `last_used_at` — for sorting

### Getting the Workspace Agent ID

To execute commands, you need the agent ID. Extract it from the workspace response:

```
workspace.latest_build.resources[].agents[].id
```

Filter for agents with `status: "connected"`.

---

## 5. Claude Code Execution

### Execution Model

Claude Code runs **inside the target workspace** via SSH. The app server spawns a child process:

```bash
coder ssh {workspace_name} -- claude -p "{task_prompt}" \
  --session-id {session_uuid} \
  --output-format stream-json \
  --allowedTools "Read,Edit,Write,Bash,Glob,Grep" \
  --max-turns 200
```

For follow-up messages (when user replies to `awaiting_feedback`):

```bash
coder ssh {workspace_name} -- claude -p "{user_feedback}" \
  --resume {session_uuid} \
  --output-format stream-json \
  --allowedTools "Read,Edit,Write,Bash,Glob,Grep" \
  --max-turns 200
```

### Coder SSH Authentication

The `coder ssh` command needs to authenticate with the Coder server. Set the environment for the child process:

```javascript
const child = spawn('coder', ['ssh', workspaceName, '--', 'claude', '-p', ...], {
  env: {
    ...process.env,
    CODER_URL: coderUrl,
    CODER_SESSION_TOKEN: userAccessToken,
  }
});
```

This ensures the SSH connection uses the user's own credentials — they can only access workspaces they have permission for.

### Streaming Output

With `--output-format stream-json`, Claude Code emits newline-delimited JSON events:

```json
{"type":"assistant","message":{"content":[{"type":"text","text":"I'll fix the flaky test..."}]}}
{"type":"tool_use","toolName":"Read","input":{"file_path":"/src/auth_test.go"}}
{"type":"tool_result","content":"...file contents..."}
{"type":"assistant","message":{"content":[{"type":"text","text":"I found the issue..."}]}}
{"type":"result","subtype":"stop","session_id":"uuid","cost":0.05}
```

The app server should:
1. Parse each line as JSON
2. Forward relevant events to the client via WebSocket
3. Store assistant messages in the database as conversation history
4. On `result` event, transition the task to `awaiting_feedback`

### What to Store vs. Stream

| Event Type | Stream to Client? | Store in DB? |
|---|---|---|
| `assistant` (text) | Yes | Yes — this is Claude's response |
| `tool_use` | Yes (summary) | No — too verbose |
| `tool_result` | No | No — too verbose |
| `result` | Yes (cost, session_id) | Yes — marks completion |
| `system` | No | No |

### Session ID Management

- Generate a UUID v4 when creating a task — this becomes its `claude_session_id`
- Store it in the tasks table
- Use `--session-id` on first run, `--resume` on subsequent runs
- Claude Code persists the full conversation context on disk inside the workspace — so resuming a session has full history even across app restarts

### Error Handling

- If the `coder ssh` process exits with non-zero, capture stderr
- Common failures:
  - Workspace is stopped → prompt user to start it
  - Workspace agent not connected → show status, suggest waiting
  - Claude Code not installed in workspace → clear error message
  - Claude Code API key not configured in workspace → clear error message
- Store error details in a `failed_reason` column on the task

---

## 6. Data Model

### Schema

```sql
-- Users table: caches Coder user info for display purposes
CREATE TABLE users (
  id TEXT PRIMARY KEY,              -- Coder user UUID
  username TEXT NOT NULL,
  email TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tasks table
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,              -- UUID v4
  workspace_id TEXT NOT NULL,       -- Coder workspace UUID
  workspace_name TEXT NOT NULL,     -- Denormalized for display
  user_id TEXT NOT NULL,            -- Coder user UUID (task creator)
  title TEXT NOT NULL,              -- Short task description
  prompt TEXT NOT NULL,             -- Full initial prompt for Claude
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'working', 'awaiting_feedback', 'completed', 'failed')),
  position INTEGER NOT NULL,        -- Order in queue (per workspace)
  claude_session_id TEXT,           -- UUID for Claude Code session
  failed_reason TEXT,               -- Error message if failed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_tasks_workspace_status ON tasks(workspace_id, status);
CREATE INDEX idx_tasks_workspace_position ON tasks(workspace_id, position);

-- Messages table: conversation history per task
CREATE TABLE messages (
  id TEXT PRIMARY KEY,              -- UUID v4
  task_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,            -- Message text content
  cost REAL,                        -- API cost (for assistant messages)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_task ON messages(task_id, created_at);

-- Sessions table: server-side session storage
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,              -- Session token
  user_id TEXT NOT NULL,
  coder_access_token TEXT NOT NULL, -- Encrypted
  coder_refresh_token TEXT,         -- Encrypted
  token_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### Notes

- All IDs are UUID v4 strings
- Timestamps are ISO 8601 UTC strings
- `position` is an integer for simple reordering — use gaps (10, 20, 30...) to allow insertions without rewriting all positions
- Coder tokens in the sessions table must be encrypted at rest (use a server-side encryption key from environment variables)
- The `messages` table only stores the meaningful conversation content (user prompts and assistant responses), not internal tool calls

---

## 7. API Routes

### Authentication

| Method | Path | Description |
|---|---|---|
| `GET` | `/auth/login` | Initiates OAuth2 flow (redirects to Coder) |
| `GET` | `/auth/callback` | OAuth2 callback, exchanges code for tokens |
| `POST` | `/auth/token-login` | Fallback: login with a Coder API token |
| `POST` | `/auth/logout` | Destroys session |
| `GET` | `/auth/me` | Returns current user info |

### Workspaces

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/workspaces` | Lists user's Coder workspaces (proxies to Coder API) |
| `GET` | `/api/workspaces/:id` | Gets workspace details (proxies to Coder API) |

### Tasks

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/workspaces/:workspaceId/tasks` | Lists tasks for a workspace |
| `POST` | `/api/workspaces/:workspaceId/tasks` | Creates a new task (queued) |
| `GET` | `/api/tasks/:taskId` | Gets task details with messages |
| `PUT` | `/api/tasks/:taskId` | Updates task (reorder, edit prompt) |
| `POST` | `/api/tasks/:taskId/reply` | Sends follow-up message (resumes Claude) |
| `POST` | `/api/tasks/:taskId/complete` | Marks task as completed |
| `POST` | `/api/tasks/:taskId/retry` | Retries a failed task |
| `POST` | `/api/tasks/:taskId/wake` | Fires a scheduled wake-up now instead of waiting |
| `DELETE` | `/api/tasks/:taskId/wake` | Cancels a scheduled wake-up without replying |
| `DELETE` | `/api/tasks/:taskId` | Cancels/deletes a task |

### WebSocket

| Path | Description |
|---|---|
| `ws://host/ws` | WebSocket endpoint for real-time task output streaming |

#### WebSocket Protocol

After connecting, the client sends a message to subscribe to a task:

```json
{ "type": "subscribe", "taskId": "uuid" }
```

The server streams events:

```json
{ "type": "output", "taskId": "uuid", "content": "Claude's text output" }
{ "type": "tool_call", "taskId": "uuid", "tool": "Edit", "summary": "Editing auth_test.go" }
{ "type": "status_change", "taskId": "uuid", "status": "awaiting_feedback" }
{ "type": "error", "taskId": "uuid", "message": "Workspace agent disconnected" }
```

---

## 8. Frontend Pages

### Page 1: Login

- Coder OAuth2 login button (primary)
- API token input field (fallback)
- Shows the Coder instance URL being connected to

### Page 2: Workspace List

- Grid or list of user's Coder workspaces
- Each card shows: workspace name, template name, status (running/stopped), agent status, last used date
- Visual indicator for workspaces with active or queued tasks
- Click to navigate to that workspace's task view
- Stopped workspaces should be visually distinct (grayed out) with a note that they must be running for tasks to execute

### Page 3: Task Queue (per workspace)

- Workspace name and status in the header
- List of tasks in queue order, showing: title, status badge, created date
- "New Task" button/form at the top — text input for the task prompt
- Tasks are draggable to reorder (only `queued` tasks)
- Click a task to navigate to its detail/chat view
- Status filters: All, Active, Completed

### Page 4: Task Detail / Chat View

- Task title and status at the top
- Chat-style conversation thread:
  - Initial task prompt (user message, right-aligned or distinct)
  - Claude's response (assistant message, left-aligned)
  - User's follow-up (if any)
  - Claude's follow-up response
  - ... and so on
- When status is `working`: show a streaming output area with Claude's live progress
- When status is `awaiting_feedback`: show a reply input box
- When status is `completed`: read-only conversation view
- Action buttons: Mark Complete, Retry (if failed), Cancel (if queued/working)
- Show cost per assistant message and total cost

---

## 9. Configuration

The app is configured via environment variables:

| Variable | Required | Description |
|---|---|---|
| `CODER_URL` | Yes | Base URL of the Coder deployment (e.g., `https://coder.example.com`) |
| `CODER_CLIENT_ID` | For OAuth | OAuth2 client ID |
| `CODER_CLIENT_SECRET` | For OAuth | OAuth2 client secret |
| `APP_URL` | Yes | Public URL of this app (for OAuth callback) |
| `SESSION_SECRET` | Yes | Secret key for encrypting session cookies and tokens |
| `PORT` | No | Server port (default: 3000) |
| `DATABASE_PATH` | No | Path to SQLite database file (default: `./data/cpm.db`) |
| `CLAUDE_MAX_TURNS` | No | Max agentic turns per Claude execution (default: 200) |
| `CLAUDE_ALLOWED_TOOLS` | No | Comma-separated list of tools Claude can use (default: `Read,Edit,Write,Bash,Glob,Grep`) |
| `CPM_WAKE_POLL_INTERVAL_MS` | No | How often to check for due `[WAKE]` wake-ups and probe sentinel files (default: 30000) |
| `CPM_MAX_AUTO_WAKES` | No | Consecutive agent-scheduled wake-ups allowed without a user reply (default: 12) |
| `CPM_MEMORY_MCP_URL_TEMPLATE` | No | URL with `{username}` / `{workspace}` placeholders; auto-derives each user's memory endpoint. See below. |
| `CPM_MEMORY_MCP_URLS` | No | Explicit per-user memory endpoint map (overrides the template). See below. |

### Per-user memory store

When configured, CPM registers a user's Mem0/OpenMemory endpoint as an MCP
server (`openmemory`) on every task and advisory-agent session that user owns,
and appends a system prompt telling the agent to recall from and save to it. The
store is **user-specific** — each Coder user resolves to their own endpoint, so
no user's memories leak to another. Users with no endpoint get no memory MCP
(agents fall back to local memory files only).

There are two configuration sources, checked in order:

Both sources support two placeholders: `{username}` (the task owner's Coder
username) and `{workspace}` (the target workspace name). `{workspace}` is what
lets each workspace write under its own OpenMemory **app** — the `/mcp/<app>/`
path segment — so memories are partitioned per app, e.g. `cpm-{workspace}`.

1. **`CPM_MEMORY_MCP_URL_TEMPLATE`** — a single URL containing `{username}`
   (and optionally `{workspace}`). A user's endpoint is derived by substituting
   those values. Use this when everyone shares one Mem0 server:

   ```
   CPM_MEMORY_MCP_URL_TEMPLATE=http://192.168.1.199:8765/mcp/cpm-{workspace}/sse/{username}
   ```

   For user `magnus` on workspace `coder-project-manager` this resolves to
   `http://192.168.1.199:8765/mcp/cpm-coder-project-manager/sse/magnus`.

2. **`CPM_MEMORY_MCP_URLS`** — a JSON object mapping Coder username → endpoint,
   for users on a different server or to opt a specific user in/out. An explicit
   entry always wins over the template. Each value is the URL string (it may use
   the same placeholders), or `{ "url": "...", "type": "sse" | "http" }` when the
   transport isn't SSE:

   ```
   CPM_MEMORY_MCP_URLS={"magnus":"http://192.168.1.199:8765/mcp/cpm-{workspace}/sse/magnus"}
   ```

The workspaces running the agents must be able to reach the endpoint over the
network. Changing either variable requires a CPM server restart.

**Agent behaviour.** When a memory endpoint is configured, agents get a system
prompt — parameterized by the resolving Coder user so its identity references
are correct per user (the store is user-scoped). It instructs the agent to
recall on start, save durable knowledge as it goes, write **curated** entries
with `infer=false` (the agent authors the final memory in the standard's
frontmatter+body format, rather than letting the server re-extract raw text),
attribute writes to the `cpm-<workspace>` source/app, search-then-supersede to
avoid duplicates, and never store secrets. Magnus's personal *Shared Memory
Standard* (the `type` taxonomy and classification rules) is embedded only for its
owner; other users get the generic prompt without it. Because CPM agents write
curated, the store's `custom_instructions` (which govern *inferred* extraction)
don't affect CPM's writes — they're an operator-managed setting for other tools
that write in inferred mode.

---

## 10. Development Phases

### Phase 1: MVP (Start Here)

- API token login (skip OAuth2 initially)
- Workspace listing from Coder API
- Task CRUD with SQLite storage
- Sequential task execution via `coder ssh` + `claude -p`
- Basic conversation persistence (store initial prompt + final response)
- Simple UI: workspace list → task list → task detail with reply
- No streaming — poll for completion

### Phase 2: Real-Time

- WebSocket streaming of Claude output
- Live progress indicator in the UI
- Task status updates via WebSocket (no polling)

### Phase 3: Polish

- OAuth2 login flow
- Drag-to-reorder tasks
- Token refresh handling
- Cost tracking and display
- Workspace status monitoring (auto-detect stopped workspaces)
- Error recovery (retry failed tasks, handle disconnects)

### Phase 4: Nice-to-Have

- Task templates (save common prompts)
- Bulk task creation
- Search/filter across all tasks
- Keyboard shortcuts
- Notifications (browser notifications when a task completes)

---

## 11. Key Technical Decisions

### Why SQLite?

- Single-file database, no external dependencies
- Perfectly adequate for this use case (single-user or small team)
- Synchronous API via better-sqlite3 is simpler than async ORMs
- Easy to backup and migrate

### Why SSH instead of WebSocket PTY?

Coder's API offers a WebSocket PTY endpoint for interactive terminal sessions, but SSH via the `coder` CLI is simpler and better suited for non-interactive command execution:

- `coder ssh workspace -- command` works out of the box
- No need to manage WebSocket connections and terminal emulation
- Easier to capture structured output
- The `coder` CLI handles authentication, DERP relay, and reconnection

### Why not run Claude Code via the SDK directly on the server?

The Claude Code SDK would run Claude on the **app server**, not inside the workspace. This means:

- No access to the workspace filesystem
- No access to workspace-specific tools, git, memory, etc.
- Would need to proxy all file operations

Running via SSH ensures Claude operates in the workspace environment with full access to everything.

### Why stream-json output format?

- Provides structured, parseable events
- Includes session ID, cost, and tool usage metadata
- Can be streamed line-by-line without buffering the full response
- Easy to filter relevant events for the UI vs. storage
