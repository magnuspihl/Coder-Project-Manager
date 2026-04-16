import { sshExec, detectProjectDir } from './claude.js';
import { addMessage, getTask, type Task } from './tasks.js';
import { getDb } from '../db/index.js';
import { execFile } from 'child_process';

/**
 * Fetch a GitHub token from Coder's external auth provider.
 * Returns the token string or null if unavailable.
 */
function fetchGitHubToken(): Promise<string | null> {
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
    await sshExec(workspaceName, `cd ${projectDir} && git rev-parse --verify origin/main`);
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
    const remoteUrl = await sshExec(workspaceName, `cd ${projectDir} && git config --get remote.origin.url`);
    if (!remoteUrl) return null;

    // SSH format: git@github.com:user/repo.git
    const sshMatch = remoteUrl.match(/git@github\.com:(.+?)(?:\.git)?$/);
    if (sshMatch) return `https://github.com/${sshMatch[1]}`;

    // HTTPS format: https://github.com/user/repo.git
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
    await sshExec(workspaceName, `cd ${projectDir} && git rev-parse --is-inside-work-tree`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if git remote operations are allowed for a workspace.
 */
function isRemoteAllowed(workspaceId: string): boolean {
  const row = getDb().prepare('SELECT git_push_enabled FROM workspace_settings WHERE workspace_id = ?')
    .get(workspaceId) as { git_push_enabled: number } | undefined;
  return row?.git_push_enabled !== 0; // default true
}

/**
 * Get the stash message tag for a task.
 */
function stashTag(taskId: string): string {
  return `cpm-task-${taskId}`;
}

/**
 * Find the stash index for a given task, or -1 if not found.
 */
async function findStashIndex(workspaceName: string, projectDir: string, taskId: string): Promise<number> {
  try {
    const list = await sshExec(workspaceName, `cd ${projectDir} && git stash list --format='%gd %s'`);
    const tag = stashTag(taskId);
    for (const line of list.split('\n')) {
      if (line.includes(tag)) {
        const match = line.match(/^stash@\{(\d+)\}/);
        if (match) return parseInt(match[1], 10);
      }
    }
  } catch { /* no stashes or no git */ }
  return -1;
}

/**
 * Get the last active task ID for a workspace.
 */
function getLastActiveTaskId(workspaceId: string): string | null {
  const row = getDb().prepare('SELECT last_active_task_id FROM workspace_settings WHERE workspace_id = ?')
    .get(workspaceId) as { last_active_task_id: string | null } | undefined;
  return row?.last_active_task_id || null;
}

/**
 * Set the last active task ID for a workspace.
 */
function setLastActiveTaskId(workspaceId: string, taskId: string | null): void {
  getDb().prepare(`
    INSERT INTO workspace_settings (workspace_id, last_active_task_id)
    VALUES (?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET last_active_task_id = excluded.last_active_task_id
  `).run(workspaceId, taskId);
}

// ─── Task Launch: detect repo URL, no branching ─────────────────────────

/**
 * Called when a NEW task is about to be launched (not a resume).
 * Detects and stores the GitHub repo URL for UI linking.
 */
export async function handleTaskLaunchGit(task: Task): Promise<void> {
  const dir = task.project_dir;
  if (!dir) return;

  const ws = task.workspace_name;

  try {
    if (!await hasGitRepo(ws, dir)) return;

    // Detect and store the GitHub repo URL for UI linking
    const repoUrl = await detectGitHubRepoUrl(ws, dir);
    if (repoUrl) {
      storeTaskRepoUrl(task.id, repoUrl);
      task.github_repo_url = repoUrl;
    }
  } catch (err: any) {
    console.error(`[git] Launch git setup failed for task ${task.id}:`, err.message);
  }

  // Handle stash switching (stash previous task's changes, restore this task's)
  await handleSwitchToTask(task);
}

// ─── Lazy Stash: only stash when another task needs the working tree ────

/**
 * Called when switching TO a task (launch or resume).
 * If a different task's changes are in the working tree, stash them first,
 * then restore this task's stash if one exists.
 * Finally, marks this task as the active one for the workspace.
 */
export async function handleSwitchToTask(task: Task): Promise<void> {
  const dir = task.project_dir;
  if (!dir) return;

  const ws = task.workspace_name;

  try {
    if (!await hasGitRepo(ws, dir)) return;

    // Check if another task's changes are in the working tree
    const lastActiveId = getLastActiveTaskId(task.workspace_id);
    if (lastActiveId && lastActiveId !== task.id) {
      // Stash the previous task's changes
      const status = await sshExec(ws, `cd ${dir} && git status --porcelain`);
      if (status.trim()) {
        await sshExec(ws, `cd ${dir} && git stash push --include-untracked -m "${stashTag(lastActiveId)}"`, 30000);
        console.log(`[git] Stashed changes for previous task ${lastActiveId}`);
      }
    }

    // Restore this task's stash if one exists
    const idx = await findStashIndex(ws, dir, task.id);
    if (idx >= 0) {
      await sshExec(ws, `cd ${dir} && git stash pop stash@{${idx}}`, 30000);
      console.log(`[git] Restored stash for task ${task.id}`);
    }

    // Mark this task as the active one
    setLastActiveTaskId(task.workspace_id, task.id);
  } catch (err: any) {
    console.error(`[git] Switch-to-task failed for task ${task.id}:`, err.message);
    addMessage(task.id, 'system', `Warning: git stash switch failed: ${err.message}`);
  }
}

/**
 * Called when a task leaves working state (pause/complete).
 * Does NOT stash — changes stay in the working tree for review.
 * Only updates tracking so we know whose changes are there.
 */
export async function handleStashAway(task: Task): Promise<void> {
  // No-op: lazy stashing means we leave changes in the working tree.
  // They'll be stashed later if/when another task needs the working tree.
  // We keep last_active_task_id pointing at this task so we know whose changes are there.
}

// ─── Task Resume: switch to task (lazy stash + restore) ─────────────────

/**
 * Called before a task is resumed (feedback reply).
 */
export async function handleTaskResumeGit(task: Task): Promise<void> {
  await handleSwitchToTask(task);
}

// ─── Manual branch checkout ─────────────────────────────────────────────

/**
 * Manually switch a workspace to a task's branch.
 * Returns a status message. Throws on failure.
 */
export async function checkoutTaskBranch(task: Task): Promise<string> {
  const dir = task.project_dir;
  if (!dir) throw new Error('No project directory for this task');
  if (!task.git_branch) throw new Error('No branch associated with this task');

  const ws = task.workspace_name;
  const currentBranch = (await sshExec(ws, `cd ${dir} && git rev-parse --abbrev-ref HEAD`)).trim();
  if (currentBranch === task.git_branch) {
    return `Already on branch \`${task.git_branch}\``;
  }

  // Stash uncommitted changes before switching
  const status = await sshExec(ws, `cd ${dir} && git status --porcelain`);
  if (status.trim()) {
    await sshExec(ws, `cd ${dir} && git stash push --include-untracked -m "auto-stash before switching to ${task.git_branch}"`, 15000);
  }

  await sshExec(ws, `cd ${dir} && git checkout ${task.git_branch}`, 15000);
  return `Switched to branch \`${task.git_branch}\``;
}

// ─── Task Completion ────────────────────────────────────────────────────

/**
 * After a task is marked complete:
 * - If remote allowed: create branch, commit, push, PR, merge
 * - If remote disabled: refuse if there are uncommitted changes
 *
 * Returns true if completion is allowed, false if blocked.
 */
export async function handleTaskCompletionGit(task: Task): Promise<boolean> {
  const dir = await resolveProjectDir(task);
  if (!dir) return true; // no project dir — nothing to do

  const ws = task.workspace_name;

  try {
    if (!await hasGitRepo(ws, dir)) return true;

    // If another task's changes are in the working tree, stash them first
    const lastActiveId = getLastActiveTaskId(task.workspace_id);
    if (lastActiveId && lastActiveId !== task.id) {
      const prevStatus = await sshExec(ws, `cd ${dir} && git status --porcelain`);
      if (prevStatus.trim()) {
        await sshExec(ws, `cd ${dir} && git stash push --include-untracked -m "${stashTag(lastActiveId)}"`, 30000);
        console.log(`[git] Stashed previous task ${lastActiveId} changes before completing ${task.id}`);
      }
    }

    // Restore this task's stash if one exists
    const stashIdx = await findStashIndex(ws, dir, task.id);
    if (stashIdx >= 0) {
      await sshExec(ws, `cd ${dir} && git stash pop stash@{${stashIdx}}`, 30000);
    }

    const remoteAllowed = isRemoteAllowed(task.workspace_id);

    // Check for uncommitted changes
    const status = await sshExec(ws, `cd ${dir} && git status --porcelain`);
    const hasChanges = !!status.trim();

    if (!remoteAllowed) {
      // Remote disabled: refuse completion if there are uncommitted changes
      if (hasChanges) {
        addMessage(task.id, 'system', 'Cannot complete: there are uncommitted changes. Please handle git operations manually before completing this task.');
        return false;
      }
      return true;
    }

    // Remote allowed: create branch, commit, push, PR, merge
    if (!hasChanges) {
      // Nothing to commit — task is done
      return true;
    }

    const defaultBranch = await getDefaultBranch(ws, dir);

    // Re-read task for latest title
    const freshTask = getTask(task.id) || task;
    const branchName = generateBranchName(freshTask);

    // Create branch (or switch to it if it already exists), commit, push
    const currentBranch = (await sshExec(ws, `cd ${dir} && git rev-parse --abbrev-ref HEAD`)).trim();
    if (currentBranch === branchName) {
      // Already on the right branch (e.g. reopen → complete retry)
    } else {
      try {
        await sshExec(ws, `cd ${dir} && git checkout -b ${branchName}`, 15000);
      } catch {
        // Branch already exists — switch to it
        await sshExec(ws, `cd ${dir} && git checkout ${branchName}`, 15000);
      }
    }
    // Stage and commit (skip if nothing actually staged — worktrees/submodules can show as modified but not stageable)
    await sshExec(ws, `cd ${dir} && git add -A`);
    const staged = await sshExec(ws, `cd ${dir} && git diff --cached --name-only`);
    if (!staged.trim()) {
      // Nothing actually committable — bail out cleanly
      return true;
    }
    await sshExec(ws, `cd ${dir} && git commit -m ${shellEscape(freshTask.title || 'Task changes')}`, 30000);
    storeTaskBranch(task.id, branchName);

    // Detect and store the GitHub repo URL
    const repoUrl = await detectGitHubRepoUrl(ws, dir);
    if (repoUrl) {
      storeTaskRepoUrl(task.id, repoUrl);
    }

    try {
      await sshExec(ws, `cd ${dir} && git push -u origin ${branchName}`, 30000);
    } catch {
      try {
        await sshExec(ws, `cd ${dir} && git push origin ${branchName}`, 30000);
      } catch (pushErr: any) {
        addMessage(task.id, 'system', `Changes committed on branch \`${branchName}\` but push failed: ${pushErr.message}`);
        return true;
      }
    }

    // Create PR (check if one already exists for this branch)
    const prTitle = freshTask.title || `Task: ${freshTask.prompt.slice(0, 60)}`;
    const prBody = `Automated PR for completed task.\n\n**Task:** ${freshTask.title}\n**Task ID:** ${freshTask.id}`;
    let prUrl: string;
    try {
      const existingPr = await sshGh(ws, `cd ${dir} && gh pr view ${branchName} --json url --jq .url 2>/dev/null`);
      if (existingPr.trim()) {
        prUrl = existingPr.trim();
        addMessage(task.id, 'system', `Existing pull request found: ${prUrl}`);
      } else {
        throw new Error('no existing PR');
      }
    } catch {
      prUrl = await sshGh(ws,
        `cd ${dir} && gh pr create --base ${defaultBranch} --head ${branchName} --title ${shellEscape(prTitle)} --body ${shellEscape(prBody)}`
      );
      addMessage(task.id, 'system', `Pull request created: ${prUrl}`);
    }

    // Merge
    try {
      await sshGh(ws, `cd ${dir} && gh pr merge ${branchName} --merge --delete-branch`);
      addMessage(task.id, 'system', `PR merged and branch \`${branchName}\` deleted.`);
      await sshExec(ws, `cd ${dir} && git checkout ${defaultBranch} && git pull origin ${defaultBranch}`, 30000);
    } catch (mergeErr: any) {
      addMessage(task.id, 'system', `PR created but merge failed: ${mergeErr.message}. Manual merge may be needed.`);
    }

    // Clear active task tracking — this task is done
    setLastActiveTaskId(task.workspace_id, null);
    return true;
  } catch (err: any) {
    const reason = `Git completion failed: ${err.message || err}`;
    addMessage(task.id, 'system', `Error: ${reason}`);
    return true; // Don't block completion on git errors
  }
}

// ─── Task Reopen ────────────────────────────────────────────────────────

/**
 * When a task is reopened, nothing special needed — the task just goes
 * back to awaiting_feedback. Any stash handling happens on next resume.
 */
export async function handleTaskReopenGit(_task: Task): Promise<void> {
  // No-op — stash restore happens when the task is next worked on
}

/**
 * Shell-escape a string for safe inclusion in a remote shell command.
 */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
