import { Router, Request, Response } from 'express';
import { execFile } from 'child_process';
import { requireAuth } from '../middleware/auth.js';
import { listWorkspaces, getWorkspace, stopWorkspace, startWorkspace, CoderAuthError } from '../services/coder.js';
import { getTaskCountsByWorkspace, getTokenTotalsByWorkspace, getGithubRepoUrlsByWorkspace } from '../services/tasks.js';
import { getLatestDiscussionMessageByWorkspace } from '../services/discussions.js';
import { getWorkspaceUsages } from '../services/claude.js';
import { deleteSession, refreshAccessToken } from '../services/sessions.js';
import { getModelsForWorkspace } from '../services/models.js';

const router = Router();

/**
 * Wraps a Coder API call with automatic token refresh on auth failure.
 * The `fn` receives the current access token. On CoderAuthError, we attempt
 * a refresh and retry once. If refresh fails, we invalidate the session.
 */
async function withTokenRefresh<T>(
  req: Request,
  res: Response,
  fn: (token: string) => Promise<T>,
  fallbackMsg: string,
): Promise<T | undefined> {
  try {
    return await fn(req.session!.coder_access_token);
  } catch (err) {
    if (err instanceof CoderAuthError && req.session!.coder_refresh_token) {
      const newToken = await refreshAccessToken(req.session!);
      if (newToken) {
        // Update in-memory session for subsequent middleware/handlers in this request
        req.session!.coder_access_token = newToken;
        try {
          return await fn(newToken);
        } catch (retryErr) {
          if (retryErr instanceof CoderAuthError) {
            // Refresh succeeded but token still rejected — force logout
            deleteSession(req.session!.id);
            res.clearCookie('session_id');
            res.status(401).json({ error: 'Coder token expired. Please log in again.' });
            return undefined;
          }
          res.status(502).json({ error: fallbackMsg });
          return undefined;
        }
      }
    }
    if (err instanceof CoderAuthError) {
      deleteSession(req.session!.id);
      res.clearCookie('session_id');
      res.status(401).json({ error: 'Coder token expired. Please log in again.' });
      return undefined;
    }
    res.status(502).json({ error: fallbackMsg });
    return undefined;
  }
}

router.get('/', requireAuth, async (req: Request, res: Response) => {
  const workspaces = await withTokenRefresh(req, res, (token) => listWorkspaces(token), 'Failed to fetch workspaces from Coder');
  if (workspaces === undefined) return;
  const taskCounts = getTaskCountsByWorkspace();
  const tokenTotals = getTokenTotalsByWorkspace();
  const githubRepoUrls = getGithubRepoUrlsByWorkspace();
  const latestDiscussionMessages = getLatestDiscussionMessageByWorkspace();
  const claudeUsage = getWorkspaceUsages();
  res.json({ workspaces, taskCounts, tokenTotals, githubRepoUrls, latestDiscussionMessages, claudeUsage });
});

// Proxy favicon/icon images from workspace ports (they require Coder auth)
// Must be before /:id to avoid being caught by the wildcard route
router.get('/proxy-icon', requireAuth, async (req: Request, res: Response) => {
  const url = req.query.url as string;
  if (!url) {
    res.status(400).json({ error: 'Missing url parameter' });
    return;
  }

  try {
    const iconRes = await fetch(url, {
      headers: { 'Coder-Session-Token': req.session!.coder_access_token },
      signal: AbortSignal.timeout(3000),
    });
    if (!iconRes.ok) {
      res.status(iconRes.status).end();
      return;
    }
    const contentType = iconRes.headers.get('content-type') || 'image/x-icon';
    // Only proxy image content types
    if (!contentType.startsWith('image/')) {
      res.status(415).end();
      return;
    }
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=300');
    const buffer = Buffer.from(await iconRes.arrayBuffer());
    res.send(buffer);
  } catch {
    res.status(502).end();
  }
});

router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  const workspace = await withTokenRefresh(req, res, (token) => getWorkspace(token, req.params.id), 'Failed to fetch workspace from Coder');
  if (workspace === undefined) return;
  res.json({ workspace });
});

// Stop a workspace
router.post('/:id/stop', requireAuth, async (req: Request, res: Response) => {
  const result = await withTokenRefresh(req, res, (token) => stopWorkspace(token, req.params.id), 'Failed to stop workspace');
  if (result === undefined) return;
  res.json({ ok: true });
});

// Start a workspace
router.post('/:id/start', requireAuth, async (req: Request, res: Response) => {
  const result = await withTokenRefresh(req, res, (token) => startWorkspace(token, req.params.id), 'Failed to start workspace');
  if (result === undefined) return;
  res.json({ ok: true });
});

// Discover git project directories in a workspace
router.get('/:id/projects', requireAuth, async (req: Request, res: Response) => {
  const workspace = await withTokenRefresh(req, res, (token) => getWorkspace(token, req.params.id), 'Failed to discover projects');
  if (workspace === undefined) return;
  const wsName = workspace.name;

  // Find directories containing .git in home dir (max depth 3)
  const dirs = await new Promise<string[]>((resolve) => {
    execFile('coder', ['ssh', wsName, '--', 'find', '/home', '-maxdepth', '4', '-name', '.git', '-type', 'd', '-not', '-path', '*/.*/*'], {
      timeout: 10000,
    }, (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      const projects = stdout.trim().split('\n')
        .filter(Boolean)
        .map(p => p.replace(/\/\.git$/, ''));
      resolve(projects);
    });
  });

  res.json({ projects: dirs });
});

// Get available Claude models for a workspace
router.get('/:workspaceId/models', requireAuth, async (req: Request, res: Response) => {
  const workspace = await withTokenRefresh(req, res, (token) => getWorkspace(token, req.params.workspaceId), 'Failed to fetch workspace');
  if (!workspace) return;

  try {
    const models = await getModelsForWorkspace(workspace.name);
    res.json({ models });
  } catch {
    res.status(500).json({ error: 'Failed to fetch models' });
  }
});

export default router;
