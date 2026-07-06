# CPM — A Visual Overview

**Coder Project Manager (CPM)** is a web app that turns Claude Code from a single
interactive terminal session into a **managed, multi-workspace task queue**. You
queue work, CPM runs Claude inside the right Coder workspace, and you review and
iterate through a chat UI — without babysitting a terminal.

This document is the picture-first tour. For the full spec see
[`SPEC.md`](./SPEC.md); for the concurrency model see [`WORKTREES.md`](./WORKTREES.md).

---

## 1. CPM in relation to Coder

Coder gives you **workspaces** (cloud dev environments) and the **auth + transport**
to reach them. CPM sits on top as an **orchestration layer** — it never replaces
Coder, it drives it. Auth, workspace ownership, and access control all stay with
Coder; CPM only borrows the user's token to act *as that user*.

```mermaid
flowchart TB
    User([User / Browser])

    subgraph CPM["CPM — orchestration layer"]
        UI[React UI]
        API[Express API + WebSocket]
        DB[(SQLite<br/>tasks · messages · sessions)]
        UI <--> API
        API <--> DB
    end

    subgraph Coder["Coder — platform layer"]
        OAuth[OAuth2 / token auth]
        RestAPI[REST API<br/>list workspaces]
        SSH[coder ssh<br/>exec transport]
    end

    subgraph WS["Coder Workspaces (dev environments)"]
        WS1[workspace A<br/>Claude Code CLI]
        WS2[workspace B<br/>Claude Code CLI]
    end

    User --> UI
    API -->|"who are you?"| OAuth
    API -->|"list my workspaces"| RestAPI
    API -->|"run claude in ws"| SSH
    SSH --> WS1
    SSH --> WS2
```

| Layer | Owns | CPM's relationship |
|---|---|---|
| **Coder** | Workspaces, users, RBAC, network transport | CPM is a *client* — it authenticates as the user and calls Coder |
| **CPM** | Task queue, conversation history, streaming UI | Adds workflow that Coder doesn't provide |
| **Claude Code** | Actually doing the work inside a workspace | CPM launches and resumes it; it runs *in* the workspace, not on the CPM server |

**Key principle:** CPM implements *no* authorization of its own. It keeps the
user's Coder token server-side in the SQLite `sessions` table; the browser holds
only an opaque, httpOnly `session_id` cookie that keys into that row. Every Coder
call is made with the stored token — so a user can only ever touch workspaces
Coder already lets them touch.

---

## 2. How CPM layers Claude on top of Coder

CPM never runs Claude on its own server. It uses Coder's SSH transport to launch
the `claude` CLI **inside the target workspace**, where Claude has native access
to the filesystem, git, tools, and its own on-disk memory. CPM's job is to
**spawn, stream, parse, and persist**.

```mermaid
sequenceDiagram
    participant U as User
    participant S as CPM Server
    participant DB as SQLite
    participant C as coder ssh
    participant CC as Claude CLI<br/>(in workspace)

    U->>S: Create task "Fix flaky test"
    S->>DB: insert task (status=queued, new session UUID)
    Note over S: queue slot free → launch
    S->>C: coder ssh ws -- claude -p "..." --session-id UUID<br/>--output-format stream-json
    C->>CC: exec inside workspace
    loop streaming
        CC-->>S: {type:"assistant", text:"..."} (NDJSON)
        S-->>U: WebSocket: output / tool_call
        S->>DB: store assistant messages
    end
    CC-->>S: {type:"result", session_id, cost}
    S->>DB: status = awaiting_feedback
    S-->>U: status_change

    U->>S: Reply "add a margin"
    S->>C: coder ssh ws -- claude -p "..." --resume UUID
    Note over CC: full prior context restored from disk
```

The **session UUID** is the thread of continuity:

- **First run** → `--session-id <uuid>` (creates the session on the workspace).
- **Every reply** → `--resume <uuid>` (Claude reloads full history from
  `~/.claude/projects/` on the workspace — survives CPM restarts).

Each task runs in its own **git worktree** on its own branch (see `WORKTREES.md`),
so multiple tasks in one workspace never step on each other. "Mark Complete"
commits → pushes → opens a PR → merges → removes the worktree.

```mermaid
flowchart LR
    T[Task] -->|owns| SID[session UUID]
    T -->|runs in| WT["git worktree<br/>~/.cpm/worktrees/task-uuid"]
    T -->|gets| PORTS["port range<br/>40000–40999 (chunks of 10)"]
    WT -->|branched from| MAIN[origin/default branch]
    T -->|Mark Complete| PR[commit → push → PR → merge → remove worktree]
```

---

## 3. How task queueing works

Each workspace has its own ordered queue. CPM runs **up to `max_concurrent`
tasks per workspace at once** (default 3; set to 1 for strictly sequential).
`processQueue` fills free slots in `position` order.

```mermaid
stateDiagram-v2
    [*] --> queued
    queued --> working: slot free (working_count < max_concurrent)
    working --> awaiting_feedback: Claude finishes
    awaiting_feedback --> working: user replies (--resume)
    awaiting_feedback --> completed: Mark Complete (commit·push·PR·merge)
    working --> failed: SSH / workspace / Claude error
    working --> cancelled: user cancels
    queued --> cancelled: user cancels
    failed --> working: retry (resume in same worktree)
    completed --> [*]
```

