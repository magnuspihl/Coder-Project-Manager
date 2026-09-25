import { Router, Request, Response } from 'express';
import { execFile, exec } from 'child_process';
import net from 'net';
import dnsPromises from 'dns/promises';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { rateLimit } from '../middleware/security.js';
import { listWorkspaces, getWorkspace, stopWorkspace, startWorkspace, CoderAuthError } from '../services/coder.js';
import { getTaskCountsByWorkspace, getTokenTotalsByWorkspace, getGithubRepoUrlsByWorkspace, getWindowedTokenUsage } from '../services/tasks.js';
import { getSubscriptionUsage, getObservedSubscriptionKeys, subscriptionKeyFor, type RateLimitUsage } from '../services/claude.js';
import { listAccounts } from '../services/claude-accounts.js';
import { deleteSession, refreshAccessToken } from '../services/sessions.js';
import { getModelsForWorkspace } from '../services/models.js';
import { getCliInfo, updateCli } from '../services/cli-version.js';
import { getPortOwnerTaskId } from '../services/port-janitor.js';
import { setWorkspacesForUser } from '../services/workspace-cache.js';
import { readWorkspaceMemory, writeWorkspaceMemoryFile } from '../services/workspace-memory.js';
import { resolveWorkspaceRepo, listOpenIssues, getIssueDetail, GitHubError } from '../services/github-issues.js';

const router = Router();

/**
 * Rate limits for the workspace list, attributed to the subscription each
 * workspace is actually running on.
 *
 * Usage is tracked per subscription, not per workspace, because a task can now
 * pick which Claude subscription it burns. A workspace card still wants one pair
 * of bars, so resolve each workspace to the subscription its most recent task
 * used. `rateLimitSubscriptions` carries the human label for that choice so the
 * card can say which subscription the bars refer to instead of implying it's the
 * workspace's own.
 *
 * Deliberately NOT restricted to live tasks. Rate limits describe a reset window
 * measured in hours or days, so the bars are meant to persist between tasks — and
 * with a default account configured (the expected setup) every task is
 * acct:-billed, so a live-only filter would blank the card the moment a task
 * completed and leave nothing for the `ws:` fallback to restore.
 */
