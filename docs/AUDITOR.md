# The auditor

An independent account of what a task built, and where it duplicates existing code or departs from the repo's conventions. The verifier (proof-mode reviewer, see `AUTO_REVIEW.md`) answers "is it broken?"; the auditor answers "what is this, and did it reuse what we already have?" without taking the implementer's word for it.

It is **non-blocking**: it never sends work back to the implementer and never changes the task's status. It reports to the human.

## When it runs

- **Automatically, once per implementer-turn count**, right after a review settles on **pass or partial** (`routeVerifiedReview` → `maybeLaunchAudit`). Never during a fail loop — there is no point explaining code that is about to change.
- **On demand**: the "Run audit" button, `POST /api/tasks/:id/audit`, or the MCP tool `audit` (next to `review`). Refused while the task is `working`.
- **Per-task setting** `tasks.audit`: `NULL` (the default) follows `auto_review`; `0`/`1` is an explicit choice (`PUT /api/tasks/:id {audit: true|false|null}`, or the "audit on/off" select in the task header). The spec asked for a per-workspace setting; there is no workspace settings table, so this follows the existing per-task `auto_review` pattern instead. An explicit `audit = 1` with auto-review off never fires automatically (there is no review to follow) — use the button.
- **Skipped, with a recorded reason**, when the change is docs-only or under `AUDIT_MIN_CHANGED_LINES` (20, `audit-report.ts`; lockfiles and other exempt files do not count). The skip is a `task_audits` row (`status = skipped`, `reason = "audit skipped: docs-only change"` / `"audit skipped: 7 changed lines (under 20)"`) and a system message on the task, so its absence is explained. A skip is not re-evaluated on every pass; it is once per implementer-turn count like everything else. Manual runs skip only when there is no diff at all.

### Cancellation and re-run

Every implementer launch calls `cancelAudit(task, 'code is changing')`. A running audit becomes `cancelled` with that reason (never left `running`), its remote process is killed, and the next pass/partial review audits again (`auditDue`: a `cancelled` audit does not count as "this code was audited"). A server restart marks leftover `running` rows `cancelled` ("server restarted") at startup. A `failed` audit is *not* retried automatically (retry by hand); `done`, `running` and `skipped` are not repeated for the same implementer-turn count.

## Independence and the two phases

A fresh, read-only `claude -p` session on the workspace, hardened like the reviewer: `--setting-sources ''` (no CLAUDE.md discovery), the reviewer's read-only tool allowlist minus the test/lint runners, a turn cap, the reviewer's model precedence (task `reviewer_model` → `CLAUDE_REVIEWER_MODEL` → task model), the task's Claude subscription. It is **not** a `task_turns` row and not the task's active role, so it cannot hold the task in `working`, block a reply, or delay the queue. Its output is not written to the conversation (only to the stream log); token usage is added to the task's totals.

- **Phase 1** gets: the task title and prompt, the merge-base diff (committed + uncommitted + untracked, capped at 60 000 chars — it can read the rest itself), the changed-file list, the repo's architecture guidance **inlined** (CLAUDE.md, ARCHITECTURE.md, docs/**.md of the worktree; 40 000 char budget, whole files first, overflow listed by name), the harness-computed facts, and the mandatory export checklist. It does **not** get the implementer's summary or the conversation. It ends with an `AUDIT_REPORT: {...}` line.
- The harness verifies citations, assembles the report, and **stores it** (`task_audits.report_json`, `phase = comparing`) *before* phase 2.
- **Phase 2** is a `--resume` turn in the same session. Only now is it given the implementer's summary (last assistant message of the last implementer turn that said anything, with `[WAKE]`/`[TASK_REQUEST]`/`NO_REVIEW_NEEDED`/`TEST_PROFILE` markers stripped) and asked for **discrepancies only**. Only the `discrepancies` field of its answer is read; a revised summary or new findings are ignored. If phase 2 fails, times out, or there is no summary, phase 1 stands with `discrepancies: null` and a `discrepanciesNote`.
- If phase 1 hits the turn cap without a report, one resumed recovery turn asks for the report from what it has read.

Budget: `CLAUDE_AUDITOR_MAX_TURNS` (default 40) for phase 1, 4 for recovery, 8 for phase 2, 15 minutes wall-clock per process. Expect on the order of 100–300K cached input tokens per audit, which is why small and docs-only changes are skipped.

## The report (`AUDIT_REPORT`)

Parsed as tolerantly as `REVIEW_DECISION` (markdown wrapping, pretty-printing, the marker mentioned in prose before the real one, placeholder echoes rejected). Fields:

