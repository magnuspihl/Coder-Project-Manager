# Phase 1: Code Quality & Architecture Review

## Code Quality Findings (4 Critical, 17 High, 24 Medium, 20 Low)

### CRITICAL
- **C1. SSRF + Coder token exfiltration in `/proxy-icon`** — `server/routes/workspaces.ts:86-115`. Fetches arbitrary `req.query.url` with the caller's `Coder-Session-Token` attached; no host validation → SSRF to metadata endpoints / token exfil. Fix: validate scheme+host, reject private/loopback IPs, only send token to verified Coder hosts.
- **C2. MCP task tools perform no ownership/authorization check** — `server/mcp/index.ts` (~188-211, 283-301, 311-378, 445-493). Task-scoped tools act on `getTask(task_id)` with no Coder RBAC check; any authenticated user can read/destroy others' tasks by ID enumeration. Fix: resolve `task.workspace_id` and `getWorkspace(ctx.token, ...)` before acting.
- **C3. Reviewer verdict text double-appended** — `server/services/claude.ts:2384, 2393, 2440`. Dedup uses tail-slice compare that rarely matches → final verdict appended twice. Fix: track exact last-appended text like the implementer poller.
- **C4. Upload Content-Type/Content-Disposition injection → stored XSS** — `server/routes/uploads.ts:77-78`. Attacker-controlled `mime_type`/`original_name` echoed into headers, served `inline` → HTML upload executes JS on app origin. Fix: `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, whitelist content-type, encode filename.

### HIGH (correctness cluster)
- **H1. Check-then-act outside workspace lock: reply/retry/reset-session/compact-session** — `server/routes/tasks.ts:193-231, 430-455, 461-499, 504-539`. Concurrent requests both pass `awaiting_feedback` guard → duplicated messages + double relaunch. Fix: wrap mutations in `withWorkspaceLock` + re-read, like `complete`.
- **H2. `interrupt` route outside lock** — `server/routes/tasks.ts:542-557`. Can kill null/stale `ssh_pid`, orphaning remote process.
- **H3. `cancel` route check-then-act outside lock; `cancelTask` doesn't set status** — `server/routes/tasks.ts:560-585`. Launch can re-assert `working` after cancel, resurrecting task / leaking SSH.
- **H4. `complete` capacity check assumes `max_concurrent === 1`** — `server/routes/tasks.ts:298-305` + `server/services/tasks.ts:412,431`. Uses `getWorkingTask` (LIMIT 1); with default concurrency 3, completion runs shared-git mutations while another task still works. Fix: `getWorkingTaskCount(workspace) > 0` and none is `fresh.id`.
- **H5. `createTask` position allocation not atomic** — `server/services/tasks.ts:285-298`. MAX(position)+INSERT non-atomic → duplicate positions. Also MAX omits `deleted_at IS NULL`. Fix: `db.transaction`.
- **H6. `linesRead`/`wiped` desync drops stream events on rollback** — `server/services/claude.ts:2009-2035, 1904`. `linesRead` incremented inside transaction; on insert throw, DB rolls back but counter doesn't → `tail -n +N` skips lines permanently. Fix: snapshot+restore or advance after commit.
- **H7. `worktreeHasChanges` swallows SSH failure as "no changes"** — `server/services/claude.ts:486-493, 2157-2159, 581`. Transient SSH failure → auto-review silently skipped. Fix: distinguish empty-output from command-failure.
- **H8. Reconcile of leaked worktrees bypasses workspace lock** — `server/services/git.ts:461-474` via `server/index.ts:56`. Startup `git worktree prune`/`branch -D` without lock can corrupt live worktree metadata.
- **H9. Merge verification silently skipped when `branchTip` capture fails** — `server/services/git.ts:618-621, 669, 726`. Empty `branchTip` → verification skipped → can mark completed unmerged. Fix: treat HEAD-read failure as hard error.
- **H10. Legacy non-worktree completion marks complete with unmerged commits** — `server/services/git.ts:542-562`. `if(!hasChanges) return true` before ancestry check. Fix: route both paths through clean-tree ancestry check.
- **H11. Worktree creation not idempotent** — `server/services/git.ts:341-366`. Retry/relaunch fails on existing branch/dir, silently runs in main dir; two separate DB writes leave inconsistent state on crash. Fix: adopt/reset existing, single DB update.
- **H12. `handleComplete` swallows non-"uncommitted" errors, closes as success** — `client/src/components/TaskDetailModal.tsx:766-780`. Fix: surface error, only close on success.
- **H13. Session refresh disabled when plain-token session shadows OAuth** — `server/services/sessions.ts:203-214`. `ORDER BY created_at DESC` lets non-refreshable API-token session win. Fix: `ORDER BY (coder_refresh_token IS NOT NULL) DESC, created_at DESC`.
- **H14. Unhandled rejections in WorkspacesPage action handlers** — `client/src/pages/WorkspacesPage.tsx:606-662`. Fix: try/catch + setError + finally loadData.
- **H15. Unhandled rejections in TaskDetailModal action handlers** — `client/src/components/TaskDetailModal.tsx:782-848`.
- **H16. Web workers never `terminate()`d on error** — `client/src/utils/whisperSTT.ts:44-50`, `client/src/utils/kokoroTTS.ts:92-101`. Orphaned worker holds ONNX model in memory. Fix: `w.terminate()` before nulling.
- **H17. AudioContext leaked in Kokoro TTS path** — `client/src/hooks/useTTSVoice.ts:204-223`. After ~6 interrupted playbacks, `new AudioContext()` throws, TTS stops. Fix: `ctx.close()` before early return.

### MEDIUM (selected)
- **M1. DB migrations run without transaction** — `server/db/index.ts:24-318`. Crash mid-sequence leaves partial migration with FK enforcement off.
- **M2. STT: 30s timer never cleared; `ffmpeg.stdin` no EPIPE guard** — `server/routes/stt.ts:97-100, 32`.
- **M3. Stale `completing` closure defeats Alt+C guard** — `client/src/components/TaskDetailModal.tsx:386-401`. `[]` deps freeze `completing`. Fix: `completingRef`.
- **M4. setState-after-unmount systemic (no mountedRef)** — TaskDetailModal + WorkspacesPage loadData/loadStreamLog setters.
- **M5. Undo timer setState after unmount** — `WorkspacesPage.tsx:662-670`.
- **M6. `availableVoicesLoadedRef` set true before fetch completes** — `WorkspacesPage.tsx:713-742`.
- **M7. `reopen` fires `handleTaskReopenGit` floating promise, swallowed errors** — `server/routes/tasks.ts:365`.
- **M8. `generateTitleAsync` uncapped floating subprocess, no length cap** — `server/services/tasks.ts:105-122`.
- **M9. `getMessages` treats limit=0/NaN as "no limit"** — `server/services/tasks.ts:511-521`.
- **M10. `updateTaskPosition` unvalidated body.position** — `server/routes/tasks.ts:168-170`.
- **M11. `interruptReviewer` leaks open turn when session id missing** — `server/services/claude.ts:1639-1646`.
- **M12. `get_task` count-then-select TOCTOU** — `server/mcp/index.ts:195-198`.
- **M13. `voice_ids` JSON.parse without try/catch** — `server/routes/workspaces.ts:290`.
- **M14. `assignDefaultVoices` non-atomic count-then-insert** — `server/routes/workspaces.ts:242-263`, runs on every list fetch.
- **M15. `getDefaultBranch` misclassifies repo as `master` on transient failure** — `server/services/git.ts:151-171`.
- **M16. `removeTaskWorktree` retry reports success when probe fails** — `server/services/git.ts:414-424`. Loses pointer to leaked worktree.
- **M17. Port-janitor unvalidated PIDs into remote `kill` loop** — `server/services/port-janitor.ts:181-182`.
- **M18. Anthropic model-list fallback back-dates success cache** — `server/services/models.ts:91-97`.
- **M19. `data.workspaces` used as array without validation** — `server/services/coder.ts:279-281`. Use allSettled per-workspace.
- **M20. `handleFileSelect` desyncs pendingFiles/uploadedAttachmentIds** — `TaskDetailModal.tsx:408-427`.
- **M21. `useVoiceRecorder.stopRecording` can hang forever; unmount setState** — `useVoiceRecorder.ts:44-127`.
- **M22. `useVoiceMode` silence timeout can send truncated transcript** — `useVoiceMode.ts:145-167`.
- **M23. `useWorkspacePreview` effect keyed on length, misses URL drift** — `useWorkspacePreview.ts:77-115`.
- **M24. Kokoro worker abandons WebGPU iterator on WASM fallback** — `client/src/workers/kokoroWorker.ts:60-72`.

### LOW (selected)
L1-L20 include: refresh-token rotation handling (sessions.ts:142-150), unbounded caches leaking memory incl. plaintext tokens (auth.ts:24, coder.ts:104, workspace-cache.ts), parseInt env vars without NaN guards (port-janitor.ts:34,50), cookie `secure` inconsistency (auth.ts:153 vs 117), PKCE state not bound to browser (auth.ts:42), `/restart` runnable by any auth user (workspaces.ts:118), client `res.json()` on 204 (client.ts:21), uploads stream no error handler (uploads.ts:79), useTheme localStorage no try/catch, and several more.

## Architecture Findings (3 Critical, 6 High, 6 Medium, 4 Low)

### CRITICAL
- **AC1. No per-resource authorization** — every `/tasks/:taskId` handler resolves task by ID with no `task.user_id === req.user.id` check. Cross-tenant read/mutate/delete. Fix: `loadOwnedTask` middleware. (Overlaps C2 from quality review.)
- **AC2. Workspace-list aggregates leak all users' data** — `server/routes/workspaces.ts:60-81`. `getTaskCountsByWorkspace`/`getTokenTotalsByWorkspace`/`getGithubRepoUrlsByWorkspace` are global, no user_id filter. Fix: scope by user_id.
- **AC3. Task state machine not enforced in one place** — `updateTaskStatus` accepts any string, no transition table; rules scattered across ~5 files + route handlers. DB-level concurrency guard was dropped (idx_tasks_one_working_per_workspace). Fix: single `transition(task, toState)` validator.

### HIGH
- **AH1. `claude.ts` is a 3,227-line god-module** with 34 exports / ~6 responsibilities. Split into ssh.ts/queue.ts/review.ts/rate-limits.ts/recovery.ts/participants.ts.
- **AH2. Circular dependency `claude.ts` ↔ `git.ts`** — extract `sshExec`/`buildCoderEnv`/`detectProjectDir` into leaf `ssh.ts`.
- **AH3. Three near-identical output pollers** (~250 lines each) — `startFilePolling`/`startReviewerPolling`/`startTaskParticipantPolling`. Root of recurring "lost final message" bugs. Extract `pollRemoteJsonl`.
- **AH4. Completion business logic duplicated in route + `processQueue`** — kept in sync by hand. Extract single `completeTask(task)` service.
- **AH5. Missing transactions around multi-statement invariants** — only 3 `db.transaction()` exist; createTask, finalizeReviewer routing, reset/retry/reply all non-atomic.
- **AH6. Migration logic unstructured/unversioned inside `getDb()`** — ~330 lines re-run every startup, no schema_version table. Add versioned migration runner.

### MEDIUM
- **AM1. Spec's WebSocket architecture silently replaced by polling** — no `server/ws/`, no ADR. N modals = N polls/3s hitting DB. Consider SSE / consolidated poll.
- **AM2. Denormalized workspace_name (no rename propagation); dead discussion tables; legacy `tasks.branch` column.**
- **AM3. Auth middleware writes to DB and forges a Session object.**
- **AM4. In-memory maps as coordination primitives lose state on restart** — document single-instance assumption; ensure correctness-affecting state is DB-reconstructable.
- **AM5. Inconsistent error contracts** — 502 vs 500, 400 vs 409/417; createTask swallows real error.
- **AM6. `TaskDetailModal.tsx` is 2,230-line god-component** — extract hooks/subcomponents.

### LOW
- AL1. `fetchGitHubToken` hardcodes provider id `'magnuspihl'` (git.ts:21).
- AL2. Title generation shells out to `claude` on CPM host (tasks.ts:110).
- AL3. `verification_url` regex-extracted + UPDATE on every assistant message (tasks.ts:467-497).
- AL4. `unhandledRejection` handler logs and continues, can mask stuck-working tasks (index.ts:23).

## Critical Issues for Phase 2 Context

Security/perf review should focus on:
- **Authorization**: no per-resource ownership check on task routes (AC1) and MCP tools (C2/quality); workspace aggregates leak cross-user data (AC2). This is the dominant security theme.
- **SSRF**: `/proxy-icon` forwards Coder token to arbitrary URLs (C1).
- **Stored XSS**: upload serving with attacker Content-Type/Disposition (C4).
- **Injection**: port-janitor interpolates unvalidated PIDs into remote shell (M17); verify SSH command construction / shellEscape usage throughout git.ts and claude.ts.
- **Race conditions / concurrency**: task state transitions outside workspace lock (H1-H5), non-atomic DB writes (H5, AH5), in-memory locks not DB-backed (AC3).
- **Performance**: per-modal 3s polling hitting DB (AM1); three duplicate pollers with setInterval; unbounded in-memory caches (L3); floating uncapped subprocesses (M8); Promise.all vs allSettled in listWorkspaces (M19); web worker / AudioContext leaks (H16, H17).
- **Secrets**: plaintext tokens cached indefinitely in memory (L3); token in cookies vs DB.
