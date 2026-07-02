# Comprehensive Code Review Report — Coder Project Manager (CPM)

## Review Target

Full code review of the entire CPM codebase (~16,200 lines of TS/TSX across `server/` and `client/`) for bugs and optimizations. CPM is a web app providing a task queue and conversational interface for Claude Code agents running inside Coder workspaces (Express + better-sqlite3 + `coder ssh` child processes; React 18 + Vite frontend; polling-based transport).

## Executive Summary

The codebase is capable and thoughtfully commented at the function level, but has grown well past its spec into a large multi-user system without the structural, security, and testing foundations that scale demands. **The single dominant issue is a complete absence of per-resource authorization**: any authenticated Coder user can read, drive, and destroy any other user's tasks (over both REST and MCP) by enumerating IDs — and because replies resume another user's agent inside their workspace with their OAuth token, this is effectively remote-code-execution-by-proxy. Alongside that, there is a cluster of task-state race conditions (mutations outside the workspace lock), several git-completion bugs that can mark work "done" while unmerged, a server-crash risk from unhandled child-process spawn errors, zero automated tests, and no CI pipeline. Nothing here is unfixable, and the fixes are mostly well-contained; the authorization gate and the task-state locking are the two changes that matter most before this grows further.

## Findings by Priority

### Critical Issues (P0 — Must Fix Immediately)

1. **No per-resource authorization (REST + MCP)** — `server/routes/tasks.ts` (all `:taskId` handlers), `server/mcp/index.ts` (all task tools), `server/services/tasks.ts:262` (`getTask` unscoped). Cross-tenant read/reply/retry/delete/complete by ID enumeration; reply/reset resumes another user's agent in their workspace with their token. *[Security SC1/SC2, Architecture AC1, Testing TC1]* — CVSS 9.1. Fix: `loadOwnedTask` middleware returning 404 on `task.user_id !== req.user.id`; mirror in every MCP task tool; scope `listTasks`/aggregates by user_id.

2. **Plaintext Coder OAuth tokens (access + refresh) stored in SQLite** — `server/services/sessions.ts:34-37,63-66,143-150`. Directly violates CLAUDE.md ("NEVER store tokens in the database"); DB read/backup/snapshot → account takeover for all users. Documented `SESSION_SECRET` is unused. *[Security SC3, DevOps OC2, Docs DC2]* Fix: AES-256-GCM at rest with env/KMS key, or the spec's encrypted-cookie design.

3. **SSRF + Coder token exfiltration via `/proxy-icon`** — `server/routes/workspaces.ts:86-115`. Fetches arbitrary `req.query.url` with the caller's `Coder-Session-Token` attached; no host validation. *[Security SH1, Quality C1]* — CVSS 8.6. Fix: validate host matches Coder deployment, block private/link-local, https only.

4. **Stored XSS via uploaded-file serving** — `server/routes/uploads.ts:77-79`. Attacker-controlled `mime_type`/`original_name` echoed into `Content-Type` + `Content-Disposition: inline`; HTML upload runs JS on app origin → drives victim tasks. *[Security SH2, Quality C4, Best-practices BC2/BH2]* Fix: `attachment` disposition, `nosniff`, whitelist/verify content-type by magic bytes, encode filename.

5. **Spawned child processes have no `'error'` handler → server crash** — `server/services/claude.ts:~1470,~2310,~3058`. A failed `spawn` (coder/bash missing, ENOMEM, EMFILE) emits async `'error'`; no listener → whole process crashes; try/catch does not catch it. *[Best-practices BC1]* Fix: `.on('error', ...)` after each spawn, mark task failed.

6. **Reviewer verdict text double-appended to task chat** — `server/services/claude.ts:2384,2393,2440`. Tail-slice dedup rarely matches → final verdict appended twice. *[Quality C3]* Fix: track exact last-appended text.

7. **Production `build` script omits schema-copy → prod DB init fails** — `package.json:11-12`. `npm run build && npm start` on a clean checkout can't find `schema.sql`. *[Best-practices BC4]* Fix: `"build": "vite build && npm run build:server"`.

8. **No CI/CD pipeline** — nothing gates push/PR (no build/typecheck/lint/test); root cause of recurring "Build failed". *[DevOps OC1]* Fix: GitHub Actions — `npm ci`, `tsc --noEmit` ×2, `npm run build`, node_modules-tracked guard, boot smoke test.

### High Priority (P1 — Fix Before Next Release)

**Task-state race cluster** (all in `server/routes/tasks.ts`, mutations outside `withWorkspaceLock`): reply/retry/reset-session/compact-session (H1), interrupt (H2), cancel + `cancelTask` doesn't set status (H3). Plus `complete` capacity check assumes `max_concurrent === 1` while default is 3 (H4), and `createTask` position allocation is non-atomic (H5). Fix: wrap check-then-act in the lock + re-read; `getWorkingTaskCount > 0` guard; `db.transaction` for position.

