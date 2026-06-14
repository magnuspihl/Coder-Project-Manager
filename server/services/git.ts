import { sshExec, detectProjectDir } from './claude.js';
import { addMessage, getTask, type Task } from './tasks.js';
import { getDb } from '../db/index.js';
import { execFile } from 'child_process';

const CPM_WORKTREE_BASE = process.env.CPM_WORKTREE_BASE || '/home/coder/.cpm/worktrees';

/**
 * Fetch a GitHub token from Coder's external auth provider.
 * Returns the token string or null if unavailable.
 */
export function fetchGitHubToken(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('coder', ['external-auth', 'access-token', 'magnuspihl'], {
      timeout: 10000,
    }, (err, stdout) => {
      if (err || !stdout?.trim()) resolve(null);
      else resolve(stdout.trim());
    });
  });
}

/**
 * Run a gh CLI command in a remote workspace with GH_TOKEN set.
 */
async function sshGh(workspaceName: string, command: string, timeout = 30000): Promise<string> {
  const token = await fetchGitHubToken();
  if (token) {
    return sshExec(workspaceName, `export GH_TOKEN=${shellEscape(token)} && ${command}`, timeout);
  }
  return sshExec(workspaceName, command, timeout);
}

interface AdoResponse {
  /** HTTP status code, or 0 if the request couldn't be made. */
  status: number;
  /** Response body (trimmed). */
  body: string;
  /** True when `curl` is not installed in the workspace. */
  curlMissing?: boolean;
}

/**
 * Call the Azure DevOps REST API from inside a workspace using `curl`.
 *
 * Authenticates with HTTP Basic using the workspace's `ADO_PAT` (the same token
 * that pre-authenticates git over HTTPS) — so no extra CLI or extension needs to
 * be installed. The PAT never leaves the workspace: the auth header is built on
 * the remote side from `$ADO_PAT`.
 *
 * A JSON `body` is sent by base64-encoding it here and decoding it to a temp file
 * on the remote, which sidesteps all shell-quoting issues with arbitrary titles
 * and descriptions. `curl -sS` returns exit 0 for HTTP 4xx/5xx (so we can read
 * the error body); the HTTP status is appended via `-w` and parsed back out.
 */
async function adoApi(ws: string, method: string, url: string, body?: unknown): Promise<AdoResponse> {
  const authCmd = `AUTH="Authorization: Basic $(printf ':%s' "$ADO_PAT" | base64 | tr -d '\\n')"`;
  const common = `-sS -H "$AUTH" -H "Accept: application/json"`;
  let cmd: string;
  if (body !== undefined) {
    const b64 = Buffer.from(JSON.stringify(body)).toString('base64');
    cmd =
      `${authCmd} && TMP=$(mktemp) && printf %s ${shellEscape(b64)} | base64 -d > "$TMP" && ` +
      `curl ${common} -H "Content-Type: application/json" -X ${method} --data @"$TMP" ${shellEscape(url)} -w '\\nHTTP_STATUS:%{http_code}'; ` +
      `rm -f "$TMP"`;
  } else {
    cmd = `${authCmd} && curl ${common} -X ${method} ${shellEscape(url)} -w '\\nHTTP_STATUS:%{http_code}'`;
  }

  let out: string;
  try {
    out = await sshExec(ws, cmd, 60000);
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/curl: (command )?not found|not recognized|No such file/i.test(msg)) {
      return { status: 0, body: '', curlMissing: true };
    }
    throw e;
  }

  const marker = 'HTTP_STATUS:';
  const idx = out.lastIndexOf(marker);
  if (idx === -1) return { status: 0, body: out.trim() };
  const status = parseInt(out.slice(idx + marker.length).trim(), 10) || 0;
  return { status, body: out.slice(0, idx).trim() };
}

/**
 * True when an Azure DevOps response indicates an auth failure — typically an
 * expired/invalid PAT (ADO answers with 401/403, or 203 + a sign-in page).
 */
function isAdoAuthError(res: AdoResponse): boolean {
  return res.status === 401 || res.status === 403 || res.status === 203;
}

/**
 * Resolve project_dir for a task — use stored value or auto-detect.
 */
async function resolveProjectDir(task: Task): Promise<string | null> {
  if (task.project_dir) return task.project_dir;
  return detectProjectDir(task.workspace_name);
}

/**
 * Get the default branch name (main or master) as tracked on the remote.
 */
async function getDefaultBranch(workspaceName: string, projectDir: string): Promise<string> {
  try {
    await sshExec(workspaceName, `cd ${shellEscape(projectDir)} && git rev-parse --verify origin/main`);
    return 'main';
  } catch {
    return 'master';
  }
}

/**
 * Get the local default branch name (main or master). Used when remote git is
 * disabled and origin refs may be stale or absent — the user manages git locally.
 */
async function getLocalDefaultBranch(workspaceName: string, projectDir: string): Promise<string> {
  try {
    await sshExec(workspaceName, `cd ${shellEscape(projectDir)} && git rev-parse --verify main`);
    return 'main';
  } catch {
    return 'master';
  }
}

/**
 * Generate a branch name from a task's title and ID.
 */
