# Coder Project Manager

A web application that provides a task queue and conversational interface for Claude Code agents running inside Coder workspaces.

## Problem

When using Claude Code inside Coder workspaces, users interact through a single terminal chat session. This works well for interactive, real-time collaboration, but lacks the ability to:

- Queue multiple tasks and have the agent work through them sequentially
- Step away and return to review results later
- Maintain separate conversational threads per task (for iterative feedback)
- Manage tasks across multiple workspaces from a single UI

## Solution

Coder Project Manager is a central web app that:

1. **Authenticates via Coder** — uses Coder's OAuth2 provider, so only authorized users can access their workspaces
2. **Lists your workspaces** — shows all Coder workspaces you have access to
3. **Manages task queues per workspace** — each workspace has its own ordered list of tasks
4. **Executes tasks via Claude Code** — runs `claude` commands inside the target workspace using Coder's SSH/exec capabilities
5. **Maintains conversational continuity** — each task is a Claude Code session that can be resumed for iterative feedback
6. **Streams output** — shows Claude's progress in real-time as it works

## Key Design Principles

- **The agent runs in the workspace** — not externally. It has full access to the filesystem, git, tools, and Claude Code's memory system.
- **Tasks are conversations** — not fire-and-forget jobs. You can review results and reply to iterate.
- **Coder handles auth** — the app delegates all access control to Coder's existing RBAC.
- **Simple first** — start with a functional MVP and iterate.

## Documentation

- [Technical Specification](./docs/SPEC.md) — full architecture, API design, data model, and implementation details
- [CLAUDE.md](./CLAUDE.md) — instructions for the Claude Code agent building this project

## Tech Stack

- **Backend**: Node.js with Express
- **Frontend**: React with TypeScript
- **Database**: SQLite (via better-sqlite3)
- **Real-time**: WebSocket (ws)
- **Claude Code**: `@anthropic-ai/claude-agent-sdk` (Node.js SDK)
- **Coder Integration**: Coder REST API + SSH exec