The scheduler loop, run whenever a task is created or reaches a terminal state:

```mermaid
flowchart TD
    Start([processQueue for workspace]) --> Count{working_count<br/>&lt; max_concurrent?}
    Count -->|no| Wait[wait — slots full]
    Count -->|yes| Next{any queued<br/>tasks?}
    Next -->|no| Done[nothing to do]
    Next -->|yes| Pick[pick lowest-position queued task]
    Pick --> Launch[create worktree · assign ports · launch Claude]
    Launch --> Count
```

Rules that fall out of this:

- A task ending (**completed / failed / cancelled**) re-runs `processQueue`, which
  pulls the next queued task in — the queue auto-advances.
- Only `working` tasks count against `max_concurrent`. When a task reaches
  `awaiting_feedback` it **frees its slot**, so a queued task can launch while
  another awaits your feedback. Replying re-queues the task, which must
  re-acquire a slot before it resumes.
- `position` uses gaps (10, 20, 30…) so `queued` tasks can be reordered without
  rewriting every row.
- On CPM restart, **all** `working` tasks are reconnected (not just one).

---

## 4. Inter-workspace communication (invited agents)

A task has a **host** agent (its own workspace). You can **invite other
workspaces** into the task as *participants* ("advisors"). Every agent — host and
guests — reads and writes **one shared message log**; each keeps its **own Claude
session** on its **own workspace**. This lets an agent in workspace A consult an
agent in workspace B within a single conversation.

```mermaid
flowchart TB
    subgraph Task["One Task = one shared conversation"]
        LOG[(messages log<br/>participant_id tags the speaker)]
    end

    subgraph A["Host workspace"]
        HA["Claude session<br/>(host)"]
    end
    subgraph B["Invited workspace B"]
        PB["Claude session<br/>(participant)"]
    end
    subgraph C["Invited workspace C"]
        PC["Claude session<br/>(participant)"]
    end

    HA <-->|reads / writes| LOG
    PB <-->|reads / writes| LOG
    PC <-->|reads / writes| LOG
    User([User]) <-->|reads / writes| LOG
```

### Turn-passing: the `[MENTION:]` tag

There is **no round-robin or lock** on who speaks. Turn-passing is entirely
event-driven: any agent can emit `[MENTION:workspace_name]` in its response. CPM
scans every message as it's written and *nudges* the mentioned agent — but only if
that agent is **idle** and has **unseen context**.

```mermaid
sequenceDiagram
    participant H as Host (ws A)
    participant L as CPM (shared log)
    participant P as Participant (ws B)

    H->>L: "...need the schema. [MENTION:workspace-b]"
    Note over L: parseTaskMentions() on every message
    L->>L: resolve mention → participant B, is B idle?
    L->>P: launch: buildContext(delta since B last spoke) + nudge
    Note over P: coder ssh ws-b -- claude --resume B's session
    P->>L: "the schema is X. [MENTION:workspace-a]"
    L->>H: nudge host with the new context
    H->>L: continues the task
```

**Context building** — when an agent is nudged, CPM hands it only what it hasn't
seen: messages since its own last turn, minus its own prior output, formatted as a
`[TASK CONTEXT] … [END CONTEXT]` block prepended to the prompt. So each agent
catches up without re-reading the whole thread.

Two things drive a participant to speak — and *only* these two:

| Trigger | Source |
|---|---|
| `[MENTION:workspace_name]` in any message | Automatic — emitted by any agent |
| Explicit nudge / direct message | Human, via the task UI / API |

There is **no** end-of-conversation broadcast: if the host's final turn contains no
`[MENTION:]`, participants stay quiet until mentioned or nudged. A concurrency
guard skips a launch if that participant is already running, so nudges can't
double-fire.

### How a workspace joins

```mermaid
flowchart LR
    U([User]) -->|"POST /tasks/:id/participants"| INV[invite workspace B]
    INV --> REG[addTaskParticipant:<br/>new row + own session UUID]
    REG --> SYS["system message:<br/>'workspace-b joined as an advisor'"]
    SYS --> READY[B idle until mentioned or messaged]
```

Each participant is tracked in `task_participants` with its own
`claude_session_id` and detected `project_dir`; guests run as
`coder ssh <their-workspace>` child processes, so they operate in *their* codebase
while collaborating in the *host* task's conversation.

---

## Summary

```mermaid
flowchart LR
    Coder[Coder<br/>auth · workspaces · SSH] --> CPM[CPM<br/>queue · chat · streaming]
    CPM --> Claude[Claude Code<br/>runs in-workspace]
    CPM -.multi-agent.-> Invited[Invited workspaces<br/>shared log · MENTION]
```

- **Coder** provides identity, workspaces, and the pipe to reach them.
- **CPM** adds the queue, the conversation, and the real-time UI — delegating all
  auth to Coder.
- **Claude** runs *inside* each workspace, one resumable session per task (and per
  invited participant).
- **Invited agents** collaborate through one shared log, passing turns with
  `[MENTION:]` — no central lock.