**Git worktree/merge completion bugs** (`server/services/git.ts` + `claude.ts`): `linesRead`/`wiped` desync drops stream events on rollback (H6); `worktreeHasChanges` swallows SSH failure as "no changes" → auto-review silently skipped (H7); reconcile bypasses workspace lock (H8); merge verification skipped when `branchTip` capture fails → completes unmerged (H9); legacy path marks complete with unmerged commits (H10); worktree creation not idempotent (H11).

**MCP `cancel_task`/`delete_task` kill the wrong target** — `server/mcp/index.ts:467,484` pass `task.workspace_id` to `cancelTask(taskId)`; SSH process never killed. Fix: `cancelTask(task.id)`.

**Client silent failures & resource leaks**: `handleComplete` swallows errors + closes as success (H12); unhandled rejections in action handlers (H14/H15); web workers never `terminate()`d → ONNX models leak (H16); AudioContext leaked → TTS breaks after ~6 playbacks (H17); Alt+C stale closure double-completes (BC3).

**Session refresh disabled when plain-token session shadows OAuth** — `sessions.ts:203-214`. Fix: order by refresh-token presence.

**Other P1**: `/restart` runnable by any authenticated user (SH3); workspace-list aggregates leak all users' data (SH4/AC2); Express 4 async handlers have no error middleware (BH1); module-level Maps never drain → memory leak (BH5); side-effecting async work inside a DB transaction (BH6); no `uncaughtException` handler / no graceful shutdown (OH1/OH2); no health endpoint (OH3/OH4); hardcoded `'magnuspihl'` provider breaks portability (OH5).

**Performance P1**: every backend poll spawns a full `coder ssh` (SSH handshake per tick) — dominant bottleneck (PC1); no WebSocket, everything polls (PC2); `/api/workspaces` N+1 to Coder + rejects-all on one failure (PC3); `getTokenTotalsByWorkspace` full-table scan with continuously-busted cache (PH2); unbounded in-memory caches (PH3); `/tasks/:taskId` recomputes full payload every 3s per modal (PH4); uncapped `generateTitleAsync` subprocesses (PH1).

### Medium Priority (P2 — Plan for Next Sprint)

- DB migrations run without transactions / unversioned inside `getDb()` (M1/AH6/OM6); add `PRAGMA user_version` runner.
- Three near-duplicate stream-json pollers (AH3) — extract `pollRemoteJsonl`/`splitNdjsonChunk`; root of the recurring dropped-final-message bug class.
- `claude.ts` 3,227-line god-module (AH1) + `claude.ts↔git.ts` circular dependency (AH2) — extract leaf `ssh.ts`, split by seam.
- `TaskDetailModal.tsx` 2,230-line god-component (AM6) — extract hooks/memoized subcomponents; index-as-key on stream log (BH10); parallel files/ids arrays desync (M20/BH9).
- setState-after-unmount systemic (M4/M21/BM15); stale-closure keyboard handlers (M3/BH8); undo/TTS timers fire after unmount (M5/BM4).
- Input validation gaps: `getMessages` limit=0/NaN → all rows (M9); `updateTaskPosition` unvalidated (M10); `voice_ids` JSON.parse no try/catch (M13); createTask no prompt type check (TH2).
- `getDefaultBranch` misclassifies as `master` on transient failure (M15); `removeTaskWorktree` reports success on failed probe (M16).
- Unsafe casts of untrusted CLI stream JSON (BM8); `assignDefaultVoices` non-atomic + runs every list fetch (M14/PM8).
- Missing composite index `idx_tasks_ws_status_position` (PM1); client `JSON.stringify` diffing every poll (PM4); no list virtualization (PM5).
- Workspace-settings routes lack RBAC (SM1); PKCE state not browser-bound (SM2); cookie `secure` inconsistency (SM3); CORS reflects any origin (SM4/OL2); no security headers/helmet (SM5); verbose stderr surfaced to users (SM6).
- Unstructured logging (OM1); pollers not observable (OM2); non-atomic deploy/stale-dist risk (OM3); no Node engine pin (OM4).

### Low Priority (P3 — Track in Backlog)

- Refresh-token rotation handling (L1/L2); unbounded token cache stores plaintext (L3); parseInt env vars without NaN guards (L4/BM3); `useTheme` localStorage no try/catch (L10); `client.ts` `res.json()` on 204 (L13/BM11); Markdown deprecated `children` prop (BM13); alert/confirm for errors (BM14); non-null assertion overuse (BL5); extra strict flags off (BL7); poll intervals not unref'd (BL3); unused deps `react-router-dom` + `react-syntax-highlighter` (BH3/BH4/PL1); no manual Vite chunking (PL2).
- **Downgraded**: port-janitor "PID shell injection" (was M17) → Informational; PIDs are numeric-guaranteed by remote awk and reaping is off by default. Add `/^\d+$/` defense-in-depth anyway.
- Extensive duplication/technical debt: completion-git decision ladder duplicated route vs queue (AH4); per-function ssh-token shadow wrappers; participant/task-request route guards; `renderWorkspaceColumn` ~510 lines.

