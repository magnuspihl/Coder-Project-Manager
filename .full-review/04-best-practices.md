# Phase 4: Best Practices & Standards

## Framework & Language Findings (4 Critical, 11 High, 15 Medium, 12 Low)

Overall competent: polling architecture mostly well-implemented (self-rescheduling setTimeout with cancelled flags, refs-for-latest-value, fully parameterized SQL — no SQL injection found). Serious issues cluster in child-process crash safety, Express 4 async error handling, and untrusted-file serving.

### CRITICAL
- **BC1. `spawn`ed child processes have no `'error'` handler → server crash** — `server/services/claude.ts:1470-1480` (launchTask), ~2310 (executeReviewer), ~3058 (launchTaskParticipant). A ChildProcess that fails to spawn (coder/bash not on PATH, ENOMEM, EMFILE) emits async `'error'`; with no listener Node throws → whole process crashes. Surrounding try/catch does NOT catch it (fires on later tick). `transferFilesToWorkspace` ~989 does it right. Fix: `sshProcess.on('error', err => {...mark task failed})` after each spawn. **[NEW — high-value]**
- **BC2. Stored XSS: uploads served `inline` with attacker MIME** — `server/routes/uploads.ts:77-79`. (Confirms SH2/C4.)
- **BC3. Alt+C fires stale `handleComplete` → double-completion** — `client/src/components/TaskDetailModal.tsx:386-401`. Empty deps freeze `completing`; guard is dead. (Confirms M3 quality.) Fix: read via ref.
- **BC4. Production `build` script omits schema-copy → prod DB init fails** — `package.json:11-12`. `build` = `vite build && tsc` but never `cp server/db/schema.sql dist/server/db/`; only `build:server` copies it. `npm run build && npm start` on clean checkout fails to find schema. Fix: `"build": "vite build && npm run build:server"`. **[NEW]**

### HIGH
- **BH1. Express 4 async handlers throw into the void — no error middleware** — no asyncHandler wrapper, no terminal error middleware in server/index.ts. Thrown DB/logic error leaves request hanging until socket timeout. Fix: `asyncHandler` + `app.use((err,req,res,next)=>...)`.
- **BH2. Content-Disposition header injection via `original_name`** — uploads.ts:78. Fix: `filename*=UTF-8''${encodeURIComponent(name)}` or res.download().
- **BH3. `react-router-dom` completely unused dependency** — remove.
- **BH4. `react-syntax-highlighter` + types unused** — remove (heavy, pulls refractor/highlight.js).
- **BH5. Module-level Maps/Sets in claude.ts never fully drain (memory leak)** — ~137-154,466,474. `interruptedReviews`/`noReviewDeclared`/`taskActivity`/`rateLimitInfo` orphaned on non-happy paths. Fix: single `cleanupTaskState(taskId)` from every terminal transition.
- **BH6. Side-effecting async work fired from inside a better-sqlite3 transaction** — claude.ts ~1937-1938 inside db.transaction ~2025. parseTaskMentions/parseTaskRequests kick off SSH work; if txn rolls back, side effects ran against uncommitted state. Fix: run parsers after commit.
- **BH7. `loadData` unmemoized, passed as `onTaskChanged`** — WorkspacesPage.tsx ~320/1594. New identity every 5s poll. Fix: useCallback.
- **BH8. Alt+N handler closes over stale `runningWorkspaces`** — WorkspacesPage.tsx ~556-578. Fix: read from ref.
- **BH9. Parallel files/attachmentIds arrays desync → wrong attachment removed** — TaskDetailModal.tsx:424-427, WorkspacesPage.tsx:852-855. (Confirms M20 quality.) Fix: single `{file,id,status}[]`.
- **BH10. Index-as-key on live-updating stream log** — TaskDetailModal.tsx:1591-1592 `key={i}`; streamLog sliced to last 500 so i remaps after trim → mis-reconcile. Fix: `key={entry.id}`.
- **BH11. `taskStatusRef` used in `loadData` before declaration (TDZ)** — TaskDetailModal.tsx ref at ~242, used at ~214. Works only because not invoked until after mount. Fix: move declaration up.

### MEDIUM (selected)
- BM1. `error: any` in catch clauses widespread — strict mode gives `unknown` free; use `errMessage(e)` helper.
- BM2. `as any` on DB rows despite existing `Attachment` interface — uploads.ts:43/68/93/102.
- BM3. `parseInt` without radix + no NaN guard — claude.ts:26-28, port-janitor.ts:34, auth.ts:12 → `setInterval(fn, NaN)`.
- BM4. No unmount cleanup in useTTSVoice.ts — audio plays after unmount; untracked setTimeout.
- BM5. Conversation render rebuilds Maps + re-runs Markdown every render — TaskDetailModal.tsx:1354-1468. useMemo + React.memo.
- BM6. Stream read pipe no `'error'` listener — uploads.ts:79 TOCTOU crash.
- BM7. Restart route ungraceful `process.exit(0)` — workspaces.ts ~122-132.
- BM8. Unsafe `as` casts of untrusted claude CLI stream JSON — claude.ts:1536/1920/1931/2377. Add type guards.
- BM9-BM15: wsVoiceSettings effect stale deps; useWorkspacePreview mutates unmemoized candidates; api/client.ts blind `res.json() as T` no empty-body guard; clipboard unhandled rejection; Markdown deprecated `children` prop + as any; alert/confirm for errors; useVoiceRecorder setState after unmount.

