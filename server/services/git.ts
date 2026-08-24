import { sshExec as coderSshExec, detectProjectDir, type RemoteExecError } from './claude.js';
import { getValidCoderTokenForUser } from './sessions.js';
import { addMessage, getTask, type Task } from './tasks.js';
import { getDb } from '../db/index.js';
import { execFile } from 'child_process';
import { AsyncLocalStorage } from 'async_hooks';

const CPM_WORKTREE_BASE = process.env.CPM_WORKTREE_BASE || '/home/coder/.cpm/worktrees';

/**
 * Per-step timeout budgets for the remote git/gh steps below.
 *
 * Every one of these runs through `coder ssh`, which adds connection overhead on
 * top of the command itself, and against real repositories — the ones that fail
 * in practice have ~100MB of git history, where `git add -A` and a first branch
 * push are not 15-second operations. Each step is therefore generous, because the
 * failure mode of a too-small step budget is bad in both directions: the step is
 * reported as an unexplained failure (execFile kills the child and leaves no
 * error text at all), and for `push` it is a *false* failure — SIGTERM to the
 * local client does not undo a ref update the remote already accepted.
 *
 * Generous per-step budgets do NOT get to add up, though: `handleTaskCompletionGit`
 * is awaited while holding the per-workspace lock (routes/tasks.ts, mcp/index.ts),
 * which blocks processQueue and every other task on that workspace. Summing the
 * worst-case path would hold that lock for the better part of an hour. So the whole
 * flow also runs under one wall-clock deadline (GIT_T_COMPLETION_TOTAL) that clamps
 * every remaining step — see `withCompletionDeadline`.
 */
const GIT_T_READ = 30_000;      // metadata reads: rev-parse, config, status, ls-remote
const GIT_T_INDEX = 120_000;    // index/worktree writes: add -A, commit, checkout
const GIT_T_NETWORK = 180_000;  // anything talking to the remote: fetch, merge, push, gh
const GIT_T_WORKTREE = 180_000; // `git worktree add` = a full checkout

/** Wall-clock ceiling on one whole completion attempt, lock included. */
const GIT_T_COMPLETION_TOTAL = parseInt(
  process.env.CPM_GIT_COMPLETION_BUDGET_MS || '600000', 10,
);

/** How hard to re-check the remote ref after a *killed* push (see the push step). */
const PUSH_LANDED_ATTEMPTS = 4;
const PUSH_LANDED_RETRY_DELAY_MS = 5_000;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Deadline for the enclosing completion attempt, propagated through awaits by
 * AsyncLocalStorage so that *every* remote call made below — including the ones
 * inside helpers several frames deep (detectGitRemote, completePrGitHub, the
 * Azure poll loop) — is clamped without threading a parameter through all of them.
 */
const completionDeadline = new AsyncLocalStorage<{ endsAt: number }>();

/** Run `fn` under an overall wall-clock deadline for remote calls. */
function withCompletionDeadline<T>(totalMs: number, fn: () => Promise<T>): Promise<T> {
  return completionDeadline.run({ endsAt: Date.now() + totalMs }, fn);
}

/**
 * Module-wide stand-in for the real `sshExec`: identical, except that inside a
 * `withCompletionDeadline` scope it shortens each step to whatever is left of the
 * overall budget and refuses outright once that budget is spent. Everything in
 * this file calls remote commands through here (directly, or via sshGh/adoApi),
 * so the deadline cannot be bypassed by adding another step.
 */
function sshExec(
  workspaceName: string,
  command: string,
  timeout = 15000,
  userId?: string | null,
  maxBuffer?: number,
): Promise<string> {
  const ctx = completionDeadline.getStore();
  if (!ctx) return coderSshExec(workspaceName, command, timeout, userId, maxBuffer);
  const left = ctx.endsAt - Date.now();
  if (left <= 0) {
    return Promise.reject(new Error(
      `the git completion flow ran out of its ${Math.round(GIT_T_COMPLETION_TOTAL / 1000)}s overall time budget ` +
      `(the workspace or its git remote is responding too slowly) — retry completion`,
    ));
  }
  return coderSshExec(workspaceName, command, Math.min(timeout, left), userId, maxBuffer);
}

// Alias to the deadline-aware executor above. Task-scoped functions below shadow
// `sshExec` with a local wrapper that injects the task owner's refreshable Coder
// token (so background git ops use the user's OAuth credential, not the frozen,
// build-time CODER_SESSION_TOKEN that lapses with the OIDC session). That local
// wrapper delegates here to avoid referencing the shadowed name.
const coderSsh = sshExec;

/**
 * Coder external-auth provider ID that vends the GitHub token. Deployment
 * specific — override with CPM_GITHUB_EXTERNAL_AUTH_ID.
 */
const GITHUB_EXTERNAL_AUTH_ID = process.env.CPM_GITHUB_EXTERNAL_AUTH_ID || 'magnuspihl';

/** A resolved GitHub token, or the reason it could not be resolved. */
interface GitHubTokenResult {
  token: string | null;
  /** Human-readable reason `token` is null — for surfacing in failure messages. */
  error: string | null;
}

/**
 * Fetch a GitHub token from Coder's external auth provider.
 *
 * `userId` matters: `coder external-auth` is authenticated by CODER_SESSION_TOKEN,
 * and the ambient one is the frozen build-time token that lapses with the OIDC
 * session. Background completion work must use the task owner's refreshable OAuth
 * token, exactly like every `coder ssh` call here does.
 *
 * When this fails the `gh` CLI runs with no GH_TOKEN and — in a workspace where
 * nobody ran `gh auth login` — exits 4, which surfaces as an opaque "PR creation
 * failed … status 4". Hence `error`: callers report *why* there was no token.
 */
async function resolveGitHubToken(userId?: string | null): Promise<GitHubTokenResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (userId) {
    try {
      const coderToken = await getValidCoderTokenForUser(userId);
      if (coderToken) env.CODER_SESSION_TOKEN = coderToken;
    } catch { /* fall back to the ambient token */ }
  }
  return new Promise((resolve) => {
    execFile('coder', ['external-auth', 'access-token', GITHUB_EXTERNAL_AUTH_ID], {
      timeout: 30000,
      env,
    }, (err, stdout, stderr) => {
      const token = stdout?.trim();
      if (token && !err) return resolve({ token, error: null });
      const detail = (stderr || '').trim() || (err as any)?.message || '';
      const reason = (err as any)?.killed
        ? `\`coder external-auth access-token ${GITHUB_EXTERNAL_AUTH_ID}\` timed out`
        : `\`coder external-auth access-token ${GITHUB_EXTERNAL_AUTH_ID}\` failed${detail ? `: ${detail.slice(0, 200)}` : ''}`;
      console.error(`[git] GitHub token unavailable — ${reason}`);
      resolve({ token: null, error: reason });
    });
  });
}

/**
 * Fetch a GitHub token from Coder's external auth provider.
 * Returns the token string or null if unavailable.
 */
export async function fetchGitHubToken(userId?: string | null): Promise<string | null> {
  return (await resolveGitHubToken(userId)).token;
}

/**
 * Strip terminal escape sequences (ANSI/CSI colour, OSC queries, cursor reports)
 * from a captured string. `coder ssh` allocates a PTY, so `gh` thinks it is on a
 * terminal and decorates its output — colourised `--json`, an OSC-11 background
 * query (`ESC ] 11 ; ? ESC \`), a DSR cursor query (`ESC [ 6 n`), spinner frames.
 * Over a PTY stderr is merged into stdout, so that decoration lands in what we
 * capture and breaks `JSON.parse` / corrupts a PR identifier. The non-interactive
 * env below normally suppresses it; this is the belt-and-suspenders guarantee
 * that no stray escape from any `gh`/shell version can ever survive into a parse.
 */
