# Parallel Task Execution via Git Worktrees

## 1. Summary

This document specifies the architectural change from sequential, stash-based task execution to
parallel, worktree-based task execution. It supersedes the relevant sections of `SPEC.md` (task
state machine, Claude execution model, data model) and should be read alongside it.

**What changes:**
- Each task runs in its own git worktree on its own branch — no more stash switching
- Multiple tasks per workspace can run concurrently (configurable, default 3)
- Each task gets a dedicated port range for its services
- Chat (Discussion) sessions also use worktrees, eliminating the read-only restriction
- The main workspace checkout permanently tracks the default branch and serves as a stable preview

**What stays the same:**
- "Mark Complete" semantics: branch → commit → push → PR → merge
- `--session-id` / `--resume` flow (session search is already global across `~/.claude/projects/`)
- WebSocket streaming, polling, task CRUD, OAuth, all API routes

---

## 2. Worktree Lifecycle

### Creation (task queued → working)

When `processQueue` picks up a task:

```bash
# On the remote workspace:
git fetch origin
git worktree add ~/.cpm/worktrees/task-{uuid} -b task/{slug}-{shortid} origin/{defaultBranch}
```

- The worktree lives at `~/.cpm/worktrees/task-{uuid}` — persists across workspace restarts
- The branch is created from `origin/{defaultBranch}` (not the local HEAD) so it starts clean
  regardless of anything in the main checkout or other worktrees
- `worktree_path` and `git_branch` are stored in the task row immediately

Claude is launched with the worktree as its working directory:

```bash
cd ~/.cpm/worktrees/task-{uuid} && claude -p "..." --session-id {uuid} ...
```

### Resumption (awaiting_feedback → working)

No git action needed. The worktree already exists. CPM just `cd`s back into it:

```bash
cd ~/.cpm/worktrees/task-{uuid} && claude -p "..." --resume {uuid} ...
```

`--resume` finds the session via `find ~/.claude/projects/ -name '{uuid}.jsonl'` (global search —
confirmed by the existing code in `claude.ts`). The cwd is stable because the worktree path never
changes for the lifetime of a task.

### Completion (Mark Complete)

1. Inside the worktree: `git add -A && git commit -m "..."`
2. `git push -u origin task/{slug}-{shortid}`
3. `gh pr create` (or reuse existing)
4. `gh pr merge --merge --delete-branch`
5. `git worktree remove ~/.cpm/worktrees/task-{uuid} --force`
6. Task status → `completed`, `worktree_path` → `NULL`

The main checkout does not need to be touched. It stays on its branch. The `git pull` step that
currently follows merge is removed — the main checkout is managed separately (see Section 6).

### Cancellation

```bash
git worktree remove ~/.cpm/worktrees/task-{uuid} --force
git branch -D task/{slug}-{shortid}
```

Work is discarded. This matches the existing cancel semantics.

### Failure

The worktree and branch are **kept**. The user can inspect partial work, retry the task (which
resumes into the same worktree), or delete the task (which triggers the cancellation cleanup above).

On retry, the task picks up in the existing worktree — no new worktree is created. The
`session_initialized` flag determines whether `--resume` or `--session-id` is used.

---

## 3. Concurrency Model

### Replacing the one-task-per-workspace invariant

The DB unique index `idx_tasks_one_working_per_workspace` is **dropped**. The in-process
`workspaceLocks` Map is retained but its scope is narrowed: it now protects only DB state
transitions (a few milliseconds), not the full Claude execution window (which could be minutes).

The new invariant: **at most `max_concurrent` tasks in `working` state per workspace at once**,
where `max_concurrent` is a per-workspace setting (default 3).

`processQueue` logic changes from:
> "If no task is working, start the next queued one"

to:
> "While (working_count < max_concurrent) and (queued tasks exist), start the next queued task"

On server startup, `reconnectWorkingTasks` reconnects all tasks in `working` state (not just one).

### Task ordering

`position` ordering is kept and still meaningful: when `processQueue` has concurrency slots to fill,
it fills them in position order. So a task at position 10 starts before one at position 20 even if
both are queued simultaneously.

### State machine changes

The state machine is otherwise unchanged. Multiple tasks can be `working` simultaneously; each
transitions independently through `awaiting_feedback`, `completed`, `failed`, or `cancelled`. There
is no workspace-level "slot" — each task manages its own lifecycle.

```
queued → working → awaiting_feedback → (user replies) → working → ...
                                     → (mark complete) → completed
       (failure) → failed
       (cancel)  → cancelled
```

---

## 4. Port Range Allocation

### Reserved range

Tasks are allocated ports from **40000–40999** in chunks of 10 per task, giving 100 concurrent
task slots. The main workspace checkout's services continue using whatever ports they normally use
(3000, 5173, etc.) — tasks never touch those.

### Assignment

At task launch time, CPM finds the lowest chunk not currently owned by any active task:

```sql
-- Active tasks are those with status IN ('working', 'awaiting_feedback')
-- and port_range_start IS NOT NULL
SELECT port_range_start FROM tasks
WHERE workspace_id = ? AND port_range_start IS NOT NULL
  AND status IN ('working', 'awaiting_feedback')
  AND deleted_at IS NULL
ORDER BY port_range_start;
```

The lowest free chunk start (40000, 40010, 40020, …) is assigned and stored as
`tasks.port_range_start`. No separate port pool table is needed — the tasks table is the pool.

### Injection into Claude

The port range is communicated to Claude in two ways:

**Environment variable** (handled by many tools automatically):
```javascript
env: {
  ...process.env,
  PORT: String(task.port_range_start),
  CPM_PORT_RANGE: `${task.port_range_start}-${task.port_range_start + 9}`,
}
```

**System prompt addition** (appended via `--append-system-prompt`):
```
Your task is running in a dedicated git worktree. Use port range {start}–{end} for any
services you start — do not use ports outside this range (e.g. 3000, 5173) as they are
reserved by the workspace's main service. Your primary preview URL via Coder is:
https://{start}--{workspace}--{owner}.coder.domain
Include this URL in your output when a service is ready to view.
```

The Coder proxy URI template is already available via `VSCODE_PROXY_URI` in the environment.

### Cleanup

When a task ends (any terminal state transition):

```bash
fuser -k 40000/tcp 40001/tcp ... 40009/tcp 2>/dev/null || true
```

This is run via SSH after the Claude process exits and before `port_range_start` is freed.
Non-fatal — if nothing is listening, `fuser` exits non-zero, which is ignored.

### Preview panel integration

The existing `useWorkspacePreview` hook takes a `taskId`. When a task has `port_range_start` set,
the hook constructs the Coder URL for that port and places it first in the `candidates` list. The
user can still switch to any other detected port, as today.

---

## 5. Chat (Discussion) Worktrees

### Change

Chat sessions currently run with a read-only filesystem restriction to avoid conflicting with
concurrent tasks. With worktrees, Chat sessions also get isolated working directories and the
restriction is removed.

### Worktree location

```
~/.cpm/worktrees/discussion-{uuid}
```

Created at discussion start, on a branch named `discussion/{shortid}`. Branched from
`origin/{defaultBranch}`, same as tasks.

### Lifecycle

**Session starts:** Worktree created, `discussion.project_dir` set to the worktree path.
`full_access` remains as a separate permission toggle (controls `--dangerously-skip-permissions`),
independent of the read-only boundary which is now gone.

**Session active:** Claude runs in the worktree. It can freely read and write files.

**Session ends (status → closed):**

1. Check for uncommitted changes: `git -C {worktree_path} status --porcelain`
2. **No changes:** `git worktree remove` silently. Done.
3. **Changes present:** Show the user a prompt:
   > "This chat made changes to the workspace. Create a task to continue this work?"
   - **Yes → Create task:** The worktree is handed off to a new task. The task row is created with
     `worktree_path` pointing to the existing worktree and `git_branch` set to the discussion's
     branch. The worktree is renamed from `discussion-{uuid}` to `task-{uuid}`. The discussion
     branch is renamed to `task/{slug}-{shortid}`. No new Claude session is started — the task
     starts as `queued` and will use `--session-id` (fresh session) with the existing worktree.
   - **No → Discard:** `git worktree remove --force`, `git branch -D`.

### Removed code

- `getReadOnlyOverride()` — removed
- `getDiscussionPromptPrefix()` read-only boundary text — removed (project context text retained)
- The `full_access` toggle in workspace settings now only controls tool permissions
  (`--dangerously-skip-permissions`), not filesystem access

---

## 6. Main Checkout's New Role

The main workspace checkout (e.g. `~/my-project`) **never has tasks run in it**. Its role is:

- Permanently checked out to the default branch
- Runs the workspace's auto-started services (dev server, etc.) on their default ports
- Serves as the "accepted work" preview: what has been merged to main
- Source of truth for new worktree creation (`origin/{defaultBranch}`)

CPM no longer calls `git checkout`, `git stash`, or any mutating git command on the main checkout.
The only git operation on it is `git pull` after a task's PR is merged, to keep it current.

This `git pull` happens automatically after the `gh pr merge` step in task completion, replacing
the current pattern of checking out main and pulling as part of the stash-reset flow.

---

## 7. Database Schema Changes

### New columns (added via migration)

```sql
-- tasks table
ALTER TABLE tasks ADD COLUMN worktree_path TEXT;
ALTER TABLE tasks ADD COLUMN port_range_start INTEGER;

-- workspace_settings table
ALTER TABLE workspace_settings ADD COLUMN max_concurrent INTEGER NOT NULL DEFAULT 3;

-- discussions table
ALTER TABLE discussions ADD COLUMN worktree_path TEXT;
```

### Removed index (dropped via migration)

```sql
DROP INDEX IF EXISTS idx_tasks_one_working_per_workspace;
```

The `workspace_settings.last_active_task_id` column (used by the stash system to track which task
owns the working directory) becomes unused and can be ignored — leave it in place for now to avoid
a destructive migration, but stop writing to it.

