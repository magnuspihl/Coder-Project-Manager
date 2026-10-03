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
- **A blocking finding must be backed by a failing test** (Section 17). The Reviewer emits tests; the
  *harness* runs them and decides the outcome. Findings it cannot demonstrate are advisory and never loop
- The harness also runs the change's own tests and reports what they show (Section 18)
- Up to `CPM_REVIEW_MAX_LOOPS` (default 2) automated fix rounds per task; if still failing, the task escalates to the user
- Tasks can opt out at creation time; review is skipped automatically when the branch has no work relative to the default branch (Section 3)
- The Reviewer can also be triggered manually on an `awaiting_feedback` task — via the **Review**
  button next to **Complete** in the task detail UI, the `POST /api/tasks/:taskId/review` route, or
  the `review` MCP tool. A manual review resets the loop counter, then routes its verdict through the
  same `finalizeReviewer` path as auto-review (pass → `awaiting_feedback`; fail → back to the
  Implementer, capped by the loop limit). It is rejected if the branch has no work or the workspace is at
  its task concurrency limit. **The route answers immediately** (`202`, task `working`, `active_turn_role:
  reviewer`) once those synchronous checks pass: the review-time full verification (budget up to 480 s) and
  the reviewer launch continue in the background. A failure after the response is never lost —
  `failReviewerLaunch` closes the reviewer turn as failed, adds a system message ("The review could not be
  started: …") and returns the task to `awaiting_feedback`. Interrupting during that verification window
  works: the launch notices the interrupt and does not start a reviewer over it. Every other route that
  starts verification or a reviewer already follows this rule (`POST /verify` returns `202` and runs in the
  background; the Fix / Fix-all routes only queue the task and start `processQueue` in the background;
  auto-review runs from the turn-completion handler, not a request).

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
any work vs the merge-base? (committed, uncommitted or untracked — Section 3)
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

Review is skipped when the task has **no work relative to the default branch**. "Work" is measured against
the merge-base of `HEAD` with `origin/main` / `main` / `origin/master` / `master` (`hasBranchChanges`,
`review-io.ts`) and counts anything committed on the branch, staged, modified, or untracked:

```bash
git -C {worktree} status --porcelain        # uncommitted / untracked
git -C {worktree} diff --quiet $base HEAD   # committed on the branch
```

**This must never be `git status --porcelain` alone.** An implementer that commits everything before its
turn ends leaves a clean porcelain, and a porcelain-only check then reads a fully implemented task as
"nothing to review" — auto_review=1 tasks bcabb2f9 and 554b3aad got no reviewer turn for exactly this
reason. The reviewer's diff (`getReviewDiff`) and the verification step's changed-file list use the same
`$base`, so committed work is also *shown* to the reviewer and its tests are found. A regression test
builds a repo whose work is fully committed (clean porcelain) and asserts detection, the diff and the test
discovery all still see it.

If the workspace cannot be asked, the check **fails toward reviewing** (assumes changes, logs a warning):
"no changes" would silently skip the review, whereas a reviewer that can't launch reports its own error.

If the branch has no work at all, the task transitions directly to `awaiting_feedback` without a Reviewer
turn. This covers:

- **Speccing / discussion turns** — Claude responded without writing any files
- **No-op turns** — user asked a question, Claude answered

(An earlier version also promised to catch a "stuck loop" — a fix turn that changed nothing — via the
clean-tree check. That only ever worked when the implementer happened to have committed; it is not
detected now, and such a turn is simply reviewed again, bounded by `CPM_REVIEW_MAX_LOOPS`.)

If `worktree_path` is NULL (pre-worktrees task), skip review and fall through to the existing
`awaiting_feedback` behaviour unchanged.

---

## 4. Reviewer Context

The Reviewer has **no conversation history from the Implementer**. Its first pass starts a fresh Claude
session (`--session-id` with a new UUID); later passes on the same task **resume that reviewer session**
(`--resume`) when it still exists on the workspace — an actual resumed session remembers what *it* already
raised, which the replayed blocks below only approximate. Either way, the server constructs its context:

```
Original task:
{task.prompt}

Changes made by the implementer:
{git diff HEAD}

Untracked files added:
{git ls-files --others --exclude-standard}

Tests found in this change, as run by the harness:      (Section 18, when there are results)
{verification block}

---
Review the change adversarially, then emit your verdict.
{verdict contract — REVIEW_DECISION_FORMAT (opinion) or the proof-mode format (Section 17)}
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
- `buildWaiverBlock` replays **every finding raised by an earlier pass on this task** (see Section
  16), labelled with what happened to it — `dismissed` (never raise again), `resolved` (user says
  it's done: verify, don't restate), `fixing` / `open` (known; don't reword into a new-looking
  problem). It also forbids contradicting an earlier finding on the same code without saying so.

  This originally replayed **only dismissed** findings, which meant the *automatic* loop got nothing
  at all: it fires the next Reviewer seconds after the previous verdict, long before the user has
  triaged anything, so every finding is still `open` and therefore invisible. That is the common
  case, not the edge case — on task `a22ff87b` reviewer turn #6 ran at 14:11 and the turn #4
  findings were not dismissed until 14:17 and 14:23. The pass had no way to know what had already
  been said, so it restated it, and contradicted turn #4 on the same function.

  A turn never sees its own findings (`getPriorFindings(taskId, excludeTurnId)`).

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

Appended via `--append-system-prompt`, same mechanism as caveman mode. The text below is the
**opinion-mode** prompt (used when the workspace has no runnable test setup, Section 17.2). Proof mode
shares its preamble (role, read-only rules, "no human is reading") and replaces the tail with the
**evidence rules** and proof-mode output contract described in Section 17.

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

Parsing (`parseReviewDecision`, now in `server/services/review-verdict.ts`) is deliberately tolerant. It collects **every** `REVIEW_DECISION`
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

The verdict accepts two payload shapes, merged if both appear: the long-standing `issues` (plain strings,
or `{text, reraises}`) and the evidence-based `findings` (`{defect, requirement, proof, reraises?}`, where
`requirement` may be a string or `{quote, source}` and `proof` a path string or `{path}`). Placeholder
tokens copied from the prompt's template (`<defect>`, `<quote>`…) are stripped like the old ones.

The parsed object is stored in `task_turns.review_outcome` and `task_turns.review_summary`. In proof mode
`review_outcome` is the **harness's** outcome, not the reviewer's claim (Section 17.5).

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

`review_loop_count` is **cumulative over the task's life**, not per stretch of conversation (see the
comment on `MAX_REVIEW_LOOPS`): once spent, reviews still run and still report, they just stop being routed
back automatically. It is refilled only by explicit user intent — a manual review, **Fix** on a finding,
interrupting a reviewer, or toggling auto-review off and on. (An earlier version reset it on every reply,
which let any task with an active user accumulate unbounded rounds.)

---

## 8. Opt-In

`auto_review` defaults to `0` (off). Users can enable it at task creation with a checkbox in the
task creation form. Left unchecked, `tasks.auto_review = 0` and all review logic is skipped for
that task.

No workspace-level default — the per-task setting is the only control. The UI defaults the
checkbox to unchecked, so checking it is a deliberate opt-in. Callers that don't mention
`autoReview` at all (MCP `create_task`, task-request approval) get it off.

It is also switchable **mid-conversation**, alongside the model and subscription switchers in the
task detail header (`PUT /api/tasks/:id` with `{ autoReview: boolean }`). Semantics match those
switchers — it applies from the next decision point, not retroactively:

- A reviewer already running is **not** interrupted. It finishes and records its findings, but on a
  `fail` verdict the implementer is not resumed; the task settles into `awaiting_feedback` with the
  findings in the inbox.
- Later implementer turns skip the review entirely (`onImplementerTurnComplete` re-reads the task).
- Disabling resets `review_loop_count`. `settleWithUnresolvedFindings` — the single helper every
  review-related hand-back routes through — deliberately does **not** (the budget is cumulative, see
  Section 7); it does disarm a pending "complete after this turn" when a *blocking* finding is still
  open. Advisory findings never hold a completion back.
- The change is written to the conversation as a system message — unlike model/subscription
  switches — because it changes what happens when the current turn ends.
- A **manually** requested review (the "Review" button / `POST /api/tasks/:id/review`) is exempt
  from the mid-review guard: the user asked for that pass, so a `fail` verdict still routes back to
  the implementer once, exactly as it did before this setting existed. Only once, though — that fix
  turn then ends at the `auto_review` check in `onImplementerTurnComplete`, so no second review pass
  follows and `MAX_REVIEW_LOOPS` is never reached. With `auto_review = 1` the manual review behaves
  like any other pass and loops normally.

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
ALTER TABLE tasks ADD COLUMN auto_review INTEGER NOT NULL DEFAULT 0;
-- 1 = auto-review opted in, 0 = off (the default)

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
  review_outcome TEXT CHECK (review_outcome IS NULL OR review_outcome IN ('pass', 'fail', 'partial')),
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
   - `--allowedTools` — `Read,Glob,Grep` plus the read-only `Bash(<cmd>:*)` whitelist (Section 4); bare
     `Bash` was removed. Proof mode changes nothing here: the reviewer stays read-only, and the harness
     writes and runs its tests
   - `--append-system-prompt {reviewer_system_prompt}` (plus the verdict contract embedded in the
     `-p` prompt itself — see Section 4's "self-contained" note)
   - `--model {actualModel}` — precedence: the task's `reviewer_model` (set in the task header) >
     `CLAUDE_REVIEWER_MODEL` > the implementer's model. Running the reviewer on a *different* model than
     the implementer is the recommended setup: independent checks are worth more than correlated ones.
     Ollama models are supported: the `ollama/` prefix is stripped for `--model` and `ANTHROPIC_BASE_URL` /
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
8. On `result` event, parse `REVIEW_DECISION` from the accumulated assistant text (`finalizeReviewer`)
9. Proof mode: materialise, run and classify the proofs, with at most one repair round (Section 17)
10. Route on the *harness-decided* outcome (`routeVerifiedReview`): transition the task or start a new
    Implementer turn

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
Answers "does the task have any work relative to the default branch" — see Section 3. It is **not** a
`git status` check.

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

- `createTask` gains `autoReview?: boolean` parameter (defaults to `false`)
- `Task` type gains `auto_review`, `review_loop_count`, `active_turn_role` fields

---

## 12. UI Changes

### Task creation form

A checkbox below the task prompt textarea:

```
[ ] Auto-review  — A separate agent will verify implementation before surfacing to you
```

Unchecked by default. Checking it sets `auto_review: true` in the POST body.

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

Optional environment variables:

| Variable | Default | Description |
|---|---|---|
| `CPM_REVIEW_MAX_LOOPS` | `2` | Max automated fix rounds per task before escalating to user |
| `CLAUDE_REVIEWER_MAX_TURNS` | `100` | Turn cap for an **opinion-mode** review |
| `CLAUDE_REVIEWER_PROOF_MAX_TURNS` | `40` | Turn cap for a **proof-mode** review (scoped: read the diff, write ≤5 tests, stop) |
| `CLAUDE_REVIEWER_MODEL` | *(implementer's model)* | Deployment default reviewer model; the per-task `reviewer_model` overrides it |
| `CPM_VERIFY_TURN_BUDGET_SEC` | `150` | Hard cap on the per-turn *quick* check (the change's own tests) |
| `CPM_VERIFY_FULL_BUDGET_SEC` | `480` | Hard cap on a *full* verification (comparison with the original code + whole suite) |
| `CPM_PROOF_BUDGET_SEC` | `480` | Hard cap on running the reviewer's proof tests (and re-running confirmed ones) |

Per-workspace, not environment (both on the workspace card, `PUT /api/workspaces/:id/test-profile`):
the **test profile** (`workspace_settings.test_profile`, *Test runner*) — Section 17.2 — and the
**implementer test obligation** (`workspace_settings.test_obligation`, *Implementer tests*) — Section 18.

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
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'fixing', 'dismissed', 'resolved')),
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

| State | Meaning | Set by |
|---|---|---|
| `open` | Needs a human decision. **The only state in the user's inbox.** | — |
| `fixing` | Handed to the Implementer; no report back yet. | routing / **Fix this** |
| `fixed` | Implementer reported it fixed; awaiting Reviewer verification. | Implementer |
| `verified` | A later Reviewer pass checked the claim and did not re-raise it. | Reviewer |
| `dismissed` | User decided this will **not** be changed. | **Ignore** |
| `resolved` | User asserts it is **already fixed**. | **Already fixed** |

`dismissed` and `resolved` both retire a finding but mean opposite things to the next Reviewer
("don't change this" vs "verify this is done"), so they must not be collapsed into one action.
Without `resolved`, users dismissed with a note of "Fixed" — which fed the Reviewer a waiver saying
the user had decided it *would not be changed*, the exact opposite of what they meant. The migration
that adds the state reclassifies historical dismissals whose note was `Fixed`/`Done`.

**Undo** returns a decided finding to `open`, clearing its note and `decided_at`.

### Routes

- `PATCH /api/tasks/:taskId/findings/:findingId` — `{state: 'open'|'dismissed', note?}`. Scoped by
  task as well as id, so a finding id from another task is not mutable through this route.
- `POST /api/tasks/:taskId/findings/fix` — `{findingIds: string[]}`. Posts a user reply containing
  only the selected findings, marks them `fixing`, resets the review loop, and queues the task. The
  reply also lists any dismissed findings as explicit do-not-touch, so the Implementer does not
  "helpfully" fix a waived issue it can still see earlier in the conversation.

`GET /api/tasks/:taskId` gains a `findings` array.

### One problem per issue

`REVIEW_DECISION_FORMAT` requires each entry in `issues` to be exactly one problem, because each
entry is a separate decision the user has to make. Two call sites needing the same guard is ONE
issue naming both, and the remedy belongs inside that issue's text rather than as its own entry.
On `a22ff87b` a single "wrap these two calls in try/catch" problem was emitted as three findings —
the third being the fix instruction for the first two — tripling the triage burden.

### UI

Each finding renders as its own row with **Fix this**, **Already fixed** and **Ignore**. Ignore opens an optional
one-line reason (shown to later reviewers) before confirming. Dismissed findings render struck
through and muted with their reason and an **Undo dismiss** link. A **Fix all N remaining** button
appears when more than one finding is still open. Verdicts recorded before this feature have no
finding rows and fall back to the original flat bullet list plus **Apply suggested fixes**.

### The Implementer closes its own findings

Triage was originally all manual, which turned the findings list into an inbox: the only signal that
a finding had been dealt with was "a later Reviewer didn't mention it", so every already-fixed item
still had to be hand-closed. The Implementer now reports on each finding directly and the Reviewer
verifies, so only genuinely unresolved work reaches the user.

Each finding has a short stable ref (`findingRef` — first 8 chars of its id) used by both agents.

1. Reviewer fails with findings A, B, C. All three go to the Implementer, tagged with their refs and
   marked `fixing`, along with `FINDING_REPORT_FORMAT`.
2. The Implementer ends its turn with
   `FINDING_REPORT: [{"ref":"...","status":"fixed|not_fixed|disagree","note":"..."}]`.

   `parseFindingReport` also accepts the shapes models actually emit when only one finding is in
   flight and the array feels like ceremony: a single object, an object with no `ref`, and a bare
   status word (`FINDING_REPORT: fixed`). All three resolve to `ALL_IN_FLIGHT_REF` ('*'), which
   `applyFindingReport` expands to every finding the turn was handed — so the prompt requires
   explicit refs whenever there is more than one. The strict-array-only parser silently discarded
   the bare form on task `6745fb16`, reopening a finding the Implementer had genuinely fixed. The
   marker is stripped from the user-visible message **whether or not it parsed** — the array-only
   strip left `FINDING_REPORT: fixed` in the chat when parsing failed.
   - `fixed` → `fixed` (a **claim**, not a conclusion — only the Reviewer can close it)
   - `not_fixed` / `disagree` → back to `open` with the Implementer's reason in `note`, shown to the
     user. These are exactly the calls it should not be making alone.
   - **omitted** → `reopenUnreportedFindings` returns it to `open`. A forgotten finding must not
     vanish.
   Refs are only honoured for findings actually in flight, so a stale or hallucinated ref cannot
   reopen something the user already decided.
3. A Reviewer **pass** closes the entire outstanding set — `open`, `fixing` and `fixed` alike — via
   `closeOutstandingOnPass`. The Reviewer is handed every prior finding with its state and told to
   re-raise anything still present, so passing is its verdict on all of them. Only `fixed` used to
   be promoted, so a finding that came back `open` (e.g. its report failed to parse) survived every
   later pass and sat in the inbox permanently while the UI said "Review passed" — exactly the
   contradiction reported on `6745fb16`. User decisions (`dismissed` / `resolved`) are never
   overwritten by a pass.
4. On a **fail**, the Reviewer is given every `fixed` finding as *"IMPLEMENTER CLAIMS FIXED — you must
   verify this"*. If the fix holds it says nothing and `verifyClaimedFixes` promotes it to
   `verified`. If the fix is inadequate it re-raises with
   `{"text":"<why the fix doesn't work>","reraises":"<ref>"}`, and `reraiseReviewFinding` reopens
   **that same finding** in place with the revised reasoning and `revision + 1` — so a disputed fix
   never leaves a near-duplicate behind.
5. At the loop cap, the user gets only `open` findings: re-raised ones (labelled *"the reviewer
   judged the previous fix inadequate"*) and ones the Implementer handed back or skipped.

`verified` is a checked result, not the old "nobody mentioned it again" guess — the Reviewer was
explicitly instructed to verify each claim. The heuristic label is suppressed for any finding
carrying a real verdict (`revision > 0` or an Implementer note), where it would contradict it.

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

### What a pass does to open findings

A pass settles the **blocking** findings still outstanding (`closeOutstandingOnPass`): the reviewer is
handed every prior finding and told to re-raise any that persists, so passing is its verdict on them. In
proof mode "re-raise" needs a failing test like any other finding, and confirmed proof tests are re-run by
the harness after each implementer turn (Section 17.6) — so a finding closed by a pass has usually been
*verified by execution*, not merely not-mentioned.

Two things a pass never touches: the user's own decisions (`dismissed`, `resolved`) and **advisory**
findings, which were never asserted as defects so a pass says nothing about them. An open finding no later
review mentions is labelled *"A later review didn't raise this again — likely fixed, but not confirmed"*
(a fresh session can simply miss it); that label is never applied to advisory findings.

---

## 17. Evidence-Based Review ("proof, not opinion")

An opinion-based reviewer has the same model's blind spots and its findings are unfalsifiable: the
implementer cannot tell a real bug from a hallucination, and neither can the user. The contract is
therefore: **a blocking finding must be backed by a failing test, and the harness — not the reviewer —
verifies it.** A finding the reviewer cannot demonstrate is advisory and never triggers a fix loop.

### 17.1 What the reviewer must produce

For each blocking finding: the **defect**, the **requirement** it violates (a quote from the task or the
user's later direction, or the existing behaviour/test/doc it contradicts — this guards against invented
requirements; "it would be nicer" is not one), and a **test** that fails on the current code and passes once
the defect is fixed. The reviewer stays read-only (Section 4); it cannot run what it writes, so it emits
the tests in its reply:

~~~text
PROOF_FILE: src/parse.cpm-proof.test.ts
```ts
import test from 'node:test'; …           (the whole test file, in a fenced block)
```

REVIEW_DECISION: {"outcome":"fail","summary":"…","findings":[
  {"defect":"parseRow() crashes on an empty line","requirement":"Task: \"blank lines must be skipped\"","proof":"src/parse.cpm-proof.test.ts"}]}
~~~

Test source travels in **fenced blocks, not inside the JSON**: multi-line code in a one-line JSON string
loses the entire verdict to a single bad escape; a malformed fence now costs one proof (`extractProofFiles`
ignores unterminated blocks; a longer fence lets a test contain ``` itself; the last block for a path wins).

