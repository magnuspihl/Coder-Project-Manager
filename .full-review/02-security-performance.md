# Phase 2: Security & Performance Review

## Security Findings (3 Critical, 4 High, 6 Medium, 3 Low)

### CRITICAL
- **SC1. No per-resource authorization on any task route** — CWE-639/284, CVSS 9.1. `server/routes/tasks.ts` (every handler), `server/services/tasks.ts:262` (`getTask` no user scoping). No `task.user_id === req.user.id` check anywhere; any authenticated Coder user can read/reply/retry/delete/complete any task by ID enumeration (IDs leak via workspace task-lists, stream logs, port owner_task_id, MCP list_tasks). Reply/reset drive another user's Claude agent inside their workspace via their OAuth token → RCE-by-proxy. Fix: `requireTaskAccess` middleware returning 404 on owner mismatch; scope `listTasks` by user_id.
- **SC2. MCP task tools skip the RBAC check workspace tools enforce** — CWE-639/862, CVSS 9.1. `server/mcp/index.ts` get_task/get_task_diff/reply_to_task/complete_task/review/rename_task/interrupt_task/cancel_task/delete_task. Workspace tools call `getWorkspace(ctx.token, ...)`; task tools don't. Fix: enforce `task.user_id === ctx.userId` (and/or probe getWorkspace) in each.
- **SC3. Plaintext Coder OAuth tokens (access + refresh) stored in SQLite** — CWE-312/522, CVSS ~8.1. `server/services/sessions.ts:34-37,63-66,143-150`; `sessions` table TEXT columns. **Directly violates CLAUDE.md** ("NEVER store Coder API tokens in the database — keep them in encrypted HTTP-only cookies"). DB read/backup/snapshot/traversal → all users' refresh tokens → account takeover. Fix: AES-256-GCM at rest with env/KMS key, or spec's encrypted-cookie design.

### HIGH
- **SH1. SSRF + Coder token exfiltration via `/api/workspaces/proxy-icon`** — CWE-918/200, CVSS 8.6. `server/routes/workspaces.ts:86-115`. Fetches arbitrary `req.query.url` with caller's `Coder-Session-Token` attached; no host/scheme validation → exfil token to attacker host or SSRF to `169.254.169.254`. Fix: validate host matches Coder deployment, block private/link-local, https only.
- **SH2. Stored/reflected XSS via uploaded-file serving** — CWE-79/434, CVSS 8.0. `server/routes/uploads.ts:35-49, 77-78`. Attacker-controlled mime_type/original_name echoed into Content-Type + `Content-Disposition: inline`; HTML upload runs JS on CPM origin → drives victim's tasks via SC1. Fix: `Content-Type: application/octet-stream` (or magic-byte-verified image allowlist), `nosniff`, `attachment`, sanitize filename.
- **SH3. `POST /api/workspaces/restart` runnable by any authenticated user** — CWE-285/400, CVSS 7.1. `server/routes/workspaces.ts:117-136`. Runs `npm run build:server` + `process.exit(0)`; trivial DoS for all users. Fix: gate to `CPM_ADMIN_USERS` allowlist + rate limit.
- **SH4. Workspace-list aggregate endpoints leak all users' data globally** — CWE-200, CVSS 6.5. `server/routes/workspaces.ts:77-79`; `server/services/tasks.ts:141,172,187`; `server/routes/tasks.ts:46`. taskCounts/githubRepoUrls/tokenTotals/costs aggregate over ALL users, no user_id filter. Fix: thread req.user.id + `AND user_id = ?`.

### MEDIUM
- **SM1. Workspace-settings routes have no RBAC/ownership** — CWE-862/639. `server/routes/workspaces.ts` git-settings/voice-settings/preview-settings GET/PATCH read/write `workspace_settings` from params with no getWorkspace probe (unlike /memory, /models). Any user can flip another workspace's `git_push_enabled` or preview_url (phishing/clickjacking). Fix: gate behind `withTokenRefresh(getWorkspace(...))`.
- **SM2. PKCE `state` not bound to browser** — CWE-352/1275. `server/routes/auth.ts:17,42,59-72`. Login CSRF / session fixation. Fix: httpOnly SameSite=Lax `oauth_state` cookie compared on callback.
- **SM3. Cookie `secure` set inconsistently** — CWE-614. `server/routes/auth.ts:117` (`APP_URL.startsWith('https')`) vs `:153` (`NODE_ENV==='production'`). Token-login cookie can go plaintext over HTTPS. Fix: one consistent predicate.
- **SM4. CORS reflects any origin with credentials** — CWE-942/346. `server/index.ts:32` `cors({ origin: true, credentials: true })`. Any site can make credentialed calls. Fix: `origin: APP_URL`.
- **SM5. No security headers (no CSP/HSTS/nosniff/frame-options)** — CWE-693/1021. `server/index.ts`. Fix: `helmet()` with tuned CSP; would blunt SH2.
- **SM6. Verbose git/PR/build stderr surfaced into task messages / HTTP** — CWE-209. `server/services/git.ts:612,634,761`; `/restart` returns 2000 chars build stderr. Fix: log server-side, sanitize user-facing.