### No new tables

Port pool state is derived from `tasks.port_range_start` WHERE active — no separate table needed.
Worktree existence is derived from `worktree_path IS NOT NULL` — no separate table needed.

---

## 8. Service-Level Changes

### `git.ts`

| Current | Replacement |
|---|---|
| `handleTaskLaunchGit` (stash switch) | `createWorktree(task)` → `git worktree add` |
| `handleTaskResumeGit` (stash restore) | No-op — worktree already exists |
| `handleTaskCompletionGit` (stash pop → commit → push → PR → merge) | `commitAndMerge(task)` → commit in worktree → push → PR → merge → `git worktree remove` → `git pull` on main |
| `handleStashAway` (stash other tasks) | Removed |

All stash-related functions (`handleStashAway`, stash pop/push, `last_active_task_id` writes) are
removed. `detectProjectDir` is retained and called once at task creation; the result is stored as a
reference point for the main checkout path (used for branch naming, GitHub URL detection, etc.) but
is no longer the task's working directory — `worktree_path` is.

### `claude.ts`

| Current | Change |
|---|---|
| `processQueue`: checks for one working task | Check `working_count < max_concurrent` |
| `launchTask`: `project_dir` as cwd | Use `task.worktree_path` as cwd |
| Task launch: no port env | Inject `PORT` and `CPM_PORT_RANGE` |
| Task launch: no port system prompt | Append port range instruction |
| `withWorkspaceLock`: held across execution | Narrow to DB transition only (a few ms) |
| On task end: no port cleanup | SSH `fuser -k` on port range before marking done |
| `reconnectWorkingTasks`: reconnects one | Reconnects all working tasks |

### `db/index.ts`

- Add migration for new columns (Section 7)
- Drop `idx_tasks_one_working_per_workspace`
- On startup orphan handling: demote working tasks with no `worktree_path` to `failed` with reason
  `"Upgraded to worktree-based execution — retry to continue"` (these are pre-migration tasks that
  can no longer be reconnected)

### `useWorkspacePreview.ts`

- When `taskId` is provided and the task has `port_range_start`, construct the Coder preview URL
  for that port and prepend it to `candidates` as the default
- No change to the rest of the hook

---

## 9. Migration of Existing Tasks

Tasks in `working` or `awaiting_feedback` at the time of upgrade have no `worktree_path`. They
cannot be reconnected to the new execution model. On server startup:

1. Any task with `status IN ('working', 'awaiting_feedback') AND worktree_path IS NULL` is set to
   `failed` with `failed_reason = 'Server restarted after upgrade to parallel execution. Please retry.'`
2. `processQueue` is called for each affected workspace, which picks up any `queued` tasks.

Tasks already in `completed`, `failed`, or `cancelled` are unaffected.

### What is preserved after demotion

- **Conversation history** (messages table) — fully intact
- **Claude session file** (`~/.claude/projects/.../session.jsonl` on the workspace) — intact;
  `--resume` will find it and Claude will have full context of what it was working on

### What is not preserved

- **Uncommitted file changes.** The stash-based system stored in-progress filesystem changes in a
  git stash. After the upgrade, that stash is still on the workspace but no code reads it. A retry
  creates a fresh worktree from `origin/{defaultBranch}`. Claude resumes with full conversation
  context but a clean filesystem, and would need to redo any file work from that context.

### Recommended pre-upgrade steps

| Task state | Action |
|---|---|
| `awaiting_feedback` — result is good, want to keep the changes | **Mark Complete** before upgrading |
| `awaiting_feedback` — result was unsatisfactory | No action; retry after upgrade works fine |
| `working` (Claude running) | No action; server restart interrupts these regardless |
| `queued` | No action; not started yet, unaffected |

---

## 10. Configuration

New environment variables (optional):

| Variable | Default | Description |
|---|---|---|
| `CPM_WORKTREE_BASE` | `~/.cpm/worktrees` | Base directory for worktrees on workspace |
| `CPM_PORT_RANGE_START` | `40000` | First port in the task port pool |
| `CPM_PORT_RANGE_SIZE` | `10` | Ports per task slot |
| `CPM_PORT_RANGE_SLOTS` | `100` | Maximum concurrent task slots |

`max_concurrent` is a per-workspace setting stored in `workspace_settings`, configurable via the
workspace settings UI. It defaults to 3. Setting it to 1 restores sequential behaviour.

---

## 11. What This Does Not Change

- **API routes** — no new or changed routes; `worktree_path` and `port_range_start` are internal
- **WebSocket protocol** — unchanged
- **`--session-id` / `--resume` logic** — unchanged; session search is already global
- **Task CRUD, reordering, retry, cancel** — unchanged (cancel gains worktree cleanup)
- **Git push / PR / merge workflow** — same steps, now run from inside the worktree
- **Participant sessions** — participants run in their own workspace, unaffected
- **Auth, OAuth, Coder API integration** — unchanged
- **Streaming, polling, cost tracking** — unchanged