Rules the prompt imposes: one file per finding; file name contains `cpm-proof`; path must not exist; import
the real code (never re-implement it); no network/clock/randomness; assert the requirement, not the current
output; at most 5 findings with proofs; read one existing test for conventions first. `outcome` is only a
*claim* — the harness decides.

### 17.2 Mode selection and the test profile

Before the reviewer launches, `resolveTestProfile` works out how this workspace runs tests. **No runnable
setup → opinion mode**: today's read-and-judge review, recorded on the turn (`review_mode = 'opinion'`) and
labelled in the UI ("Opinion-based review — findings were not checked by running anything").

Profile precedence: **user setting > what the repo says right now > what the implementer last reported.**
Detection beats the implementer's report because it reflects the tree as it is (`package.json` deps and
`test` script, then `pyproject.toml`/`pytest.ini`…, `go.mod`, `*.sln`/`*.csproj`). Supported runners:
`node-test`, `vitest`, `jest`, `pytest`, `go`, `dotnet`. A profile is `{runner, command?, cwd?, suite?}`;
`command` and `suite` are validated (no shell operators) because they reach a shell. `suite` carries a
`node --test` project's glob, which node does not discover for `.ts` files on its own.

### 17.3 Materialising and running the proofs (`review-proof.ts`, `review-io.ts`)