function buildWorkspaceRateLimits(userId: string): {
  rateLimits: Record<string, Record<string, RateLimitUsage>>;
  rateLimitSubscriptions: Record<string, string>;
} {
  const rateLimits: Record<string, Record<string, RateLimitUsage>> = {};
  const rateLimitSubscriptions: Record<string, string> = {};

  const labels = new Map(listAccounts(userId).map(a => [a.id, a.label]));
  // One row per workspace: the account used by its most recently touched task.
  // Relies on SQLite's documented guarantee that bare columns in a MAX() aggregate
  // come from the row that produced the max.
  //
  // MAX(datetime(...)), not MAX(...): tasks.updated_at holds two formats —
  // "2026-07-30 12:00:00" from the schema's datetime('now') default (what
  // createTask leaves behind) and "2026-07-30T12:00:00.000Z" from
  // new Date().toISOString() on every later write. Space sorts before 'T', so a
  // plain string MAX picks a stale row over a newer never-updated one.
  //
  // Scoped by user_id because workspace_name is only unique per Coder owner —
  // template-derived names repeat across users, so an unscoped GROUP BY would let
  // another user's task decide what this user's card is attributed to.
  const rows = getDb().prepare(`
    SELECT workspace_name, claude_account_id, MAX(datetime(updated_at)) AS latest
    FROM tasks
    WHERE deleted_at IS NULL
      AND user_id = ?
    GROUP BY workspace_name
  `).all(userId) as Array<{ workspace_name: string; claude_account_id: string | null; latest: string }>;

  for (const row of rows) {
    const workspaceName = row.workspace_name;
    // An account that has since been deleted has no usable label or usage; treat
    // the workspace as being on its own login rather than inventing an attribution.
    const accountId = row.claude_account_id && labels.has(row.claude_account_id)
      ? row.claude_account_id
      : null;

    // Prefer the resolved subscription, but fall back to the workspace's own login
    // when that subscription has no usage recorded yet — e.g. an account added
    // moments ago, or one whose window has never been reported. Without this a
    // freshly pinned workspace would show nothing despite having login history.
    const preferred = getSubscriptionUsage(subscriptionKeyFor(accountId, workspaceName));
    if (preferred) {
      rateLimits[workspaceName] = preferred;
      rateLimitSubscriptions[workspaceName] = accountId ? labels.get(accountId)! : 'workspace login';
      continue;
    }
    if (accountId) {
      const ownLogin = getSubscriptionUsage(subscriptionKeyFor(null, workspaceName));
      if (ownLogin) {
        rateLimits[workspaceName] = ownLogin;
        rateLimitSubscriptions[workspaceName] = 'workspace login';
      }
    }
  }

  // Workspaces with no tasks at all: surface their own login's usage so a
  // workspace used outside CPM still shows whatever was last observed for it.
  for (const key of getObservedSubscriptionKeys()) {
    if (!key.startsWith('ws:')) continue;
    const workspaceName = key.slice('ws:'.length);
    if (rateLimits[workspaceName]) continue;
    const usage = getSubscriptionUsage(key);
    if (!usage) continue;
    rateLimits[workspaceName] = usage;
    rateLimitSubscriptions[workspaceName] = 'workspace login';
  }

  return { rateLimits, rateLimitSubscriptions };
}

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
  // Annotate each forwarded port with the active task that owns it (from the
  // port janitor's latest scan), so the UI can place drifted ports on the right
  // task card. Falls back to null when the janitor has no fresh data.
  for (const w of workspaces) {
    for (const p of w.listening_ports ?? []) {
      p.owner_task_id = getPortOwnerTaskId(w.name, p.port);
    }
  }
  setWorkspacesForUser(req.user!.id, workspaces.map(w => ({
    id: w.id,
    name: w.name,
    running: w.latest_build.status === 'running',
  })));
  assignDefaultVoices(workspaces.map(w => w.id));
  const taskCounts = getTaskCountsByWorkspace();
  const tokenTotals = getTokenTotalsByWorkspace();
  const githubRepoUrls = getGithubRepoUrlsByWorkspace();
  const { rateLimits, rateLimitSubscriptions } = buildWorkspaceRateLimits(req.user!.id);
  res.json({ workspaces, taskCounts, tokenTotals, githubRepoUrls, rateLimits, rateLimitSubscriptions });
});

// Base hostname of the Coder deployment, derived from CODER_URL. The caller's
// Coder-Session-Token is only ever attached to requests targeting this host or
// its subdomains (the wildcard port-forward / app hostnames), never to
// arbitrary destinations.
const CODER_HOST = (() => {
  try { return new URL(process.env.CODER_URL || '').hostname.toLowerCase(); } catch { return ''; }
})();

function isCoderHost(hostname: string): boolean {
  if (!CODER_HOST) return false;
  const h = hostname.toLowerCase();
  return h === CODER_HOST || h.endsWith('.' + CODER_HOST);
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true; // malformed → treat as unsafe
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return isPrivateIpv4(ip);
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIpv4(mapped[1]);
    // fe80::/10 link-local, fc00::/7 unique-local
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    return false;
  }
  return true; // not an IP literal — caller resolves via DNS
}

