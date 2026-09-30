/**
 * GitHub label watcher: put a label on an issue and CPM picks it up.
 *
 * The "+ Issue" composer is pull-based — you open CPM and choose an issue. This
 * is the push-based counterpart: a workspace can opt in to watching its repo
 * for open issues carrying a trigger label (default `cpm:ready`). Whenever one
 * appears, CPM creates an issue-backed task from it exactly as "+ Issue" with a
 * blank description would — the issue is the brief — and queues it.
 *
 * Polling rather than webhooks: CPM sits behind Coder and isn't necessarily
 * reachable from GitHub, and a webhook would also need repo-admin setup plus a
 * shared secret per repo. One `issues?labels=` call per watched workspace every
 * couple of minutes is far inside GitHub's rate limit.
 *
 * Safety rules, in order:
 *  - Only a label applied by the watching user's OWN GitHub account counts. The
 *    label is the approval gate for running an agent on third-party issue text,
 *    with that user's workspace and Claude subscription, so it can't be
 *    delegated to whoever else happens to have triage rights on the repo.
 *  - A label is consumed once. It triggers a task only if it was applied after
 *    the newest task already created for that issue in this workspace (deleted
 *    ones included), so a label that couldn't be removed never re-fires; while
 *    a live (not completed/deleted) task exists for the issue, nothing fires.
 *    Removing and re-adding the label is how you ask for a fresh task.
 *  - After pickup the label is removed and a comment is posted, so the issue
 *    itself shows it was taken. Both are best-effort and reported into the
 *    task's message log.
 */

import { getDb } from '../db/index.js';
import { createTask, addMessage } from './tasks.js';
import { processQueue } from './claude.js';
import {
  ghApi, requireToken, refFromRepoSlug, getIssueDetail, buildIssuePrompt, failureReason,
  applyIssueProgressLabel, GitHubError, type GitHubRepoRef,
} from './github-issues.js';

export const DEFAULT_WATCH_LABEL = 'cpm:ready';

const POLL_INTERVAL_MS = Number(process.env.CPM_ISSUE_WATCH_INTERVAL_MS) || 2 * 60_000;
/** Newest-first pages of issue events to scan for the label's `labeled` event. */
const MAX_EVENT_PAGES = 10;

export interface IssueWatchSettings {
  /** Trigger label, or null when the watcher is off for this workspace. */
  label: string | null;
  /** `owner/repo` being watched — resolved once when the watcher is enabled. */
  repo: string | null;
  /** CPM user who enabled it: the tasks are theirs and run on their tokens. */
  userId: string | null;
  workspaceName: string | null;
}

/**
 * Validate a label name. GitHub caps labels at 50 characters; commas are
 * rejected because the `labels` query parameter is comma-separated and a comma
 * would silently turn one label into two.
 */
export function normalizeWatchLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const label = raw.trim();
  if (!label || label.length > 50 || label.includes(',') || /[\u0000-\u001f]/.test(label)) return null;
  return label;
}

export function getIssueWatchSettings(workspaceId: string): IssueWatchSettings {
  const row = getDb().prepare(
    `SELECT issue_watch_label, issue_watch_repo, issue_watch_user_id, issue_watch_workspace_name
     FROM workspace_settings WHERE workspace_id = ?`,
  ).get(workspaceId) as {
    issue_watch_label: string | null; issue_watch_repo: string | null;
    issue_watch_user_id: string | null; issue_watch_workspace_name: string | null;
  } | undefined;
  return {
    label: row?.issue_watch_label ?? null,
    repo: row?.issue_watch_repo ?? null,
    userId: row?.issue_watch_user_id ?? null,
    workspaceName: row?.issue_watch_workspace_name ?? null,
  };
}