### LOW
- **SL1. `fetchGitHubToken` hardcodes provider `'magnuspihl'`** — `server/services/git.ts:19-28`. All users' PR ops use one account's credential. Fix: config/env, per-user.
- **SL2. `unhandledRejection` swallows+continues; no rate limiting** — `server/index.ts:23`. No limits on `/auth/token-login` brute force, TTS/STT quota abuse, `/restart`.
- **SL3. Bearer session synthesizes 24h expiry, user cached 60s** — CWE-613. `auth.ts:76-84`. Acceptable given cache; keep TTL short.

### DOWNGRADED FROM PHASE 1
- **port-janitor "shell injection via unvalidated PIDs" (was M17) → Informational.** `server/services/port-janitor.ts:181-182`. PIDs originate from remote awk matching `/^\/proc\/[0-9]+\/fd\/?:$/`, guaranteed numeric; no injection path, and reaping is off by default. Still worth `/^\d+$/` defense-in-depth so safety doesn't depend on trusting remote awk.

### NEW CORRECTNESS BUG (security-flavored)
- **MCP `cancel_task`/`delete_task` kill the wrong target** — `server/mcp/index.ts:467,484` call `cancelTask(task.workspace_id)` but `cancelTask(taskId)` looks up `WHERE id = ?`. The running SSH/Claude process is NEVER killed on MCP cancel/delete; user believes task cancelled while agent keeps running. REST path (`routes/tasks.ts:573`) correctly passes `task.id`. Fix: `cancelTask(task.id)`.

## Performance Findings (3 Critical, 6 High, 8 Medium, 3 Low)

### CRITICAL
- **PC1. Every backend poll spawns a full `coder ssh` process (SSH handshake per tick)** — `server/services/claude.ts:828-862` (sshExec), used by pollOutputAndExit, startFilePolling (5s), startReviewerPolling (3s), startTaskParticipantPolling (5s), port-janitor (30s). No connection reuse. In-flight `coder ssh` count grows with working tasks + reviewers + participants + open modals + workspaces. Dominant CPU/latency/scale bottleneck (~40-60 SSH connects/min under modest load). Fix: pipe remote `claude` stdout over ONE persistent `coder ssh`, or SSH `ControlMaster=auto ControlPersist` to reuse the tunnel.
- **PC2. No WebSocket anywhere — whole app polls, contradicting spec** — `server/index.ts` has no `ws` server. Each open modal polls `/tasks/:taskId` every 3s (working); endpoint does 9+ DB queries + N participant checks + re-serializes entire message list per call. WorkspacesPage polls `/workspaces` every 5s + fan-out getTasks per running workspace. Load scales multiplicatively (users × modals × workspaces). Fix: `ws` push of deltas, or at minimum `?afterMessageId=`/ETag conditional fetch (stream-log endpoint already does this).
- **PC3. `GET /api/workspaces` does N+1 HTTP enrichment to Coder, rejects-all on one failure** — `server/services/coder.ts:271-283, 222, 187, 107`. Per call: 1 list + 1 /listening-ports per running workspace + 1 GET per port + 1 HEAD per favicon, all `Promise.all` (one rejection fails whole board), no concurrency cap. Polled every 5s. Fix: `Promise.allSettled`, bound probe concurrency, cache listening-ports per workspace with longer TTL.

