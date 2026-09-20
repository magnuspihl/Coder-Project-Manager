# Tasks from GitHub Issues

## 1. Summary

A task can be created *from* an open GitHub issue on the repo the workspace is checked out on, and
stays linked to it for the rest of its life. This is additive: every other task is unaffected.

- **"+ Issue"** sits next to "+ Task" on the workspace card and opens a three-pane browser: the
  repo's open issues, the selected issue's body and comment thread, and a composer for what you
  want done.
- The task's prompt is `Regarding issue #N: <title>` + the issue URL + the issue body (+ the
  comment thread, optional) + your description.
- **Marking the task complete closes the issue. Reopening the task reopens it.** This is the one
  place CPM writes to an external system as a side effect of a normal task transition.

Implementation: `server/services/github-issues.ts`, `client/src/components/IssueTaskModal.tsx`.

---

## 2. Which repo?

`resolveWorkspaceRepo` answers "which GitHub repo do this workspace's issues live on":

1. The `github_repo_url` already recorded on one of the workspace's tasks (free — a column read).
2. Otherwise `git config --get remote.<remote>.url` in the detected project dir, over SSH.

In **fork-PR mode** (`workspace_settings.fork_pr_mode`) step 1 is skipped and `upstream` is tried
before `origin`: `origin` is the user's fork, and the issues worth starting a task from are on the
repo being contributed to. Results are cached for 5 minutes per workspace.

A workspace whose repo isn't on GitHub resolves to `null`; `GET …/github/issues` then returns
`{ repo: null, issues: [] }` and the UI says so rather than showing a broken browser.

---

## 3. API

All calls go **directly from the CPM server to api.github.com**, not through `gh` over `coder ssh`.
The browser is read-heavy (a list, then a body plus comments on every click) and an SSH round-trip
per call would make it unusable. The token is the same one the git flows use:
`coder external-auth access-token` for the task owner (`fetchGitHubToken`).

| Route | Purpose |
| --- | --- |
| `GET /api/workspaces/:id/github/issues` | Open issues, most recently updated first. Pull requests are filtered out — GitHub's issues endpoint returns them too. |
| `GET /api/workspaces/:id/github/issues/:number` | One issue with its body and full comment thread. |
| `POST /api/workspaces/:id/tasks` with `issueNumber` | Creates the issue-backed task. `prompt` carries **only** the user's description. |

The issue text is fetched **server-side** at creation, never posted by the client: the quoted text
is then what GitHub actually holds, and the linkage stored on the task — the thing that later
closes the issue — is verified to exist before the task row is written.

The composed prompt frames the issue thread explicitly as quoted third-party material, because it
is: the instruction that governs the task is the user's, stated after it. Bodies are capped at 12k
characters, comments at 4k each / 20k total.

---

## 4. Linkage and lifecycle

Four nullable columns on `tasks`:

| Column | Notes |
| --- | --- |
| `github_issue_repo` | `owner/repo`. **Not** necessarily `github_repo_url`'s repo — in fork-PR mode they differ. |
| `github_issue_number` | |
| `github_issue_title` | Cached for display; also becomes the task title (`#N: <title>`), which is why issue-backed tasks skip LLM title generation. |
| `github_issue_url` | Cached for display. |

- **Complete → close.** `closeIssueForCompletedTask` runs from both completion paths: the
  `/tasks/:id/complete` route and `processQueue`'s deferred `pending_complete` flush.
- **Reopen → reopen.** `reopenIssueForTask` runs from `/tasks/:id/reopen`.

Both are **best-effort and never fatal**. The task has already changed state by the time they run,
and a GitHub outage or a revoked token must not turn a successful completion into a failure. The
outcome — either way — is written to the task's message log, so the user sees it without leaving
CPM.

The state change is sent **before** the explanatory comment. In the reverse order, a rejected
`PATCH` (the normal outcome on a repo you can comment on but not close — i.e. every fork-PR-mode
workspace) would leave a comment announcing a closure that never happened on someone else's
tracker. A silent no-op plus a message in the task log is better than a false public statement.
