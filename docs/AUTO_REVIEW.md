# Auto-Review (Red Team)

## 1. Summary

After each Implementer turn that produces file changes, a separate Reviewer Claude instance
automatically runs a fresh session to critique the work adversarially. The user only enters the
`awaiting_feedback` state when the Reviewer is satisfied, or when the loop limit is reached and a
human call is needed. This document should be read alongside `SPEC.md` and `WORKTREES.md`.

**What changes:**
- Task execution gains a post-turn review phase, triggered automatically when files are modified
- A new `task_turns` table tracks each Implementer and Reviewer turn within a task
- The Reviewer runs as a fresh, read-only Claude session — no shared context with the Implementer
- Up to 2 Reviewer passes per Implementer turn; if still failing, the task escalates to the user
- Tasks can opt out at creation time; review is skipped automatically when the worktree is clean

**What stays the same:**
- All task states (`queued`, `working`, `awaiting_feedback`, `completed`, `failed`, `cancelled`)
- WebSocket streaming, task CRUD, OAuth, all API routes
- Worktree lifecycle (each task still gets one worktree; the Reviewer runs inside it read-only)
- `--session-id` / `--resume` logic for the Implementer

---

## 2. Review Flow

```
Implementer turn completes
          ↓
git status --porcelain in worktree
          ↓
    ┌─────┴──────┐
    │ no changes │  changes
    └─────┬──────┘    ↓
          │     Reviewer turn starts (fresh session)
          │           ↓
          │     ReviewComplete(outcome, summary)
          │           ↓
          │    ┌──────┴──────┐
          │  pass           fail
          │    │               ↓
          │    │        loop_count < 2?
          │    │         ┌────┴────┐
          │    │        yes       no
          │    │         ↓         ↓
          │    │    new Implementer   escalate to user
          │    │    turn with issues  (awaiting_feedback)
          │    ↓
          └──→ awaiting_feedback (user)
```

The Implementer always refers to Claude running the user's task. The Reviewer is a separate Claude
invocation that critiques the result. Neither is aware of the other at the model level — the
adversarial separation is architectural.

---

## 3. Skip Condition

Review is skipped when the worktree is clean after an Implementer turn. The server runs:

```bash
git -C {task.worktree_path} status --porcelain
```

If the output is empty (no modified, staged, or untracked files), the task transitions directly
to `awaiting_feedback` without starting a Reviewer turn. This covers:

- **Speccing / discussion turns** — Claude responded without writing any files
- **No-op turns** — user asked a question, Claude answered
- **Stuck loop** — if an Implementer turn after a failed review also produces no changes, this is
  caught here and the task escalates to the user immediately (rather than running another review
  on identical code)

If `worktree_path` is NULL (pre-worktrees task), skip review and fall through to the existing
`awaiting_feedback` behaviour unchanged.

---

## 4. Reviewer Context

The Reviewer starts a **fresh Claude session** (`--session-id` with a new UUID, not `--resume`).
It receives no conversation history from the Implementer. Its context is constructed by the server:

```
Original task:
{task.prompt}

Changes made by the implementer:
{git diff HEAD}

Untracked files added:
{git ls-files --others --exclude-standard}
```

If the diff exceeds ~8 000 tokens (estimated by character count), it is truncated to the first
8 000 tokens with a note: `[diff truncated — review what you can see]`. Full file reads are
available via the Reviewer's Read tool.

The Reviewer's working directory is the task's existing worktree. It inherits the same `coder ssh`
invocation path. No new worktree is created.

---

## 5. Reviewer System Prompt

Appended via `--append-system-prompt`, same mechanism as caveman mode:

```
MANDATORY REVIEW RULES — RED TEAM MODE:

You are a code reviewer who did not write this code. Your job is to find problems
the implementer missed, not to confirm that things work.

Focus on:
- Does the implementation actually fulfill the original task?
- Missing input validation or boundary checks
- Unhandled error paths and edge cases
- Incorrect logic that would produce wrong results under specific conditions
- Missing or wrong tests for critical behaviour
- Security issues (injection, auth gaps, unsafe operations)

Do NOT:
- Praise the implementation
- Describe what the code does (assume the reader knows)
- Create, edit, or delete any files
- Run commands that modify state (no git commits, no writes, no installs)

You MAY run read-only commands: git diff, git log, git status, cat, grep, find,
npm test / go test / pytest (read test results — do not write new test files).

When you are done, include the following block as the last thing in your response,
on its own line, with no trailing text:

REVIEW_DECISION: {"outcome":"pass","summary":"<one sentence>"}
   or
REVIEW_DECISION: {"outcome":"fail","summary":"<one sentence>","issues":["<specific issue>","..."]}

"pass" means: no significant issues; the implementer's work is ready for user review.
"fail" means: specific actionable issues were found that the implementer should fix.
List only issues that are genuine problems, not stylistic preferences.
```

