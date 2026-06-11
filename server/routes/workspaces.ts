import { Router, Request, Response } from 'express';
import { execFile, exec } from 'child_process';
import { requireAuth } from '../middleware/auth.js';
import { listWorkspaces, getWorkspace, stopWorkspace, startWorkspace, CoderAuthError } from '../services/coder.js';
import { getTaskCountsByWorkspace, getTokenTotalsByWorkspace, getGithubRepoUrlsByWorkspace } from '../services/tasks.js';
import { getLatestDiscussionMessageByWorkspace } from '../services/discussions.js';
import { getWorkspaceUsages, getGlobalRateLimits } from '../services/claude.js';
import { deleteSession, refreshAccessToken } from '../services/sessions.js';
import { getModelsForWorkspace } from '../services/models.js';
import { setWorkspacesForUser } from '../services/workspace-cache.js';
import { readWorkspaceMemory, writeWorkspaceMemoryFile } from '../services/workspace-memory.js';

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
  setWorkspacesForUser(req.user!.id, workspaces.map(w => ({
    id: w.id,
    name: w.name,
    running: w.latest_build.status === 'running',
  })));
  assignDefaultVoices(workspaces.map(w => w.id));
  const taskCounts = getTaskCountsByWorkspace();
  const tokenTotals = getTokenTotalsByWorkspace();
  const githubRepoUrls = getGithubRepoUrlsByWorkspace();
  const latestDiscussionMessages = getLatestDiscussionMessageByWorkspace();
  const claudeUsage = getWorkspaceUsages();
  const globalRateLimits = getGlobalRateLimits();
  res.json({ workspaces, taskCounts, tokenTotals, githubRepoUrls, latestDiscussionMessages, claudeUsage, globalRateLimits });
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

// Restart CPM: rebuild server and exit (the wrapper loop restarts the server)
router.post('/restart', requireAuth, (req: Request, res: Response) => {
  const projectRoot = process.cwd();
  console.log('[restart] Build + restart requested, running npm run build:server...');

  exec('npm run build:server', { cwd: projectRoot, timeout: 120000 }, (err, _stdout, stderr) => {
    if (err) {
      console.error('[restart] Build failed:', stderr.slice(0, 500));
      res.status(500).json({ error: 'Build failed', details: stderr.slice(0, 2000) });
      return;
    }
    console.log('[restart] Build succeeded, exiting for restart...');
    res.json({ ok: true, message: 'Build succeeded, restarting...' });

    // Give the response time to flush, then exit
    setTimeout(() => {
      process.exit(0);
    }, 500);
  });
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

// Memory

router.get('/:workspaceId/memory', requireAuth, async (req: Request, res: Response) => {
  const workspace = await withTokenRefresh(req, res, (token) => getWorkspace(token, req.params.workspaceId), 'Failed to fetch workspace');
  if (!workspace) return;
  try {
    const row = getDb()
      .prepare(`SELECT project_dir FROM tasks WHERE workspace_id = ? AND project_dir IS NOT NULL AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`)
      .get(req.params.workspaceId) as { project_dir: string } | undefined;
    const files = await readWorkspaceMemory(workspace.name, row?.project_dir);
    res.json({ files });
  } catch {
    res.status(500).json({ error: 'Failed to read workspace memory' });
  }
});

router.put('/:workspaceId/memory/:filename', requireAuth, async (req: Request, res: Response) => {
  const workspace = await withTokenRefresh(req, res, (token) => getWorkspace(token, req.params.workspaceId), 'Failed to fetch workspace');
  if (!workspace) return;
  const { content } = req.body as { content: unknown };
  if (typeof content !== 'string') {
    res.status(400).json({ error: 'content must be a string' });
    return;
  }
  try {
    const row = getDb()
      .prepare(`SELECT project_dir FROM tasks WHERE workspace_id = ? AND project_dir IS NOT NULL AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`)
      .get(req.params.workspaceId) as { project_dir: string } | undefined;
    await writeWorkspaceMemoryFile(workspace.name, req.params.filename, content, row?.project_dir);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message || 'Failed to write memory file' });
  }
});

// Git settings
import { getDb } from '../db/index.js';

// Kokoro voice IDs in round-robin assignment order
const KOKORO_VOICE_IDS = [
  'kokoro:af_heart', 'kokoro:af_bella', 'kokoro:af_sarah', 'kokoro:af_sky',
  'kokoro:af_nicole', 'kokoro:am_fenrir', 'kokoro:am_michael', 'kokoro:am_puck',
  'kokoro:am_adam', 'kokoro:bf_emma', 'kokoro:bf_isabella', 'kokoro:bm_george',
  'kokoro:bm_fable', 'kokoro:bm_lewis',
];

