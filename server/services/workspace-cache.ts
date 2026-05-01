/**
 * Per-user cache of running workspaces, populated by /api/workspaces fetches
 * and read by the discussion prompt builder when injecting cross-workspace
 * task targets. The cache is intentionally short-lived (~60s) — it piggybacks
 * on the UI's normal polling cadence and only feeds the agent's prompt; the
 * authoritative RBAC check happens upstream when listWorkspaces() is called
 * with the user's Coder token.
 */

export interface CachedWorkspace {
  id: string;
  name: string;
  running: boolean;
}

interface Entry {
  workspaces: CachedWorkspace[];
  fetchedAt: number;
}

const TTL_MS = 60_000;
const cache = new Map<string, Entry>();

export function setWorkspacesForUser(userId: string, workspaces: CachedWorkspace[]): void {
  cache.set(userId, { workspaces, fetchedAt: Date.now() });
}

export function getWorkspacesForUser(userId: string): CachedWorkspace[] | null {
  const entry = cache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) {
    cache.delete(userId);
    return null;
  }
  return entry.workspaces;
}

/**
 * Look up a workspace by name (case-insensitive) for a given user, only
 * returning a hit if the workspace is in their cached list. Returns null on
 * miss or stale cache. Used for resolving agent-supplied targetWorkspace
 * names.
 */
export function findUserWorkspaceByName(userId: string, name: string): CachedWorkspace | null {
  const list = getWorkspacesForUser(userId);
  if (!list) return null;
  const lower = name.trim().toLowerCase();
  return list.find(w => w.name.toLowerCase() === lower) ?? null;
}

export function findUserWorkspaceById(userId: string, id: string): CachedWorkspace | null {
  const list = getWorkspacesForUser(userId);
  if (!list) return null;
  return list.find(w => w.id === id) ?? null;
}
