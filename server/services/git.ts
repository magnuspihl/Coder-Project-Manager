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

/**
 * Detect the GitHub repository URL from a workspace's git remote.
 * Converts SSH URLs (git@github.com:user/repo.git) to HTTPS URLs.
 * Returns null if not a GitHub repo or detection fails.
 */
async function detectGitHubRepoUrl(workspaceName: string, projectDir: string): Promise<string | null> {
  try {
    const remoteUrl = await sshExec(workspaceName, `cd ${shellEscape(projectDir)} && git config --get remote.origin.url`);
    if (!remoteUrl) return null;

    const sshMatch = remoteUrl.match(/git@github\.com:(.+?)(?:\.git)?$/);
    if (sshMatch) return `https://github.com/${sshMatch[1]}`;

    const httpsMatch = remoteUrl.match(/https:\/\/github\.com\/(.+?)(?:\.git)?$/);
    if (httpsMatch) return `https://github.com/${httpsMatch[1]}`;

    return null;
  } catch {
    return null;
  }
}

/**
 * Store the GitHub repo URL on a task in the database.
 */
function storeTaskRepoUrl(taskId: string, url: string): void {
  getDb().prepare('UPDATE tasks SET github_repo_url = ? WHERE id = ?').run(url, taskId);
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

    // Store GitHub URL for UI linking
    const repoUrl = await detectGitHubRepoUrl(ws, dir);
    if (repoUrl) {
      storeTaskRepoUrl(task.id, repoUrl);
      task.github_repo_url = repoUrl;
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

    // Store GitHub URL if not already done
    if (task.project_dir && !task.github_repo_url) {
      const repoUrl = await detectGitHubRepoUrl(ws, task.project_dir);
      if (repoUrl) storeTaskRepoUrl(task.id, repoUrl);
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

    // PR
    const freshTask = getTask(task.id) || task;
    const prTitle = freshTask.title || `Task: ${freshTask.prompt.slice(0, 60)}`;
    const prBody = `Automated PR for completed task.\n\n**Task:** ${freshTask.title}\n**Task ID:** ${freshTask.id}`;
    const defaultBranch = await getDefaultBranch(ws, dir);
    let prUrl: string;
    try {
      const existingPr = await sshGh(ws, `cd ${shellEscape(dir)} && gh pr view ${shellEscape(branchName)} --json url --jq .url 2>/dev/null`);
      if (existingPr.trim()) {
        prUrl = existingPr.trim();
        addMessage(task.id, 'system', `Existing pull request found: ${prUrl}`);
      } else {
        throw new Error('no existing PR');
      }
    } catch {
      try {
        prUrl = await sshGh(ws,
          `cd ${shellEscape(dir)} && gh pr create --base ${shellEscape(defaultBranch)} --head ${shellEscape(branchName)} --title ${shellEscape(prTitle)} --body ${shellEscape(prBody)}`
        );
        addMessage(task.id, 'system', `Pull request created: ${prUrl}`);
      } catch (prErr: any) {
        addMessage(task.id, 'system',
          `Cannot complete: PR creation failed for branch \`${branchName}\`: ${prErr.message}. ` +
          `Resolve the issue and retry completion.`
        );
        return false;
      }
    }

    // Sync local main with origin before merging — handles the case where origin/main
    // has advanced (e.g. a PR was merged on GitHub before CPM performs its merge step).
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

    // Merge PR
    let mergeConfirmedByState = false;
    try {
      await sshGh(ws, `cd ${shellEscape(dir)} && gh pr merge ${shellEscape(branchName)} --merge --delete-branch`);
      addMessage(task.id, 'system', `PR merged and branch \`${branchName}\` deleted.`);
    } catch (mergeErr: any) {
      // Check if the PR was already merged on GitHub (e.g. by the user or auto-merge)
      let alreadyMerged = false;
      try {
        const prState = await sshGh(ws,
          `cd ${shellEscape(dir)} && gh pr view ${shellEscape(branchName)} --json state --jq .state`
        );
        alreadyMerged = prState.trim() === 'MERGED';
      } catch { /* ignore state-check errors */ }

      if (alreadyMerged) {
        addMessage(task.id, 'system', `PR for branch \`${branchName}\` was already merged on GitHub.`);
        mergeConfirmedByState = true;
      } else {
        addMessage(task.id, 'system',
          `Cannot complete: PR merge failed for \`${branchName}\`: ${mergeErr.message}. ` +
          `Resolve any conflicts on the PR and retry completion.`
        );
        return false;
      }
    }

    // Verify the merge actually landed on origin/<default>. `gh pr merge` exiting 0
    // is normally sufficient, but this guards against partial/misreported merges so
    // a task is never marked completed while its branch is still unmerged. With the
    // `--merge` strategy the branch tip becomes a parent of the merge commit, so it
    // must be an ancestor of the updated default branch.
    //
    // Skip when GitHub already reports the PR as MERGED (authoritative): a manual
    // squash/rebase merge produces new commits, so the branch tip would legitimately
    // not be an ancestor — checking it would be a false-negative block.
    if (branchTip && !mergeConfirmedByState) {
      try {
        await sshExec(ws,
          `cd ${shellEscape(dir)} && git fetch origin ${shellEscape(defaultBranch)} && ` +
          `git merge-base --is-ancestor ${shellEscape(branchTip)} origin/${shellEscape(defaultBranch)}`,
          30000,
        );
      } catch {
        addMessage(task.id, 'system',
          `Cannot complete: the merge could not be verified on \`origin/${defaultBranch}\` — commit \`${branchTip.slice(0, 8)}\` is not part of the remote default branch yet. ` +
          `The worktree has been kept. Check the PR state on GitHub and retry completion.`
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
