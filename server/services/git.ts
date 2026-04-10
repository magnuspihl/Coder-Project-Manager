import { sshExec, detectProjectDir } from './claude.js';
import { addMessage, type Task } from './tasks.js';
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
    // Export GH_TOKEN inside a shell so && chains work correctly over SSH
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

// ─── Task Launch: create a feature branch ───────────────────────────────

/**
 * Called when a NEW task is about to be launched (not a resume).
 * Creates a feature branch off the default branch and stores it on the task.
 */
export async function handleTaskLaunchGit(task: Task): Promise<void> {
  const dir = task.project_dir;
  if (!dir) return;

  const ws = task.workspace_name;

  try {
    if (!await hasGitRepo(ws, dir)) return;

    const defaultBranch = await getDefaultBranch(ws, dir);

    // Make sure we're on the default branch and up to date
    await sshExec(ws, `cd ${dir} && git checkout ${defaultBranch}`, 15000);
    try {
      await sshExec(ws, `cd ${dir} && git pull origin ${defaultBranch}`, 30000);
    } catch {
      // Pull may fail if no remote — continue anyway
    }

    const branchName = generateBranchName(task);
    await sshExec(ws, `cd ${dir} && git checkout -b ${branchName}`, 15000);

    storeTaskBranch(task.id, branchName);
    task.git_branch = branchName;

    // Detect and store the GitHub repo URL for UI linking
    const repoUrl = await detectGitHubRepoUrl(ws, dir);
    if (repoUrl) {
      storeTaskRepoUrl(task.id, repoUrl);
      task.github_repo_url = repoUrl;
    }

    console.log(`[git] Created branch ${branchName} for task ${task.id}`);
  } catch (err: any) {
    console.error(`[git] Failed to create branch for task ${task.id}:`, err.message);
    // Non-fatal — Claude can still work on whatever branch is active
  }
}

// ─── Task Resume: switch to the task's branch ───────────────────────────

/**
 * Called before a task is resumed (feedback reply).
 * Switches the workspace to the task's stored branch.
 */
export async function handleTaskResumeGit(task: Task): Promise<void> {
  const dir = task.project_dir;
  if (!dir || !task.git_branch) return;

  const ws = task.workspace_name;

  try {
    const currentBranch = await sshExec(ws, `cd ${dir} && git rev-parse --abbrev-ref HEAD`);
    if (currentBranch === task.git_branch) return; // Already on correct branch

    // Stash any uncommitted changes from the current branch before switching
    const status = await sshExec(ws, `cd ${dir} && git status --porcelain`);
    if (status) {
      await sshExec(ws, `cd ${dir} && git stash push -m "auto-stash before switching to ${task.git_branch}"`, 15000);
    }

    await sshExec(ws, `cd ${dir} && git checkout ${task.git_branch}`, 15000);
    console.log(`[git] Switched to branch ${task.git_branch} for task ${task.id}`);
  } catch (err: any) {
    console.error(`[git] Failed to switch to branch ${task.git_branch}:`, err.message);
    addMessage(task.id, 'system', `Warning: could not switch to branch \`${task.git_branch}\`: ${err.message}`);
  }
}

// ─── Task Completion: PR + merge ────────────────────────────────────────

/**
 * After a task is marked complete, check for a feature branch and create a PR + merge.
 * This is a best-effort operation — failures are logged as system messages on the task
 * but do not block task completion.
 */
