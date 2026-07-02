# Review Scope

## Target

Full code review of the entire Coder Project Manager (CPM) codebase for **bugs and optimizations**. CPM is a web app providing a task queue and conversational interface for Claude Code agents running inside Coder workspaces. Repo root: `/home/coder/.cpm/worktrees/task-12a66b6a-2c4f-417a-b5ad-006fb41aa229` (~16,200 lines of TS/TSX).

Primary emphasis (per user request): correctness bugs (race conditions, state-machine errors, resource leaks, error handling, SQL misuse, WebSocket handling) and performance/optimization opportunities. Security issues that constitute bugs are in scope.

## Files

### Server (Express + better-sqlite3 + ws + child_process/SSH)
- server/index.ts — entry point, HTTP + WebSocket setup
- server/db/index.ts, server/db/schema.sql — SQLite schema & queries
- server/middleware/auth.ts — auth middleware (Coder OAuth2, encrypted session cookies)
- server/routes/ — auth.ts, tasks.ts, workspaces.ts, tts.ts, stt.ts, uploads.ts
- server/services/ — tasks.ts (task queue/state machine), claude.ts (Claude Code execution over SSH, stream-json), coder.ts (Coder API), git.ts (worktree lifecycle), sessions.ts, models.ts, port-janitor.ts, workspace-cache.ts, workspace-memory.ts, memory-mcp.ts
- server/mcp/index.ts — MCP server exposure

### Client (React 18 + Vite + Tailwind)
- client/src/App.tsx, main.tsx, api/client.ts
- client/src/pages/ — LoginPage.tsx, WorkspacesPage.tsx
- client/src/components/ — Layout.tsx, Markdown.tsx, RateLimitBanner.tsx, TaskDetailModal.tsx, WorkspacePreviewPanel.tsx
- client/src/hooks/ — useDraft, useIsMobile, useTheme, useTTSVoice, useVoiceMode, useVoiceRecorder, useWorkspacePreview
- client/src/utils/ — chime.ts, kokoroTTS.ts, linkify.tsx, listenChime.ts, whisperSTT.ts
- client/src/workers/ — kokoroWorker.ts, whisperWorker.ts

### Config / build
- package.json, tsconfig.json, tsconfig.server.json, vite.config.ts, vite.preview*.mjs/ts, tailwind.config.js, start-stable.sh

Excluded: node_modules, data/ (runtime DB), docs/ (spec reference only).

## Flags

- Security Focus: no
- Performance Critical: no
- Strict Mode: no
- Framework: Express + React 18 + Vite + better-sqlite3 (TypeScript, strict)

## Review Phases

1. Code Quality & Architecture
2. Security & Performance
3. Testing & Documentation
4. Best Practices & Standards
5. Consolidated Report