### LOW (selected)
- BL1. Non-transactional table-rebuild migrations (db/index.ts:57-91,185-208).
- BL2. probeCache never evicts (coder.ts:104).
- BL3. Poll intervals not unref'd (claude.ts:2123/2456/3223) — graceful shutdown hangs.
- BL5. Non-null assertion overuse (`req.session!`/`req.user!`).
- BL7. Extra strict flags off — noUncheckedIndexedAccess would catch array-index bugs.
- BL9-L12: blind JSON casts in useDraft/useTTSVoice; getAgentStatus ignores multi-agent; setIfChanged JSON.stringify diffing; pkceStore interval not unref'd.

### NON-FINDINGS (verified)
- `@anthropic-ai/claude-agent-sdk` is NOT in package.json — only in docs. No action (code correctly shells out to `claude` CLI).
- No WebSocket/`ws` dep exists — app is entirely polling-based (consistent with package.json).
- SQL fully parameterized — no injection found.
- Shell command strings use shellEscape correctly at all call sites; workspace-name args go through execFile argv (no shell). Not exploitable today; recommend argv arrays.

## CI/CD & DevOps Findings (2 Critical, 5 High, 6 Medium, 3 Low)

### CRITICAL
- **OC1. No CI/CD pipeline whatsoever** — no .github/workflows, no pipeline file. Nothing gates push/PR: no build, typecheck, lint, or test. Broken main discovered only at deploy time (in-process `npm run build:server` fails). Root cause of recurring "Build failed" (committed node_modules symlink). Fix: GitHub Actions on push/PR — `npm ci`, `tsc --noEmit` (both configs), `npm run build`, boot smoke test hitting a health endpoint, and a `git ls-files | grep node_modules` guard.
- **OC2. Prod serves nothing static + plaintext token storage** — (a) server/index.ts has no `express.static`/sendFile; `dist/client` never served. Deployment runs `npx vite &` (dev server) as prod frontend, unsupervised by the backend's while-loop. `vite build` output is dead weight. (b) `schema.sql:190` stores `coder_access_token`/`coder_refresh_token` plaintext (violates CLAUDE.md + SPEC; `SESSION_SECRET` documented but unused). (Confirms SC3/DC2.) Fix: decide prod topology (Express static vs supervised Vite — relay to template orchestrator); encrypt tokens or move to cookie; wire+require SESSION_SECRET.

### HIGH
- **OH1. No `uncaughtException` handler** — server/index.ts:23 only handles unhandledRejection (swallowed). Sync throw in timer/handler crashes process; rejection handler loses stack (`.message.slice(0,200)`). Fix: uncaughtException handler with log+exit(1) paired with supervisor.
- **OH2. No graceful shutdown** — no SIGTERM/SIGINT. No server.close(), no WAL checkpoint, no interval teardown, no child signalling. `reconnectWorkingTasks()` (claude.ts:1705) handles the crash path well; gap is the clean path. Fix: SIGTERM handler → stop new work, server.close, clear intervals, `wal_checkpoint(TRUNCATE)`, exit.
- **OH3. Config drift + no `.env.example` + no startup validation** — SPEC says CODER_CLIENT_ID/SECRET/SESSION_SECRET; code reads OAUTH_CLIENT_ID/SECRET, never SESSION_SECRET. ~28 env vars undocumented. Missing vars → empty-string defaults, deep failures not boot failure. Fix: reconcile SPEC, commit `.env.example`, preflight fail-fast on required vars.
- **OH4. No health/readiness endpoint** — no /healthz or /readyz. Fix: unauth `GET /healthz` (liveness) + `GET /readyz` (DB `SELECT 1` + poller flags).
- **OH5. Hardcoded external-auth provider `'magnuspihl'`** — git.ts:21. Non-portable; other deployments silently get null token, GitHub ops break silently. (Confirms SL1/AL1.) Fix: env var `CODER_GIT_AUTH_PROVIDER` + warn on null.

### MEDIUM
- OM1. Unstructured `console.*` logging (98 calls), no levels/correlation/request logging. Introduce pino + level env + task/user/workspace fields.
- OM2. Pollers/child processes not observable — no metrics (live SSH children, active pollers, queue depth, last-run). Expose on /readyz or /metrics.
- OM3. Deploy flow risks stale code — build runs in two places (start-stable.sh + restart route), non-atomic; partial dist on failed build. Fix: build to temp, atomic swap.
- OM4. No Node engine pin — better-sqlite3 native ABI mismatch risk. Add `engines.node`, use `npm ci`.
- OM5. node_modules-symlink footgun has no guard — gitignore correct but nothing prevents reintroduction. Add CI check.
- OM6. DB migrations ad-hoc inline ALTERs, not versioned — db/index.ts (49 ALTER occurrences), foreign_keys=OFF rebuild block. Partial failure = server won't boot. Fix: `PRAGMA user_version` versioned migrations in transactions. (Confirms M1 quality / AH6.)

### LOW
- OL1. `dist/`, `data/`, `.env`, `*.db` correctly gitignored (positive).
- OL2. `cors({origin:true, credentials:true})` reflects any origin — restrict to APP_URL. (Confirms SM4.)
- OL3. Restart build 120s timeout + 500-char stderr truncation may hide real cause.

### POSITIVES (credit)
`reconnectWorkingTasks()` restart recovery (PID liveness + poll resume + exit-code reconciliation); pollers `.catch()` async errors; sensible SQLite pragmas (WAL, FK on, busy_timeout, cache_size); timers unref'd; lockfile committed; secrets/artifacts gitignored; port-janitor reaping opt-in/off by default.