function generateBranchName(task: Task): string {
  const slug = (task.title || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const shortId = task.id.slice(0, 8);
  return `task/${slug}-${shortId}`;
}

/**
 * Store the git branch name on a task in the database.
 */
function storeTaskBranch(taskId: string, branch: string): void {
  getDb().prepare('UPDATE tasks SET git_branch = ? WHERE id = ?').run(branch, taskId);
}

export type GitProvider = 'github' | 'azure' | 'unknown';

export interface GitRemoteInfo {
  provider: GitProvider;
  /** Browsable web URL for the repository (null for unknown providers). */
  webUrl: string | null;
  /** Azure DevOps coordinates, present only when provider === 'azure'. */
  azure?: { orgUrl: string; project: string; repo: string };
}

/**
 * Parse an Azure DevOps remote URL into {orgUrl, project, repo}.
 * Handles the modern dev.azure.com form (with or without the `{org}@` userinfo),
 * the SSH form (git@ssh.dev.azure.com:v3/...), and the legacy
 * `{org}.visualstudio.com` form (with or without a `DefaultCollection` segment).
 * Returns null if the URL is not an Azure DevOps remote.
 */
export function parseAzureRemote(remoteUrl: string): { orgUrl: string; project: string; repo: string } | null {
  const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

  // https://dev.azure.com/{org}/{project}/_git/{repo}   (optional `{org}@` userinfo)
  let m = remoteUrl.match(/https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/(.+?)(?:\.git)?\/?$/i);
  if (m) {
    return { orgUrl: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  }

  // git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
  m = remoteUrl.match(/git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (m) {
    return { orgUrl: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  }

  // https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}
  m = remoteUrl.match(/https?:\/\/(?:[^@/]+@)?([^.]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/(.+?)(?:\.git)?\/?$/i);
  if (m) {
    return { orgUrl: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  }

  return null;
}

/**
 * Detect the git hosting provider and a browsable web URL from a workspace's
 * git remote. Supports GitHub and Azure DevOps; returns provider 'unknown' with
 * a null webUrl for anything else, and null if detection fails entirely.
 */
async function detectGitRemote(workspaceName: string, projectDir: string): Promise<GitRemoteInfo | null> {
  try {
    const remoteUrl = await sshExec(workspaceName, `cd ${shellEscape(projectDir)} && git config --get remote.origin.url`);
    if (!remoteUrl) return null;
    const url = remoteUrl.trim();

    // GitHub (ssh + https)
    const sshMatch = url.match(/git@github\.com:(.+?)(?:\.git)?$/);
    if (sshMatch) return { provider: 'github', webUrl: `https://github.com/${sshMatch[1]}` };
    const httpsMatch = url.match(/https:\/\/github\.com\/(.+?)(?:\.git)?$/);
    if (httpsMatch) return { provider: 'github', webUrl: `https://github.com/${httpsMatch[1]}` };

    // Azure DevOps
    const azure = parseAzureRemote(url);
    if (azure) {
      const webUrl = `${azure.orgUrl}/${encodeURIComponent(azure.project)}/_git/${encodeURIComponent(azure.repo)}`;
      return { provider: 'azure', webUrl, azure };
    }

    return { provider: 'unknown', webUrl: null };
  } catch {
    return null;
  }
}

/**
 * Store the repo web URL and provider on a task in the database.
 */
function storeTaskRepo(taskId: string, url: string | null, provider: GitProvider): void {
  getDb().prepare('UPDATE tasks SET github_repo_url = ?, git_provider = ? WHERE id = ?').run(url, provider, taskId);
}

/**
 * Check if a workspace has a git repository at the given path.
 */
async function hasGitRepo(workspaceName: string, projectDir: string): Promise<boolean> {
  try {
    await sshExec(workspaceName, `cd ${shellEscape(projectDir)} && git rev-parse --is-inside-work-tree`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the repository has at least one commit.
 */
async function hasCommits(workspaceName: string, projectDir: string): Promise<boolean> {
  try {
    await sshExec(workspaceName, `cd ${shellEscape(projectDir)} && git rev-parse --verify HEAD`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if git remote operations are allowed for a workspace.
 */
export function isRemoteAllowed(workspaceId: string): boolean {
  const row = getDb().prepare('SELECT git_push_enabled FROM workspace_settings WHERE workspace_id = ?')
    .get(workspaceId) as { git_push_enabled: number } | undefined;
  return row?.git_push_enabled !== 0;
}

// ─── Task Launch: create worktree ────────────────────────────────────────────

/**
 * Called when a NEW task is about to be launched.
 * Creates a git worktree on a new branch for the task.
 * Mutates task.worktree_path and task.git_branch on success.
 */
export async function handleTaskLaunchGit(task: Task): Promise<void> {
  const dir = task.project_dir;
  if (!dir) return;

  const ws = task.workspace_name;

  try {
    if (!await hasGitRepo(ws, dir)) return;

    // Store repo URL + provider for UI linking and provider-aware completion
    const remote = await detectGitRemote(ws, dir);
    if (remote) {
      storeTaskRepo(task.id, remote.webUrl, remote.provider);
      task.github_repo_url = remote.webUrl;
      task.git_provider = remote.provider;
    }

    if (!await hasCommits(ws, dir)) return;

    // A worktree is always created — including when remote git is disabled — so
    // that concurrent tasks on the same workspace stay isolated from each other
    // and from the main checkout. The only difference for remote-disabled
    // workspaces is the branch base and that completion never pushes/merges.
    const remoteAllowed = isRemoteAllowed(task.workspace_id);
    const branchName = generateBranchName(task);
    const worktreePath = `${CPM_WORKTREE_BASE}/task-${task.id}`;

    if (remoteAllowed) {
      // Branch from the canonical origin tip so the worktree starts clean
      // regardless of local state in the main checkout or other worktrees.
      const defaultBranch = await getDefaultBranch(ws, dir);
      await sshExec(ws,
        `mkdir -p ${shellEscape(CPM_WORKTREE_BASE)} && cd ${shellEscape(dir)} && ` +
        `git fetch origin ${defaultBranch} 2>/dev/null || true && ` +
        `git worktree add ${shellEscape(worktreePath)} -b ${shellEscape(branchName)} origin/${defaultBranch}`,
        60000,
      );
    } else {
      // Remote disabled: the user manages git locally and origin may be stale or
      // absent, so branch from the LOCAL default branch tip instead of origin.
      const defaultBranch = await getLocalDefaultBranch(ws, dir);
      await sshExec(ws,
        `mkdir -p ${shellEscape(CPM_WORKTREE_BASE)} && cd ${shellEscape(dir)} && ` +
        `git worktree add ${shellEscape(worktreePath)} -b ${shellEscape(branchName)} ${shellEscape(defaultBranch)}`,
        60000,
      );
    }

    storeTaskBranch(task.id, branchName);
    getDb().prepare('UPDATE tasks SET worktree_path = ? WHERE id = ?').run(worktreePath, task.id);
    task.worktree_path = worktreePath;
    task.git_branch = branchName;

    console.log(`[git] Created worktree ${worktreePath} on branch ${branchName}`);
  } catch (err: any) {
    console.error(`[git] Worktree creation failed for task ${task.id}:`, err.message);
    addMessage(task.id, 'system', `Warning: could not create git worktree: ${err.message}. Task will run in the main workspace directory.`);
  }
}

// ─── Task Resume: no-op — worktree already exists ────────────────────────────

/**
 * Called before a task is resumed (feedback reply).
 * The worktree already exists — nothing to do.
 */
export async function handleTaskResumeGit(_task: Task): Promise<void> {
  // no-op: worktree persists between turns
}

// ─── Worktree removal ────────────────────────────────────────────────────────

/**
 * Remove a task's worktree directory and branch.
 *
 * Returns true if the worktree is confirmed gone (or there was none), false if
 * removal genuinely failed (e.g. a process still holds the directory open). On
 * failure the worktree is kept for inspection, `worktree_path` is left set so the
 * removal can be retried, and a warning is surfaced to the task.
 *
 * IMPORTANT: this no longer masks `git worktree remove` failures with `|| true`,
 * so a preview server holding the worktree open is detected rather than silently
 * leaking the directory. Callers should shut down preview servers
 * (`cleanupPortRange`) BEFORE calling this.
 */
export async function removeTaskWorktree(task: Task): Promise<boolean> {
  if (!task.worktree_path) return true;
  const ws = task.workspace_name;
  const dir = task.project_dir;
  const wt = task.worktree_path;
  const gitRoot = dir ? `cd ${shellEscape(dir)} && ` : '';

  // Try to remove; on failure prune stale metadata and retry once.
  let removed = false;
  try {
    await sshExec(ws, `${gitRoot}git worktree remove ${shellEscape(wt)} --force`, 15000);
    removed = true;
  } catch {
    try {
      await sshExec(ws, `${gitRoot}git worktree prune`, 10000).catch(() => {});
      // If the directory is already gone, pruning the metadata alone resolves it.
      const stillThere = (await sshExec(ws, `test -d ${shellEscape(wt)} && echo yes || echo no`).catch(() => 'no')).trim() === 'yes';
      if (stillThere) {
        await sshExec(ws, `${gitRoot}git worktree remove ${shellEscape(wt)} --force`, 15000);
      }
      removed = true;
    } catch {
      removed = false;
    }
  }

  if (!removed) {
    addMessage(task.id, 'system',
      `Warning: could not remove git worktree \`${wt}\` — a process may still be using it. ` +
      `If it persists, remove it manually with \`git worktree remove ${wt} --force\`.`
    );
    console.error(`[git] Failed to remove worktree for task ${task.id}`);
    return false;
  }

  // Delete the local branch (best-effort; `--delete-branch` on merge may already have removed it).
  if (task.git_branch && dir) {
    await sshExec(ws,
      `cd ${shellEscape(dir)} && git branch -D ${shellEscape(task.git_branch)} 2>/dev/null || true`,
      10000,
    ).catch(() => {});
  }
  getDb().prepare('UPDATE tasks SET worktree_path = NULL WHERE id = ?').run(task.id);
  task.worktree_path = null;
  console.log(`[git] Removed worktree for task ${task.id}`);
  return true;
}

/**
 * Startup sweep: remove worktrees left behind by **deleted** tasks. Worktrees live
 * for the entire task lifecycle (so any non-deleted task can be resumed) and are
 * removed only on deletion — so the only task that should never still own a worktree
 * is a deleted one. This catches deletions whose removal failed at the time (e.g. a
 * preview server was still holding the directory).
 *
 * Worktree-dir only — does NOT kill ports, since a deleted task's old port range may
 * already have been reallocated to a now-active task.
 */
export async function reconcileLeakedWorktrees(): Promise<void> {
  const rows = getDb().prepare(
    `SELECT * FROM tasks WHERE worktree_path IS NOT NULL AND deleted_at IS NOT NULL`
  ).all() as Task[];
  if (rows.length === 0) return;
  console.log(`[git] Reconciling ${rows.length} worktree(s) left behind by deleted tasks`);
  for (const task of rows) {
    try {
      await removeTaskWorktree(task);
    } catch (err: any) {
      console.error(`[git] Worktree reconcile failed for task ${task.id}:`, err?.message);
    }
  }
}

// ─── Task Completion ─────────────────────────────────────────────────────────

/**
 * After a task is marked complete:
 * - Remote allowed: commit in worktree, push, open PR, merge, verify merge landed, pull main.
 * - Remote disabled: refuse if uncommitted changes; otherwise pass through.
 *
 * The worktree is intentionally NOT removed here — it persists for the entire task
 * lifecycle so a completed task can be reopened and continued in the same worktree
 * (re-completion runs a fresh push/PR/merge). Worktrees are removed only on deletion.
 *
 * Returns true if completion is allowed, false if blocked.
 */
export async function handleTaskCompletionGit(task: Task): Promise<boolean> {
  // Use worktree path if available, else fall back to project_dir
  const dir = task.worktree_path || await resolveProjectDir(task);
  if (!dir) return true;

  const ws = task.workspace_name;

  try {
    if (!await hasGitRepo(ws, dir)) return true;
    if (!await hasCommits(ws, dir)) return true;

    const remoteAllowed = isRemoteAllowed(task.workspace_id);
    const status = await sshExec(ws, `cd ${shellEscape(dir)} && git status --porcelain`);
    const hasChanges = !!status.trim();

    if (!remoteAllowed) {
      if (hasChanges) {
        const loc = task.git_branch
          ? `on branch \`${task.git_branch}\` in the worktree \`${dir}\``
          : `in \`${dir}\``;
        addMessage(task.id, 'system',
          `Cannot complete automatically — remote git operations are disabled for this workspace, so CPM will not commit, push, open a PR, or merge. You handle git manually here.\n\n` +
          `Your changes are preserved ${loc} exactly as-is — nothing has been discarded, and the worktree is kept until you delete this task. ` +
          `Commit and integrate them into your default branch yourself, then mark this task complete (or delete it once you're done).`
        );
        return false;
      }
      // Working tree is clean — any work has already been integrated manually.
      // Leave the worktree in place; it is removed only on deletion.
      return true;
    }

    // Determine branch name
    let branchName = task.git_branch;
    if (!branchName) {
      const freshTask = getTask(task.id) || task;
      branchName = generateBranchName(freshTask);
      storeTaskBranch(task.id, branchName);
    }

    // For worktree tasks: verify we're on the task branch (sanity check)
    if (task.worktree_path) {
      const currentBranch = (await sshExec(ws, `cd ${shellEscape(dir)} && git rev-parse --abbrev-ref HEAD`)).trim();
      if (currentBranch !== branchName) {
        addMessage(task.id, 'system',
          `Cannot complete: worktree is on branch \`${currentBranch}\` instead of expected \`${branchName}\`.`
        );
        return false;
      }
    } else {
      // Legacy non-worktree path: check we're on default branch and create task branch
      const defaultBranch = await getDefaultBranch(ws, dir);
      const currentBranch = (await sshExec(ws, `cd ${shellEscape(dir)} && git rev-parse --abbrev-ref HEAD`)).trim();
      if (currentBranch !== defaultBranch) {
        addMessage(task.id, 'system',
          `Cannot complete: workspace is on branch \`${currentBranch}\` instead of \`${defaultBranch}\`. ` +
          `The agent appears to have switched branches mid-task. Please reconcile manually before completing.`
        );
        return false;
      }
      if (!hasChanges) return true;
      try {
        await sshExec(ws, `cd ${shellEscape(dir)} && git checkout -b ${shellEscape(branchName)}`, 15000);
      } catch (err: any) {
        addMessage(task.id, 'system',
          `Cannot complete: could not create branch \`${branchName}\`: ${err.message}.`
        );
        return false;
      }
    }

    if (!hasChanges) {
      // Nothing to commit — already complete. Worktree is kept (removed on deletion).
      return true;
    }

    // Commit
    try {
      await sshExec(ws, `cd ${shellEscape(dir)} && git add -A`);
      const staged = await sshExec(ws, `cd ${shellEscape(dir)} && git diff --cached --name-only`);
      if (staged.trim()) {
        const freshTask = getTask(task.id) || task;
        await sshExec(ws,
          `cd ${shellEscape(dir)} && git commit -m ${shellEscape(freshTask.title || 'Task changes')}`,
          30000,
        );
      }
    } catch (err: any) {
      addMessage(task.id, 'system', `Cannot complete: git commit failed: ${err.message}`);
      return false;
    }

    // Capture the committed tip so we can later verify the merge actually landed,
    // even after `gh pr merge --delete-branch` removes the branch ref.
    let branchTip = '';
    try {
      branchTip = (await sshExec(ws, `cd ${shellEscape(dir)} && git rev-parse HEAD`)).trim();
    } catch { /* validation is skipped if we couldn't capture the tip */ }

    // Detect the git host so the PR flow can be routed to the right provider
    // (and store the repo URL + provider for UI linking if not already done).
    const remote = await detectGitRemote(ws, dir);
    const provider: GitProvider = remote?.provider ?? (task.git_provider as GitProvider | null) ?? 'unknown';
    if (remote) {
      storeTaskRepo(task.id, remote.webUrl ?? task.github_repo_url, remote.provider);
    }

    // Push
    try {
      await sshExec(ws, `cd ${shellEscape(dir)} && git push -u origin ${shellEscape(branchName)}`, 30000);
    } catch (pushErr: any) {
      addMessage(task.id, 'system',
        `Cannot complete: changes committed on branch \`${branchName}\` but push failed: ${pushErr.message}. ` +
        `Resolve the push issue and retry completion.`
      );
      return false;
    }

    const defaultBranch = await getDefaultBranch(ws, dir);

    // Sync local main with origin first — handles the case where origin/main has
    // advanced (e.g. a PR was merged on GitHub before CPM performs its merge step).
    // Only applies in worktree mode where task.project_dir is the main checkout.
    if (task.worktree_path && task.project_dir) {
      try {
        await sshExec(ws,
          `cd ${shellEscape(task.project_dir)} && ` +
          `git fetch origin ${shellEscape(defaultBranch)} && ` +
          `git merge --ff-only origin/${shellEscape(defaultBranch)}`,
          30000,
        );
      } catch (syncErr: any) {
        addMessage(task.id, 'system',
          `Cannot complete: local \`${defaultBranch}\` has diverged from origin/${defaultBranch} and cannot be fast-forwarded: ${syncErr.message}. ` +
          `Reconcile the branch manually then retry completion.`
        );
        return false;
      }
    }

    // Nothing-to-merge guard. A reopened task that was previously completed already
    // has its commit on origin/<default>. If the committed tip is already an
    // ancestor of the remote default branch there is nothing left to merge, so
    // complete instead of re-merging the stale (already-MERGED) PR — which would
    // print "PR merged" yet leave the new commit stranded and fail verification.
    if (branchTip) {
      let alreadyLanded = false;
      try {
        await sshExec(ws,
          `cd ${shellEscape(dir)} && git fetch origin ${shellEscape(defaultBranch)} && ` +
          `git merge-base --is-ancestor ${shellEscape(branchTip)} origin/${shellEscape(defaultBranch)}`,
          30000,
        );
        alreadyLanded = true;
      } catch { /* tip not on origin/<default> yet → real work to merge */ }
      if (alreadyLanded) {
        addMessage(task.id, 'system',
          `Changes on branch \`${branchName}\` are already present on \`origin/${defaultBranch}\` — nothing to merge. Marking complete.`
        );
        return true;
      }
    }

    // Open (or reuse) and complete the PR through the detected provider. Each
    // helper finds/creates the PR, merges it, surfaces its own status/error
    // messages, and reports whether the git-ancestor merge verification below
    // should run. A branch completed before has a closed/merged PR; the helpers
    // open a fresh PR for the new commit rather than re-merging stale ones.
    const freshTask = getTask(task.id) || task;
    const prTitle = freshTask.title || `Task: ${freshTask.prompt.slice(0, 60)}`;
    const prBody = `Automated PR for completed task.\n\n**Task:** ${freshTask.title}\n**Task ID:** ${freshTask.id}`;

    let outcome: PrOutcome;
    if (provider === 'azure') {
      if (!remote?.azure) {
        addMessage(task.id, 'system',
          `Cannot complete: changes were pushed to branch \`${branchName}\`, but the Azure DevOps organization/project/repository could not be parsed from the git remote. ` +
          `Open and complete the PR manually, then mark this task complete.`
        );
        return false;
      }
      outcome = await completePrAzure(ws, task.id, branchName, defaultBranch, prTitle, prBody, branchTip, remote.azure);
    } else {
      // GitHub and anything else (e.g. GitHub Enterprise) go through the `gh` CLI,
      // matching the prior behaviour where `gh` was used unconditionally.
      outcome = await completePrGitHub(ws, dir, task.id, branchName, defaultBranch, prTitle, prBody);
    }

    if (outcome.kind === 'blocked') return false;
    if (outcome.kind === 'nothing-to-merge') return true;
    const verifyMergeWithGit = outcome.verifyByGit;

    // Verify the merge actually landed on origin/<default>. `gh pr merge` exiting 0
    // is normally sufficient, but this guards against partial/misreported merges so
    // a task is never marked completed while its branch is still unmerged. With the
    // `--merge` strategy the branch tip becomes a parent of the merge commit, so it
    // must be an ancestor of the updated default branch.
    //
    // Skip when the provider authoritatively reports the PR as merged/completed: a
    // squash/rebase merge (GitHub) or a non-merge completion strategy (Azure DevOps)
    // produces new commits, so the branch tip would legitimately not be an ancestor —
    // checking it would be a false-negative block.
    if (branchTip && verifyMergeWithGit) {
      try {
        await sshExec(ws,
          `cd ${shellEscape(dir)} && git fetch origin ${shellEscape(defaultBranch)} && ` +
          `git merge-base --is-ancestor ${shellEscape(branchTip)} origin/${shellEscape(defaultBranch)}`,
          30000,
        );
      } catch {
        addMessage(task.id, 'system',
          `Cannot complete: the merge could not be verified on \`origin/${defaultBranch}\` — commit \`${branchTip.slice(0, 8)}\` is not part of the remote default branch yet. ` +
          `The worktree has been kept. Check the PR state and retry completion.`
        );
        return false;
      }
    }

    // The worktree is intentionally kept — it is removed only when the task is
    // deleted, so a completed task can be reopened and continued in the same
    // worktree. The caller (complete route / deferred-completion handler) frees the
    // port range after marking the task completed.

    // Pull main checkout to reflect the merge
    if (task.project_dir) {
      try {
        await sshExec(ws,
          `cd ${shellEscape(task.project_dir)} && git pull --ff-only origin ${shellEscape(defaultBranch)}`,
          30000,
        );
      } catch (pullErr: any) {
        addMessage(task.id, 'system', `Warning: post-merge pull failed: ${pullErr.message}.`);
      }
    }

    return true;
  } catch (err: any) {
    const reason = `Git completion failed: ${err.message || err}`;
    addMessage(task.id, 'system', `Error: ${reason}`);
    return false;
  }
}

// ─── Provider-specific PR completion ─────────────────────────────────────────

/**
 * Result of a provider's open-PR-and-merge step:
 * - `completed`: the PR was merged/completed. `verifyByGit` says whether the
 *   caller should verify the merge landed via a git-ancestor check (true) or
 *   trust the provider's authoritative state (false).
 * - `nothing-to-merge`: the branch adds no commits over the base — mark complete.
 * - `blocked`: completion could not proceed; an explanatory message was already
 *   added to the task and completion should be refused.
 */
type PrOutcome =
  | { kind: 'completed'; verifyByGit: boolean }
  | { kind: 'nothing-to-merge' }
  | { kind: 'blocked' };

/**
 * GitHub PR flow via the `gh` CLI: reuse an OPEN PR or open a fresh one, then
 * merge it by identity (number/URL, never branch name, so a stale MERGED PR for
 * the same branch can't be re-targeted).
 */
async function completePrGitHub(
  ws: string, dir: string, taskId: string, branchName: string,
  defaultBranch: string, prTitle: string, prBody: string,
): Promise<PrOutcome> {
  let mergeTarget: string;
  let existingPr: { url?: string; state?: string; number?: number } | null = null;
  try {
    const raw = await sshGh(ws, `cd ${shellEscape(dir)} && gh pr view ${shellEscape(branchName)} --json url,state,number 2>/dev/null`);
    if (raw.trim()) existingPr = JSON.parse(raw);
  } catch { /* no PR associated with this branch yet */ }

  if (existingPr && existingPr.state === 'OPEN' && existingPr.url) {
    mergeTarget = existingPr.number != null ? String(existingPr.number) : existingPr.url;
    addMessage(taskId, 'system', `Existing open pull request found: ${existingPr.url}`);
  } else {
    if (existingPr && existingPr.url && (existingPr.state === 'MERGED' || existingPr.state === 'CLOSED')) {
      addMessage(taskId, 'system',
        `Previous pull request for branch \`${branchName}\` is ${existingPr.state.toLowerCase()} (${existingPr.url}); opening a fresh PR for the new commit.`
      );
    }
    try {
      const prUrl = (await sshGh(ws,
        `cd ${shellEscape(dir)} && gh pr create --base ${shellEscape(defaultBranch)} --head ${shellEscape(branchName)} --title ${shellEscape(prTitle)} --body ${shellEscape(prBody)}`
      )).trim();
      mergeTarget = prUrl;
      addMessage(taskId, 'system', `Pull request created: ${prUrl}`);
    } catch (prErr: any) {
      const msg = String(prErr?.message || prErr);
      // GitHub refuses a PR when the branch adds no commits over the base — the
      // reopened task's changes are already on the default branch.
      if (/no commits between/i.test(msg)) {
        addMessage(taskId, 'system',
          `Nothing to merge — branch \`${branchName}\` adds no commits over \`${defaultBranch}\` (changes already on the default branch). Marking complete.`
        );
        return { kind: 'nothing-to-merge' };
      }
      addMessage(taskId, 'system',
        `Cannot complete: PR creation failed for branch \`${branchName}\`: ${msg}. Resolve the issue and retry completion.`
      );
      return { kind: 'blocked' };
    }
  }

  try {
    await sshGh(ws, `cd ${shellEscape(dir)} && gh pr merge ${shellEscape(mergeTarget)} --merge --delete-branch`);
    addMessage(taskId, 'system', `PR merged and branch \`${branchName}\` deleted.`);
    return { kind: 'completed', verifyByGit: true };
  } catch (mergeErr: any) {
    // Check if the PR was already merged on GitHub (e.g. by the user or auto-merge).
    let alreadyMerged = false;
    try {
      const prState = await sshGh(ws,
        `cd ${shellEscape(dir)} && gh pr view ${shellEscape(mergeTarget)} --json state --jq .state`
      );
      alreadyMerged = prState.trim() === 'MERGED';
    } catch { /* ignore state-check errors */ }

    if (alreadyMerged) {
      addMessage(taskId, 'system', `PR for branch \`${branchName}\` was already merged on GitHub.`);
      return { kind: 'completed', verifyByGit: false };
    }
    addMessage(taskId, 'system',
      `Cannot complete: PR merge failed for \`${branchName}\`: ${mergeErr.message}. Resolve any conflicts on the PR and retry completion.`
    );
    return { kind: 'blocked' };
  }
}

/**
 * Azure DevOps PR flow via the REST API (using `curl` + the workspace `ADO_PAT`):
 * reuse an active PR or create one, set it to "completed" (which merges and
 * deletes the source branch), then poll the PR status until ADO reports the
 * completion landed (completion is processed asynchronously server-side).
 *
 * Deliberately uses the REST API rather than the `az` CLI so that nothing needs
 * to be installed in the workspace — `curl` is universally available and the PAT
 * that already pre-authenticates git over HTTPS is reused for API auth.
 */
async function completePrAzure(
  ws: string, taskId: string, branchName: string,
  defaultBranch: string, prTitle: string, prBody: string,
  branchTip: string, azure: { orgUrl: string; project: string; repo: string },
): Promise<PrOutcome> {
  const apiVer = 'api-version=7.1';
  const reposBase =
    `${azure.orgUrl}/${encodeURIComponent(azure.project)}/_apis/git/repositories/${encodeURIComponent(azure.repo)}`;
  const prWebUrl = (id: number | string) =>
    `${azure.orgUrl}/${encodeURIComponent(azure.project)}/_git/${encodeURIComponent(azure.repo)}/pullrequest/${id}`;
  const sourceRef = `refs/heads/${branchName}`;
  const targetRef = `refs/heads/${defaultBranch}`;

  const curlMissingMsg =
    `Cannot complete: \`curl\` is not available in this workspace, so CPM cannot reach the Azure DevOps REST API to open the pull request. ` +
    `Open and complete the PR for branch \`${branchName}\` manually, then mark this task complete.`;
  const authErrMsg =
    `Cannot complete: Azure DevOps rejected the request (auth error). The workspace \`ADO_PAT\` is likely missing or expired — ` +
    `regenerate it at dev.azure.com/{org}/_usersSettings/tokens and update the workspace parameter, then retry completion.`;

  const findActivePr = async (): Promise<number | null> => {
    const url =
      `${reposBase}/pullrequests?searchCriteria.sourceRefName=${encodeURIComponent(sourceRef)}` +
      `&searchCriteria.targetRefName=${encodeURIComponent(targetRef)}&searchCriteria.status=active&${apiVer}`;
    const res = await adoApi(ws, 'GET', url);
    if (res.curlMissing) { addMessage(taskId, 'system', curlMissingMsg); return null; }
    if (isAdoAuthError(res)) { addMessage(taskId, 'system', authErrMsg); return null; }
    if (res.status >= 200 && res.status < 300) {
      try {
        const data = JSON.parse(res.body);
        if (Array.isArray(data.value) && data.value.length > 0 && data.value[0].pullRequestId != null) {
          return data.value[0].pullRequestId as number;
        }
      } catch { /* fall through */ }
    }
    return null;
  };

  // Reuse an existing active PR for this source→target branch if present.
  let prId: number | null = await findActivePr();

  if (prId != null) {
    addMessage(taskId, 'system', `Existing active pull request found: ${prWebUrl(prId)}`);
  } else {
    const res = await adoApi(ws, 'POST', `${reposBase}/pullrequests?${apiVer}`, {
      sourceRefName: sourceRef,
      targetRefName: targetRef,
      title: prTitle,
      description: prBody,
    });
    if (res.curlMissing) { addMessage(taskId, 'system', curlMissingMsg); return { kind: 'blocked' }; }
    if (isAdoAuthError(res)) { addMessage(taskId, 'system', authErrMsg); return { kind: 'blocked' }; }
    if (res.status >= 200 && res.status < 300) {
      try { prId = JSON.parse(res.body).pullRequestId; } catch { /* handled below */ }
      if (prId != null) addMessage(taskId, 'system', `Pull request created: ${prWebUrl(prId)}`);
    } else if (/TF401179|active pull request.*already exists/i.test(res.body)) {
      // A PR for this branch pair already exists — recover by looking it up.
      prId = await findActivePr();
      if (prId != null) addMessage(taskId, 'system', `Existing active pull request found: ${prWebUrl(prId)}`);
    }
    if (prId == null) {
      addMessage(taskId, 'system',
        `Cannot complete: PR creation failed for branch \`${branchName}\` (HTTP ${res.status}): ${truncate(res.body, 300)}. Resolve the issue and retry completion.`
      );
      return { kind: 'blocked' };
    }
  }

  // Complete the PR: merge it and delete the source branch. `lastMergeSourceCommit`
  // must match the PR's current source tip, so prefer the value ADO reports and fall
  // back to the commit we just pushed. Completion is queued and processed
  // asynchronously, so the poll below waits for the authoritative status.
  let mergeSourceCommit = branchTip;
  const showUrl = `${reposBase}/pullrequests/${prId}?${apiVer}`;
  const showRes = await adoApi(ws, 'GET', showUrl);
  if (showRes.status >= 200 && showRes.status < 300) {
    try {
      const commit = JSON.parse(showRes.body)?.lastMergeSourceCommit?.commitId;
      if (commit) mergeSourceCommit = commit;
    } catch { /* keep branchTip */ }
  }

  const patchBody: Record<string, unknown> = {
    status: 'completed',
    completionOptions: { deleteSourceBranch: true, mergeStrategy: 'noFastForward' },
  };
  if (mergeSourceCommit) patchBody.lastMergeSourceCommit = { commitId: mergeSourceCommit };

  const patchRes = await adoApi(ws, 'PATCH', `${reposBase}/pullrequests/${prId}?${apiVer}`, patchBody);
  let patchErr = '';
  if (patchRes.curlMissing) { addMessage(taskId, 'system', curlMissingMsg); return { kind: 'blocked' }; }
  if (isAdoAuthError(patchRes)) { addMessage(taskId, 'system', authErrMsg); return { kind: 'blocked' }; }
  if (!(patchRes.status >= 200 && patchRes.status < 300)) {
    patchErr = `HTTP ${patchRes.status}: ${truncate(patchRes.body, 300)}`;
  }

  // Poll until ADO finishes the merge.
  let finalStatus = '';
  for (let i = 0; i < 15; i++) {
    const res = await adoApi(ws, 'GET', showUrl);
    if (res.status >= 200 && res.status < 300) {
      try { finalStatus = JSON.parse(res.body).status || ''; } catch { /* retry */ }
    }
    if (finalStatus === 'completed' || finalStatus === 'abandoned') break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (finalStatus === 'completed') {
    addMessage(taskId, 'system', `PR completed and branch \`${branchName}\` merged: ${prWebUrl(prId)}`);
    // ADO's merge strategy may rewrite commits, so trust the authoritative status
    // instead of a git-ancestor check.
    return { kind: 'completed', verifyByGit: false };
  }

  addMessage(taskId, 'system',
    `Cannot complete: the Azure DevOps PR for \`${branchName}\` could not be completed` +
    `${finalStatus ? ` (status: ${finalStatus})` : ''}${patchErr ? ` — ${patchErr}` : ''}. ` +
    `It may require approvals or have merge conflicts / branch policies — resolve them on the PR (${prWebUrl(prId)}) and retry completion.`
  );
  return { kind: 'blocked' };
}

/** Truncate a string for inclusion in a user-facing status message. */
function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// ─── Legacy stubs — kept for routes compatibility ────────────────────────────

/**
 * No-op stub. Worktree architecture makes reopen a no-op.
 */
export async function handleTaskReopenGit(_task: Task): Promise<void> {
  // no-op: worktree persists until the task is cancelled/completed
}

/**
 * Manually switch a workspace to a task's branch.
 * With worktrees the branch is already isolated; just reports the status.
 */
export async function checkoutTaskBranch(task: Task): Promise<string> {
  if (!task.git_branch) throw new Error('No branch associated with this task');
  if (task.worktree_path) {
    return `Task branch \`${task.git_branch}\` is isolated in worktree \`${task.worktree_path}\`.`;
  }
  const dir = task.project_dir;
  if (!dir) throw new Error('No project directory for this task');
  const ws = task.workspace_name;
  const currentBranch = (await sshExec(ws, `cd ${shellEscape(dir)} && git rev-parse --abbrev-ref HEAD`)).trim();
  if (currentBranch === task.git_branch) {
    return `Already on branch \`${task.git_branch}\``;
  }
  const status = await sshExec(ws, `cd ${shellEscape(dir)} && git status --porcelain`);
  if (status.trim()) {
    await sshExec(ws, `cd ${shellEscape(dir)} && git stash push --include-untracked -m "auto-stash before switching to ${task.git_branch}"`, 15000);
  }
  await sshExec(ws, `cd ${shellEscape(dir)} && git checkout ${shellEscape(task.git_branch)}`, 15000);
  return `Switched to branch \`${task.git_branch}\``;
}

/**
 * Shell-escape a string for safe inclusion in a remote shell command.
 */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