// Proxy favicon/icon images from workspace ports (they require Coder auth)
// Must be before /:id to avoid being caught by the wildcard route
router.get('/proxy-icon', requireAuth, async (req: Request, res: Response) => {
  const url = req.query.url as string;
  if (!url) {
    res.status(400).json({ error: 'Missing url parameter' });
    return;
  }

  // Validate the target before making any request. Only the Coder deployment's
  // own host (and its port-forward/app subdomains) ever receives the caller's
  // Coder token, so it can't be exfiltrated to an attacker-controlled URL.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    res.status(400).json({ error: 'Invalid url' });
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    res.status(400).json({ error: 'Unsupported protocol' });
    return;
  }
  const host = parsed.hostname.toLowerCase();
  const coderHost = isCoderHost(host);

  // SSRF guards apply only to NON-Coder hosts. The Coder deployment itself is
  // trusted and, on self-hosted installs, legitimately resolves to a private
  // address (e.g. coder.pihl.family → 192.168.x.x), so its wildcard favicon
  // URLs must not be caught by the private-IP block. No token is sent to
  // non-Coder hosts, so the checks below are purely SSRF-to-internal defense.
  if (!coderHost) {
    if (host === 'localhost' || host.endsWith('.localhost')) {
      res.status(400).json({ error: 'Blocked host' });
      return;
    }
    // Literal IP in a private/reserved range → block outright.
    if (net.isIP(host) && isPrivateIp(host)) {
      res.status(400).json({ error: 'Blocked host' });
      return;
    }
    // Hostname → resolve and block if any address is private. Best-effort
    // pre-flight only: fetch() below resolves DNS independently, so this is
    // NOT rebinding-proof. That residual is acceptable here because no
    // credential is attached to non-Coder requests — a rebind can at most
    // return image bytes from an internal host, never leak the Coder token.
    if (!net.isIP(host)) {
      try {
        const addrs = await dnsPromises.lookup(host, { all: true });
        if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
          res.status(400).json({ error: 'Blocked host' });
          return;
        }
      } catch {
        res.status(502).end();
        return;
      }
    }
  }

  try {
    const iconRes = await fetch(url, {
      headers: coderHost ? { 'Coder-Session-Token': req.session!.coder_access_token } : {},
      signal: AbortSignal.timeout(3000),
      redirect: 'error', // don't follow redirects into blocked hosts
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
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=300');
    const buffer = Buffer.from(await iconRes.arrayBuffer());
    res.send(buffer);
  } catch {
    res.status(502).end();
  }
});

// Restart CPM: rebuild server and exit (the wrapper loop restarts the server).
// Admin-only and rate limited — it takes the whole deployment down for every
// user, so it is not something any authenticated Coder user should be able to
// trigger, let alone in a loop.
const restartLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  message: 'Too many restart requests. Try again shortly.',
});

router.post('/restart', requireAuth, requireAdmin, restartLimiter, (req: Request, res: Response) => {
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
// Token usage attributable to a rolling time window, for a single workspace.
// Accepts `?since=<unixms>` (inclusive lower bound) or `?hours=<n>` (window
// ending now). `since` takes precedence when both are given; defaults to the
// last 24 hours when neither is supplied. Returns per-workspace and per-task
// sums with the input/output/cache split. This is additive — the cumulative
// all-time totals on GET /workspaces (tokenTotals) are unchanged.
router.get('/:workspaceId/token-usage', requireAuth, (req: Request, res: Response) => {
  const now = Date.now();
  let since: number;
  const sinceRaw = req.query.since;
  const hoursRaw = req.query.hours;
  if (typeof sinceRaw === 'string' && sinceRaw.trim() !== '') {
    since = Number(sinceRaw);
    if (!Number.isFinite(since) || since < 0) {
      res.status(400).json({ error: 'Invalid `since` — expected a unix-ms timestamp.' });
      return;
    }
  } else if (typeof hoursRaw === 'string' && hoursRaw.trim() !== '') {
    const hours = Number(hoursRaw);
    if (!Number.isFinite(hours) || hours <= 0) {
      res.status(400).json({ error: 'Invalid `hours` — expected a positive number.' });
      return;
    }
    since = now - hours * 3_600_000;
  } else {
    since = now - 24 * 3_600_000;
  }

  const usage = getWindowedTokenUsage(since, req.params.workspaceId);
  res.json(usage);
});

// GitHub issues — backing for the "+ Issue" task composer. Only workspaces whose
// repo is on GitHub get a repo back; everything else returns `repo: null` and the
// UI hides the entry point rather than showing a broken browser.

router.get('/:workspaceId/github/issues', requireAuth, async (req: Request, res: Response) => {
  const workspace = await withTokenRefresh(req, res, (token) => getWorkspace(token, req.params.workspaceId), 'Failed to fetch workspace');
  if (!workspace) return;

  const repo = await resolveWorkspaceRepo(req.params.workspaceId, workspace.name, req.user!.id);
  if (!repo) {
    res.json({ repo: null, issues: [] });
    return;
  }
  try {
    const issues = await listOpenIssues(repo, req.user!.id);
    res.json({ repo, issues });
  } catch (err) {
    const status = err instanceof GitHubError ? err.status : 502;
    res.status(status).json({ repo, error: (err as Error).message || 'Failed to list issues' });
  }
});

router.get('/:workspaceId/github/issues/:number', requireAuth, async (req: Request, res: Response) => {
  const issueNumber = Number(req.params.number);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    res.status(400).json({ error: 'Invalid issue number' });
    return;
  }
  const workspace = await withTokenRefresh(req, res, (token) => getWorkspace(token, req.params.workspaceId), 'Failed to fetch workspace');
  if (!workspace) return;

  const repo = await resolveWorkspaceRepo(req.params.workspaceId, workspace.name, req.user!.id);
  if (!repo) {
    res.status(404).json({ error: 'This workspace is not checked out on a GitHub repository.' });
    return;
  }
  try {
    const issue = await getIssueDetail(repo, issueNumber, req.user!.id);
    res.json({ repo, issue });
  } catch (err) {
    const status = err instanceof GitHubError ? err.status : 502;
    res.status(status).json({ error: (err as Error).message || 'Failed to fetch issue' });
  }
});

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

/**
 * Claude Code CLI version for a workspace.
 *
 * Deliberately separate from /models rather than folded into it: the probe greps
 * the whole CLI binary and can take tens of seconds on a cold cache, and the
 * model dropdown must not wait on it. The client fetches both in parallel and
 * layers the staleness warning on once this resolves.
 */
router.get('/:workspaceId/cli', requireAuth, async (req: Request, res: Response) => {
  const workspace = await withTokenRefresh(req, res, (token) => getWorkspace(token, req.params.workspaceId), 'Failed to fetch workspace');
  if (!workspace) return;

  try {
    const cli = await getCliInfo(workspace.name, req.user!.id);
    res.json({ cli });
  } catch {
    res.status(500).json({ error: 'Failed to probe CLI version' });
  }
});

router.post('/:workspaceId/cli/update', requireAuth, async (req: Request, res: Response) => {
  const workspace = await withTokenRefresh(req, res, (token) => getWorkspace(token, req.params.workspaceId), 'Failed to fetch workspace');
  if (!workspace) return;

  try {
    const result = await updateCli(workspace.name, req.user!.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, version: null, output: (err as Error).message?.slice(0, 500) || 'Update failed' });
  }
});

