# Coder Project Manager — Agent Instructions

You are building the Coder Project Manager, a web application that provides a task queue and conversational interface for Claude Code agents running inside Coder workspaces.

## Before You Start

1. Read `docs/SPEC.md` thoroughly — it contains the complete technical specification
2. Read this file completely for build/run conventions
3. Ask clarifying questions if anything in the spec is ambiguous

## Project Structure

```
/
├── CLAUDE.md              # This file
├── README.md              # Project overview
├── docs/
│   └── SPEC.md            # Full technical specification
├── package.json
├── tsconfig.json
├── server/                # Express backend
│   ├── index.ts           # Entry point
│   ├── routes/            # API route handlers
│   ├── services/          # Business logic (task queue, claude execution, coder API)
│   ├── db/                # SQLite schema and queries
│   └── ws/                # WebSocket handlers
├── client/                # React frontend
│   ├── src/
│   │   ├── App.tsx
│   │   ├── pages/         # Workspace list, task list, task detail/chat
│   │   ├── components/    # Shared UI components
│   │   ├── hooks/         # Custom React hooks (WebSocket, API)
│   │   └── api/           # API client functions
│   └── index.html
└── data/                  # SQLite database (gitignored)
```

## Tech Stack

- **Runtime**: Node.js 20+
- **Language**: TypeScript (strict mode) for both server and client
- **Backend**: Express
- **Frontend**: React 18+ with Vite as the build tool
- **Database**: SQLite via better-sqlite3 (synchronous, no ORM)
- **WebSocket**: ws library on the server, native WebSocket on the client
- **Claude Code SDK**: `@anthropic-ai/claude-agent-sdk`
- **Styling**: Keep it simple — Tailwind CSS or plain CSS. No heavy component libraries.

## Build & Run Commands

```bash
# Install dependencies
npm install

# Development (runs both server and client with hot reload)
npm run dev

# Build for production
npm run build

# Start production server (serves built client)
npm start
```

## Key Implementation Notes

### Coder API Integration
- The app authenticates users via Coder's OAuth2 provider (experimental feature, must be enabled on the Coder deployment)
- All Coder API calls use the user's OAuth2 access token
- Workspace listing: `GET /api/v2/workspaces`
- Command execution in workspaces: use `coder ssh <workspace> -- <command>` via child_process, authenticated with the user's token
- See SPEC.md Section 4 for full details

### Claude Code Execution
- Each task maps to a Claude Code session with a unique session ID (UUID)
- First run: `claude -p "<task>" --session-id <uuid> --output-format stream-json` inside the target workspace via SSH
- Follow-up/iteration: `claude -p "<feedback>" --resume <uuid> --output-format stream-json`
- Stream the JSON output back to the client via WebSocket
- See SPEC.md Section 5 for full details

### Task Lifecycle
```
queued → working → awaiting_feedback → working → ... → completed
```
- Only one task per workspace runs at a time
- When a task finishes, its status becomes `awaiting_feedback`
- The user can reply (resumes the session) or mark it complete
- When complete, the next queued task starts automatically
- See SPEC.md Section 3 for the full state machine

### Database
- Use raw SQL with better-sqlite3 (no ORM)
- Schema is defined in SPEC.md Section 6
- Migrations: single `schema.sql` file applied on startup
- All timestamps in UTC ISO 8601

### Security
- NEVER store Coder API tokens in the database — keep them in encrypted HTTP-only session cookies
- All API routes require authentication
- Authorization is Coder's RBAC via the user's token **for anything Coder owns** (workspaces, users). For data CPM owns, CPM must scope it itself — Coder has no opinion on it:
  - Tasks are per-user (`requireTaskAccess`; `listTasks` filters by `user_id`)
  - Claude subscription accounts (`claude_accounts`) are per-user and never shared. A token there is a bearer credential for a paid subscription, and staging one into a workspace exposes it to anyone with a shell there — so scope every read, write, and resolve by `user_id`
- Validate all user input
- Use parameterized queries for all SQL

### Error Handling
- If Claude Code exits with an error, capture stderr and store it in the task's conversation log
- If SSH to a workspace fails (workspace stopped, etc.), set the task to a `failed` state with the error message
- Surface errors clearly in the UI — don't silently swallow failures

## What NOT to Do

- Don't over-engineer. Start with the simplest working implementation of each feature.
- Don't add features not described in the spec. If something seems missing, ask first.
- Don't use an ORM — raw SQL with better-sqlite3 is intentional.
- Don't add heavy UI frameworks or component libraries.
- Don't implement your own auth system — Coder is the auth provider.
- Don't store secrets in the database or in environment variables committed to the repo. The one deliberate exception is `claude_accounts.token_enc` (Claude subscription tokens), which is encrypted with AES-256-GCM via `server/services/secrets.ts` — a user-supplied credential CPM has to replay later, so there is nowhere else for it to live. Encrypt anything similar the same way; don't add plaintext secret columns.
