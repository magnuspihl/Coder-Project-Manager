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
- The Reviewer can also be triggered manually on an `awaiting_feedback` task — via the **Review**
  button next to **Complete** in the task detail UI, the `POST /api/tasks/:taskId/review` route, or
  the `review` MCP tool. A manual review resets the loop counter, then routes its verdict through the
  same `finalizeReviewer` path as auto-review (pass → `awaiting_feedback`; fail → back to the
  Implementer, capped by the loop limit). It is rejected if the worktree is clean or another task is
  running on the workspace.

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

---
Review the change adversarially, then emit your verdict.
{REVIEW_DECISION_FORMAT — the literal verdict contract, see "self-contained" note below}
```

If the diff exceeds ~8 000 tokens (estimated by character count), it is truncated to the first
8 000 tokens with a note: `[diff truncated — review what you can see]`. Full file reads are
available via the Reviewer's Read tool.

**Reviewer memory (user direction + waivers).** `task.prompt` alone was the reviewer's *entire*
notion of what was asked. Because the Reviewer starts a fresh session every pass, any direction the
user gave in a later reply went only to the Implementer (via `--resume`) and was structurally
invisible to the Reviewer — which then re-derived its opinion from the original prompt and re-raised
issues the user had already overruled ("don't do what the reviewer said about issue X, the first
implementation was correct" had no effect on the next pass). Two blocks now sit between the prompt
and the diff:

- `buildUserDirectionBlock` replays the user's subsequent replies, oldest first, stating explicitly
  that later instructions override earlier ones *including the original task*. Auto-generated
  bodies (the per-finding fix action and the legacy "Apply suggested fixes" button) are excluded —
  replaying those would echo the reviewer's own prior verdict back at it as if the user had asked
  for it independently.
- `buildWaiverBlock` replays every finding the user **dismissed** (see Section 16), with the user's
  reason, and states that re-raising one is itself a review failure.

Each block is capped at 6 000 characters; the direction block keeps the *most recent* replies when
trimming, since later direction is what matters.

The Reviewer's working directory is the task's existing worktree. It inherits the same `coder ssh`
invocation path. No new worktree is created.

**Isolation from workspace memory.** The Reviewer is launched with `--setting-sources ''`, which
skips the `claude` CLI's CLAUDE.md auto-discovery (both `~/.claude/CLAUDE.md` and the project
`./CLAUDE.md`). Those files instruct a normal agent to report status via tooling, ask the user when
blocked, and act as the project's builder — instructions that directly contradict the Reviewer's
read-only, non-interactive contract. Without isolation the CLAUDE.md directives override the
appended Reviewer prompt, so reviewers asked the user questions, requested edit access, and never
emitted `REVIEW_DECISION`. Setting sources govern only settings.json + CLAUDE.md, not credentials,
so OAuth/keychain auth is unaffected.

**Read-only enforcement.** The Reviewer's `--allowedTools` grants `Read,Glob,Grep` plus a whitelist
of read-only `Bash(<cmd>:*)` rules (git inspection, file readers, test runners). Bare `Bash` was
removed because an allowed tool is auto-approved in headless `-p` mode, which let reviewers write
files (e.g. edit `.gitignore`, `rm` artifacts). Write commands now fall outside the allowlist and
are denied by the CLI's permission layer.

**Stream reassembly (the actual root cause of the missing-verdict bug).** The reviewer's output is
streamed off the workspace by polling its log file every 3s with `tail -n +${linesRead+1}`
(`pollOutputAndExit`). `linesRead` is advanced only for **fully-consumed** lines; the trailing line
that is still being written is popped off *without* advancing it, so the next poll's `tail` already
re-reads that line from its start, in full. The poll loops, however, also prepended their own saved
copy of it (`const fullData = partialLine + jsonPart`) — duplicating the line's bytes
(`<partial><same line in full>`), which made `JSON.parse` throw so the event was silently dropped in
`catch`. It only triggers when a poll lands mid-write of a line, so **large** events are the prime
victims — and a reviewer's whole review plus its trailing `REVIEW_DECISION` arrives as one big final
message that routinely straddles a poll boundary. Net effect: even a perfectly-emitted verdict was
dropped, producing *both* the "did not emit a structured verdict" message **and** the "cut off"
appearance. The fix removes the prepend in all three pollers that shared this bug (reviewer,
implementer `startFilePolling`, chat-participant `startTaskParticipantPolling`); `tail`'s re-read is
the single source of truth, and the trailing partial line is still skipped (never `JSON.parse`d or
counted) until a later poll sees it complete. The prompt-hardening and verdict-recovery below are
complementary backstops for genuine prose-only endings, not the primary fix.

A *second* defect lived in the same line-counting logic and is fixed alongside it: the trailing
`split('\n')` element used to be popped **only when non-empty** (`if (lastElement && lastElement.trim())`).
When a poll's chunk ended on a clean newline (`"…\n"` — the common state during the idle gaps while
the reviewer is thinking or running a tool), the trailing `""` was left in `allLines` and the loop did
`linesRead++` for it before the empty-line `continue`, advancing `linesRead` one past the real line
count. The next `tail -n +${linesRead+1}` then skipped a real line — usually the first message
emitted *after* the gap, which is exactly where the final `REVIEW_DECISION` lands. The done-flush
can't recover it (it only reparses the last poll's `partialLine`, not a line skipped mid-stream). The
fix pops the final element **unconditionally** (`partialLine = allLines.pop() ?? ''`) in all three
pollers — that element is never a consumed line, so it must never be counted.

A *third* facet: the **done-flush** (reparse the trailing `partialLine` once the run is finished) is
now present in **all three** pollers, not just the reviewer. The final line — usually the `result`
event carrying the fatal-error / cost / token info — can arrive **without a trailing newline**, so it
is popped into `partialLine` and otherwise never processed. In the implementer and chat-participant
pollers this previously meant `resultSeen` never flipped, finalize fell through to the exit-code
branch, and the `result` event was silently dropped (a context-window error on the final event could
even be misread as a clean exit). Each poller now flushes the trailing line when the stream is done:
the implementer reuses its shared `processLine` (guarded on `wiped` so it never bypasses the staging
wipe); the participant poller likewise extracts a shared `processParticipantLine` used by **both** the
incremental loop and the flush, so every event shape (text, `AskUserQuestion`, other `tool_use`,
`rate_limit_event`, `result`) is handled identically — the earlier inline flush open-coded a narrower
subset and would drop a final `AskUserQuestion` or rate-limit line that arrived without a newline. The
reviewer's flush additionally **persists** the
flushed text via `addMessage` and **dedups** the `result` text against what the in-loop path already
captured, so the final review (incl. the verdict line) is visible in the conversation and never
double-appended.

**Turn budget.** The Reviewer runs with `--max-turns` set from `CLAUDE_REVIEWER_MAX_TURNS`
(default **100**). A red-team review reading the diff, grepping, opening several files, and running
the test suite each consume turns. The previous cap of 20 routinely cut reviewers off mid-analysis
*before* they emitted `REVIEW_DECISION`, which surfaced the confusing "did not emit a structured
verdict" message and a visibly truncated reviewer response. When the CLI does abort on the turn
limit, the `result` event's subtype is `error_max_turns`; finalize detects this and surfaces an
explicit "ran out of turns" message (with the limit) instead of the generic no-verdict text.

**Verdict recovery.** Whenever a review finishes with **no parseable `REVIEW_DECISION`** — whether
because the model wrote a prose review and never appended the block (the common case in practice) or
because it was cut off at the turn limit — finalize does not immediately escalate. It resumes the
**same** reviewer session once (`--resume`, so all the context it already gathered is retained) with
a short prompt demanding *only* the `REVIEW_DECISION` block: no further investigation, no questions,
no commentary (a tight `--max-turns 5`). The recovery is one-shot: an `isWrapUp` flag threaded
through polling prevents it from recursing if the resume itself yields no verdict, in which case the
"did not emit a structured verdict" / "ran out of turns" message is surfaced to the user as before.

**The verdict contract must be self-contained.** The recovery prompt restates the exact
`REVIEW_DECISION` format inline (`REVIEW_DECISION_FORMAT`) rather than referring to "the JSON from
your instructions." The appended system prompt is **not reliably re-attached to a `--resume`d
session**, and the reviewer is additionally launched with `--setting-sources ''` (which strips
CLAUDE.md and other instruction sources). A resumed session therefore frequently no longer carries
the verdict schema, and a prompt that merely says "emit the JSON from your instructions" elicits the
exact failure observed in the field: *"I don't have a REVIEW_DECISION format in my instructions —
there's no such schema defined anywhere in this session."* The model is correct to refuse to
fabricate one. The fix embeds the literal format in the **conversation** — it is appended to the
initial reviewer prompt (the `-p` content) and repeated verbatim in the recovery prompt — so the
verdict is reproducible regardless of whether the system prompt was delivered. The appended system
prompt's OUTPUT CONTRACT section remains as a first-pass nudge; the in-conversation copy is the
durable source of truth.

**Why both a hardened prompt and recovery.** The reviewer system prompt leads with an explicit
"OUTPUT CONTRACT" section (a worked example, plus a checklist to confirm the literal `REVIEW_DECISION:`
line is present) so the *first* pass emits the block inline most of the time. The recovery resume is
the backstop for the cases where the model still ends with prose or a "Want me to fix this?" question
despite the contract — so a missing verdict no longer dead-ends on the user.

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

Parsing (`parseReviewDecision`) is deliberately tolerant. It collects **every** `REVIEW_DECISION`
marker and tries them from **last to first**, returning the first that yields a valid verdict object.
For each marker it extracts the first balanced JSON object after it — walking brace depth while
respecting string literals, so the JSON may span multiple lines and contain `}` inside string values
— tolerating markdown wrappers (`**bold**`, `` `code` ``, fenced blocks) and indentation. Trying the
**last** marker first preserves the "the model sometimes mentions the token before emitting the real
verdict" behaviour; the **fallback to earlier markers** fixes a real misparse when the reviewer
reviews *this* pipeline: a genuine verdict can contain the literal token inside an issue string
(e.g. `…"issues":["the reviewer never emits REVIEW_DECISION: when cut off"]`). The last marker then
lands *inside* the JSON, where anchoring to it alone would find no `{` (or a stray later brace) and
silently drop an otherwise-valid verdict. An even earlier anchored single-line regex
(`/^REVIEW_DECISION:\s*(\{.+\})$/m`) was too strict: it required the marker at the start of a line
and the JSON to be the entire rest of one line, so bolded, indented, fenced, pretty-printed, or
trailing-text verdicts were silently treated as "no decision."

**Placeholder rejection.** Because the reviewer prompt now embeds the verdict contract with a worked
example, a weak or rushed model can echo the example line verbatim —
`REVIEW_DECISION: {"outcome":"pass","summary":"<one sentence>"}`. Accepting that as a real verdict
would **silently route the task on a fabricated pass/fail**. `extractDecisionAt` therefore rejects any
verdict whose `summary` is a known placeholder (`<one sentence>`, `<summary>`) by returning null — so
`parseReviewDecision` falls back to an earlier real marker if one exists, or returns null (triggering
verdict recovery) if the echo was all there was. Placeholder *issue* entries (`<specific issue>`,
`...`) are stripped from the `issues` list, and an issues list that collapses to empty becomes
`undefined` so routing falls back to the summary. A real summary that merely contains angle brackets
(e.g. "mishandles `<html>` tags") is **not** rejected — only the exact template tokens are.

If no parseable `REVIEW_DECISION` is found, the turn is treated as `fail` and a system message
surfaces the reviewer's prose to the user, who can then proceed or reply. The review loop count is
reset rather than incremented in this case. The message wording depends on *why* the verdict is
missing: if the `result` subtype was `error_max_turns` the reviewer was cut off and the message says
so (and points at `CLAUDE_REVIEWER_MAX_TURNS`); otherwise it reports a genuine no-verdict. Before
parsing, finalize also flushes any trailing buffered line that lacked a newline terminator — the
final assistant message (where `REVIEW_DECISION` lives) can arrive that way, and dropping it would
misread a valid verdict as "no decision."

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

Messages written during a turn are tagged with that turn's `turn_id`, so the UI can group and label
them by persona. **Both** Implementer and Reviewer turns are recorded: each `launchTask` call (first
run and every resume) creates an `implementer` turn, and its assistant messages carry that turn's
id. Originally only Reviewer turns were created, so Implementer messages had a NULL `turn_id` and the
UI could not distinguish the Developer from the Reviewer — when a reviewer (mis)asked the user a
question, the user's reply was routed to the implementer session, which then answered in the
reviewer's voice. Recording implementer turns restores correct per-persona attribution. Legacy
messages with no `turn_id` still render as ungrouped assistant output.

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
   - `--append-system-prompt {reviewer_system_prompt}` (plus the verdict contract embedded in the
     `-p` prompt itself — see Section 4's "self-contained" note)
   - `--model {actualModel}` if set — Reviewer uses the **same model as the Implementer**, including
     Ollama models: the `ollama/` prefix is stripped for `--model` and `ANTHROPIC_BASE_URL` /
     `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are exported in the remote command exactly as the
     implementer does. (Previously the reviewer skipped `--model` for Ollama and never set the
     endpoint, so it ran against the default Anthropic API — wrong model, or an auth error producing
     an empty review and a spurious "no verdict" escalation.)
   - Caveman mode is NOT applied — verbosity is useful in review output
6. **Before spawning**, archive the previous reviewer run's output/exit files (`mv -f … .prev`) in a
   **separate, awaited** SSH step — mirroring the implementer. The remote command's own in-band
   `rm -f` only runs once the detached `coder ssh` connects (seconds later), but polling starts
   synchronously; without the pre-clean the first poll could `cat` a **stale** `-review.exit` from a
   prior pass and finalize immediately against the previous turn's leftover output (routing on a
   stale verdict, or on empty text once the in-band `rm` lands). Awaiting the archive closes the race.