---

## 6. Routing Signal

The server detects the Reviewer's decision by scanning the accumulated text of the final assistant
message after the `result` event arrives in the stream. It looks for a line matching:

```
REVIEW_DECISION: {valid JSON}
```

Parsing is done with a regex that extracts the JSON payload:

```typescript
const match = finalText.match(/^REVIEW_DECISION:\s*(\{.+\})$/m);
```

If no `REVIEW_DECISION` line is found (malformed output, Claude didn't follow instructions), the
turn is treated as `fail` with summary `"Reviewer did not produce a decision — escalating to user"`.
This counts toward the loop limit.

The parsed object is stored in `task_turns.review_outcome` and `task_turns.review_summary`.

---

## 7. Loop Control

Each Implementer → Reviewer cycle increments `tasks.review_loop_count`. The cap is **2 Reviewer
passes** before escalation. The logic:

| Condition | Action |
|---|---|
| Reviewer returns `pass` | Task → `awaiting_feedback`. `review_loop_count` irrelevant. |
| Reviewer returns `fail`, `review_loop_count < 2` | New Implementer turn. Prompt = original task prompt prepended with the Reviewer's issues. `review_loop_count++`. |
| Reviewer returns `fail`, `review_loop_count >= 2` | Task → `awaiting_feedback`. System message added to conversation: "Reviewer found unresolved issues after 2 passes. Review required." |
| Worktree clean after Implementer turn | Skip to `awaiting_feedback`. `review_loop_count` not incremented. |

When the Implementer starts a new turn after a failed review, its prompt is:

```
The reviewer found the following issues with your previous implementation:
{issues joined as bulleted list}

Please address these issues. Original task:
{task.prompt}
```

The Implementer's `--resume` flag is used (same session, full context of prior work is available).

`review_loop_count` resets to 0 when the user manually replies to a task in `awaiting_feedback`,
since that constitutes a new human-directed turn.

---

## 8. Opt-Out

`auto_review` defaults to `1` (on). Users can disable it at task creation with a checkbox in the
task creation form. This sets `tasks.auto_review = 0` and skips all review logic for that task.

No workspace-level default — the per-task checkbox is the only control. The UI should default the
checkbox to checked, so unchecking is a deliberate override.

---

## 9. State Machine Changes

The visible task states are **unchanged**. `working` now covers both Implementer and Reviewer
phases — from the user's perspective, the task is simply still running. The turn distinction is
visible in the conversation view (Section 12) but not in the status badge.

Internally, a new field `tasks.active_turn_role` tracks whether the current `working` phase is
`"implementer"` or `"reviewer"`. This is used to:
- Route the `ReviewComplete` decision correctly
- Show the correct label in the UI during streaming
- Prevent user replies while the Reviewer is running (the reply box is hidden; only Cancel is shown)

```
queued → working[implementer] → (files changed?) → working[reviewer]
                                      ↓ no              ↓
                               awaiting_feedback    pass → awaiting_feedback
                                                    fail → working[implementer] (loop)
                                                    fail+cap → awaiting_feedback (escalate)
```

---

## 10. Data Model

### New columns on `tasks`

```sql
ALTER TABLE tasks ADD COLUMN auto_review INTEGER NOT NULL DEFAULT 1;
-- 1 = auto-review on, 0 = opted out

ALTER TABLE tasks ADD COLUMN review_loop_count INTEGER NOT NULL DEFAULT 0;
-- Counts completed Reviewer passes since last user reply

ALTER TABLE tasks ADD COLUMN active_turn_role TEXT CHECK (
  active_turn_role IN ('implementer', 'reviewer', NULL)
);
-- NULL when not in working state
```

### New table: `task_turns`

```sql
CREATE TABLE task_turns (
  id TEXT PRIMARY KEY,                    -- UUID v4
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('implementer', 'reviewer')),
  turn_number INTEGER NOT NULL,           -- 1-indexed, sequential across both roles
  claude_session_id TEXT,                 -- New UUID for reviewer; task's session_id for implementer
  prompt TEXT,                            -- Prompt used for this turn
  review_outcome TEXT CHECK (review_outcome IN ('pass', 'fail', NULL)),
  review_summary TEXT,                    -- Reviewer's one-sentence summary
  review_issues TEXT,                     -- JSON array of issue strings (reviewer fail only)
  files_changed INTEGER,                  -- 1 if worktree was dirty, 0 if clean, NULL for reviewer turns
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX idx_task_turns_task ON task_turns(task_id, turn_number);
```

### Change to `messages`

Add a nullable FK to `task_turns`:

```sql
ALTER TABLE messages ADD COLUMN turn_id TEXT REFERENCES task_turns(id);
```

Messages written during a Reviewer turn are tagged with the Reviewer's `turn_id`. This allows the
UI to group and label messages by turn. Existing messages (no `turn_id`) are treated as belonging
to the first Implementer turn.

---

## 11. Service Changes

### `claude.ts`

New function `launchReviewer(task: Task, issues: string[] | null)`:

1. Compute git diff: `git -C {worktree_path} diff HEAD` + untracked files list
2. Build reviewer context string (original prompt + diff, truncated if needed)
3. Build reviewer system prompt (`buildReviewerPrompt()`)
4. Generate a new `claude_session_id` for this reviewer turn (fresh session)
5. Invoke Claude with:
   - `--session-id {new_uuid}` (not `--resume`)
   - `--allowedTools "Read,Glob,Grep,Bash"`
   - `--append-system-prompt {reviewer_system_prompt}`
   - `--model {task.model}` if set — Reviewer uses the same model as the Implementer
   - Caveman mode is NOT applied — verbosity is useful in review output
6. Stream output to client via WebSocket, tagged with `role: "reviewer"` in the event payload
7. On `result` event, parse `REVIEW_DECISION` from final assistant text
8. Act on outcome (transition task or start new Implementer turn)

New function `buildReviewerPrompt()`: returns the static reviewer system prompt from Section 5.

Modified `onTaskComplete(task)` (called when Implementer turn finishes):

```typescript
async function onImplementerComplete(task: Task) {
  if (!task.auto_review || !task.worktree_path) {
    return transitionToAwaitingFeedback(task);
  }

  const hasChanges = await worktreeHasChanges(task.worktree_path, task.workspace_name);
  if (!hasChanges) {
    return transitionToAwaitingFeedback(task);
  }

  await launchReviewer(task, null);
}
```

New helper `worktreeHasChanges(worktreePath, workspaceName): Promise<boolean>`:
Runs `git -C {worktree_path} status --porcelain` via SSH. Returns `true` if output is non-empty.

### `tasks.ts`

- `createTask` gains `autoReview?: boolean` parameter (defaults to `true`)
- `Task` type gains `auto_review`, `review_loop_count`, `active_turn_role` fields

---

## 12. UI Changes

### Task creation form

A checkbox below the task prompt textarea:

```
[✓] Auto-review  — A separate agent will verify implementation before surfacing to you
```

Checked by default. Unchecking sets `auto_review: false` in the POST body.

### Task detail / chat view

Turns are visually separated in the conversation with a thin divider and a role label:

```
┌──────────────────────────────────────┐
│ ◆ Implementer                        │  ← small muted label, not a header
│   [streaming output / messages]      │
├──────────────────────────────────────┤
│ 🔍 Reviewer                          │  ← different icon; red-tinted label if fail
│   [reviewer output]                  │
│   Issues found: …                    │
├──────────────────────────────────────┤
│ ◆ Implementer — Turn 2               │
│   [revised work]                     │
├──────────────────────────────────────┤
│ 🔍 Reviewer — Passed ✓               │
└──────────────────────────────────────┘
[Reply box visible to user]
```

The Reviewer label shows its outcome once complete: "Passed ✓" (green) or "Issues found" (amber).
On escalation (loop cap hit), a system message appears: "Auto-review reached the loop limit.
Unresolved issues are listed below — your input is needed."

During a Reviewer turn, the reply input is hidden and a status line shows: "Reviewer running…"
The Cancel button remains available.

### No new pages or routes

All changes are within the existing task detail view and task creation form.

---

## 13. WebSocket Changes

The server tags streamed events with a `turnRole` field:

```json
{ "type": "output", "taskId": "uuid", "content": "...", "turnRole": "reviewer" }
{ "type": "status_change", "taskId": "uuid", "status": "working", "turnRole": "reviewer" }
```

The client uses `turnRole` to group messages into the correct turn section in the conversation view.
No protocol version bump needed — existing clients that don't read `turnRole` will still render the
output; they just won't show the turn labels.

---

## 14. Configuration

One new optional environment variable:

| Variable | Default | Description |
|---|---|---|
| `CPM_REVIEW_MAX_LOOPS` | `2` | Max Reviewer passes before escalating to user |

The per-task `auto_review` column is the primary control. There is no workspace-level default setting.

---

## 15. What This Does Not Change

- **Task states** — no new user-visible states; `working` covers both roles
- **Worktree lifecycle** — no new worktrees; Reviewer runs in the existing task worktree
- **Implementer session** — `--resume` / `--session-id` logic unchanged; Reviewer always starts fresh
- **API routes** — no new routes; `task_turns` is internal
- **Git workflow** — Mark Complete commits whatever is in the worktree, regardless of review outcome
- **Retries** — a failed task can be retried as before; `review_loop_count` resets
- **Cost tracking** — Reviewer turns are counted as normal assistant messages; cost is attributed to the task
