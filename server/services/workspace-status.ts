import { getValidCoderTokenForUser } from './sessions.js';
import { getWorkspaceStatusByName } from './coder.js';

/**
 * Whether a workspace is up, for background work that must never be the reason
 * it comes up: `coder ssh` auto-starts a stopped workspace, so anything that runs
 * on a timer has to ask Coder's REST API (which never starts anything) first.
 *
 * - `running` — safe to SSH in.
 * - `down`    — stopped, stopping, or gone. Nothing of ours is running there.
 * - `unknown` — starting, mid-build, failed build, no token, or the lookup
 *               failed. Don't SSH in, and don't conclude anything either.
 */
export type WorkspaceRunState = 'running' | 'down' | 'unknown';

const DOWN_STATUSES = new Set(['stopped', 'stopping', 'deleted', 'deleting']);

export async function getWorkspaceRunState(workspaceName: string, userId: string | null): Promise<WorkspaceRunState> {
  // The workspace CPM itself runs in is up by definition.
  const local = process.env.CODER_WORKSPACE_NAME || '';
  if (local && workspaceName === local) return 'running';
  let token: string | null = null;
  if (userId) token = await getValidCoderTokenForUser(userId).catch(() => null);
  token = token || process.env.CODER_SESSION_TOKEN || null;
  if (!token) return 'unknown';
  let status: string | null;
  try {
    status = await getWorkspaceStatusByName(token, workspaceName);
  } catch (err) {
    console.warn(`[workspace-status] status check failed for ${workspaceName}: ${(err as Error).message?.slice(0, 150)}`);
    return 'unknown';
  }
  if (status === 'running') return 'running';
  if (status === null || DOWN_STATUSES.has(status)) return 'down';
  return 'unknown';
}
