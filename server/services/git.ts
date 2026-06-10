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
 * Get the default branch name (main or master).
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
    if (!isRemoteAllowed(task.workspace_id)) return;

    const branchName = generateBranchName(task);
    const defaultBranch = await getDefaultBranch(ws, dir);
    const worktreePath = `${CPM_WORKTREE_BASE}/task-${task.id}`;

    await sshExec(ws,
      `mkdir -p ${shellEscape(CPM_WORKTREE_BASE)} && ` +
      `cd ${shellEscape(dir)} && ` +
      `git fetch origin ${defaultBranch} 2>/dev/null || true && ` +
      `git worktree add ${shellEscape(worktreePath)} -b ${shellEscape(branchName)} origin/${defaultBranch}`,
      60000,
    );

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
 * Called on cancellation. On failure the task keeps its worktree for inspection.
 */
export async function removeTaskWorktree(task: Task): Promise<void> {
  if (!task.worktree_path) return;
  const ws = task.workspace_name;
  const dir = task.project_dir;

  try {
    const gitRoot = dir ? `cd ${shellEscape(dir)} && ` : '';
    await sshExec(ws,
      `${gitRoot}git worktree remove ${shellEscape(task.worktree_path)} --force 2>/dev/null || true`,
      15000,
    );
    if (task.git_branch && dir) {
      await sshExec(ws,
        `cd ${shellEscape(dir)} && git branch -D ${shellEscape(task.git_branch)} 2>/dev/null || true`,
        10000,
      );
    }
    getDb().prepare('UPDATE tasks SET worktree_path = NULL WHERE id = ?').run(task.id);
    task.worktree_path = null;
    console.log(`[git] Removed worktree for task ${task.id}`);
  } catch (err: any) {
    console.error(`[git] Failed to remove worktree for task ${task.id}:`, err.message);
  }
}

// ─── Task Completion ─────────────────────────────────────────────────────────

/**
 * After a task is marked complete:
 * - Remote allowed: commit in worktree, push, open PR, merge, remove worktree, pull main.
 * - Remote disabled: refuse if uncommitted changes; otherwise pass through.
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
        addMessage(task.id, 'system', 'Cannot complete: uncommitted changes and remote pushes are disabled. Handle git manually before completing.');
        return false;
      }
      if (task.worktree_path) {
        await removeTaskWorktree(task);
      }
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
      if (task.worktree_path) await removeTaskWorktree(task);
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

    // Merge
    try {
      await sshGh(ws, `cd ${shellEscape(dir)} && gh pr merge ${shellEscape(branchName)} --merge --delete-branch`);
      addMessage(task.id, 'system', `PR merged and branch \`${branchName}\` deleted.`);
    } catch (mergeErr: any) {
      addMessage(task.id, 'system',
        `Cannot complete: PR merge failed for \`${branchName}\`: ${mergeErr.message}. ` +
        `Resolve any conflicts on the PR and retry completion.`
      );
      return false;
    }

    // Remove worktree now that merge is done
    if (task.worktree_path) {
      await removeTaskWorktree(task);
    }

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
 * Get the last active task ID for a workspace (now always returns null).
 * Kept for route compatibility; parallel tasks don't have a single "active" one.
 */
export function getLastActiveTaskId(_workspaceId: string): string | null {
  return null;
}

/**
 * Switch active task — not meaningful with worktrees; returns a note.
 */
export async function switchActiveTask(task: Task): Promise<string> {
  if (task.worktree_path) {
    return `Task is isolated in worktree \`${task.worktree_path}\`. No stash switching needed.`;
  }
  return 'Task does not have an assigned worktree.';
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