function assignDefaultVoices(workspaceIds: string[]): void {
  const db = getDb();
  const { c: assignedCount } = db
    .prepare('SELECT COUNT(*) as c FROM workspace_settings WHERE default_voice_id IS NOT NULL')
    .get() as { c: number };
  let nextIdx = assignedCount;
  const now = new Date().toISOString();
  for (const id of workspaceIds) {
    const row = db
      .prepare('SELECT default_voice_id FROM workspace_settings WHERE workspace_id = ?')
      .get(id) as { default_voice_id: string | null } | undefined;
    if (!row || row.default_voice_id === null) {
      const voiceId = KOKORO_VOICE_IDS[nextIdx % KOKORO_VOICE_IDS.length];
      db.prepare(
        `INSERT INTO workspace_settings (workspace_id, default_voice_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET default_voice_id = excluded.default_voice_id, updated_at = excluded.updated_at`
      ).run(id, voiceId, now);
      nextIdx++;
    }
  }
}

router.get('/:workspaceId/git-settings', requireAuth, (req: Request, res: Response) => {
  const row = getDb().prepare('SELECT git_push_enabled FROM workspace_settings WHERE workspace_id = ?')
    .get(req.params.workspaceId) as { git_push_enabled: number } | undefined;
  res.json({ gitPushEnabled: row?.git_push_enabled !== 0 });
});

router.patch('/:workspaceId/git-settings', requireAuth, (req: Request, res: Response) => {
  const { gitPushEnabled } = req.body;
  if (typeof gitPushEnabled !== 'boolean') {
    res.status(400).json({ error: 'gitPushEnabled must be a boolean' });
    return;
  }
  const db = getDb();
  db.prepare(
    `INSERT INTO workspace_settings (workspace_id, git_push_enabled, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET git_push_enabled = ?, updated_at = ?`
  ).run(req.params.workspaceId, gitPushEnabled ? 1 : 0, new Date().toISOString(), gitPushEnabled ? 1 : 0, new Date().toISOString());
  res.json({ ok: true, gitPushEnabled });
});

// Voice settings
router.get('/:workspaceId/voice-settings', requireAuth, (req: Request, res: Response) => {
  const row = getDb().prepare('SELECT voice_ids, default_voice_id FROM workspace_settings WHERE workspace_id = ?')
    .get(req.params.workspaceId) as { voice_ids: string | null; default_voice_id: string | null } | undefined;
  const voiceIds: string[] = row?.voice_ids ? JSON.parse(row.voice_ids) : [];
  const defaultVoiceId: string | null = row?.default_voice_id ?? null;
  res.json({ voiceIds, defaultVoiceId });
});

router.patch('/:workspaceId/voice-settings', requireAuth, (req: Request, res: Response) => {
  const { voiceIds } = req.body as { voiceIds: unknown };
  if (!Array.isArray(voiceIds) || !voiceIds.every(v => typeof v === 'string')) {
    res.status(400).json({ error: 'voiceIds must be an array of strings' });
    return;
  }
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO workspace_settings (workspace_id, voice_ids, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET voice_ids = excluded.voice_ids, updated_at = excluded.updated_at`
  ).run(req.params.workspaceId, JSON.stringify(voiceIds), now);
  res.json({ ok: true, voiceIds });
});

// Preview settings: per-workspace iframe preview URL (auto-detected or user-set)
router.get('/:workspaceId/preview-settings', requireAuth, (req: Request, res: Response) => {
  const row = getDb().prepare('SELECT preview_url FROM workspace_settings WHERE workspace_id = ?')
    .get(req.params.workspaceId) as { preview_url: string | null } | undefined;
  res.json({ previewUrl: row?.preview_url ?? null });
});

router.patch('/:workspaceId/preview-settings', requireAuth, (req: Request, res: Response) => {
  const { previewUrl } = req.body as { previewUrl: unknown };
  if (previewUrl !== null && typeof previewUrl !== 'string') {
    res.status(400).json({ error: 'previewUrl must be a string or null' });
    return;
  }
  let normalized: string | null = null;
  if (typeof previewUrl === 'string') {
    const trimmed = previewUrl.trim();
    if (trimmed === '') {
      normalized = null;
    } else {
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          res.status(400).json({ error: 'previewUrl must use http or https' });
          return;
        }
        normalized = parsed.toString();
      } catch {
        res.status(400).json({ error: 'previewUrl is not a valid URL' });
        return;
      }
    }
  }
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO workspace_settings (workspace_id, preview_url, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET preview_url = excluded.preview_url, updated_at = excluded.updated_at`
  ).run(req.params.workspaceId, normalized, now);
  res.json({ ok: true, previewUrl: normalized });
});


export default router;
