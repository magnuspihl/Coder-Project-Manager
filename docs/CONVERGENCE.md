# Tasks / Chat Convergence

## Goal

Collapse the two parallel subsystems — **Tasks** and **Chat (discussions)** — into one (**Tasks**), and delete Chat entirely. After the worktree changes, Tasks and Chat behave nearly identically and Tasks is already a near-superset; maintaining both means duplicating participant tables, message tables, catch-up builders, and pollers.

## Target end state

One concept: **Tasks**. Every task is a write-enabled, worktree-isolated Claude session that supports:

- the queue / lifecycle (`queued → working → awaiting_feedback → completed/failed/cancelled`)
- auto-review
- multi-agent participants, `@mentions`, and catch-up/nudge
- `[TASK_REQUEST]` for delegating discovered work

There is **no advisory/read-only mode**. Chat (`discussions*` tables, routes, services, `DiscussionModal`) is removed.

## Locked decisions

1. **Advisory/read-only mode is removed.** It only existed because of the shared-filesystem read-only requirement, which worktrees obsoleted. It is already vestigial — `getDiscussionPromptPrefix` only emits read-only text in the no-worktree fallback branch.
2. **`[TASK_REQUEST]` is kept but repurposed** from "propose because I can't act" to **work delegation/splitting**: a task agent discovers out-of-scope work and emits a `[TASK_REQUEST]` for user approval into a separate tracked task, instead of fixing it inline or creating it via the CPM API. The task system prompt must instruct: *"if the user asks you to create a task, or you find out-of-scope work, emit `[TASK_REQUEST]` — do NOT create tasks via the CPM API directly."*
3. **Delegated tasks always branch from `main`.** If work is worth delegating, it's because it's a common/general problem, not specific to the discovering task. No inheriting the parent's worktree/branch.
4. **Multi-agent conversations are kept** (participants, `@mentions`, catch-up/nudge) and must work on the task side.

## Phases

### Phase 1 — `[TASK_REQUEST]` in Tasks (fixes the original bug; independently shippable)

- **Data model:** drop `NOT NULL` on `task_requests.discussion_id`, add nullable `task_id` (+ migration in `server/db/index.ts`). Keep `target_workspace_*` for cross-workspace delegation.
- **Parsing:** generalize `parseTaskRequests`/`createTaskRequest` to accept a task or discussion origin; call it from the main task poller **and** `startTaskParticipantPolling` (both the assistant-text and result-text branches).
- **Routes:** `/tasks/:id/task-requests/:rid/approve|dismiss|target`, mirroring `server/routes/discussions.ts`.
- **Client:** lift the approval-card UI out of `DiscussionModal` into a shared component; render it in `TaskDetailModal`.
- **Prompt:** add the delegation instructions + API guardrail to the task system prompt. Approved delegated tasks branch from `main`.

### Phase 2 — Multi-agent parity on Tasks

- Catch-up/nudge endpoints for tasks (`/tasks/:id/catchup`, `/tasks/:id/participants/:pid/catchup`).
- `parseMentions` wired into the task pollers.
- Merge `buildTaskParticipantContext` and `buildCatchUpContext` into one shared builder.

### Phase 3 — De-duplicate shared machinery

- Unify `task_participants` + `discussion_participants` (identical schema) and the participant service logic.
- Decide `messages` vs `discussion_messages` (differ only by `turn_id`): unify behind a discriminator, or leave separate until Phase 4 makes `discussion_messages` disposable (lower-risk, preferred).
- Unify the poll-key scheme (`task:` / `disc:` / `task-p:`) and extract one shared launch/poll core.

### Phase 4 — Migrate & delete Chat

- Data migration: convert open discussions → tasks (carry participants + messages).
- Delete `discussions*` tables, `server/routes/discussions.ts`, discussion services, `DiscussionModal`, and the Chat nav entry.