7. Stream output to client via WebSocket, tagged with `role: "reviewer"` in the event payload
8. On `result` event, parse `REVIEW_DECISION` from final assistant text
9. Act on outcome (transition task or start new Implementer turn)

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

#### Implementer opt-out (`NO_REVIEW_NEEDED`)

The diff gate alone is insufficient: a question/diagnosis/advisory turn can still
leave the worktree dirty (build output, a touched lockfile, a scratch file),
which trips `worktreeHasChanges` and launches a pointless reviewer. So the
implementer can declare intent directly.

When auto-review is on, the implementer's system prompt (`NO_REVIEW_PROMPT`,
appended via `--append-system-prompt`) tells it to end its final response with a
bare `NO_REVIEW_NEEDED` line when the turn isn't a review-worthy code change. The
implementer poller detects and strips that marker (`stripNoReviewMarker`) before
the message is shown to the user, recording the task id in an in-memory
`noReviewDeclared` set. `onImplementerComplete` consumes the flag and skips the
reviewer — but only when `review_loop_count === 0`, so a mid-loop implementer
that's supposed to be fixing flagged issues can't opt out of its own re-review.
The diff gate remains the safety net if the flag is ever lost (e.g. a restart
mid-turn).

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

---

## 16. Per-Finding Triage

A fail verdict's `issues` array is also exploded into one `review_findings` row per issue, so each
one is decided on its own rather than as an all-or-nothing block.