function stripAnsi(s: string): string {
  // ESC is \u001b. Strip OSC sequences (ESC ] … terminated by BEL or ST) first,
  // then CSI/other ESC-introduced sequences (colour, cursor moves, DSR), then any
  // lone ESC. gh output we consume is plain ASCII (JSON, URLs, numbers, status
  // text), so removing control escapes is always safe here.
  return s
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/\u001b[@-_][0-?]*[ -/]*[@-~]?/g, "")
    .replace(/\u001b/g, "");
}

/**
 * Run a gh CLI command in a remote workspace with GH_TOKEN set.
 *
 * The non-interactive vars must be `export`ed (not used as a `VAR=val cmd`
 * prefix): the command typically starts with `cd <dir> && gh …`, so a bare
 * prefix would attach the vars to `cd` and leave `gh` running with the PTY's
 * `TERM=xterm-256color` — which is exactly how polluted output kept reaching
 * `gh pr view`/`gh pr merge`. Exporting applies them to the whole shell, and
 * `stripAnsi` scrubs anything that still slips through.
 */
const GH_NONINTERACTIVE_ENV = 'TERM=dumb NO_COLOR=1 CLICOLOR=0 GH_PROMPT_DISABLED=1 GH_PAGER=cat';
async function sshGh(
  workspaceName: string,
  command: string,
  timeout = GIT_T_NETWORK,
  userId?: string | null,
  /**
   * Pre-resolved GitHub token. Pass `undefined` to resolve one per call; pass an
   * explicit `string | null` to reuse a token already resolved for this flow, so
   * a multi-step gh sequence doesn't re-shell out to `coder external-auth` for
   * every command (and can't have some steps authenticated and others not).
   */
  token?: string | null,
): Promise<string> {
  const resolved = token === undefined ? await fetchGitHubToken(userId) : token;
  const assignments = resolved
    ? `GH_TOKEN=${shellEscape(resolved)} ${GH_NONINTERACTIVE_ENV}`
    : GH_NONINTERACTIVE_ENV;
  const out = await sshExec(workspaceName, `export ${assignments} && ${command}`, timeout, userId);
  return stripAnsi(out);
}

// Alias so task-scoped functions can shadow `sshGh` with a token-injecting
// wrapper that still delegates to the real implementation here.
const coderSshGh = sshGh;

interface AdoResponse {
  /** HTTP status code, or 0 if the request couldn't be made. */
  status: number;
  /** Response body (trimmed). */
  body: string;
  /** True when `curl` is not installed in the workspace. */
  curlMissing?: boolean;
}

/**
 * Call the Azure DevOps REST API from inside a workspace using `curl`.
 *
 * Authenticates with HTTP Basic using the workspace's `ADO_PAT` (the same token
 * that pre-authenticates git over HTTPS) — so no extra CLI or extension needs to
 * be installed. The PAT never leaves the workspace: the auth header is built on
 * the remote side from `$ADO_PAT`.
 *
 * A JSON `body` is sent by base64-encoding it here and decoding it to a temp file
 * on the remote, which sidesteps all shell-quoting issues with arbitrary titles
 * and descriptions. `curl -sS` returns exit 0 for HTTP 4xx/5xx (so we can read
 * the error body); the HTTP status is appended via `-w` and parsed back out.
 */
async function adoApi(ws: string, method: string, url: string, body?: unknown, userId?: string | null): Promise<AdoResponse> {
  const authCmd = `AUTH="Authorization: Basic $(printf ':%s' "$ADO_PAT" | base64 | tr -d '\\n')"`;
  const common = `-sS -H "$AUTH" -H "Accept: application/json"`;
  let cmd: string;
  if (body !== undefined) {
    const b64 = Buffer.from(JSON.stringify(body)).toString('base64');
    cmd =
      `${authCmd} && TMP=$(mktemp) && printf %s ${shellEscape(b64)} | base64 -d > "$TMP" && ` +
      `curl ${common} -H "Content-Type: application/json" -X ${method} --data @"$TMP" ${shellEscape(url)} -w '\\nHTTP_STATUS:%{http_code}'; ` +
      `rm -f "$TMP"`;
  } else {
    cmd = `${authCmd} && curl ${common} -X ${method} ${shellEscape(url)} -w '\\nHTTP_STATUS:%{http_code}'`;
  }

  let out: string;
  try {
    out = await sshExec(ws, cmd, GIT_T_NETWORK, userId);
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/curl: (command )?not found|not recognized|No such file/i.test(msg)) {
      return { status: 0, body: '', curlMissing: true };
    }
    throw e;
  }

  const marker = 'HTTP_STATUS:';
  const idx = out.lastIndexOf(marker);
  if (idx === -1) return { status: 0, body: out.trim() };
  const status = parseInt(out.slice(idx + marker.length).trim(), 10) || 0;
  return { status, body: out.slice(0, idx).trim() };
}

// Alias so the Azure PR flow can shadow `adoApi` with a token-injecting wrapper.
const coderAdoApi = adoApi;

/**
 * True when an Azure DevOps response indicates an auth failure — typically an
 * expired/invalid PAT (ADO answers with 401/403, or 203 + a sign-in page).
 */
function isAdoAuthError(res: AdoResponse): boolean {
  return res.status === 401 || res.status === 403 || res.status === 203;
}

/**
 * Resolve project_dir for a task — use stored value or auto-detect.
 */
async function resolveProjectDir(task: Task): Promise<string | null> {
  if (task.project_dir) return task.project_dir;
  return detectProjectDir(task.workspace_name, task.user_id);
}

/**
 * Get the default branch name (main or master) as tracked on the remote.
 */
async function getDefaultBranch(workspaceName: string, projectDir: string, userId?: string | null): Promise<string> {
  try {
    await sshExec(workspaceName, `cd ${shellEscape(projectDir)} && git rev-parse --verify origin/main`, GIT_T_READ, userId);
    return 'main';
  } catch {
    return 'master';
  }
}

/**
 * Get the local default branch name (main or master). Used when remote git is
 * disabled and origin refs may be stale or absent — the user manages git locally.
 */