### HIGH
- **PH1. `generateTitleAsync` spawns uncapped `claude` subprocess per task creation** — `server/services/tasks.ts:105-122`. Burst of creates → N heavy processes, PID/RAM exhaustion. Fix: concurrency limiter (max 2-3); heuristic fallback already gives immediate title.
- **PH2. `getTokenTotalsByWorkspace` full messages GROUP BY scan, cache busted continuously** — `server/services/tasks.ts:187-225`. Subquery scans entire messages table; 30s cache invalidated on every addTokenUsage/updateMessageCost (every result event) → re-runs every 5s poll under load, blocking event loop (better-sqlite3 sync). Fix: add `total_cost_usd` task column updated incrementally; avoid the aggregate.
- **PH3. Unbounded in-memory caches/maps, no eviction** — `middleware/auth.ts:24` tokenCache (worst — grows per unique token, leaks forever), `coder.ts:104` probeCache, `claude.ts:793` projectDirCache / `:147` taskActivity / `:154` rateLimitInfo / `:176` workspaceRateLimits. Fix: LRU + max size or timed sweep.
- **PH4. `/tasks/:taskId` recomputes cost + full payload every 3s per open modal** — `server/routes/tasks.ts:121-143`. ~9 queries (getTaskCostUsd aggregate, getTaskParticipants + isTaskParticipantRunning per participant, attachments, turns, pending requests, full getMessages) per poll. Fix: delta fetch + reuse PH2 per-task cost column.
- **PH5. better-sqlite3 synchronous — big scans/parses block event loop** — `claude.ts:1903 processLine, :2025-2029` wipe-and-full-reparse in transaction, `:2721 processRemainingOutput` cats entire file. Large turn parse+reinsert blocks all HTTP. Fix: cap re-parse, avoid wipe-and-full-reparse on reconnect, move heavy JSON parsing off request path.
- **PH6. `processQueue` loads full conversation to peek last message under global lock** — `claude.ts:1076-1131`, `getMessages(next.id)` at :1120 inside `withWorkspaceLock`. Fix: targeted `ORDER BY created_at DESC LIMIT 1` query.

### MEDIUM
- **PM1. Missing composite index for hottest queue query** — `getNextQueuedTask` (`tasks.ts:405`) sorts by `position`; `idx_tasks_workspace_status(workspace_id,status)` doesn't cover sort. Add `idx_tasks_ws_status_position(workspace_id,status,position)`.
- **PM2. `allocatePortRange` scans all working/awaiting tasks every launch** — `claude.ts:30-44`. Fine now; index `port_range_start` if volume grows.
- **PM3. `buildTaskParticipantContext` loads full message list, sometimes twice** — `tasks.ts:614-711`, `triggerTaskHostCatchUp` builds twice (`claude.ts:2940`). Cache per (task, since).
- **PM4. Client `JSON.stringify` of entire state for change detection every poll** — `WorkspacesPage.tsx:305-311`, `TaskDetailModal.tsx:215-228`. Fix: cheap signature (count + last id + last updated_at).
- **PM5. No list virtualization for messages/stream log** — `TaskDetailModal.tsx:1366, 1591` (up to 500 rows). Markdown is memo'd (good) but large initial render unbounded. Consider react-window.
- **PM6. God-components cause wide re-renders** — `TaskDetailModal` 2230 lines, `renderWorkspaceColumn` ~510 lines re-run every 3s poll. Extract memoized children.
- **PM7. `getWorkspaceRateLimits` returns fresh objects each call** — `claude.ts:256-276`, busts client setIfChanged unnecessarily.
- **PM8. `assignDefaultVoices` per-workspace SELECT+UPSERT loop on every `/workspaces` poll** — `routes/workspaces.ts:242-263`. Fix: short-circuit when all assigned.

### LOW
- **PL1. `react-syntax-highlighter` + types are dependencies but never imported** — remove from package.json.
- **PL2. No manual chunking in `vite.config.ts`** — react-markdown/remark land in main chunk; kokoro/whisper correctly lazy. Consider manualChunks.
- **PL3. `RateLimitBanner:28` and `Layout:24` each run own setInterval** — several timers per page; consolidate.

### PERF/SECURITY CROSS-REFERENCE
SH4/AC2 (global aggregates) is also a perf issue: scans grow with total system task count, not requesting user's — scoping by user_id fixes both leak and scan cost.

## Critical Issues for Phase 3 Context (Testing & Documentation)

- **Zero test coverage is the key testing gap** — verify whether any test files/framework exist. Highest-value untested paths: task state machine transitions (the SC1/H1-H5/AC3 race cluster), git worktree/merge completion (H8-H11, merge-verification safety), stream-json poller line-counting (H6/C3/AH3 recurring bug class), authorization gates (SC1/SC2 — once added, must be tested).
- **Documentation drift**: spec (docs/SPEC.md, CLAUDE.md) mandates WebSocket streaming and "tokens never in DB" — both contradicted by implementation (PC2, SC3). Needs ADRs or spec updates. CLAUDE.md lists a `server/ws/` dir that doesn't exist.
- Security fixes (SC1/SC2 authz, SH1 SSRF, SH2 XSS) each need regression tests once implemented.