### Data model

```sql
CREATE TABLE review_findings (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES task_turns(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,        -- order within the verdict
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'fixing', 'dismissed')),
  note TEXT,                        -- user's reason when dismissing
  decided_at TEXT,
  created_at TEXT NOT NULL
);
```

`task_turns.review_issues` is unchanged and remains the verbatim verdict payload; `review_findings`
is the actionable copy. `createReviewFindings` is idempotent per turn (a re-finalized turn replaces
its own rows), and findings from other turns are left alone so waivers accumulate across passes.
Blank issue strings are skipped. A fail verdict that carried no issues list falls back to one
finding holding the summary, so a fail is never un-triageable.

### States

| State | Meaning |
|---|---|
| `open` | Not yet decided. |
| `fixing` | Sent to the Implementer via the fix action. |
| `dismissed` | Waived by the user. Replayed to every later Reviewer as a waiver (Section 4). |

Reopening a dismissed finding clears its note and `decided_at`.

### Routes

- `PATCH /api/tasks/:taskId/findings/:findingId` — `{state: 'open'|'dismissed', note?}`. Scoped by
  task as well as id, so a finding id from another task is not mutable through this route.
- `POST /api/tasks/:taskId/findings/fix` — `{findingIds: string[]}`. Posts a user reply containing
  only the selected findings, marks them `fixing`, resets the review loop, and queues the task. The
  reply also lists any dismissed findings as explicit do-not-touch, so the Implementer does not
  "helpfully" fix a waived issue it can still see earlier in the conversation.