// Memory — view and edit the agent's cross-task memory files for a workspace

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
  const row = getDb().prepare('SELECT git_push_enabled, fork_pr_mode FROM workspace_settings WHERE workspace_id = ?')
    .get(req.params.workspaceId) as { git_push_enabled: number; fork_pr_mode: number } | undefined;
  res.json({
    gitPushEnabled: row?.git_push_enabled !== 0,
    forkPrMode: row?.fork_pr_mode === 1,
  });
});

router.patch('/:workspaceId/git-settings', requireAuth, (req: Request, res: Response) => {
  const { gitPushEnabled, forkPrMode } = req.body;
  if (gitPushEnabled === undefined && forkPrMode === undefined) {
    res.status(400).json({ error: 'gitPushEnabled and/or forkPrMode must be provided' });
    return;
  }
  if (gitPushEnabled !== undefined && typeof gitPushEnabled !== 'boolean') {
    res.status(400).json({ error: 'gitPushEnabled must be a boolean' });
    return;
  }
  if (forkPrMode !== undefined && typeof forkPrMode !== 'boolean') {
    res.status(400).json({ error: 'forkPrMode must be a boolean' });
    return;
  }
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT git_push_enabled, fork_pr_mode FROM workspace_settings WHERE workspace_id = ?')
    .get(req.params.workspaceId) as { git_push_enabled: number; fork_pr_mode: number } | undefined;
  const nextGitPushEnabled = gitPushEnabled !== undefined ? (gitPushEnabled ? 1 : 0) : (existing?.git_push_enabled ?? 1);
  const nextForkPrMode = forkPrMode !== undefined ? (forkPrMode ? 1 : 0) : (existing?.fork_pr_mode ?? 0);
  db.prepare(
    `INSERT INTO workspace_settings (workspace_id, git_push_enabled, fork_pr_mode, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET git_push_enabled = ?, fork_pr_mode = ?, updated_at = ?`
  ).run(req.params.workspaceId, nextGitPushEnabled, nextForkPrMode, now, nextGitPushEnabled, nextForkPrMode, now);
  res.json({ ok: true, gitPushEnabled: nextGitPushEnabled === 1, forkPrMode: nextForkPrMode === 1 });
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
