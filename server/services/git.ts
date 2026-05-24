import { sshExec, detectProjectDir } from './claude.js';
import { addMessage, getTask, getWorkingTask, type Task } from './tasks.js';
import { getDb } from '../db/index.js';
import { execFile } from 'child_process';

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
 * Check if the repository has at least one commit. A freshly `git init`'d repo
 * has an unborn HEAD: `rev-parse --is-inside-work-tree` succeeds, but stash,
 * checkout, push, and `rev-parse --abbrev-ref HEAD` all fail until the first
 * commit lands. Skip the entire git lifecycle in that state.
 */
async function hasCommits(workspaceName: string, projectDir: string): Promise<boolean> {
  try {
    await sshExec(workspaceName, `cd ${projectDir} && git rev-parse --verify HEAD`);
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
export function getLastActiveTaskId(workspaceId: string): string | null {
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
 *
 * Behavior depends on whether git remote operations are allowed:
 *
 *   Remote allowed: stash any other task's changes, force-checkout the
 *   default branch (with pull), then pop this task's stash. Every task
 *   starts on a clean default branch — this prevents stale branches from
 *   prior tasks (or mid-task drift) from polluting future work.
 *
 *   Remote disabled: stash/pop only, never touch branches. The user is
 *   driving git manually in this mode.
 */
export async function handleSwitchToTask(task: Task): Promise<void> {
  const dir = task.project_dir;
  if (!dir) return;

  const ws = task.workspace_name;

  try {
    if (!await hasGitRepo(ws, dir)) return;
    if (!await hasCommits(ws, dir)) {
      setLastActiveTaskId(task.workspace_id, task.id);
      return;
    }

    const remoteAllowed = isRemoteAllowed(task.workspace_id);

    // Stash the previous task's changes if the working tree currently belongs
    // to a different task.
    const lastActiveId = getLastActiveTaskId(task.workspace_id);
    if (lastActiveId && lastActiveId !== task.id) {
      const status = await sshExec(ws, `cd ${dir} && git status --porcelain`);
      if (status.trim()) {
        await sshExec(ws, `cd ${dir} && git stash push --include-untracked -m "${stashTag(lastActiveId)}"`, 30000);
        console.log(`[git] Stashed changes for previous task ${lastActiveId}`);
      }
    }

    // Force HEAD onto the default branch so every task starts from a known state.
    // Only when remote ops are allowed — otherwise the user is driving branches manually.
    if (remoteAllowed) {
      try {
        const defaultBranch = await getDefaultBranch(ws, dir);
        const currentBranch = (await sshExec(ws, `cd ${dir} && git rev-parse --abbrev-ref HEAD`)).trim();
        if (currentBranch !== defaultBranch) {
          await sshExec(ws, `cd ${dir} && git checkout ${defaultBranch}`, 15000);
          console.log(`[git] Switched workspace ${ws} from '${currentBranch}' to '${defaultBranch}' for task ${task.id}`);
        }
        await sshExec(ws, `cd ${dir} && git pull --ff-only origin ${defaultBranch}`, 30000).catch((err: any) => {
          console.warn(`[git] Pull on ${defaultBranch} failed (continuing): ${err.message}`);
        });
      } catch (err: any) {
        console.warn(`[git] Could not normalize to default branch: ${err.message}`);
        addMessage(task.id, 'system', `Warning: could not switch to default branch: ${err.message}`);
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
 * No-op under lazy stashing: changes stay in the working tree and are stashed
 * later only if another task needs the tree. We keep last_active_task_id
 * pointing at this task so we know whose changes are there.
 */
export async function handleStashAway(_task: Task): Promise<void> {
  // intentional no-op
}

// ─── Task Resume: switch to task (lazy stash + restore) ─────────────────

/**
 * Called before a task is resumed (feedback reply).
 */
export async function handleTaskResumeGit(task: Task): Promise<void> {
  await handleSwitchToTask(task);
}

// ─── Manual stash activation ────────────────────────────────────────────

/**
 * Make a task the "active" one for its workspace: stash any other task's
 * changes, restore this task's stash (if any), and mark it active.
 * Returns a human-readable status message. Throws on failure.
 */
export async function switchActiveTask(task: Task): Promise<string> {
  const dir = task.project_dir;
  if (!dir) throw new Error('No project directory for this task');

  const ws = task.workspace_name;
  if (!await hasGitRepo(ws, dir)) {
    throw new Error('Workspace has no git repository');
  }

  const lastActiveId = getLastActiveTaskId(task.workspace_id);
  if (lastActiveId === task.id) {
    return 'Already the active task';
  }

  if (lastActiveId && lastActiveId !== task.id) {
    const status = await sshExec(ws, `cd ${dir} && git status --porcelain`);
    if (status.trim()) {
      await sshExec(ws, `cd ${dir} && git stash push --include-untracked -m "${stashTag(lastActiveId)}"`, 30000);
    }
  }

  const idx = await findStashIndex(ws, dir, task.id);
  let restored = false;
  if (idx >= 0) {
    await sshExec(ws, `cd ${dir} && git stash pop stash@{${idx}}`, 30000);
    restored = true;
  }

  setLastActiveTaskId(task.workspace_id, task.id);
  return restored ? 'Restored this task\'s changes to the workspace' : 'Workspace is now showing this task (no prior changes)';
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
 * - Remote allowed: create a fresh task branch off default, commit, push,
 *   open PR, merge, and clean up. Any failure blocks completion so the
 *   user can investigate.
 * - Remote disabled: refuse if there are uncommitted changes; otherwise
 *   pass through. The user is driving branches/pushes manually.
 *
 * Returns true if completion is allowed, false if blocked.
 */
export async function handleTaskCompletionGit(task: Task): Promise<boolean> {
  // Defense-in-depth: refuse if another task is actively working on this
  // workspace. Running git ops (stash/checkout/commit) concurrently with a
  // Claude agent would corrupt its working tree. The /complete endpoint
  // should already queue instead of calling this, but guard anyway.
  const conflicting = getWorkingTask(task.workspace_id);
  if (conflicting && conflicting.id !== task.id) {
    throw new Error(`Cannot run git completion: task ${conflicting.id} is currently working on this workspace.`);
  }

  const dir = await resolveProjectDir(task);
  if (!dir) return true; // no project dir — nothing to do

  const ws = task.workspace_name;

  try {
    if (!await hasGitRepo(ws, dir)) return true;
    if (!await hasCommits(ws, dir)) {
      setLastActiveTaskId(task.workspace_id, null);
      return true;
    }

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
      // Remote disabled: refuse completion if there are uncommitted changes —
      // user must resolve manually before completing.
      if (hasChanges) {
        addMessage(task.id, 'system', 'Cannot complete: there are uncommitted changes. Please handle git operations manually before completing this task.');
        return false;
      }
      return true;
    }

    // Remote allowed: always create a fresh task branch off the default branch.

    const defaultBranch = await getDefaultBranch(ws, dir);

    // Refuse if HEAD has drifted off the default branch — Claude (or someone)
    // switched branches mid-task. We don't try to be clever about cherry-picking;
    // surface the drift so the user can reconcile manually.
    const currentBranch = (await sshExec(ws, `cd ${dir} && git rev-parse --abbrev-ref HEAD`)).trim();
    if (currentBranch !== defaultBranch) {
      addMessage(task.id, 'system',
        `Cannot complete: workspace is on branch \`${currentBranch}\` instead of \`${defaultBranch}\`. ` +
        `The agent appears to have switched branches mid-task. Please reconcile manually ` +
        `(merge or move the work onto \`${defaultBranch}\`) before completing.`
      );
      return false;
    }

    // If there are no changes at all, nothing to do — just complete.
    if (!hasChanges) {
      // No commits to push either (we're sitting on default with a clean tree).
      setLastActiveTaskId(task.workspace_id, null);
      return true;
    }

    const freshTask = getTask(task.id) || task;
    const workingBranch = generateBranchName(freshTask);

    // Create the task branch off default. If a same-named branch somehow exists,
    // refuse rather than overwrite — this keeps the rule "always a fresh branch".
    try {
      await sshExec(ws, `cd ${dir} && git checkout -b ${workingBranch}`, 15000);
    } catch (err: any) {
      addMessage(task.id, 'system',
        `Cannot complete: could not create branch \`${workingBranch}\`: ${err.message}. ` +
        `It may already exist locally — delete it and retry, or rename the task.`
      );
      return false;
    }

    // Commit
    try {
      await sshExec(ws, `cd ${dir} && git add -A`);
      const staged = await sshExec(ws, `cd ${dir} && git diff --cached --name-only`);
      if (staged.trim()) {
        await sshExec(ws, `cd ${dir} && git commit -m ${shellEscape(freshTask.title || 'Task changes')}`, 30000);
      }
    } catch (err: any) {
      addMessage(task.id, 'system', `Cannot complete: git commit failed: ${err.message}`);
      return false;
    }

    storeTaskBranch(task.id, workingBranch);

    // Detect and store the GitHub repo URL
    const repoUrl = await detectGitHubRepoUrl(ws, dir);
    if (repoUrl) {
      storeTaskRepoUrl(task.id, repoUrl);
    }

    // Push — hard-fail on error, leaving the task in awaiting_feedback so the
    // user can inspect (the branch is committed locally but not pushed).
    try {
      await sshExec(ws, `cd ${dir} && git push -u origin ${workingBranch}`, 30000);
    } catch (pushErr: any) {
      addMessage(task.id, 'system',
        `Cannot complete: changes committed on branch \`${workingBranch}\` but push failed: ${pushErr.message}. ` +
        `Resolve the push issue and retry completion.`
      );
      return false;
    }

    // Create PR (or reuse existing for this branch)
    const prTitle = freshTask.title || `Task: ${freshTask.prompt.slice(0, 60)}`;
    const prBody = `Automated PR for completed task.\n\n**Task:** ${freshTask.title}\n**Task ID:** ${freshTask.id}`;
    let prUrl: string;
    try {
      const existingPr = await sshGh(ws, `cd ${dir} && gh pr view ${workingBranch} --json url --jq .url 2>/dev/null`);
      if (existingPr.trim()) {
        prUrl = existingPr.trim();
        addMessage(task.id, 'system', `Existing pull request found: ${prUrl}`);
      } else {
        throw new Error('no existing PR');
      }
    } catch {
      try {
        prUrl = await sshGh(ws,
          `cd ${dir} && gh pr create --base ${defaultBranch} --head ${workingBranch} --title ${shellEscape(prTitle)} --body ${shellEscape(prBody)}`
        );
        addMessage(task.id, 'system', `Pull request created: ${prUrl}`);
      } catch (prErr: any) {
        addMessage(task.id, 'system',
          `Cannot complete: PR creation failed for branch \`${workingBranch}\`: ${prErr.message}. ` +
          `Resolve the issue and retry completion.`
        );
        return false;
      }
    }

    // Merge — hard-fail. Don't auto-clean if merge fails; the user needs the branch to investigate.
    try {
      await sshGh(ws, `cd ${dir} && gh pr merge ${workingBranch} --merge --delete-branch`);
      addMessage(task.id, 'system', `PR merged and branch \`${workingBranch}\` deleted.`);
    } catch (mergeErr: any) {
      addMessage(task.id, 'system',
        `Cannot complete: PR merge failed for \`${workingBranch}\`: ${mergeErr.message}. ` +
        `Resolve any conflicts on the PR and retry completion.`
      );
      return false;
    }

    // Clean up: switch back to default and pull the merged commit.
    try {
      await sshExec(ws, `cd ${dir} && git checkout ${defaultBranch} && git pull --ff-only origin ${defaultBranch}`, 30000);
    } catch (cleanupErr: any) {
      // Cleanup failure is non-fatal — the merge already happened; just warn.
      addMessage(task.id, 'system', `Warning: post-merge cleanup failed: ${cleanupErr.message}. Workspace may need a manual \`git checkout ${defaultBranch} && git pull\`.`);
    }

    // Clear active task tracking — this task is done
    setLastActiveTaskId(task.workspace_id, null);
    return true;
  } catch (err: any) {
    const reason = `Git completion failed: ${err.message || err}`;
    addMessage(task.id, 'system', `Error: ${reason}`);
    // Block completion on git errors — leave the task in awaiting_feedback
    // so the user can inspect, resolve manually, and retry completion.
    return false;
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
