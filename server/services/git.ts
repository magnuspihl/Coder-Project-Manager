import { sshExec } from './claude.js';
import { addMessage, type Task } from './tasks.js';

/**
 * Check if the workspace is on a non-main feature branch with commits ahead of main.
 * Returns branch name if so, null otherwise.
 */
async function getFeatureBranch(workspaceName: string, projectDir: string): Promise<string | null> {
  try {
    const branch = await sshExec(workspaceName, `cd ${projectDir} && git rev-parse --abbrev-ref HEAD`);
    if (!branch || branch === 'main' || branch === 'master') {
      return null;
    }
    return branch;
  } catch {
    return null;
  }
}

/**
 * Check if the current branch has commits ahead of the default branch.
 */
async function hasCommitsAhead(workspaceName: string, projectDir: string, branch: string): Promise<boolean> {
  try {
    // Try main first, fall back to master
    let defaultBranch = 'main';
    try {
      await sshExec(workspaceName, `cd ${projectDir} && git rev-parse --verify origin/main`);
    } catch {
      defaultBranch = 'master';
    }

    const count = await sshExec(workspaceName,
      `cd ${projectDir} && git rev-list --count origin/${defaultBranch}..${branch} 2>/dev/null || echo 0`
    );
    return parseInt(count, 10) > 0;
  } catch {
    return false;
  }
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
 * After a task is marked complete, check for a feature branch and create a PR + merge.
 * This is a best-effort operation — failures are logged as system messages on the task
 * but do not block task completion.
 */
export async function handleTaskCompletionGit(task: Task): Promise<void> {
  if (!task.project_dir) return;

  const { workspace_name: ws, project_dir: dir } = task;

  try {
    const branch = await getFeatureBranch(ws, dir);
    if (!branch) {
      // On main/master or no git — nothing to do
      return;
    }

    // Ensure all changes are committed and pushed
    const status = await sshExec(ws, `cd ${dir} && git status --porcelain`);
    if (status) {
      // There are uncommitted changes — commit them
      await sshExec(ws, `cd ${dir} && git add -A && git commit -m "Final changes for task ${task.id}"`, 30000);
    }

    // Push the branch
    try {
      await sshExec(ws, `cd ${dir} && git push -u origin ${branch}`, 30000);
    } catch {
      await sshExec(ws, `cd ${dir} && git push origin ${branch}`, 30000);
    }

    const ahead = await hasCommitsAhead(ws, dir, branch);
    if (!ahead) {
      addMessage(task.id, 'system', `Branch \`${branch}\` has no new commits ahead of the default branch. No PR created.`);
      return;
    }

    const defaultBranch = await getDefaultBranch(ws, dir);

    // Create PR using gh CLI
    const prTitle = task.title || `Task: ${task.prompt.slice(0, 60)}`;
    const prBody = `Automated PR for completed task.\n\n**Task:** ${task.title}\n**Task ID:** ${task.id}`;
    const prUrl = await sshExec(ws,
      `cd ${dir} && gh pr create --base ${defaultBranch} --head ${branch} --title ${shellEscape(prTitle)} --body ${shellEscape(prBody)}`,
      30000
    );

    addMessage(task.id, 'system', `Pull request created: ${prUrl}`);

    // Merge the PR
    try {
      await sshExec(ws, `cd ${dir} && gh pr merge ${branch} --merge --delete-branch`, 30000);
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

/**
 * When a completed task is reopened, create a new feature branch for continued work.
 */
export async function handleTaskReopenGit(task: Task): Promise<void> {
  if (!task.project_dir) return;

  const { workspace_name: ws, project_dir: dir } = task;

  try {
    // Make sure we're on the default branch first
    const defaultBranch = await getDefaultBranch(ws, dir);
    const currentBranch = await sshExec(ws, `cd ${dir} && git rev-parse --abbrev-ref HEAD`);

    if (currentBranch === defaultBranch) {
      await sshExec(ws, `cd ${dir} && git pull origin ${defaultBranch}`, 30000);
    }

    // Create a descriptive branch name from the task title
    const slug = (task.title || 'task')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    const shortId = task.id.slice(0, 8);
    const branchName = `task/${slug}-${shortId}`;

    await sshExec(ws, `cd ${dir} && git checkout -b ${branchName}`, 15000);
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