async function getLocalDefaultBranch(workspaceName: string, projectDir: string, userId?: string | null): Promise<string> {
  try {
    await sshExec(workspaceName, `cd ${shellEscape(projectDir)} && git rev-parse --verify main`, GIT_T_READ, userId);
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

export type GitProvider = 'github' | 'azure' | 'unknown';

export interface GitRemoteInfo {
  provider: GitProvider;
  /** Browsable web URL for the repository (null for unknown providers). */
  webUrl: string | null;
  /** Azure DevOps coordinates, present only when provider === 'azure'. */
  azure?: { orgUrl: string; project: string; repo: string };
}

/**
 * Parse an Azure DevOps remote URL into {orgUrl, project, repo}.
 * Handles the modern dev.azure.com form (with or without the `{org}@` userinfo),
 * the SSH form (git@ssh.dev.azure.com:v3/...), and the legacy
 * `{org}.visualstudio.com` form (with or without a `DefaultCollection` segment).
 * Returns null if the URL is not an Azure DevOps remote.
 */
export function parseAzureRemote(remoteUrl: string): { orgUrl: string; project: string; repo: string } | null {
  const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

  // https://dev.azure.com/{org}/{project}/_git/{repo}   (optional `{org}@` userinfo)
  let m = remoteUrl.match(/https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/(.+?)(?:\.git)?\/?$/i);
  if (m) {
    return { orgUrl: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  }

  // git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
  m = remoteUrl.match(/git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (m) {
    return { orgUrl: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  }

  // https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}
  m = remoteUrl.match(/https?:\/\/(?:[^@/]+@)?([^.]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/(.+?)(?:\.git)?\/?$/i);
  if (m) {
    return { orgUrl: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  }

  return null;
}

/**
 * Detect the git hosting provider and a browsable web URL from a workspace's
 * git remote. Supports GitHub and Azure DevOps; returns provider 'unknown' with
 * a null webUrl for anything else, and null if detection fails entirely.
 */
async function detectGitRemote(workspaceName: string, projectDir: string, userId?: string | null): Promise<GitRemoteInfo | null> {
  try {
    const remoteUrl = await sshExec(workspaceName, `cd ${shellEscape(projectDir)} && git config --get remote.origin.url`, GIT_T_READ, userId);
    if (!remoteUrl) return null;
    const url = remoteUrl.trim();

    // GitHub (ssh + https)
    const sshMatch = url.match(/git@github\.com:(.+?)(?:\.git)?$/);
    if (sshMatch) return { provider: 'github', webUrl: `https://github.com/${sshMatch[1]}` };
    const httpsMatch = url.match(/https:\/\/github\.com\/(.+?)(?:\.git)?$/);
    if (httpsMatch) return { provider: 'github', webUrl: `https://github.com/${httpsMatch[1]}` };

    // Azure DevOps
    const azure = parseAzureRemote(url);
    if (azure) {
      const webUrl = `${azure.orgUrl}/${encodeURIComponent(azure.project)}/_git/${encodeURIComponent(azure.repo)}`;
      return { provider: 'azure', webUrl, azure };
    }

    return { provider: 'unknown', webUrl: null };
  } catch {
    return null;
  }
}

/**
 * Read the commit a branch points at on `origin`, or null if the branch does not
 * exist there (or the query itself failed). Used to tell a push that genuinely
 * failed from one whose client was killed after the remote accepted the ref.
 *
 * The output is parsed line by line and matched against the ref we asked for,
 * never by taking the first whitespace-delimited token: `coder ssh` runs this
 * under a PTY, so ssh/git diagnostics (host-key notices, credential-helper
 * chatter, progress) merge into stdout ahead of the answer. Grabbing the first
 * token would then miss the SHA and report a landed push as a failure.
 */
async function remoteBranchTip(
  workspaceName: string, projectDir: string, branchName: string, userId?: string | null,
): Promise<string | null> {
  try {
    const out = await sshExec(
      workspaceName,
      `cd ${shellEscape(projectDir)} && git ls-remote origin ${shellEscape(`refs/heads/${branchName}`)}`,
      GIT_T_NETWORK,
      userId,
    );
    const wanted = `refs/heads/${branchName}`;
    for (const line of stripAnsi(out).split(/\r?\n/)) {
      const m = /^([0-9a-f]{40})\s+(\S+)\s*$/i.exec(line.trim());
      if (m && m[2] === wanted) return m[1].toLowerCase();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Store the repo web URL and provider on a task in the database.
 */
function storeTaskRepo(taskId: string, url: string | null, provider: GitProvider): void {
  getDb().prepare('UPDATE tasks SET github_repo_url = ?, git_provider = ? WHERE id = ?').run(url, provider, taskId);
}

/**
 * Check if a workspace has a git repository at the given path.
 */
async function hasGitRepo(workspaceName: string, projectDir: string, userId?: string | null): Promise<boolean> {
  try {
    await sshExec(workspaceName, `cd ${shellEscape(projectDir)} && git rev-parse --is-inside-work-tree`, GIT_T_READ, userId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the repository has at least one commit.
 */
async function hasCommits(workspaceName: string, projectDir: string, userId?: string | null): Promise<boolean> {
  try {
    await sshExec(workspaceName, `cd ${shellEscape(projectDir)} && git rev-parse --verify HEAD`, GIT_T_READ, userId);
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
  const userId = task.user_id;
  // Inject the task owner's refreshable token into every SSH call below.
  const sshExec = (w: string, cmd: string, timeout?: number) => coderSsh(w, cmd, timeout, userId);

  try {
    if (!await hasGitRepo(ws, dir, userId)) return;

    // Store repo URL + provider for UI linking and provider-aware completion
    const remote = await detectGitRemote(ws, dir, userId);
    if (remote) {
      storeTaskRepo(task.id, remote.webUrl, remote.provider);
      task.github_repo_url = remote.webUrl;
      task.git_provider = remote.provider;
    }

    if (!await hasCommits(ws, dir, userId)) return;

    // A worktree is always created — including when remote git is disabled — so
    // that concurrent tasks on the same workspace stay isolated from each other
    // and from the main checkout. The only difference for remote-disabled
    // workspaces is the branch base and that completion never pushes/merges.
    const remoteAllowed = isRemoteAllowed(task.workspace_id);
    const branchName = generateBranchName(task);
    const worktreePath = `${CPM_WORKTREE_BASE}/task-${task.id}`;

    if (remoteAllowed) {
      // Branch from the canonical origin tip so the worktree starts clean
      // regardless of local state in the main checkout or other worktrees.
      const defaultBranch = await getDefaultBranch(ws, dir, userId);
      await sshExec(ws,
        `mkdir -p ${shellEscape(CPM_WORKTREE_BASE)} && cd ${shellEscape(dir)} && ` +
        `git fetch origin ${defaultBranch} 2>/dev/null || true && ` +
        `git worktree add ${shellEscape(worktreePath)} -b ${shellEscape(branchName)} origin/${defaultBranch}`,
        GIT_T_WORKTREE,
      );
    } else {
      // Remote disabled: the user manages git locally and origin may be stale or
      // absent, so branch from the LOCAL default branch tip instead of origin.
      const defaultBranch = await getLocalDefaultBranch(ws, dir, userId);
      await sshExec(ws,
        `mkdir -p ${shellEscape(CPM_WORKTREE_BASE)} && cd ${shellEscape(dir)} && ` +
        `git worktree add ${shellEscape(worktreePath)} -b ${shellEscape(branchName)} ${shellEscape(defaultBranch)}`,
        GIT_T_WORKTREE,
      );
    }

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
 *
 * Returns true if the worktree is confirmed gone (or there was none), false if
 * removal genuinely failed (e.g. a process still holds the directory open). On
 * failure the worktree is kept for inspection, `worktree_path` is left set so the
 * removal can be retried, and a warning is surfaced to the task.
 *
 * IMPORTANT: this no longer masks `git worktree remove` failures with `|| true`,
 * so a preview server holding the worktree open is detected rather than silently
 * leaking the directory. Callers should shut down preview servers
 * (`cleanupPortRange`) BEFORE calling this.
 */
export async function removeTaskWorktree(task: Task): Promise<boolean> {
  if (!task.worktree_path) return true;
  const ws = task.workspace_name;
  const userId = task.user_id;
  const sshExec = (w: string, cmd: string, timeout?: number) => coderSsh(w, cmd, timeout, userId);
  const dir = task.project_dir;
  const wt = task.worktree_path;
  const gitRoot = dir ? `cd ${shellEscape(dir)} && ` : '';

  // Try to remove; on failure prune stale metadata and retry once.
  let removed = false;
  try {
    await sshExec(ws, `${gitRoot}git worktree remove ${shellEscape(wt)} --force`, GIT_T_INDEX);
    removed = true;
  } catch {
    try {
      await sshExec(ws, `${gitRoot}git worktree prune`, GIT_T_READ).catch(() => {});
      // If the directory is already gone, pruning the metadata alone resolves it.
      // Distinguish "confirmed gone" from "couldn't check" (workspace stopped,
      // SSH failure): only a confirmed 'no' counts as removed. Treating an
      // unreachable workspace as removed would NULL worktree_path below and leak
      // the directory forever once the workspace comes back.
      const check = (await sshExec(ws, `test -d ${shellEscape(wt)} && echo yes || echo no`, GIT_T_READ).catch(() => 'unknown')).trim();
      if (check === 'yes') {
        await sshExec(ws, `${gitRoot}git worktree remove ${shellEscape(wt)} --force`, GIT_T_INDEX);
        removed = true;
      } else if (check === 'no') {
        removed = true;
      }
    } catch {
      removed = false;
    }
  }

  if (!removed) {
    addMessage(task.id, 'system',
      `Warning: could not remove git worktree \`${wt}\` — a process may still be using it. ` +
      `If it persists, remove it manually with \`git worktree remove ${wt} --force\`.`
    );
    console.error(`[git] Failed to remove worktree for task ${task.id}`);
    return false;
  }

  // Delete the local branch (best-effort). This is the sole place the task branch
  // is removed: the merge step intentionally keeps it (the worktree owns it), and
  // by now the worktree is gone, so `git branch -D` no longer hits "used by worktree".
  if (task.git_branch && dir) {
    await sshExec(ws,
      `cd ${shellEscape(dir)} && git branch -D ${shellEscape(task.git_branch)} 2>/dev/null || true`,
      GIT_T_READ,
    ).catch(() => {});
  }
  getDb().prepare('UPDATE tasks SET worktree_path = NULL WHERE id = ?').run(task.id);
  task.worktree_path = null;
  console.log(`[git] Removed worktree for task ${task.id}`);
  return true;
}

/**
 * Sweep: remove worktrees left behind by **deleted** tasks. Worktrees live
 * for the entire task lifecycle (so any non-deleted task can be resumed) and are
 * removed only on deletion — so the only task that should never still own a worktree
 * is a deleted one. This catches deletions whose removal failed at the time (e.g. a
 * preview server was still holding the directory) — and, now that delete-time
 * cleanup runs in the background after the HTTP response, deletions whose cleanup
 * was cut short by a server restart.
 *
 * Runs at startup and then periodically (see startWorktreeReconciler). Retries per
 * task are capped per process lifetime: removeTaskWorktree posts a warning message
 * to the task on every failure, so unbounded retries against a permanently stuck
 * worktree (or a long-stopped workspace) would spam messages and SSH timeouts.
 * Capped-out tasks are retried again after the next server restart.
 *
 * Worktree-dir only — does NOT kill ports, since a deleted task's old port range may
 * already have been reallocated to a now-active task.
 */
const MAX_RECONCILE_ATTEMPTS = 3;
const reconcileAttempts = new Map<string, number>();

export async function reconcileLeakedWorktrees(): Promise<void> {
  const rows = (getDb().prepare(
    `SELECT * FROM tasks WHERE worktree_path IS NOT NULL AND deleted_at IS NOT NULL`
  ).all() as Task[]).filter(t => (reconcileAttempts.get(t.id) ?? 0) < MAX_RECONCILE_ATTEMPTS);
  if (rows.length === 0) return;
  console.log(`[git] Reconciling ${rows.length} worktree(s) left behind by deleted tasks`);
  for (const task of rows) {
    let ok = false;
    try {
      ok = await removeTaskWorktree(task);
    } catch (err: any) {
      console.error(`[git] Worktree reconcile failed for task ${task.id}:`, err?.message);
    }
    if (ok) {
      reconcileAttempts.delete(task.id);
    } else {
      reconcileAttempts.set(task.id, (reconcileAttempts.get(task.id) ?? 0) + 1);
    }
  }
}

const RECONCILE_INTERVAL_MS = parseInt(process.env.CPM_WORKTREE_RECONCILE_INTERVAL_MS || '600000', 10);
let reconcileTimer: NodeJS.Timeout | null = null;
let reconciling = false;

/** Start the worktree reconciler: one immediate startup pass, then periodic. Idempotent. */
export function startWorktreeReconciler(): void {
  if (reconcileTimer) return;
  const run = () => {
    if (reconciling) return; // never overlap sweeps
    reconciling = true;
    reconcileLeakedWorktrees()
      .catch((err) => console.error(`[git] Worktree reconcile sweep failed: ${(err as Error).message?.slice(0, 200)}`))
      .finally(() => { reconciling = false; });
  };
  run();
  reconcileTimer = setInterval(run, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref?.();
  console.log(`[git] worktree reconciler started (every ${Math.round(RECONCILE_INTERVAL_MS / 1000)}s)`);
}

// ─── Task Completion ─────────────────────────────────────────────────────────

/**
 * Is HEAD already contained in origin/<defaultBranch>?
 *
 * This is the only provider-agnostic "there is genuinely nothing left to ship"
 * signal completion has, and it is what makes agent-made commits safe: a clean
 * working tree means either the work already landed (true here → complete) or
 * the agent committed locally and it still needs a push + PR (false → carry on).
 * Any failure — no network, no such remote branch — answers false, i.e. assume
 * there is still work to ship rather than completing a task silently.
 */
async function isLandedOnDefault(
  ws: string,
  dir: string,
  defaultBranch: string,
  userId: string | null,
): Promise<boolean> {
  try {
    await coderSsh(ws,
      `cd ${shellEscape(dir)} && git fetch origin ${shellEscape(defaultBranch)} && ` +
      `git merge-base --is-ancestor HEAD origin/${shellEscape(defaultBranch)}`,
      GIT_T_NETWORK,
      userId,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * After a task is marked complete:
 * - Remote allowed: commit in worktree, push, open PR, merge, verify merge landed, pull main.
 * - Remote disabled: refuse if uncommitted changes; otherwise pass through.
 *
 * The worktree is intentionally NOT removed here — it persists for the entire task
 * lifecycle so a completed task can be reopened and continued in the same worktree
 * (re-completion runs a fresh push/PR/merge). Worktrees are removed only on deletion.
 *
 * Returns true if completion is allowed, false if intentionally blocked (e.g. remote-disabled
 * workspace with uncommitted changes — user must commit manually), or 'git_error' if an actual
 * git operation failed (push, PR, merge, etc.) and the task should be marked failed.
 */
export function handleTaskCompletionGit(task: Task): Promise<boolean | 'git_error'> {
  // Bound the whole attempt, not just its individual steps: the caller holds the
  // per-workspace lock for the duration, so an unbounded sum of generous per-step
  // budgets would stall processQueue and every other task on that workspace long
  // after the HTTP request or MCP call that started it has given up.
  return withCompletionDeadline(GIT_T_COMPLETION_TOTAL, () => runTaskCompletionGit(task));
}

async function runTaskCompletionGit(task: Task): Promise<boolean | 'git_error'> {
  // Use worktree path if available, else fall back to project_dir
  const dir = task.worktree_path || await resolveProjectDir(task);
  if (!dir) return true;

  const ws = task.workspace_name;
  const userId = task.user_id;
  const sshExec = (w: string, cmd: string, timeout?: number) => coderSsh(w, cmd, timeout, userId);

  try {
    if (!await hasGitRepo(ws, dir, userId)) return true;
    if (!await hasCommits(ws, dir, userId)) return true;

    const remoteAllowed = isRemoteAllowed(task.workspace_id);
    const status = await sshExec(ws, `cd ${shellEscape(dir)} && git status --porcelain`, GIT_T_READ);
    const hasChanges = !!status.trim();

    if (!remoteAllowed) {
      if (hasChanges) {
        const loc = task.git_branch
          ? `on branch \`${task.git_branch}\` in the worktree \`${dir}\``
          : `in \`${dir}\``;
        addMessage(task.id, 'system',
          `Cannot complete automatically — remote git operations are disabled for this workspace, so CPM will not commit, push, open a PR, or merge. You handle git manually here.\n\n` +
          `Your changes are preserved ${loc} exactly as-is — nothing has been discarded, and the worktree is kept until you delete this task. ` +
          `Commit and integrate them into your default branch yourself, then mark this task complete (or delete it once you're done).`
        );
        return false;
      }
      // Working tree is clean — any work has already been integrated manually.
      // Leave the worktree in place; it is removed only on deletion.
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
      const currentBranch = (await sshExec(ws, `cd ${shellEscape(dir)} && git rev-parse --abbrev-ref HEAD`, GIT_T_READ)).trim();
      if (currentBranch !== branchName) {
        // Before failing, check whether all commits are already on origin/main —
        // if so, the work is done regardless of branch name.
        const defaultBranchCheck = await getDefaultBranch(ws, dir, userId);
        const alreadyLanded = await isLandedOnDefault(ws, dir, defaultBranchCheck, userId);

        if (alreadyLanded && !hasChanges) {
          // Committed work is already on origin/main AND the working tree is clean —
          // there is genuinely nothing left to commit, push, or merge.
          addMessage(task.id, 'system',
            `Worktree is on branch \`${currentBranch}\` (expected \`${branchName}\`), but all commits are already present on \`origin/${defaultBranchCheck}\`. Marking complete.`
          );
          return true;
        }

        // Either work is not yet merged, or there are uncommitted changes on top of
        // an already-merged commit. Either way, use the actual current branch so
        // completion can commit+push those changes rather than silently dropping them.
        addMessage(task.id, 'system',
          `Note: worktree is on branch \`${currentBranch}\` instead of expected \`${branchName}\`. Using actual branch for completion.`
        );
        branchName = currentBranch;
        storeTaskBranch(task.id, branchName);
      }
    } else {
      // Legacy non-worktree path: check we're on default branch and create task branch
      const defaultBranch = await getDefaultBranch(ws, dir, userId);
      const currentBranch = (await sshExec(ws, `cd ${shellEscape(dir)} && git rev-parse --abbrev-ref HEAD`, GIT_T_READ)).trim();
      if (currentBranch !== defaultBranch) {
        addMessage(task.id, 'system',
          `Cannot complete: workspace is on branch \`${currentBranch}\` instead of \`${defaultBranch}\`. ` +
          `The agent appears to have switched branches mid-task. Please reconcile manually before completing.`
        );
        return 'git_error';
      }
      // A clean tree here does not mean there is nothing to do: the agent is
      // allowed to commit locally, which on this path leaves those commits
      // sitting on the default branch, unpushed. Only stop if HEAD is already
      // contained in origin/<default>; otherwise fall through so the commits get
      // their own branch, a push and a PR like any other work.
      if (!hasChanges && await isLandedOnDefault(ws, dir, defaultBranch, userId)) return true;
      try {
        await sshExec(ws, `cd ${shellEscape(dir)} && git checkout -b ${shellEscape(branchName)}`, GIT_T_INDEX);
      } catch (err: any) {
        addMessage(task.id, 'system',
          `Cannot complete: could not create branch \`${branchName}\`: ${err.message}.`
        );
        return 'git_error';
      }
    }

    if (!hasChanges) {
      // Working tree is clean — but this might mean the agent committed everything
      // itself (leaving unpushed commits) or a prior completion attempt pushed but
      // didn't finish the PR. The only safe, provider-agnostic signal for "nothing
      // left to do" is whether the branch tip is already on the default branch.
      //
      // NOTE: this used to gate on `gh pr view` (GitHub-only). On Azure DevOps that
      // query always failed, so the function silently returned `true` and marked the
      // task completed even when an Azure PR was still open and unmerged. The git
      // ancestry check below works identically for every provider.
      const defaultBranch = await getDefaultBranch(ws, dir, userId);
      const landed = await isLandedOnDefault(ws, dir, defaultBranch, userId);

      if (landed) {
        // The committed work is already integrated into the default branch — there
        // is genuinely nothing left to push or merge. Worktree kept (removed on deletion).
        return true;
      }

      // Commits exist that are not yet on the default branch — either committed but
      // not pushed, or pushed but the PR was never merged. Fall through to the push +
      // open/complete-PR flow, which (unlike a silent early return) will surface and
      // block on any PR failure for the task's actual provider.
      addMessage(task.id, 'system',
        `Found committed work not yet on \`${defaultBranch}\` — pushing and completing the pull request.`
      );
    }

    // Commit
    try {
      await sshExec(ws, `cd ${shellEscape(dir)} && git add -A`, GIT_T_INDEX);
      const staged = await sshExec(ws, `cd ${shellEscape(dir)} && git diff --cached --name-only`, GIT_T_INDEX);
      if (staged.trim()) {
        const freshTask = getTask(task.id) || task;
        await sshExec(ws,
          `cd ${shellEscape(dir)} && git commit -m ${shellEscape(freshTask.title || 'Task changes')}`,
          GIT_T_INDEX,
        );
      }
    } catch (err: any) {
      addMessage(task.id, 'system', `Cannot complete: git commit failed: ${err.message}`);
      return 'git_error';
    }

    // Merge origin/main into the task branch before pushing so the branch is
    // up-to-date and the resulting PR has no conflicts with the default branch.
    if (task.worktree_path) {
      const defaultForMerge = await getDefaultBranch(ws, dir, userId);
      try {
        await sshExec(ws,
          `cd ${shellEscape(dir)} && ` +
          `git fetch origin ${shellEscape(defaultForMerge)} && ` +
          `git merge origin/${shellEscape(defaultForMerge)} --no-edit`,
          GIT_T_NETWORK,
        );
      } catch (mergeErr: any) {
        addMessage(task.id, 'system',
          `Cannot complete: failed to merge \`origin/${defaultForMerge}\` into task branch before pushing: ${mergeErr.message}. ` +
          `Resolve any conflicts in the worktree (\`${dir}\`) and retry.`
        );
        return 'git_error';
      }
    }

    // Capture the committed tip so we can later verify the merge actually landed
    // (used by the post-merge ancestor check on origin/<default>).
    let branchTip = '';
    try {
      branchTip = (await sshExec(ws, `cd ${shellEscape(dir)} && git rev-parse HEAD`, GIT_T_READ)).trim();
    } catch { /* validation is skipped if we couldn't capture the tip */ }

    // Detect the git host so the PR flow can be routed to the right provider
    // (and store the repo URL + provider for UI linking if not already done).
    const remote = await detectGitRemote(ws, dir, userId);
    const provider: GitProvider = remote?.provider ?? (task.git_provider as GitProvider | null) ?? 'unknown';
    if (remote) {
      storeTaskRepo(task.id, remote.webUrl ?? task.github_repo_url, remote.provider);
    }

    // Push. A push that reports failure has NOT necessarily failed: if the client
    // is killed (timeout) or the connection drops after the remote accepted the
    // objects, the ref is already updated on the server and only the local client
    // died. Re-checking the remote ref before failing the task turns those false
    // negatives — which previously stranded completed work with an unexplained
    // "push failed" — into a successful completion.
    try {
      await sshExec(ws, `cd ${shellEscape(dir)} && git push -u origin ${shellEscape(branchName)}`, GIT_T_NETWORK);
    } catch (pushErr: any) {
      // When the push was *killed* rather than rejected, the remote side may still
      // be finishing: killing the local client does not abort a transfer the server
      // already has. Poll the ref a few times before concluding it never landed —
      // a single immediate read can catch the pre-push tip and fail a task whose
      // work is on its way to origin.
      const attempts = (pushErr as RemoteExecError).timedOut ? PUSH_LANDED_ATTEMPTS : 1;
      let remoteTip: string | null = null;
      for (let i = 0; i < attempts && branchTip; i++) {
        if (i > 0) await delay(PUSH_LANDED_RETRY_DELAY_MS);
        remoteTip = await remoteBranchTip(ws, dir, branchName, userId);
        if (remoteTip === branchTip) break;
      }
      if (remoteTip && remoteTip === branchTip) {
        addMessage(task.id, 'system',
          `Push reported an error (${truncate(pushErr.message, 300)}), but \`origin/${branchName}\` is already at \`${branchTip.slice(0, 8)}\` — the push landed. Continuing.`
        );
      } else {
        addMessage(task.id, 'system',
          `Cannot complete: changes committed on branch \`${branchName}\` but push failed: ${pushErr.message}. ` +
          `Resolve the push issue and retry completion.`
        );
        return 'git_error';
      }
    }

    const defaultBranch = await getDefaultBranch(ws, dir, userId);

    // NOTE: we deliberately do NOT sync the local `main` checkout here. In worktree
    // mode the merge into the default branch happens entirely on the remote via the
    // PR, and every local git step runs in the task's worktree against the freshly
    // fetched `origin/<default>` ref — the main checkout (task.project_dir) plays no
    // part in the merge, and new worktrees branch from `origin/<default>` regardless
    // of its state. A pre-merge `git merge --ff-only` on the main checkout used to
    // live here and hard-blocked completion whenever the checkout had diverged from
    // origin (e.g. a stray local commit), even though completion would otherwise
    // succeed. The post-merge pull below refreshes the checkout as a best effort.

    // Nothing-to-merge guard. A reopened task that was previously completed already
    // has its commit on origin/<default>. If the committed tip is already an
    // ancestor of the remote default branch there is nothing left to merge, so
    // complete instead of re-merging the stale (already-MERGED) PR — which would
    // print "PR merged" yet leave the new commit stranded and fail verification.
    if (branchTip) {
      let alreadyLanded = false;
      try {
        await sshExec(ws,
          `cd ${shellEscape(dir)} && git fetch origin ${shellEscape(defaultBranch)} && ` +
          `git merge-base --is-ancestor ${shellEscape(branchTip)} origin/${shellEscape(defaultBranch)}`,
          GIT_T_NETWORK,
        );
        alreadyLanded = true;
      } catch { /* tip not on origin/<default> yet → real work to merge */ }
      if (alreadyLanded) {
        addMessage(task.id, 'system',
          `Changes on branch \`${branchName}\` are already present on \`origin/${defaultBranch}\` — nothing to merge. Marking complete.`
        );
        return true;
      }
    }

    // Open (or reuse) and complete the PR through the detected provider. Each
    // helper finds/creates the PR, merges it, surfaces its own status/error
    // messages, and reports whether the git-ancestor merge verification below
    // should run. A branch completed before has a closed/merged PR; the helpers
    // open a fresh PR for the new commit rather than re-merging stale ones.
    const freshTask = getTask(task.id) || task;
    const prTitle = freshTask.title || `Task: ${freshTask.prompt.slice(0, 60)}`;
    const prBody = `Automated PR for completed task.\n\n**Task:** ${freshTask.title}\n**Task ID:** ${freshTask.id}`;

    let outcome: PrOutcome;
    if (provider === 'azure') {
      if (!remote?.azure) {
        addMessage(task.id, 'system',
          `Cannot complete: changes were pushed to branch \`${branchName}\`, but the Azure DevOps organization/project/repository could not be parsed from the git remote. ` +
          `Open and complete the PR manually, then mark this task complete.`
        );
        return 'git_error';
      }
      outcome = await completePrAzure(ws, task.id, branchName, defaultBranch, prTitle, prBody, branchTip, remote.azure, userId);
    } else {
      // GitHub and anything else (e.g. GitHub Enterprise) go through the `gh` CLI,
      // matching the prior behaviour where `gh` was used unconditionally.
      outcome = await completePrGitHub(ws, dir, task.id, branchName, defaultBranch, prTitle, prBody, userId);
    }

    if (outcome.kind === 'blocked') return 'git_error';
    if (outcome.kind === 'nothing-to-merge') return true;
    const verifyMergeWithGit = outcome.verifyByGit;

    // Verify the merge actually landed on origin/<default>. `gh pr merge` exiting 0
    // is normally sufficient, but this guards against partial/misreported merges so
    // a task is never marked completed while its branch is still unmerged. With the
    // `--merge` strategy the branch tip becomes a parent of the merge commit, so it
    // must be an ancestor of the updated default branch.
    //
    // Skip when the provider authoritatively reports the PR as merged/completed: a
    // squash/rebase merge (GitHub) or a non-merge completion strategy (Azure DevOps)
    // produces new commits, so the branch tip would legitimately not be an ancestor —
    // checking it would be a false-negative block.
    if (branchTip && verifyMergeWithGit) {
      try {
        await sshExec(ws,
          `cd ${shellEscape(dir)} && git fetch origin ${shellEscape(defaultBranch)} && ` +
          `git merge-base --is-ancestor ${shellEscape(branchTip)} origin/${shellEscape(defaultBranch)}`,
          GIT_T_NETWORK,
        );
      } catch {
        addMessage(task.id, 'system',
          `Cannot complete: the merge could not be verified on \`origin/${defaultBranch}\` — commit \`${branchTip.slice(0, 8)}\` is not part of the remote default branch yet. ` +
          `The worktree has been kept. Check the PR state and retry completion.`
        );
        return 'git_error';
      }
    }

    // The worktree is intentionally kept — it is removed only when the task is
    // deleted, so a completed task can be reopened and continued in the same
    // worktree. The caller (complete route / deferred-completion handler) frees the
    // port range after marking the task completed.

    // Pull main checkout to reflect the merge
    if (task.project_dir) {
      try {
        await sshExec(ws,
          `cd ${shellEscape(task.project_dir)} && git pull --ff-only origin ${shellEscape(defaultBranch)}`,
          GIT_T_NETWORK,
        );
      } catch (pullErr: any) {
        addMessage(task.id, 'system', `Warning: post-merge pull failed: ${pullErr.message}.`);
      }
    }

    return true;
  } catch (err: any) {
    const reason = `Git completion failed: ${err.message || err}`;
    addMessage(task.id, 'system', `Error: ${reason}`);
    return 'git_error';
  }
}

// ─── Provider-specific PR completion ─────────────────────────────────────────

/**
 * Result of a provider's open-PR-and-merge step:
 * - `completed`: the PR was merged/completed. `verifyByGit` says whether the
 *   caller should verify the merge landed via a git-ancestor check (true) or
 *   trust the provider's authoritative state (false).
 * - `nothing-to-merge`: the branch adds no commits over the base — mark complete.
 * - `blocked`: completion could not proceed; an explanatory message was already
 *   added to the task and completion should be refused.
 */
type PrOutcome =
  | { kind: 'completed'; verifyByGit: boolean }
  | { kind: 'nothing-to-merge' }
  | { kind: 'blocked' };

/**
 * Does a `gh` failure look like an authentication problem rather than a merge
 * one? gh exits 4 specifically for auth errors; the API surfaces 401/403 and
 * phrases like "requires authentication" / "Bad credentials" / "gh auth login".
 * Everything else (conflicts, required checks, branch protection) must NOT be
 * attributed to auth.
 */
function isGhAuthFailure(failure: string): boolean {
  const s = failure.toLowerCase();
  return /exited with status 4(?!\d)/.test(s)
    || /\b(401|403)\b/.test(s)
    || s.includes('authentication')
    || s.includes('unauthorized')
    || s.includes('bad credentials')
    || s.includes('gh auth login')
    || s.includes('not logged in')
    || s.includes('permission denied');
}

/**
 * GitHub PR flow via the `gh` CLI: reuse an OPEN PR or open a fresh one, then
 * merge it by identity (number/URL, never branch name, so a stale MERGED PR for
 * the same branch can't be re-targeted).
 */
async function completePrGitHub(
  ws: string, dir: string, taskId: string, branchName: string,
  defaultBranch: string, prTitle: string, prBody: string, userId?: string | null,
): Promise<PrOutcome> {
  // Resolve the GitHub token ONCE for the whole flow rather than per gh call, so
  // every step is authenticated identically and `coder external-auth` is shelled
  // out to once. When it can't be resolved, `gh` falls back to whatever auth the
  // workspace itself has — usually none, giving an opaque exit 4 — so keep the
  // reason around and append it to any gh failure below.
  const { token: ghToken, error: ghTokenError } = await resolveGitHubToken(userId);
  /**
   * Note appended to a gh failure — but ONLY when that failure actually looks
   * like an auth problem. `gh` can still authenticate from the workspace's own
   * credentials, so a missing CPM token does not mean the next failure is an auth
   * failure: blaming it beside a `mergeable: CONFLICTING` detail would be exactly
   * the misdirected blame this flow is supposed to stop producing.
   */
  const authNoteIf = (looksLikeAuth: boolean): string =>
    ghTokenError && looksLikeAuth
      ? ` No GitHub token could be provided to \`gh\` for this workspace (${ghTokenError}), which is the likely cause — reconnect the GitHub external auth provider in Coder.`
      : '';
  const authNoteFor = (failure: string): string => authNoteIf(isGhAuthFailure(failure));
  // Shadow sshGh to inject the task owner's token (see coderSsh note above).
  const sshGh = (w: string, cmd: string, timeout?: number) => coderSshGh(w, cmd, timeout, userId, ghToken);
  let mergeTarget: string;
  let existingPr: { url?: string; state?: string; number?: number } | null = null;
  try {
    const raw = await sshGh(ws, `cd ${shellEscape(dir)} && gh pr view ${shellEscape(branchName)} --json url,state,number 2>/dev/null`);
    if (raw.trim()) existingPr = JSON.parse(raw);
  } catch { /* no PR associated with this branch yet */ }

  if (existingPr && existingPr.state === 'OPEN' && existingPr.url) {
    mergeTarget = existingPr.number != null ? String(existingPr.number) : existingPr.url;
    addMessage(taskId, 'system', `Existing open pull request found: ${existingPr.url}`);
  } else {
    if (existingPr && existingPr.url && (existingPr.state === 'MERGED' || existingPr.state === 'CLOSED')) {
      addMessage(taskId, 'system',
        `Previous pull request for branch \`${branchName}\` is ${existingPr.state.toLowerCase()} (${existingPr.url}); opening a fresh PR for the new commit.`
      );
    }
    try {
      // Run the create but DON'T trust its stdout as the merge target. Even with
      // the non-interactive env above, `gh pr create` is the one command that
      // prints a progress line ("Creating pull request for …"); re-querying the
      // PR by branch via `--json` gives a clean, structured identifier that can
      // never carry stray decoration into the subsequent `gh pr merge`.
      await sshGh(ws,
        `cd ${shellEscape(dir)} && gh pr create --base ${shellEscape(defaultBranch)} --head ${shellEscape(branchName)} --title ${shellEscape(prTitle)} --body ${shellEscape(prBody)}`
      );
      const created = JSON.parse(
        (await sshGh(ws, `cd ${shellEscape(dir)} && gh pr view ${shellEscape(branchName)} --json url,number 2>/dev/null`)).trim()
      ) as { url?: string; number?: number };
      mergeTarget = created.number != null ? String(created.number) : (created.url ?? '');
      if (!mergeTarget) throw new Error('PR was created but its number/URL could not be read back.');
      addMessage(taskId, 'system', `Pull request created: ${created.url ?? `#${mergeTarget}`}`);
    } catch (prErr: any) {
      const msg = String(prErr?.message || prErr);
      // GitHub refuses a PR when the branch adds no commits over the base — the
      // reopened task's changes are already on the default branch.
      if (/no commits between/i.test(msg)) {
        addMessage(taskId, 'system',
          `Nothing to merge — branch \`${branchName}\` adds no commits over \`${defaultBranch}\` (changes already on the default branch). Marking complete.`
        );
        return { kind: 'nothing-to-merge' };
      }
      addMessage(taskId, 'system',
        `Cannot complete: PR creation failed for branch \`${branchName}\`: ${msg}.${authNoteFor(msg)} Resolve the issue and retry completion.`
      );
      return { kind: 'blocked' };
    }
  }

  try {
    // Merge only — deliberately NO `--delete-branch`. In worktree mode the task
    // branch is checked out in the worktree, so gh's post-merge local cleanup
    // (`git checkout <default>` + `git branch -D <branch>`) always fails with
    // "branch is used by worktree" / "'<default>' is already used by worktree",
    // making gh exit non-zero even though the merge to origin already succeeded.
    // That false failure is what kept blocking completion. The local branch is
    // intentionally kept (the worktree owns it for the task's lifetime and is
    // removed only when the task is deleted); the remote branch is cleaned up
    // best-effort below and never blocks completion.
    await sshGh(ws, `cd ${shellEscape(dir)} && gh pr merge ${shellEscape(mergeTarget)} --merge`);
    await sshGh(ws, `cd ${shellEscape(dir)} && git push origin --delete ${shellEscape(branchName)}`)
      .catch(() => { /* remote branch may be auto-deleted on merge, or kept by policy — either is fine */ });
    addMessage(taskId, 'system', `PR merged into \`${defaultBranch}\`.`);
    return { kind: 'completed', verifyByGit: true };
  } catch (mergeErr: any) {
    // The real gh error is written to the PTY (stdout) and lost from err.message,
    // so re-query the PR to learn whether it actually merged and, if not, why it
    // is blocked (conflicts, pending checks, branch protection).
    let state = '', mergeable = '', mergeStateStatus = '';
    try {
      const info = JSON.parse((await sshGh(ws,
        `cd ${shellEscape(dir)} && gh pr view ${shellEscape(mergeTarget)} --json state,mergeable,mergeStateStatus`
      )).trim()) as { state?: string; mergeable?: string; mergeStateStatus?: string };
      state = info.state ?? ''; mergeable = info.mergeable ?? ''; mergeStateStatus = info.mergeStateStatus ?? '';
    } catch { /* ignore state-check errors */ }

    if (state === 'MERGED') {
      addMessage(taskId, 'system', `PR for branch \`${branchName}\` was already merged on GitHub.`);
      return { kind: 'completed', verifyByGit: false };
    }
    const detail = (mergeable || mergeStateStatus)
      ? ` (PR state: ${state || 'unknown'}, mergeable: ${mergeable || 'unknown'}, status: ${mergeStateStatus || 'unknown'})`
      : '';
    // Only blame the missing token when the failure looks like auth, or when even
    // the state re-query came back empty — i.e. we can't see the PR at all, which
    // is what a tokenless `gh` looks like. When the re-query DID answer, its
    // mergeable/mergeStateStatus is the real reason and must not be contradicted.
    const stateQueryFailed = !state && !mergeable && !mergeStateStatus;
    addMessage(taskId, 'system',
      `Cannot complete: PR merge failed for \`${branchName}\`${detail}: ${mergeErr.message}.` +
      `${authNoteIf(stateQueryFailed || isGhAuthFailure(String(mergeErr?.message || '')))} ` +
      `Resolve any conflicts / required checks / branch-protection rules on the PR and retry completion.`
    );
    return { kind: 'blocked' };
  }
}

/**
 * Azure DevOps PR flow via the REST API (using `curl` + the workspace `ADO_PAT`):
 * reuse an active PR or create one, set it to "completed" (which merges and
 * deletes the source branch), then poll the PR status until ADO reports the
 * completion landed (completion is processed asynchronously server-side).
 *
 * Deliberately uses the REST API rather than the `az` CLI so that nothing needs
 * to be installed in the workspace — `curl` is universally available and the PAT
 * that already pre-authenticates git over HTTPS is reused for API auth.
 */
async function completePrAzure(
  ws: string, taskId: string, branchName: string,
  defaultBranch: string, prTitle: string, prBody: string,
  branchTip: string, azure: { orgUrl: string; project: string; repo: string },
  userId?: string | null,
): Promise<PrOutcome> {
  // Shadow adoApi to inject the task owner's token (see coderSsh note above).
  const adoApi = (w: string, method: string, url: string, body?: unknown) => coderAdoApi(w, method, url, body, userId);
  const apiVer = 'api-version=7.1';
  const reposBase =
    `${azure.orgUrl}/${encodeURIComponent(azure.project)}/_apis/git/repositories/${encodeURIComponent(azure.repo)}`;
  const prWebUrl = (id: number | string) =>
    `${azure.orgUrl}/${encodeURIComponent(azure.project)}/_git/${encodeURIComponent(azure.repo)}/pullrequest/${id}`;
  const sourceRef = `refs/heads/${branchName}`;
  const targetRef = `refs/heads/${defaultBranch}`;

  const curlMissingMsg =
    `Cannot complete: \`curl\` is not available in this workspace, so CPM cannot reach the Azure DevOps REST API to open the pull request. ` +
    `Open and complete the PR for branch \`${branchName}\` manually, then mark this task complete.`;
  const authErrMsg =
    `Cannot complete: Azure DevOps rejected the request (auth error). The workspace \`ADO_PAT\` is likely missing or expired — ` +
    `regenerate it at dev.azure.com/{org}/_usersSettings/tokens and update the workspace parameter, then retry completion.`;

  const findActivePr = async (): Promise<number | null> => {
    const url =
      `${reposBase}/pullrequests?searchCriteria.sourceRefName=${encodeURIComponent(sourceRef)}` +
      `&searchCriteria.targetRefName=${encodeURIComponent(targetRef)}&searchCriteria.status=active&${apiVer}`;
    const res = await adoApi(ws, 'GET', url);
    if (res.curlMissing) { addMessage(taskId, 'system', curlMissingMsg); return null; }
    if (isAdoAuthError(res)) { addMessage(taskId, 'system', authErrMsg); return null; }
    if (res.status >= 200 && res.status < 300) {
      try {
        const data = JSON.parse(res.body);
        if (Array.isArray(data.value) && data.value.length > 0 && data.value[0].pullRequestId != null) {
          return data.value[0].pullRequestId as number;
        }
      } catch { /* fall through */ }
    }
    return null;
  };

  // Reuse an existing active PR for this source→target branch if present.
  let prId: number | null = await findActivePr();

  if (prId != null) {
    addMessage(taskId, 'system', `Existing active pull request found: ${prWebUrl(prId)}`);
  } else {
    const res = await adoApi(ws, 'POST', `${reposBase}/pullrequests?${apiVer}`, {
      sourceRefName: sourceRef,
      targetRefName: targetRef,
      title: prTitle,
      description: prBody,
    });
    if (res.curlMissing) { addMessage(taskId, 'system', curlMissingMsg); return { kind: 'blocked' }; }
    if (isAdoAuthError(res)) { addMessage(taskId, 'system', authErrMsg); return { kind: 'blocked' }; }
    if (res.status >= 200 && res.status < 300) {
      try { prId = JSON.parse(res.body).pullRequestId; } catch { /* handled below */ }
      if (prId != null) addMessage(taskId, 'system', `Pull request created: ${prWebUrl(prId)}`);
    } else if (/TF401179|active pull request.*already exists/i.test(res.body)) {
      // A PR for this branch pair already exists — recover by looking it up.
      prId = await findActivePr();
      if (prId != null) addMessage(taskId, 'system', `Existing active pull request found: ${prWebUrl(prId)}`);
    }
    if (prId == null) {
      addMessage(taskId, 'system',
        `Cannot complete: PR creation failed for branch \`${branchName}\` (HTTP ${res.status}): ${truncate(res.body, 300)}. Resolve the issue and retry completion.`
      );
      return { kind: 'blocked' };
    }
  }

  // Complete the PR: merge it and delete the source branch. `lastMergeSourceCommit`
  // must match the PR's current source tip, so prefer the value ADO reports and fall
  // back to the commit we just pushed. Completion is queued and processed
  // asynchronously, so the poll below waits for the authoritative status.
  let mergeSourceCommit = branchTip;
  const showUrl = `${reposBase}/pullrequests/${prId}?${apiVer}`;
  const showRes = await adoApi(ws, 'GET', showUrl);
  if (showRes.status >= 200 && showRes.status < 300) {
    try {
      const commit = JSON.parse(showRes.body)?.lastMergeSourceCommit?.commitId;
      if (commit) mergeSourceCommit = commit;
    } catch { /* keep branchTip */ }
  }

  const patchBody: Record<string, unknown> = {
    status: 'completed',
    completionOptions: { deleteSourceBranch: true, mergeStrategy: 'noFastForward' },
  };
  if (mergeSourceCommit) patchBody.lastMergeSourceCommit = { commitId: mergeSourceCommit };

  const patchRes = await adoApi(ws, 'PATCH', `${reposBase}/pullrequests/${prId}?${apiVer}`, patchBody);
  let patchErr = '';
  if (patchRes.curlMissing) { addMessage(taskId, 'system', curlMissingMsg); return { kind: 'blocked' }; }
  if (isAdoAuthError(patchRes)) { addMessage(taskId, 'system', authErrMsg); return { kind: 'blocked' }; }
  if (!(patchRes.status >= 200 && patchRes.status < 300)) {
    patchErr = `HTTP ${patchRes.status}: ${truncate(patchRes.body, 300)}`;
  }

  // Poll until ADO finishes the merge.
  let finalStatus = '';
  for (let i = 0; i < 15; i++) {
    const res = await adoApi(ws, 'GET', showUrl);
    if (res.status >= 200 && res.status < 300) {
      try { finalStatus = JSON.parse(res.body).status || ''; } catch { /* retry */ }
    }
    if (finalStatus === 'completed' || finalStatus === 'abandoned') break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (finalStatus === 'completed') {
    addMessage(taskId, 'system', `PR completed and branch \`${branchName}\` merged: ${prWebUrl(prId)}`);
    // ADO's merge strategy may rewrite commits, so trust the authoritative status
    // instead of a git-ancestor check.
    return { kind: 'completed', verifyByGit: false };
  }

  addMessage(taskId, 'system',
    `Cannot complete: the Azure DevOps PR for \`${branchName}\` could not be completed` +
    `${finalStatus ? ` (status: ${finalStatus})` : ''}${patchErr ? ` — ${patchErr}` : ''}. ` +
    `It may require approvals or have merge conflicts / branch policies — resolve them on the PR (${prWebUrl(prId)}) and retry completion.`
  );
  return { kind: 'blocked' };
}

/** Truncate a string for inclusion in a user-facing status message. */
function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// ─── Legacy stubs — kept for routes compatibility ────────────────────────────

/**
 * No-op stub. Worktree architecture makes reopen a no-op.
 */
export async function handleTaskReopenGit(_task: Task): Promise<void> {
  // no-op: worktree persists until the task is cancelled/completed
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
  const userId = task.user_id;
  const sshExec = (w: string, cmd: string, timeout?: number) => coderSsh(w, cmd, timeout, userId);
  const currentBranch = (await sshExec(ws, `cd ${shellEscape(dir)} && git rev-parse --abbrev-ref HEAD`, GIT_T_READ)).trim();
  if (currentBranch === task.git_branch) {
    return `Already on branch \`${task.git_branch}\``;
  }
  const status = await sshExec(ws, `cd ${shellEscape(dir)} && git status --porcelain`, GIT_T_READ);
  if (status.trim()) {
    await sshExec(ws, `cd ${shellEscape(dir)} && git stash push --include-untracked -m "auto-stash before switching to ${task.git_branch}"`, GIT_T_INDEX);
  }
  await sshExec(ws, `cd ${shellEscape(dir)} && git checkout ${shellEscape(task.git_branch)}`, GIT_T_INDEX);
  return `Switched to branch \`${task.git_branch}\``;
}

/**
 * Shell-escape a string for safe inclusion in a remote shell command.
 */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
