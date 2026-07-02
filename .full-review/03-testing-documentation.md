# Phase 3: Testing & Documentation Review

## Test Coverage Findings (4 Critical, 5 High, 4 Medium, 2 Low)

**State of testing: ZERO.** No test files, no framework (no Vitest/Jest in package.json), no test config, no `test` script. ~8,700-line backend (incl. 3,226-line claude.ts) with no automated verification.

### Bootstrap plan (do first)
Vitest is zero-friction (project is Vite + ESM). Install `vitest @vitest/coverage-v8 supertest`. Config: `pool: 'forks'` for better-sqlite3 native module + module-level singletons; `DATABASE_PATH=:memory:` (or temp file) in setup. **Blocker H4 below**: `getDb()` is a lazy singleton with no reset seam — add `__resetDbForTests()`. First tests: (a) pure tasks.ts DB fns, (b) poller line-splitting, (c) authorization regression suite, (d) SSRF guard.

### CRITICAL
- **TC1. No authorization tests — because there is no authorization** — `server/routes/tasks.ts`, `server/mcp/index.ts`. `getTask` bare `WHERE id=?`. Add ownership checks + regression suite: every mutating route 404s on `task.user_id !== req.user.id`.
- **TC2. SSRF in `/proxy-icon` untested/unmitigated** — `server/routes/workspaces.ts:86-115`. Extract `isAllowedIconUrl` helper, table-test rejects (169.254.169.254, localhost, file://) vs Coder proxy host.
- **TC3. Task state-machine transitions & races untested** — `withWorkspaceLock` (claude.ts:1055), `processQueue` (claude.ts:1076). Test two concurrent completes finalize exactly once; concurrent createTask never collides positions (currently can fail).
- **TC4. Git worktree/merge completion untested** — `handleTaskCompletionGit` (git.ts:491), `handleTaskLaunchGit` (git.ts:311). Test: `git_error` result never marks task completed; worktree creation idempotent when dir exists.

### HIGH
- **TH1. Three stream-json pollers untested (recurring dropped-final-message bug)** — claude.ts:1875/2330/3088. Extract `splitNdjsonChunk(chunk, prevLinesRead)`, pin boundary conditions (trailing newline doesn't over-advance linesRead; final event without newline held as partial; partial not duplicated across polls).
- **TH2. Input validation inconsistent & untested** — createTask only `if(!prompt)` (tasks.ts:59), no type check; parseInt limit/offset no NaN guard. Introduce zod (already transitive dep), table-test boundaries.
- **TH3. Upload path/content-disposition/mime untested** — uploads.ts:77-78 (mime + original_name reflected), linkAttachmentsToTask (uploads.ts:95) no ownership. Test nosniff + no html mime reflection.
- **TH4. DB singleton makes services untestable in isolation** — db/index.ts:11-14. Add `__resetDbForTests()` + `buildSchema(db)` seam.
- **TH5. Auth middleware & token cache untested** — auth.ts:35-49 (60s cache), :58-116 (bearer/cookie branch). Test TTL boundary, eviction on failure, api: session synthesis.

### MEDIUM
- **TM1. No client-side tests at all** — add @testing-library/react + jsdom; prioritize assistant-content rendering (XSS surface) + polling hooks.
- **TM2. `extractVerificationUrl` regex untested** — tasks.ts:467-471, broad unanchored regex → stored clickable link from agent output.
- **TM3. Title-generation fallback regex untested** — tasks.ts:125-139, `while(changed)` loop = ReDoS/infinite-loop risk.
- **TM4. `buildTaskParticipantContext` untested** — tasks.ts:614-711, floor/self-exclusion = correctness + info-isolation concern.

### LOW
- **TL1. No test pyramid** — aim for wide unit base over pure fns, middle band of supertest route tests with SSH/LLM mocked, no live-workspace E2E in CI (costs money, non-deterministic).
- **TL2. No perf/load coverage for hot paths** — getTokenTotalsByWorkspace correlated subquery; N+1 in task-list map (tasks.ts:47-52). Add Vitest bench.

## Documentation Findings (3 Critical, 4 High, 4 Medium, 2 Low)

**Verdict:** SPEC.md and README describe a design that was never built as specified and were never updated. Misleading docs dominate over missing docs (worse failure mode). The four supplementary docs (AUTO_REVIEW/WORKTREES/CONVERGENCE/CONSULT_FOR_AGENTBOX) are accurate but SPEC never points to them.

### CRITICAL (actively misleading)
- **DC1. WebSocket streaming documented as core architecture but does not exist** — app is entirely polling-based. No `ws` dep, no `server/ws/` dir, no client `new WebSocket`. Misleading: CLAUDE.md structure, README:42-43, SPEC.md:35/67/449-470 (full ws://host/ws protocol), SPEC.md:602-606. Fix: replace all ws references with polling model; delete `server/ws/` from CLAUDE.md.
- **DC2. Docs claim Coder tokens encrypted; stored plaintext** — CLAUDE.md ("NEVER store... encrypted HTTP-only cookies"), SPEC.md:184/398-399/412 (`-- Encrypted`). Reality: sessions.ts:34-37,63-66 store raw tokens; no encrypt/decrypt/cipher anywhere; documented `SESSION_SECRET` unused. Fix: correct docs to state plaintext + flag encryption-at-rest as open TODO. (Pairs with security SC3.)
- **DC3. Documented task state machine missing real states** — SPEC.md:77-127 has 5 states; real system adds `cancelled` (schema.sql:20; SPEC wrongly says cancel→failed), `git_error` failure sub-state (routes/tasks.ts:199,260,285,310), auto-review roles (active_turn_role, review_loop_count). SPEC's "one working task per workspace" rule was removed (max_concurrent=3). Fix: rewrite SPEC §3 or mark superseded.

### HIGH
- **DH1. SPEC §6 data model badly out of date** — documents ~13 columns; real tasks table ~35 columns + ~10 undocumented tables (task_turns, stream_log, task_requests, task_participants, workspace_settings, attachments, rate_limits, discussions*). Fix: regenerate from schema.sql or point to it as source of truth.
- **DH2. Dead/legacy schema undocumented as deprecated** — `tasks.branch` (dead, only git_branch used); `discussions*` tables (deprecated per CONVERGENCE.md, retained for rollback). Fix: add `-- DEPRECATED` markers in schema.sql.
- **DH3. REST API surface drastically under-documented** — SPEC §7 has ~15 routes; real surface ~55 + `/mcp`. Undocumented: review/interrupt/catchup/checkout/compact-session/reopen/reset-session/restore/touch/stream-log, participants, git/preview/voice-settings, TTS/STT, /restart. Fix: regenerate from route files.
- **DH4. `/mcp` endpoint + 15 MCP tools entirely undocumented** — server/mcp/index.ts mounted at POST /mcp; major external API. Tool zod schemas are good inline docs but no top-level mention. Fix: add MCP Interface section.

### MEDIUM
- **DM1. No changelog/migration guide despite 30+ live migrations** — parallel-execution migration silently fails pre-upgrade tasks. Add docs/CHANGELOG.md.
- **DM2. README tech stack + framing stale** — lists WebSocket, omits worktrees/auto-review/participants/MCP/voice/memory.
- **DM3. Config env-var docs drift** — SPEC says CODER_CLIENT_ID/SECRET; code reads OAUTH_CLIENT_ID/SECRET (auth.ts:8). SESSION_SECRET unused.
- **DM4. Execution model doc drift** — SPEC describes stash-based sequential; real is worktree-isolated parallel. CLAUDE.md lists `@anthropic-ai/claude-agent-sdk` but code shells out to `claude` via `coder ssh` (no SDK dep).

### LOW
- **DL1. Inline documentation quality is genuinely good (positive)** — sessions.ts, db/index.ts migration hazards, mcp/index.ts attribution, git_error ordering comment (claude.ts:1083-1086). Migrate durable rationale into design docs.
- **DL2. Doc hierarchy/source-of-truth unclear** — 4 docs say they supersede SPEC but SPEC never points forward. Add banner + README links.