export async function handleTaskCompletionGit(task: Task): Promise<void> {
  const dir = await resolveProjectDir(task);
  if (!dir) return;

  const ws = task.workspace_name;

  try {
    // Use stored branch name, or detect current branch
    let branch = task.git_branch;
    if (!branch) {
      try {
        const current = await sshExec(ws, `cd ${dir} && git rev-parse --abbrev-ref HEAD`);
        if (current && current !== 'main' && current !== 'master') {
          branch = current;
        }
      } catch {
        // ignore
      }
    }

    if (!branch) {
      // On main/master or no git — nothing to do
      return;
    }

    // Switch to the task's branch to ensure we're committing on the right one
    await sshExec(ws, `cd ${dir} && git checkout ${branch}`, 15000);

    // Ensure all changes are committed and pushed
    const status = await sshExec(ws, `cd ${dir} && git status --porcelain`);
    if (status) {
      await sshExec(ws, `cd ${dir} && git add -A && git commit -m "Final changes for task ${task.id}"`, 30000);
    }

    // Push the branch
    try {
      await sshExec(ws, `cd ${dir} && git push -u origin ${branch}`, 30000);
    } catch {
      await sshExec(ws, `cd ${dir} && git push origin ${branch}`, 30000);
    }

    // Check if there are commits to PR
    const defaultBranch = await getDefaultBranch(ws, dir);
    const count = await sshExec(ws,
      `cd ${dir} && git rev-list --count origin/${defaultBranch}..${branch} 2>/dev/null || echo 0`
    );
    if (parseInt(count, 10) <= 0) {
      addMessage(task.id, 'system', `Branch \`${branch}\` has no new commits ahead of ${defaultBranch}. No PR created.`);
      return;
    }

    // Create PR using gh CLI (with GH_TOKEN from Coder external auth)
    const prTitle = task.title || `Task: ${task.prompt.slice(0, 60)}`;
    const prBody = `Automated PR for completed task.\n\n**Task:** ${task.title}\n**Task ID:** ${task.id}`;
    const prUrl = await sshGh(ws,
      `cd ${dir} && gh pr create --base ${defaultBranch} --head ${branch} --title ${shellEscape(prTitle)} --body ${shellEscape(prBody)}`
    );

    addMessage(task.id, 'system', `Pull request created: ${prUrl}`);

    // Merge the PR
    try {
      await sshGh(ws, `cd ${dir} && gh pr merge ${branch} --merge --delete-branch`);
      addMessage(task.id, 'system', `PR merged and branch \`${branch}\` deleted.`);

      // Switch back to default branch
      await sshExec(ws, `cd ${dir} && git checkout ${defaultBranch} && git pull origin ${defaultBranch}`, 30000);
    } catch (mergeErr: any) {
      addMessage(task.id, 'system', `PR created but merge failed: ${mergeErr.message || mergeErr}. Manual merge may be needed.`);
    }
  } catch (err: any) {
    addMessage(task.id, 'system', `Git PR/merge failed: ${err.message || err}`);
  }
}

// ─── Task Reopen: new feature branch ────────────────────────────────────

/**
 * When a task is reopened, check out its existing branch if it still exists.
 * Only create a new branch if the previous one was deleted (e.g. merged and cleaned up).
 */
export async function handleTaskReopenGit(task: Task): Promise<void> {
  const dir = await resolveProjectDir(task);
  if (!dir) return;

  const ws = task.workspace_name;

  try {
    if (!await hasGitRepo(ws, dir)) return;

    // If the task already has a branch, check if it still exists locally
    const existingBranch = task.git_branch;
    if (existingBranch) {
      try {
        await sshExec(ws, `cd ${dir} && git rev-parse --verify ${existingBranch} 2>/dev/null`);
        // Branch still exists — just check it out
        await sshExec(ws, `cd ${dir} && git checkout ${existingBranch}`, 15000);
        addMessage(task.id, 'system', `Switched back to existing branch \`${existingBranch}\`.`);
        return;
      } catch {
        // Branch doesn't exist locally — check remote
        try {
          await sshExec(ws, `cd ${dir} && git fetch origin ${existingBranch} 2>/dev/null && git checkout -b ${existingBranch} origin/${existingBranch}`, 30000);
          addMessage(task.id, 'system', `Checked out existing remote branch \`${existingBranch}\`.`);
          return;
        } catch {
          // Branch is gone entirely — fall through to create a new one
        }
      }
    }

    const defaultBranch = await getDefaultBranch(ws, dir);
    await sshExec(ws, `cd ${dir} && git checkout ${defaultBranch}`, 15000);
    try {
      await sshExec(ws, `cd ${dir} && git pull origin ${defaultBranch}`, 30000);
    } catch {
      // continue
    }

    // Generate a new branch name (append -v2, -v3, etc. if the base name is taken)
    const baseName = generateBranchName(task);
    let branchName = baseName;
    let attempt = 2;
    while (true) {
      try {
        await sshExec(ws, `cd ${dir} && git rev-parse --verify ${branchName} 2>/dev/null`);
        // Branch exists — try next suffix
        branchName = `${baseName}-v${attempt}`;
        attempt++;
      } catch {
        // Branch doesn't exist — we can use it
        break;
      }
    }

    await sshExec(ws, `cd ${dir} && git checkout -b ${branchName}`, 15000);

    storeTaskBranch(task.id, branchName);

    // Detect and store the GitHub repo URL for UI linking
    const repoUrl = await detectGitHubRepoUrl(ws, dir);
    if (repoUrl) {
      storeTaskRepoUrl(task.id, repoUrl);
    }

    addMessage(task.id, 'system', `Created new branch \`${branchName}\` for continued work.`);
  } catch (err: any) {
    addMessage(task.id, 'system', `Failed to create feature branch: ${err.message || err}`);
  }
}

/**
 * Shell-escape a string for safe inclusion in a remote shell command.
 */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
