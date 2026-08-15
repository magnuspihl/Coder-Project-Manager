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

   **Scope guard (learned the hard way).** The right stance is **opposite for the two roles**, so `buildTaskDelegationPrompt` takes a `role` and must keep doing so:

   - **Host** (owns the task, works in an isolated worktree): leads with *"DO THE WORK YOURSELF"*. "Out-of-scope" is narrow — work *unrelated* to the current task that is better done in isolation, or work belonging to another workspace. A request is **not** an escape hatch; the agent must finish its own task, including the fixes, refactors and adjacent changes that task genuinely needs.
   - **Participant** (invited advisor): leads with *"DO NOT CHANGE THE PROJECT YOURSELF — DELEGATE"*. It holds `Edit`/`Write`/`Bash` (`DISCUSSION_ALLOWED_TOOLS`) in its workspace's **real checkout, with no worktree**, so delegating is the only way it can safely cause a change.

   Both failure modes have happened. The first version of this prompt to actually reach agents (earlier ones were silently dropped by the `--append-system-prompt` overwrite bug) led with delegation, and hosts began outsourcing their own work. The fix for that was then applied to both roles at once, which pointed advisors at the live repo. Note the asymmetry that makes this sharp: the delegation section rides `--append-system-prompt` on **every** turn, while a participant's read-only boundary is sent **once**, on the session-opening turn (`needsPromptPrefix`) — so a host-flavoured default here quietly outranks that boundary a few turns later. `TASK_REQUEST_REMINDER_HOST` / `_PARTICIPANT` are split for the same reason.
3. **Delegated tasks always branch from `main`.** If work is worth delegating, it's because it's a common/general problem, not specific to the discovering task. No inheriting the parent's worktree/branch.

   **Independence gate (follows directly from this).** Because the new task starts from a clean default-branch checkout and may run before the parent merges, a `[TASK_REQUEST]` is only legitimate if it is **solvable on its own** — no part of it may depend on work being done in the discovering task. If it does depend on that work, the discovering agent must handle it **in the current task**, even when it isn't really part of the same problem. Splitting off dependent work produces a task that cannot be completed as written.

   **The fallback is same-workspace only.** "Do it here instead" is impossible for work in *another* workspace — a worktree is a checkout of its own workspace's repo. Making the gate unconditional silently kills the cross-workspace case that motivated this whole area (Foundry spotting work that belongs to Forge). So dependent cross-workspace work is still filed, with the dependency stated explicitly in the request prompt. Same resolution for a participant, which cannot edit anything and so never has a do-it-here option at all.
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