/** Turn the watcher on (label + owner + repo) or off (label null). */
export function setIssueWatchSettings(workspaceId: string, s: IssueWatchSettings): void {
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO workspace_settings (workspace_id, issue_watch_label, issue_watch_repo, issue_watch_user_id, issue_watch_workspace_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       issue_watch_label = excluded.issue_watch_label,
       issue_watch_repo = excluded.issue_watch_repo,
       issue_watch_user_id = excluded.issue_watch_user_id,
       issue_watch_workspace_name = excluded.issue_watch_workspace_name,
       updated_at = excluded.updated_at`,
  ).run(workspaceId, s.label, s.repo, s.userId, s.workspaceName, now);
}

function repoPath(ref: GitHubRepoRef): string {
  return `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
}

/**
 * Make sure a CPM label (the watcher's trigger label, or the in-progress label)
 * exists on the repo, creating it if not, so it is there in GitHub's label
 * menu with a sensible colour and description. Returns a warning to show the user
 * when that isn't possible (typically: no permission to create labels) — the
 * watcher still works if someone creates the label by hand.
 */
export async function ensureWatchLabel(
  ref: GitHubRepoRef,
  label: string,
  userId: string,
  description = 'Ready for Coder Project Manager to pick up',
  color = '8250df',
): Promise<string | null> {
  try {
    const token = await requireToken(userId);
    try {
      await ghApi(`${repoPath(ref)}/labels/${encodeURIComponent(label)}`, token);
      return null;
    } catch (err) {
      if (!(err instanceof GitHubError) || err.status !== 404) throw err;
    }
    await ghApi(`${repoPath(ref)}/labels`, token, {
      method: 'POST',
      body: { name: label, color, description },
    });
    return null;
  } catch (err) {
    return `Could not create the "${label}" label on ${ref.owner}/${ref.repo} (${failureReason(err)}). Create it there by hand.`;
  }
}

// GitHub login per CPM user — it is what `labeled` events are matched against.
const loginCache = new Map<string, { login: string; at: number }>();
const LOGIN_CACHE_MS = 30 * 60_000;

async function getGitHubLogin(userId: string, token: string): Promise<string> {
  const cached = loginCache.get(userId);
  if (cached && Date.now() - cached.at < LOGIN_CACHE_MS) return cached.login;
  const me = await ghApi<{ login: string }>('/user', token);
  loginCache.set(userId, { login: me.login, at: Date.now() });
  return me.login;
}

interface RawEvent {
  event: string;
  created_at: string;
  actor: { login: string } | null;
  label?: { name: string };
}

/**
 * The most recent `labeled` event for `label` on an issue. Events come oldest
 * first, so every page is read (up to a cap) and the last match kept.
 */
async function latestLabeledEvent(
  ref: GitHubRepoRef, issueNumber: number, label: string, token: string,
): Promise<RawEvent | null> {
  const wanted = label.toLowerCase();
  let latest: RawEvent | null = null;
  for (let page = 1; page <= MAX_EVENT_PAGES; page++) {
    const events = await ghApi<RawEvent[]>(
      `${repoPath(ref)}/issues/${issueNumber}/events?per_page=100&page=${page}`, token,
    );
    for (const e of events) {
      if (e.event === 'labeled' && e.label?.name.toLowerCase() === wanted) latest = e;
    }
    if (events.length < 100) break;
  }
  return latest;
}

/** SQLite `datetime('now')` ("YYYY-MM-DD HH:MM:SS", UTC) or ISO → epoch ms. */
function parseDbTime(value: string): number {
  return Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

interface ExistingIssueTask { status: string; created_at: string; deleted_at: string | null }

function tasksForIssue(workspaceId: string, repo: string, issueNumber: number): ExistingIssueTask[] {
  return getDb().prepare(
    `SELECT status, created_at, deleted_at FROM tasks
     WHERE workspace_id = ? AND github_issue_repo = ? AND github_issue_number = ?`,
  ).all(workspaceId, repo, issueNumber) as ExistingIssueTask[];
}

// Labels already judged not to count (applied by someone else), keyed by the
// event, so an ignored label isn't re-examined — and re-logged — every poll.
const ignoredLabelEvents = new Set<string>();

async function pickUpIssue(
  workspaceId: string, settings: { label: string; repo: string; userId: string; workspaceName: string },
  ref: GitHubRepoRef, issueNumber: number, labeledAt: string,
): Promise<void> {
  const { label, repo, userId, workspaceName } = settings;
  const user = getDb().prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined;
  const issue = await getIssueDetail(ref, issueNumber, userId);

  const task = createTask({
    workspaceId,
    workspaceName,
    userId,
    username: user?.username ?? 'github',
    // Blank description: the issue is the brief, same as "+ Issue" left empty.
    prompt: buildIssuePrompt(issue, ref, '', true),
    issue: { repo, number: issue.number, title: issue.title, url: issue.html_url },
    source: 'github',
    clientLabel: label,
  });
  addMessage(task.id, 'system', `Picked up automatically: the \`${label}\` label was added to [#${issue.number}](${issue.html_url}) at ${labeledAt}.`);
  console.log(`[issue-watch] ${repo}#${issue.number} → task ${task.id} (${workspaceName})`);

  processQueue(workspaceId).catch(err =>
    console.error(`[issue-watch] launch ${task.id} failed: ${(err as Error)?.message?.slice(0, 200)}`),
  );

  // Mark the issue as taken. Label first: it's the part that matters — while it
  // stays, the issue still looks untouched on GitHub (though it won't re-fire,
  // see the file header).
  const token = await requireToken(userId);
  const base = `${repoPath(ref)}/issues/${issue.number}`;
  try {
    await ghApi(`${base}/labels/${encodeURIComponent(label)}`, token, { method: 'DELETE' });
    await ghApi(`${base}/comments`, token, {
      method: 'POST',
      body: { body: `Picked up by Coder Project Manager — task "${task.title}" queued on workspace \`${workspaceName}\`.` },
    });
  } catch (err) {
    addMessage(task.id, 'system', `Could not update GitHub issue #${issue.number} after pickup (${failureReason(err)}). The \`${label}\` label may still be on it — it won't trigger another task, but you may want to remove it by hand.`);
  }
  await applyIssueProgressLabel(task.id);
}

async function pollWorkspace(workspaceId: string, s: IssueWatchSettings): Promise<void> {
  if (!s.label || !s.repo || !s.userId || !s.workspaceName) return;
  const ref = refFromRepoSlug(s.repo);
  if (!ref) return;
  const settings = { label: s.label, repo: s.repo, userId: s.userId, workspaceName: s.workspaceName };

  const token = await requireToken(s.userId);
  const issues = await ghApi<Array<{ number: number; pull_request?: unknown }>>(
    `${repoPath(ref)}/issues?state=open&labels=${encodeURIComponent(s.label)}&per_page=100&sort=updated&direction=desc`,
    token,
  );
  const candidates = issues.filter(i => !i.pull_request);
  if (candidates.length === 0) return;

  const login = (await getGitHubLogin(s.userId, token)).toLowerCase();

  for (const { number } of candidates) {
    try {
      const existing = tasksForIssue(workspaceId, s.repo, number);
      // A live task already covers this issue — nothing to do until it's finished.
      if (existing.some(t => !t.deleted_at && t.status !== 'completed')) continue;

      const event = await latestLabeledEvent(ref, number, s.label, token);
      if (!event) continue;
      const eventKey = `${workspaceId}:${s.repo}#${number}@${event.created_at}`;
      if (ignoredLabelEvents.has(eventKey)) continue;

      if (event.actor?.login.toLowerCase() !== login) {
        ignoredLabelEvents.add(eventKey);
        console.log(`[issue-watch] ${s.repo}#${number}: "${s.label}" was added by ${event.actor?.login ?? 'unknown'}, not ${login} — ignored`);
        continue;
      }

      // Consumed already: some task for this issue postdates the label.
      const labeledAt = Date.parse(event.created_at);
      if (existing.some(t => parseDbTime(t.created_at) >= labeledAt)) continue;

      await pickUpIssue(workspaceId, settings, ref, number, event.created_at);
    } catch (err) {
      console.error(`[issue-watch] ${s.repo}#${number}: ${(err as Error)?.message?.slice(0, 200)}`);
    }
  }
}

let polling = false;

export async function pollIssueWatches(): Promise<void> {
  // One pass at a time: a slow GitHub must not let passes overlap and race each
  // other into creating the same task twice.
  if (polling) return;
  polling = true;
  try {
    const rows = getDb().prepare(
      `SELECT workspace_id FROM workspace_settings WHERE issue_watch_label IS NOT NULL`,
    ).all() as Array<{ workspace_id: string }>;
    for (const { workspace_id } of rows) {
      try {
        await pollWorkspace(workspace_id, getIssueWatchSettings(workspace_id));
      } catch (err) {
        console.error(`[issue-watch] workspace ${workspace_id}: ${(err as Error)?.message?.slice(0, 200)}`);
      }
    }
  } finally {
    polling = false;
  }
}

let pollTimer: NodeJS.Timeout | null = null;

export function startIssueWatchPoller(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    pollIssueWatches().catch(err =>
      console.error('[issue-watch] Poller error:', (err as Error).message?.slice(0, 200)),
    );
  }, POLL_INTERVAL_MS);
  pollTimer.unref?.();
  console.log(`[issue-watch] GitHub label watcher started (every ${Math.round(POLL_INTERVAL_MS / 1000)}s)`);
}