**In the worktree, not a scratch copy.** A scratch copy loses `node_modules`, build output and untracked
files, and `git worktree add` loses the uncommitted work under review. Instead the trust boundary is the
*path*: relative, no `..`, safe characters, inside the tree, not `.git`/`node_modules`, shaped like a test
for the runner, name containing `cpm-proof`, size-capped, and **never overwriting an existing file**. Files
are written base64-encoded (arbitrary code; shell quoting of it is not to be trusted). Each proof runs alone
(120 s timeout) so every result is attributable to one finding; findings sharing a file run it once.

The exit code cannot tell "an assertion failed" from "it never ran", so each runner is invoked with a
machine-readable reporter and parsed (`test-runners.ts`): TAP (`node:test`), jest-JSON (jest, vitest),
JUnit (pytest), `go test -json`, TRX (`dotnet test`). Parsers are tested against **real captured output**
(`__fixtures__/test-runners`) for node:test, jest, vitest and pytest; the go and dotnet parsers follow the
documented formats and have not been exercised against a real runner. `coder ssh` runs commands under a PTY,
so output is CRLF-normalised and ANSI-stripped first.

### 17.4 Classification

| Runner result | Status | Effect |
|---|---|---|
| a test **fails** (assertion, or the code under test throws) | **confirmed** | blocking |
| the test **passes** | **refuted** | dropped; logged; shown collapsed in the UI; fed back to the reviewer so it stops re-raising it |
| suite-level error (didn't load/compile), no tests ran, all skipped, timeout | **unproven** | advisory |
| no test supplied / path rejected / file missing / over the 5-proof cap | **unproven** | advisory |

A failing test whose message shows the **test itself** is broken (`SyntaxError`, `Cannot find module`,
`x is not defined`, `x is not a function`, `module 'm' has no attribute`, `error CS####`, `[build failed]`…)
is unproven, not confirmed. The bias is deliberate: wrongly demoting a real failure costs a repair round;
wrongly confirming sends the implementer chasing a phantom. A runtime `TypeError` from inside the code under
test is *not* in that list — "crashes on empty input" is exactly what a proof should confirm.

**Known limit:** *confirmed* means the test fails, not that the reviewer is right. A hallucinated
requirement can be encoded into a test that fails perfectly. The cited requirement is shown beside the test,
and the implementer may report `disagree`, which goes to the user.

**Repair round.** The reviewer could not run its own tests, so many will be broken for trivial reasons (a
wrong import). Unproven findings whose test was broken get **one** bounded resume of the reviewer session
(`--max-turns 8`, no new findings, only corrected `PROOF_FILE` blocks); the round cannot recurse, and if it
cannot launch the review proceeds with what it has. Repair state is in memory (`reviewContexts`): a server
restart mid-review already abandons the reviewer, since `reconnectWorkingTasks` only reconnects
implementers.

### 17.5 Routing

`routeReview`: **`fail` iff ≥ 1 finding is confirmed** — regardless of the reviewer's own `outcome`.
Refuted findings are dropped; unproven ones become **advisory** findings. A reviewer that says `fail` but
proves nothing yields a pass whose summary says so. In opinion mode the reviewer's word stands, as before.
`CPM_REVIEW_MAX_LOOPS` and escalation are unchanged. Re-raising a finding the implementer claimed fixed now
needs a proof too: an unproven re-raise does not reopen it.

Advisory findings are stored (`review_findings.severity = 'advisory'`), listed in the UI, actionable
one-by-one (**Fix this** / **Ignore**), excluded from the automatic hand-back and from the reviewer card's "Fix all", and
never hold up a deferred completion. (The pinned *unresolved findings* panel lists every undecided finding,
advisory included, so its "Fix all" is the user's explicit choice to act on them.)

### 17.6 Confirmed tests are the fix target

The implementer's fix prompt lists each confirmed finding with its requirement, the failing test's path, the
command to run it and the failure output, and instructs: make the test pass; do **not** edit, weaken, skip or
delete it (if it is wrong, report `disagree`); leave it at its path. **The harness leaves confirmed tests in
the worktree uncommitted** — Mark Complete's commit picks them up, so they become regression tests without
CPM committing anything itself. Refuted and unproven files are removed.

After the implementer's turn the harness **re-runs each confirmed proof** (`reverifyConfirmedProofs`): a pass
promotes the finding to `verified` — by execution, not by anyone's say-so — and a claimed fix whose test
*still fails* goes straight back to the implementer without spending a reviewer pass (it counts against the
loop budget). A proof file that has been moved or deleted is skipped and left to the reviewer.

### 17.7 Data model

`review_findings`: `severity` (`blocking`|`advisory`), `proof_status` (`confirmed`|`unproven`|NULL for
opinion mode), `requirement`, `proof_path`, `proof_output`. `task_turns`: `review_mode`, and `review_proofs`
(JSON of **every** proof attempted, refuted ones included — the log of reviewer quality). Refuted claims are
not finding rows, so they cannot pollute the waiver replay. `workspace_settings.test_profile`.

### 17.8 UI

The reviewer card shows a status pill (`No confirmed defects` for a proof-mode pass — deliberately not
"Passed ✓", since it means the reviewer could not produce a failing test, which is weaker than proof of
correctness — or `Review confirmed issues`) with a tally (`1 confirmed · 2 refuted · 1 unproven`). Each
finding row carries its **confirmed / unproven** badge, the cited requirement, and a collapsed **Show the
test** with the failure output. Advisory notes render in their own group; refuted claims sit behind a
"tested and dropped" toggle. Opinion-mode reviews carry an explicit "not checked by running anything" note.

### 17.9 Token cost

Proof-mode reviews run with `CLAUDE_REVIEWER_PROOF_MAX_TURNS` (40 vs 100), at most 5 proofs, one repair round
of at most 8 turns, and a 5-turn verdict-recovery resume. The reviewer is told to read the diff, the files it
touches and one existing test, and to stop once it has its proofs.

---

## 18. Verification Summary and the Implementer's Test Obligation

Trust in a deliverable comes less from *absence of found bugs* than from *evidence of correct behaviour*.
So the process asks the implementer for that evidence and has the harness — no model — report what it shows.

**Obligation (a per-workspace setting; every task in a workspace where it applies, not only auto-review).**
`buildTestingPrompt` tells the implementer to add or update tests for the behaviour it changes, to name each
test as a plain-English behaviour ("rejects usernames containing @, $, € or ¥"), and to run them. If nothing
is testable it ends with `NO_TESTS_NEEDED: <reason>`; if it set up or changed the runner it ends with
`TEST_PROFILE: {"runner":…,"command":…}` (validated like a user setting, and never overriding one). Both
lines are stripped from the visible message (`implementer-markers.ts`).

Whether the obligation applies is `workspace_settings.test_obligation` (`decideTestObligation`):

| Setting | Runner detected/configured | No runner |
|---|---|---|
| **auto** (default) | obligation on — **use the existing framework; do not add one** | **off** — no prompt, no per-turn report, no "no test runner" card |
| **always** | on, existing framework | on, and the implementer **sets a framework up** as part of the task |
| **off** | off | off |

`auto` follows the tooling on purpose: a Godot (GUT) or Unity (Unity Test Framework) workspace has no
parser here, and the "obvious" framework would be the wrong thing to install into it, so it is left alone
unless someone opts in. Only an explicit *always* may ask an implementer to add a test framework. `off`
never touches the workspace. The setting governs the implementer's prompt and the harness's per-turn report;
proof-mode *review* depends only on whether a runner can be resolved (Section 17.2).

**What the harness computes** (`verification.ts`; stored in `tasks.verification`), at two levels:

| Level | What runs | When |
|---|---|---|
| **tests** (quick) | only the test files the task added or changed, each run individually | after an ordinary implementer turn that changed files |
| **full** | the above **plus** the fail-before comparison **plus** the whole suite | when a review runs (automatic or manual), and on demand via **Run full verification** (`POST /api/tasks/:id/verify`) |

**What can start a `full` run.** Exactly two things, pinned by a test: a reviewer launch (automatic *or* manual —
`launchReviewerOnTask`) and the on-demand request (`POST /api/tasks/:id/verify`, the *Run full verification*
button). Opening a task, `GET`ting it, a poller or a timer never computes one. An ordinary implementer turn
gets `tests`, and only when no reviewer follows. (Canary d11106c6 had `auto_review=0` yet stored a `full`
result stamped 3 minutes after its first turn: with no reviewer launched, the only remaining trigger is an
on-demand request, which `computedAt` — stamped when a run *starts* — dates to that moment. The 3-minute
gap is therefore when someone asked, not a run's duration. The original server log for that window was not
retained, so this is by elimination; on-demand requests now write a `[Harness] full verification requested
on demand` line to the task's stream log so the next case is attributable.)

Why not full every turn: many turns are small tweaks in a conversation, and a suite run (≤180 s) after each
would make iteration miserable for a benefit the user only needs at review time. A full result is **not
recomputed when the tree is unchanged** since the last one (a hash of `HEAD`, the diff against the merge-base
and untracked file contents), so an auto-review followed by a manual one costs one run. The card marks a
quick result as such and offers the button.

**Why not "at completion":** completion runs inside the workspace lock and does fetch/push/merge; a
multi-minute test run there would stall every other task on the workspace, and after the merge the
before-the-change comparison has nothing left to compare against. The user has just seen the last result,
and can request a full one first.

What it computes:

1. the files the task changed **relative to the merge-base** (committed, uncommitted and untracked — never
   `git status` alone, see Section 3) that look like tests — each run individually, per-test results;
2. *(full)* **fail-before, pass-after**: the same test files run against the code as it was *before* the task (a
   `git archive` of the merge-base, the test files laid over it, `node_modules` symlinked — no worktree
   metadata is written to the repository). Labels: `fails without the change` (genuinely exercises the new
   behaviour), `also passes without the change` (guards existing behaviour or proves nothing new),
   `new code: fails without the change` (on the original code the test cannot get past code the task adds:
   a module it creates, or an export it adds to an existing module — see 18.1), `couldn't run without the change` (any other reason the file
   did not load — never claimed to be more than that);
3. *(full)* the project's whole suite (pass/fail/skip counts; an incomplete run is *not* reported as a pass).

### 18.1 Tests for new code: new modules and new exports (`new_code`)

A task that adds a module and its tests used to get `not_runnable` on every test (the import cannot resolve
on the base), which reads as "unknown" when the truth is "this cannot pass without the change". The same was
true of the far more common case: a test of a function the task adds to a module that **already exists** —
on the base the import fails, or the name is `undefined`, because the export isn't there yet. The baseline
now tells the causes apart, **from structured runner output plus the task's own diff**, not from a guess at
an error string:

* **`new_code`** — one of:
  * **new module**: the base run produced a suite-level load failure (no test ran, not a timeout), the runner
    named the modules it could not resolve, and **every one** of them is a file that is absent at the
    merge-base and present in the task (`VerificationIO.addedPaths()`: `git diff --diff-filter=A` against the
    same merge-base as `changedPaths`, plus untracked files; renames count as added at the new path);
  * **new export, at load**: a suite-level load failure where every name the runner said a module does not
    provide is an export **the task adds to that file** (below), and every unresolved module (if any) is new;
    every test in the file gets the label;
  * **new export, at call time**: the file loaded, and a test failed because a name it imported was
    `undefined` when used (`… is not a function` / `is not a constructor`; pytest `module 'a.b' has no
    attribute 'n'`), and that name, traced through the test file's own imports, is an export the task adds.
    Only that test gets the label; its neighbours keep their assertion-level `fails`/`passes`.

  Distinct from `fails` because it is slightly weaker evidence: it proves the test *depends on* the new
  code, not that its assertions check the behaviour. The card says "new code: fails without the change".
* **`not_runnable`** — everything else: a syntax error, a bare package specifier (a missing third-party
  dependency, even if a same-named file was added), an env problem, an unresolved import that exists on the
  base, a **renamed export**, a **changed signature** (the name existed at the base, so nothing was added),
  a name added to a different module than the one imported, a module whose exports cannot be enumerated, a
  timeout, an unreadable added-file list or source, or any failure where the runner named *no* module or
  name (go/dotnet, below).
* A test that **loads and fails by assertion** on the base keeps that verdict (`fails` / `passes`),
  regardless of which modules the task added or changed.

**"Exports the task adds" come from the file's diff, never from the error.** For each existing file a
missing name points at — resolved from the import specifier (relative to the importing file node printed, else
the test file) or pytest's printed module path, and only among files the task changed that exist at the
merge-base (`changedPaths` minus `addedPaths`) — the harness reads the file at the merge-base
(`VerificationIO.baseSources`) and now (`VerificationIO.currentSources`) and compares the exported names
(`addedExports`, `added-exports.ts`, pure and lexical):

* JS/TS: `export function/class/const/let/var/enum/interface/type/namespace`, `export { a, b as c }` (with or
  without `from`), `export * as ns`, `export default`, CommonJS `exports.x =` / `module.exports.x =` /
  `module.exports = { … }`. Comments and string contents are ignored. `export * from`, destructured exports,
  `module.exports = <anything but an object literal>` make the set unknown → `not_runnable`.
* Python: top-level `def`/`async def`/`class`, assignments, and the names `import`/`from … import` bind.
  `from x import *` or a module-level `__getattr__` make the set unknown.
* **Renames are not additions.** If the task removed any export from the same file (Python: a top-level
  def/class/assignment that is no longer bound; dropped imports don't count), the new names are not
  claimed as added: a removal next to an addition is indistinguishable from a rename, which is a changed
  API. This also forgoes the rarer "removed one function, added an unrelated one" case — on the safe side.

To trace a call-time miss the harness also reads the test file (`jsImports`): named, aliased, default and
namespace imports and destructured `require`. A bare name must be one of the test's own bindings; a
property of a namespace binding (`dur.x`) goes to that namespace's module; a property of a module object the
runner's transform generated (below) goes to the test's named import of that name (or, with none, its
namespace imports). A `TypeError` on anything else (`items.map is not a function`) is a bug, not a missing
export, and is classified as before.

Where error text is matched it is per runner, in `test-runners.ts` (`extractUnresolved`,
`extractMissingExports`, `missingAtCall`), producing `RunReport.unresolved`/`missingExports`; fixtures are
real runs (`*-newmod.*`, `pytest-nothere-name.xml`, `*-newexport-*`):

| Runner | New module | New export | Resolved against |
|---|---|---|---|
| node:test | `Cannot find module '<spec>'` | native ESM (`.mjs`, or tsx with `"type": "module"`): load-time `SyntaxError: The requested module '<spec>' does not provide an export named '<n>'`, with the importer's `path:line` above it. tsx in CommonJS mode: call-time `(0 , import_<m>.<n>) is not a function`; a destructured `require`: `<n> is not a function`; a namespace: `<ns>.<n> is not a function` | relative specifiers from the importing file's directory, with the TS convention (`./x.js` → `x.ts`/`x.tsx`), extension probing and `index.*`; absolute paths only inside the scratch tree; bare specifiers never |
| vitest | vite's `Failed to resolve import "<spec>"`, `Cannot find module` | call-time only (vite rewrites imports): `(0 , __vite_ssr_import_<k>__.<n>) is not a function`, `__vite_ssr_import_<k>__.<n> is not a constructor`; namespace imports are rewritten the same way | as above |
| jest | `Cannot find module '<spec>'` | call-time only: `<n> is not a function` (CommonJS `require`), `(0 , _<m>.<n>)` (babel), `(0 , <m>_1.<n>)` (ts-jest/tsc) | as above |
| pytest | `ModuleNotFoundError: No module named 'a.b'`; `ImportError: cannot import name 'b' from 'a'` read as `a.b` (`from a import newmod`) | collection-time `ImportError: cannot import name '<n>' from '<a.b>' (<path>)` — the same text as the new-submodule case; either explanation is accepted. Call-time `AttributeError: module '<a.b>' has no attribute '<n>'` | new module: `a/b.py`, `a/b/__init__.py`, or any added `.py` under a new `a/` (also under a `src/` prefix). New export: the printed path inside the scratch tree, else the one changed `a/b.py` / `a/b/__init__.py` |
| go, dotnet | — | — | not classified: a missing package or name is a build failure (`undefined: X`, `CS0117`) whose wording is not captured from real runs, and a build failure can't be split per test, so these stay `not_runnable` |

**Mixed files.** A load failure takes the whole file down, so the baseline cannot say which individual
tests needed new code. The choice: **every test in the file gets `new_code`** when the file's only blocker is
new code. That is the honest reading of "this file cannot pass without the change", it stays visibly weaker
than `fails`, and the alternative (`not_runnable` for the whole file) would throw away the one fact we do
know. Caveat: a runner reports the *first* unresolved import or missing export, so a file with one new-code
import and an unrelated second broken one is `new_code` until the first is fixed; the current-tree run (which
must pass for a tick at all) rules out the second being broken now. Call-time misses don't have this
problem: they are per test.

**Cost.** The extra reads happen only when a base run failed over a missing name: one read of the test file
(call-time, JS) and one `git show` plus one `cat` per module it points at. Everything else costs nothing more.

**Hard limits — a hung test cannot hold a task in `working`.** Every layer is bounded: each run is wrapped in
`timeout -k 5` *inside the workspace* (120 s per file, 180 s per suite; it signals the whole process group, so
a test's child processes die too — verified by a test that spawns a never-exiting child); each ssh call is
killed by node after 150 s / 210 s; and the whole step races a wall-clock budget (`CPM_VERIFY_*_BUDGET_SEC`),
polled between runs (`shouldStop`) and enforced from outside (`withBudget`). When the budget wins the task
moves on, the late result is discarded, and a "did not finish" summary is stored so the card says so instead
of showing stale numbers. Proof runs get the same treatment (`CPM_PROOF_BUDGET_SEC`, a `deadline` on
`verifyProofs`). Quick check: 150 s; full: 480 s. Not covered: a workspace with no `timeout` binary relies on
the ssh kill (the PTY hang-up normally ends the remote process group); the reviewer/implementer `claude`
processes themselves are bounded by `--max-turns`, not wall-clock, as before.

**What the card leads with: what this task added or changed.** A task that touches a test file used to list
every test in it, and most of those pass on the original code too and prove nothing about the change — a wall
of ticks that defeats the card's purpose. Each test is now marked (`markAddedTests`, pure, in
`verification.ts`):

- `added: true` — its name is not in that file at the merge-base (or the whole file is new).
- `routine: true` — a pre-existing test (`added: false`) that passes, is not a reviewer proof test, and does
  **not** fail on the original code. Nothing about it is evidence for this change.
- Everything else — added tests, **anything failing**, reviewer proof tests, and an old-named test that fails
  without the change (it must exercise something the task changed) — stays prominent. A file whose base source
  cannot be read leaves `added` undetermined and its tests prominent: the filter errs toward showing.

**"Added" is name-based; "changed" is not detected.** A test whose body was edited under an unchanged name is
not noticed (unless it fails on the original code, which makes it prominent anyway). This was chosen because
it is the one mechanism that is cheap and identical across all six runners: one `git show <merge-base>:<file>`
per touched file (`VerificationIO.baseSources`), then `testExistedAtBase` looks for the name in the old
text — as a quoted title (jest/vitest/node:test, trying the whole name and then ≥2-word suffixes to peel off
`describe` prefixes), as the method name (pytest/dotnet, parameters stripped), or segment by segment (go
subtests, underscores for spaces). Misses (parameterised titles built at run time, `it.each`) read as *added*,
so the error is toward showing a test, never hiding one. Comparing bodies was rejected: finding a test's body
needs a per-language parser.

The stored `tests` array is ordered strongest-evidence-first (`orderTests`): currently failing, then
`fails` (fails on the original code, assertion level), then `new_code`, then the rest (`passes`,
`not_runnable`, no baseline), then the `routine` ones. The card renders the prominent tests and folds the rest
into an expandable "+ N existing tests in touched files still pass". Whole-suite counts and the headline
counts (`summariseVerification`) are unchanged — they still count every test.

The reviewer receives these results as facts (`buildVerificationBlock`, test lines from `reviewerTestLines`) —
filtered the same way, so it is not flooded: the change's own tests are listed, and the routine ones become one
line ("+N existing tests in the touched files … still pass and are not listed") so it knows they exist. It is asked to **audit the tests**:
does each assertion check what its name says, is any requirement untested? Weak or missing coverage is an
advisory finding (a missing test cannot itself be demonstrated by a failing test).

**UI.** A *What was verified* card at the end of the conversation (absent in workspaces where the obligation
is off) lists each test as a tick/cross with its
name and baseline label, the suite tally, files that could not be run, and — when there are no tests — the
implementer's stated reason or a plain "nothing verified this change". The no-tests reason is shown only when
the change carries no tests of its own: the implementer sometimes emits `NO_TESTS_NEEDED` even though it added
one ("not applicable, a test was added"), so the prompt now says never to write the line when any test was added
or changed, and `buildVerification` drops the stored reason whenever any non-routine test exists. It says on its face what is and isn't
trustworthy: **names are the implementer's words; a tick means the harness ran the test and it passed.**

**Limits.** Tests the implementer writes share the implementer's understanding of the requirement — the
reviewer audit and the human reading the checklist are the check on that, which is why the list is in plain
English. Repos with dependencies outside the tree (a venv, a compiled `dist/`) may show
`couldn't run without the change`. Monorepos with several roots need `cwd` in the profile.

## 19. Coverage: a review must not "pass" code it never saw

Observed on two dogfood reviews: the reviewer said "the diff was truncated, I didn't see `verification.ts`"
and still emitted `pass`. A pass from a reviewer that never saw the code is false confidence, so the harness
now tracks coverage itself rather than trusting the verdict.

**What the reviewer was shown** (`review-coverage.ts`, `buildReviewDiff`; fetched by `getReviewDiffInfo` in
`review-io.ts`). "Changed" is the same merge-base definition as everywhere in `review-io.ts` (`BASE_SNIPPET`:
committed + uncommitted + untracked). The diff is packed whole file by file within the 32k-char budget; one
file may be cut, only at a hunk boundary. Whatever did not fit is recorded exactly — path, reason, and for a cut
file how many hunks of how many were shown. Untracked files have no diff, so they are always "omitted".

**Exempt files.** Lockfiles (`package-lock.json`, `yarn.lock`, `Cargo.lock`, …), generated output (`dist/`,
`*.min.js`, `*.map`, …) and binaries are left out of the diff first (they cost budget and need no review) and
are listed to the reviewer as exempt. They never make a review partial.

**The reviewer is told, and must read them.** When anything was omitted the prompt lists each file and says the
reviewer MUST open every one with Read/Grep before deciding, and that the harness checks its tool calls. The
turn cap is raised modestly for it: +3 turns per omitted file, at most +24 (`reviewerTurnCap`).

**The verdict carries coverage.** `REVIEW_DECISION` gains an optional
`"coverage":{"reviewed":[…],"notReviewed":[{"file","reason"}]}`. The parser is tolerant: strings or objects,
a few key spellings, placeholders dropped; a missing or garbled field leaves `coverage` undefined, meaning
"unverified", and the tool-call evidence alone decides.

**The harness checks, it does not trust** (`assessCoverage`). The poller records the reviewer's `tool_use`
blocks (kept across the wrap-up resume). A changed, non-exempt file counts as reviewed only if its whole diff was
shown, or the reviewer opened it: `Read` of it, `Grep` pointed at that file, or a read-only `Bash` command naming
it. A `Grep` over a directory is a search, not a read. A claim of "reviewed" never counts without one of those.
The reviewer's own admission ("not reviewed") can only add to the unreviewed set, and never beats a tool call
that proves the file was opened.

**Outcome.** `coverageOutcome`: a `fail` with a confirmed proof stays a fail, regardless of coverage. A `pass`
with any unreviewed file becomes a **partial review**:

- stored as `task_turns.review_outcome = 'partial'` — a first-class value, so every reader (MCP `get_task`,
  the API, filters) sees it and nothing mistakes it for a pass. `review_proofs` carries only the coverage detail
  (`{"coverage":{…}}`); there is no second copy of the verdict. The summary reads
  "Partial review — not seen: a.ts, b.ts";
- shown as an amber "Partial review — not seen: …" badge with the per-file reasons, not the green one;
- not a pass for completion: it does not close outstanding findings (`closeOutstandingOnPass`) and it cancels a
  deferred "complete when the review passes";
- never loops back to the implementer: nothing is known to be wrong. The task settles to `awaiting_feedback`;
- says so when the turn cap was what stopped the reading (`stoppedByTurnCap`, `turnCap` in the report);
- offers **Review remaining files** (`POST /tasks/:id/review` with `{"remaining":true}`). The server reads the
  unreviewed list from the latest review itself (never from the client) and the re-run is scoped to exactly
  those files (`onlyFiles`), so the rest of the change is neither shown nor re-required.

**Migration.** Existing databases get `widenTaskTurnOutcome` (`server/db/index.ts`): `task_turns` is rebuilt
(create new, copy by column name, drop, rename, recreate the index) in one transaction with `foreign_keys` OFF
around it — `review_findings.turn_id` cascades, so dropping the old table with enforcement on would delete every
finding. It runs after the `review_mode`/`review_proofs` ALTERs, because the rebuild copies those columns, and is
a no-op once the table already allows `partial` (fresh installs get it from `schema.sql`). The old constraint,
`IN ('pass','fail',NULL)`, never rejected anything (NULL in the list makes the test NULL, which a CHECK accepts);
the new one is `IS NULL OR … IN (…)` and does.

Not covered: a server restart mid-review loses the in-memory context (`reviewContexts`), so that review has no
coverage record and is reported as before.

### Running the tests

`npm test` runs every `server/**/*.test.ts` with `node:test` via `tsx` (no extra dependency). They cover the
verdict parser, the per-runner output parsers (against captured real output), proof classification and
routing, the implementer markers, the verification summary, and — against real temporary git repositories
with a real `node:test` runner and a local shell standing in for `coder ssh` — the whole
write → run → classify → clean-up path and the fail-before baseline. `review-findings.test.ts` needs
better-sqlite3's native module and skips itself if it is not built; so does `manual-review.test.ts`, which
pins that the review trigger returns before the verification/launch finishes and that a failure after the
response is recorded on the task.