### Documentation (accuracy — actively misleading, treat as P1/P2)

- WebSocket documented as core architecture but does not exist; app is entirely polling-based; CLAUDE.md lists nonexistent `server/ws/` (DC1).
- Docs claim tokens encrypted; stored plaintext (DC2 — pairs with P0 #2).
- Documented 5-state task machine missing real states `cancelled`, `git_error`, auto-review roles; "one working task per workspace" rule removed but still documented (DC3).
- SPEC §6 schema (~13 cols) vs real ~35 cols + ~10 undocumented tables (DH1); dead `tasks.branch` + `discussions*` undocumented as deprecated (DH2); ~55 REST routes + `/mcp` (15 tools) undocumented (DH3/DH4); env var names drift CODER_* vs OAUTH_* (DM3).

## Findings by Category

- **Code Quality**: 65 findings (4 Critical, 17 High, 24 Medium, 20 Low)
- **Architecture**: 19 findings (3 Critical, 6 High, 6 Medium, 4 Low)
- **Security**: 17 findings (3 Critical, 4 High, 6 Medium, 3 Low) + 1 downgraded
- **Performance**: 20 findings (3 Critical, 6 High, 8 Medium, 3 Low)
- **Testing**: 15 findings (4 Critical, 5 High, 4 Medium, 2 Low) — baseline: zero tests
- **Documentation**: 13 findings (3 Critical, 4 High, 4 Medium, 2 Low)
- **Best Practices (lang/framework)**: 42 findings (4 Critical, 11 High, 15 Medium, 12 Low)
- **CI/CD & DevOps**: 16 findings (2 Critical, 5 High, 6 Medium, 3 Low)

Note: many findings overlap across categories (e.g., no-authz appears in Security, Architecture, and Testing; plaintext tokens in Security, DevOps, and Docs). The de-duplicated unique-issue count is roughly 90–100.

## Recommended Action Plan

1. **Authorization boundary (P0 #1)** — add `loadOwnedTask` middleware + enforce in every MCP task tool; scope `listTasks` and workspace aggregates by `user_id`. *Effort: Medium.* Highest leverage — neutralizes the exploit path for several other findings.
2. **Token storage (P0 #2)** — encrypt at rest or move to encrypted cookie; wire+require `SESSION_SECRET`. *Effort: Medium.*
3. **Cheap independent security fixes (P0 #3/#4)** — SSRF host allow-list on `/proxy-icon`; upload serving as `attachment`+`nosniff`; add `helmet` + pin CORS. *Effort: Small.*
4. **Crash/stability (P0 #5, #7)** — child-process `'error'` handlers; fix the prod `build` script; add `uncaughtException` + graceful shutdown + `/healthz`. *Effort: Small.*
5. **Task-state race cluster (P1)** — bring reply/retry/interrupt/cancel under `withWorkspaceLock` with re-read; fix `complete` concurrency check; atomic position allocation; fix MCP cancel target. *Effort: Medium.* Group with the git-completion correctness bugs (H6–H11).
6. **Stand up CI (P0 #8)** — typecheck + build + node_modules guard + boot smoke; then bootstrap Vitest and write the authorization + poller + state-machine regression tests. *Effort: Medium.*
7. **Client silent-failure + leak fixes (P1)** — surface errors, add try/catch, terminate workers, close AudioContext. *Effort: Small–Medium.*
8. **Performance (P1, after correctness)** — persistent `coder ssh` / SSH ControlMaster to kill per-tick handshakes; incremental `total_cost_usd` column; `Promise.allSettled` + bounded/cached port probing; bound in-memory caches. *Effort: Medium–Large.*
9. **Structural refactors (P2)** — extract shared `pollRemoteJsonl`; split `claude.ts`/`TaskDetailModal.tsx`; versioned migrations; centralize the state machine in one `transition()`. *Effort: Large.*
10. **Documentation (P1/P2)** — correct the actively-misleading WebSocket/token/state-machine claims first; regenerate schema/API sections or point to source of truth. *Effort: Small–Medium.*

## Review Metadata

- Review date: 2026-07-02
- Phases completed: 1 (Quality & Architecture), 2 (Security & Performance), 3 (Testing & Documentation), 4 (Best Practices & DevOps), 5 (Consolidated Report)
- Flags applied: none (default full review)
- Method: 8 specialized review agents across 4 analysis phases; every prior-phase claim independently re-verified in Phase 2 (one finding downgraded, two new correctness bugs found).