`GET /api/tasks/:taskId` gains a `findings` array.

### UI

Each finding renders as its own row with **Fix this** and **Ignore**. Ignore opens an optional
one-line reason (shown to later reviewers) before confirming. Dismissed findings render struck
through and muted with their reason and an **Undo dismiss** link. A **Fix all N remaining** button
appears when more than one finding is still open. Verdicts recorded before this feature have no
finding rows and fall back to the original flat bullet list plus **Apply suggested fixes**.

### Actionability is per-finding, not per-turn

A finding stays actionable until it is **decided** — `dismissed` is the only state that takes it out
of play. `fixing` is re-sendable, since it only means "handed to the implementer, outcome unknown".

This was originally gated on the finding belonging to the *latest* reviewer turn, inherited from the
pre-findings design where a verdict was one indivisible blob that a newer verdict superseded
wholesale. With individual findings that silently orphans them: fixing one finding starts an
implementer turn and then a **new** reviewer turn, at which point every other finding you were
working through belongs to an older turn and loses its **Fix this** button forever — **Ignore**
stays, so the only path left is one the user never chose. The auto-review loop orphans findings the
same way, without any user action at all.

### Unresolved findings panel

Because fixing one finding pushes the rest far up the conversation, every undecided finding (`open`
or `fixing`, across all turns, oldest first) is also mirrored in a collapsible panel pinned directly
above the reply composer, with the same per-finding **Fix this** / **Ignore** and a **Fix all N
remaining**. Without it the user has to scroll back through earlier messages to act on the rest.

The panel is **collapsed by default** and its body is capped at `min(14rem, 20vh)` with its own
scroll; each body is clamped to two lines with a per-finding **Show more**. Findings accumulate
across passes and each is a full paragraph, so an expanded, unclamped panel filled the entire modal
on a real task — burying the conversation and the composer. The header line alone carries the
signal (`N review findings still undecided`); all detail is opt-in. Any change here should be
re-measured at 800px viewport height, where the composer's action row is the first thing to be
pushed out of view.

### A pass does not resolve open findings

When a later reviewer pass runs without re-raising a finding, that is evidence it was fixed — the
implementer resumes with full context and routinely fixes neighbouring issues it can still see in
the conversation, even ones the fix action didn't send. It is **not** proof: a fresh reviewer
session can simply miss it. So a pass never changes a finding's state. Instead the finding is
labelled *"A later review didn't raise this again — likely fixed, but not confirmed"*, and the panel
header notes that a later review passed without raising them. Auto-resolving here would reproduce
exactly the failure the per-finding design exists to prevent: the system quietly deciding an issue
the user never ruled on.