| field | from | notes |
|---|---|---|
| `summary` | model | what was built, 3–6 sentences |
| `structure` | model | `added` / `modified` files with purpose / change |
| `reuseFindings` | model, checked | `reused` (cite new + existing), `possible_duplicate` (MUST cite both: new code and **pre-existing** code), or `new` (nothing existing found — added so a genuinely new abstraction is not forced into a false "reused") |
| `deviations` | model, checked | departures from documented rules or established patterns, with citations |
| `hardToReverse` | **harness** | dependencies (package.json before/after), schema (SQL files, `ALTER`/`CREATE` in code), routes added/removed, MCP tools registered/removed, env vars read for the first time. Regexes over the diff — best-effort, labelled "detected from the diff". The model may only attach a one-line `note` by fact id; unknown ids are dropped |
| `discrepancies` | model, phase 2, checked | `unsupported_claim` / `unmentioned`; `null` = not compared |
| `unassessedExports` | **harness** | exports the change added that the auditor gave no `reuseFindings` entry for |

### The export checklist is a floor

The harness computes every export the change adds (`added-exports.ts`, over new files and existing ones) and tells the auditor it must give each one a reuse entry; names it skipped are listed as `unassessedExports`. Non-exported helpers, and anything in a language `added-exports.ts` cannot enumerate (it answers "can't tell" rather than guessing), are still at the model's discretion.

### Citation verification

Every `file:line` / `file:start-end` is resolved (`audit-citations.ts`, line counts read by `audit-io.ts`): the file must exist and the range must fit. `possible_duplicate`'s *existing* citation must resolve **at the merge-base**, so it is genuinely pre-existing and not another file the task added; its *new* citation must resolve in the current tree. A citation that does not resolve is **kept and flagged** ("citation could not be verified", with the reason) rather than dropped or trusted; `verified: false` on the finding. Paths that would need shell quoting tricks are never measured.

## Storage

Table `task_audits` (created by `schema.sql`, `CREATE TABLE IF NOT EXISTS`) rather than a new `task_turns.role` — a role would need another `CHECK` rebuild like `partial` did and every consumer of turns assumes two roles. One row per run: `status` (`running|done|failed|cancelled|skipped`), `phase`, `trigger_kind`, `implementer_turns`, `base_sha`, `head_sha`, `tree`, `session_id`, `report_json`, `reason`. Plus `tasks.audit INTEGER` (nullable).

### Staleness

`implementer_turns` records how many implementer turns had run when the audit started. Once more have run, the audit is `stale` and the card and MCP output say **"stale — code changed since this audit"**. Limitation: this sees changes made by CPM turns, not edits made to the worktree by hand outside any turn (`head_sha` and `tree` are stored for that, but checking them needs the workspace and is not done on every read).

## Surfaces

- **Card** (`AuditCard.tsx`), after the verification card: possible duplicates, deviations and hard-to-reverse facts first; then "What was built" (summary, structure, reuse entries) collapsed; then discrepancies. Each finding has **Make this a task**, which creates a pending task request (`POST /api/tasks/:id/audit/findings/:findingId/task-request`) — the same object `[TASK_REQUEST]` produces, approved or dismissed in the existing "Proposed Task" card. The prompt says the new task starts from the default branch, which may not contain the audited changes.
- **API**: `GET /api/tasks/:id/audit`; `GET /api/tasks/:id` also returns `audit`; `POST /api/tasks/:id/audit` (202).
- **MCP**: `get_task` includes `audit` as a summary (status, stale, counts, "use get_audit"); `get_audit` returns the full report; `audit` triggers a run.

## Deploy notes

Needs a **server restart** (and `npm run build:server` first — the server runs compiled `dist`). **Migration**: automatic on startup — `ALTER TABLE tasks ADD COLUMN audit` and `CREATE TABLE IF NOT EXISTS task_audits`; no table rebuild, nothing to backfill (`NULL` follows `auto_review`). The client needs a rebuild too. New env var: `CLAUDE_AUDITOR_MAX_TURNS` (optional).

## Files

`audit-report.ts` (shape, tolerant parsing, assembly, gate, staleness — pure) · `audit-facts.ts` (hardToReverse — pure) · `audit-citations.ts` (pure) · `audit-prompt.ts` (pure) · `audit-io.ts` (workspace reads, parameterised on `exec`) · `audits.ts` (DB + views) · `claude.ts` ("Auditor" section: launch, cancel, process runner).
