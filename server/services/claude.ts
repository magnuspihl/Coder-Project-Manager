import { spawn, execFile, ChildProcess } from 'child_process';
import { createReadStream, createWriteStream } from 'fs';
import { updateTaskStatus, addMessage, addTokenUsage, getMessages, getNextQueuedTask, getWorkingTask, getTask, deleteCurrentSessionAssistantMessages, updateMessageCost, buildTaskParticipantContext, updateTaskParticipantProjectDir, getTaskParticipants, type Task, type TaskParticipant } from './tasks.js';
import { addDiscussionMessage, deleteCurrentDiscussionAssistantMessages, createTaskRequest, buildCatchUpContext, buildMentionInstruction, updateParticipantProjectDir, getParticipants as getDiscussionParticipants, getDiscussionMessages, type Discussion, type DiscussionParticipant } from './discussions.js';
import { getDb } from '../db/index.js';
import { handleTaskLaunchGit, handleTaskResumeGit, handleStashAway, fetchGitHubToken } from './git.js';
import { getOllamaBaseUrl } from './models.js';
import { getAttachmentsByTask, type Attachment } from '../routes/uploads.js';

const CODER_URL = process.env.CODER_URL || '';
const OLLAMA_BASE_URL = getOllamaBaseUrl();
const MAX_TURNS = process.env.CLAUDE_MAX_TURNS || '50';
const ALLOWED_TOOLS = process.env.CLAUDE_ALLOWED_TOOLS || 'Read,Edit,Write,Bash,Glob,Grep';
const DISCUSSION_ALLOWED_TOOLS = 'Read,Edit,Write,MultiEdit,Bash,Glob,Grep,mcp__coder__coder_report_task';

// Track active SSH processes per task so we can kill them
const activeProcesses = new Map<string, ChildProcess>();

// Track polling intervals per task for reconnected tasks
const activePollers = new Map<string, NodeJS.Timeout>();

// Track last activity per task for liveness monitoring
export interface TaskActivity {
  timestamp: string;
  summary: string;
}
const taskActivity = new Map<string, TaskActivity>();

// Track rate limit info per task/discussion
export interface RateLimitInfo {
  resetsAt: number; // Unix timestamp (seconds)
  rateLimitType: string;
}
const rateLimitInfo = new Map<string, RateLimitInfo>();

export function getRateLimitInfo(key: string): RateLimitInfo | undefined {
  const info = rateLimitInfo.get(key);
  if (info && info.resetsAt * 1000 < Date.now()) {
    // Expired, clean up
    rateLimitInfo.delete(key);
    return undefined;
  }
  return info;
}

// Track Claude account usage per workspace (from rate_limit_event utilization)
export interface WorkspaceUsage {
  utilization: number; // 0-1 fraction
  rateLimitType: string;
  resetsAt: number;
  updatedAt: number; // Date.now() when last updated
}
const workspaceUsage = new Map<string, WorkspaceUsage>();

// Global rate limit tracking — stores both five_hour and seven_day separately
// Persisted to SQLite so data survives server restarts
export interface RateLimitUsage {
  utilization: number; // 0-1 fraction
  resetsAt: number;    // Unix timestamp (seconds)
  updatedAt: number;   // Date.now() ms when last updated
}
const globalRateLimits = new Map<string, RateLimitUsage>(); // keyed by rateLimitType

// Load persisted rate limits from DB on first access
let rateLimitsLoaded = false;
function ensureRateLimitsLoaded(): void {
  if (rateLimitsLoaded) return;
  rateLimitsLoaded = true;
  try {
    const db = getDb();
    const rows = db.prepare('SELECT type, utilization, resets_at, updated_at FROM rate_limits').all() as Array<{
      type: string; utilization: number; resets_at: number; updated_at: number;
    }>;
    for (const row of rows) {
      globalRateLimits.set(row.type, {
        utilization: row.utilization,
        resetsAt: row.resets_at,
        updatedAt: row.updated_at,
      });
    }
  } catch {
    // DB not ready yet, will load on next call
    rateLimitsLoaded = false;
  }
}

function persistRateLimit(type: string, usage: RateLimitUsage): void {
  try {
    const db = getDb();
    db.prepare(
      'INSERT INTO rate_limits (type, utilization, resets_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(type) DO UPDATE SET utilization=excluded.utilization, resets_at=excluded.resets_at, updated_at=excluded.updated_at'
    ).run(type, usage.utilization, usage.resetsAt, usage.updatedAt);
  } catch {
    // Non-critical — best effort persistence
  }
}

function updateWorkspaceUsage(_workspaceName: string, info: { utilization?: number; rateLimitType?: string; resetsAt?: number }): void {
  if (typeof info.utilization === 'number') {
    // Legacy per-workspace map (kept for backward compat)
    workspaceUsage.set(_workspaceName, {
      utilization: info.utilization,
      rateLimitType: info.rateLimitType || 'unknown',
      resetsAt: info.resetsAt || 0,
      updatedAt: Date.now(),
    });
  }
  // Always update global limits when we have a type and resetsAt
  if (info.rateLimitType && info.resetsAt) {
    ensureRateLimitsLoaded();
    const existing = globalRateLimits.get(info.rateLimitType);
    const now = Date.now();
    // Update if we have utilization, or if the existing entry is stale/missing
    if (typeof info.utilization === 'number' || !existing || existing.updatedAt < now - 300000) {
      // If resetsAt changed, this is a new period — don't carry over old utilization
      const isNewPeriod = existing && existing.resetsAt !== info.resetsAt;
      const fallbackUtilization = isNewPeriod ? 0 : (existing?.utilization ?? 0);
      const usage: RateLimitUsage = {
        utilization: typeof info.utilization === 'number' ? info.utilization : fallbackUtilization,
        resetsAt: info.resetsAt,
        updatedAt: now,
      };
      globalRateLimits.set(info.rateLimitType, usage);
      persistRateLimit(info.rateLimitType, usage);
    }

    // When we see any rate limit event, seed the other limit type if missing
    // so it shows as indeterminate rather than being invisible
    const otherType = info.rateLimitType === 'five_hour' ? 'seven_day' : 'five_hour';
    if (!globalRateLimits.has(otherType)) {
      // Use a far-future resetsAt so it shows as active/indeterminate
      const seed: RateLimitUsage = { utilization: 0, resetsAt: Math.floor(now / 1000) + 86400 * 7, updatedAt: now };
      globalRateLimits.set(otherType, seed);
      persistRateLimit(otherType, seed);
    }
  }
}

export function getWorkspaceUsages(): Record<string, WorkspaceUsage> {
  const result: Record<string, WorkspaceUsage> = {};
  for (const [name, usage] of workspaceUsage) {
    result[name] = usage;
  }
  return result;
}

export function getGlobalRateLimits(): Record<string, RateLimitUsage> {
  ensureRateLimitsLoaded();
  const result: Record<string, RateLimitUsage> = {};
  const now = Date.now();
  for (const [type, usage] of globalRateLimits) {
    if (usage.resetsAt * 1000 <= now) {
      // Reset period has passed — clear stale utilization in the actual map
      // so it doesn't get carried over when new events arrive without utilization
      const reset = { ...usage, utilization: 0 };
      globalRateLimits.set(type, reset);
      result[type] = reset;
    } else {
      result[type] = usage;
    }
  }
  return result;
}

export function getTaskActivity(taskId: string): TaskActivity | undefined {
  return taskActivity.get(taskId);
}

// Caveman mode prompt — reduces output token usage by forcing terse communication
function buildCavemanPrompt(intensity: string): string {
  const level = intensity || 'full';
  if (level === 'lite') {
    return `MANDATORY OUTPUT RULE — CAVEMAN LITE MODE:
Respond concisely. No filler (just/really/basically/actually/simply). No pleasantries (sure/certainly/of course/happy to). No hedging. Keep articles + full sentences. Professional but tight.
NOT: "Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by..."
YES: "Bug in auth middleware. Token expiry check uses < not <=. Fix:"`;
  }
  if (level === 'ultra') {
    return `MANDATORY OUTPUT RULE — CAVEMAN ULTRA MODE:
Respond terse. Maximum compression. This rule OVERRIDES all other style guidance.

Rules: Drop articles (a/an/the). Drop filler/pleasantries/hedging. Fragments only. Abbreviate (DB/auth/config/req/res/fn/impl). Arrows for causality (X → Y). One word when one word enough. Technical terms exact. Code blocks unchanged.

Pattern: [thing] [action] [reason].

NOT: "The issue is that your component re-renders because you're creating a new object reference on each render. You should wrap it in useMemo to prevent this."
YES: "Inline obj prop → new ref → re-render. useMemo."

NOT: "I'll look into the authentication middleware to understand why it's failing."
YES: "Checking auth middleware."

NOT: "The database connection pool is exhausted because there are too many concurrent requests."
YES: "DB pool exhausted → too many concurrent req."

Exception: security warnings + irreversible action confirmations use normal language. Code/commits/PRs written normally.`;
  }
  // full (default)
  return `MANDATORY OUTPUT RULE — CAVEMAN FULL MODE:
Respond terse like smart caveman. This rule OVERRIDES all other style guidance.

Rules: Drop articles (a/an/the). Drop filler/pleasantries/hedging. Fragments OK. Short synonyms (big not extensive, fix not "implement a solution for"). Technical terms exact. Code blocks unchanged.

Pattern: [thing] [action] [reason]. [next step].

NOT: "Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by..."
YES: "Bug in auth middleware. Token expiry check use < not <=. Fix:"

Exception: security warnings + irreversible action confirmations use normal language. Code/commits/PRs written normally.`;
}

// Stream log per task — persisted to database
export interface StreamLogEntry {
  timestamp: string;
  type: string;
  summary: string;
}

export function getTaskStreamLog(taskId: string): StreamLogEntry[] {
  const rows = getDb().prepare(
    'SELECT id, timestamp, type, summary FROM stream_log WHERE task_id = ? ORDER BY id'
  ).all(taskId) as (StreamLogEntry & { id: number })[];
  return rows;
}

export function getTaskStreamLogAfter(taskId: string, afterId: number): StreamLogEntry[] {
  const rows = getDb().prepare(
    'SELECT id, timestamp, type, summary FROM stream_log WHERE task_id = ? AND id > ? ORDER BY id'
  ).all(taskId, afterId) as (StreamLogEntry & { id: number })[];
  return rows;
}

function appendStreamLog(taskId: string, type: string, summary: string): void {
  getDb().prepare(
    'INSERT INTO stream_log (task_id, timestamp, type, summary) VALUES (?, ?, ?, ?)'
  ).run(taskId, new Date().toISOString(), type, summary);
}

// Cache detected project directories per workspace name
const projectDirCache = new Map<string, string | null>();

/**
 * Shell-escape a string for safe inclusion in a remote shell command.
 */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Name of the workspace this server is running in (set by Coder)
const LOCAL_WORKSPACE_NAME = process.env.CODER_WORKSPACE_NAME || '';

function isLocalWorkspace(workspaceName: string): boolean {
  return !!LOCAL_WORKSPACE_NAME && workspaceName === LOCAL_WORKSPACE_NAME;
}

/**
 * Run a shell command locally, returning stdout.
 */
function localExec(command: string, timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('bash', ['-c', command], {
      timeout,
      env: { ...process.env },
    }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout?.trim() || '');
    });
  });
}

/**
 * Run a command via coder ssh, returning stdout.
 * When the target workspace is the local workspace, runs the command locally instead.
 */
export function sshExec(workspaceName: string, command: string, timeout = 15000): Promise<string> {
  if (isLocalWorkspace(workspaceName)) {
    return localExec(command, timeout);
  }
  return new Promise((resolve, reject) => {
    execFile('coder', ['ssh', workspaceName, '--', command], {
      timeout,
      env: { ...process.env, CODER_URL },
    }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout?.trim() || '');
    });
  });
}

/**
 * Copy local files to a remote workspace via coder ssh stdin piping.
 * Returns array of remote paths where files were placed.
 */
async function transferFilesToWorkspace(
  workspaceName: string,
  attachments: Attachment[],
  remoteDir: string,
): Promise<Map<string, string>> {
  const pathMap = new Map<string, string>();
  if (attachments.length === 0) return pathMap;

  // Create the remote directory
  await sshExec(workspaceName, `mkdir -p ${shellEscape(remoteDir)}`, 10000);

  for (const att of attachments) {
    const remotePath = `${remoteDir}/${att.original_name}`;
    try {
      if (isLocalWorkspace(workspaceName)) {
        await new Promise<void>((resolve, reject) => {
          const src = createReadStream(att.storage_path);
          const dst = createWriteStream(remotePath);
          src.pipe(dst);
          dst.on('finish', resolve);
          dst.on('error', reject);
          src.on('error', (err) => { dst.destroy(); reject(err); });
        });
      } else {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('coder', [
            'ssh', workspaceName, '--',
            `cat > ${shellEscape(remotePath)}`,
          ], {
            env: { ...process.env, CODER_URL },
            stdio: ['pipe', 'ignore', 'pipe'],
          });
          const fileStream = createReadStream(att.storage_path);
          fileStream.pipe(proc.stdin);
          fileStream.on('error', (err) => { proc.kill(); reject(err); });
          proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`SCP failed for ${att.original_name} (exit ${code})`));
          });
          proc.on('error', reject);
        });
      }
      pathMap.set(att.id, remotePath);
    } catch (err) {
      console.error(`[file-transfer] Failed to transfer ${att.original_name}:`, (err as Error).message?.slice(0, 100));
    }
  }
  return pathMap;
}

/** Remote path for task output files */
function remoteOutputPath(taskId: string): string {
  return `/tmp/cpm-task-${taskId}.jsonl`;
}

/** Remote path for task exit code file */
function remoteExitCodePath(taskId: string): string {
  return `/tmp/cpm-task-${taskId}.exit`;
}

/**
 * Auto-detect the primary project directory in a workspace.
 */
export async function detectProjectDir(workspaceName: string): Promise<string | null> {
  if (projectDirCache.has(workspaceName)) {
    return projectDirCache.get(workspaceName)!;
  }

  try {
    const output = await sshExec(workspaceName,
      'find /home/coder -maxdepth 2 -name .git -type d 2>/dev/null'
    );

    if (!output) {
      console.log('[detect-project] No git repos found');
      return null;
    }

    const projects = output.split('\n')
      .filter(line => line.startsWith('/') && line.endsWith('/.git'))
      .map(p => p.replace(/\/\.git$/, ''));

    let best: string | null = null;
    if (projects.length === 1) {
      best = projects[0];
    } else if (projects.length > 1) {
      best = projects.sort((a, b) => a.split('/').length - b.split('/').length)[0];
    }

    console.log('[detect-project] detected:', best);
    projectDirCache.set(workspaceName, best);
    return best;
  } catch (err) {
    console.log('[detect-project] error:', (err as Error).message?.slice(0, 100));
    return null;
  }
}

// Per-workspace lock to prevent concurrent processQueue calls from
// double-launching the same task (TOCTOU race between check and launch).
const queueLocks = new Map<string, Promise<void>>();

/**
 * Central queue processor. This is the ONLY way tasks get started.
 * Call this whenever the queue state might have changed for a workspace.
 */
export async function processQueue(workspaceId: string): Promise<void> {
  // Serialize per workspace — wait for any in-flight processQueue to finish
  const existing = queueLocks.get(workspaceId);
  const run = async () => {
    if (existing) await existing.catch(() => {});

    const working = getWorkingTask(workspaceId);
    if (working) {
      return;
    }

    const next = getNextQueuedTask(workspaceId);
    if (!next) {
      return;
    }

    // Check if this is a resume-pending task (was awaiting_feedback, user replied,
    // but another task was working so it was re-queued). Detect by checking if the
    // task already has a session and the last message is from the user.
    if (next.claude_session_id) {
      const msgs = getMessages(next.id);
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      if (lastMsg && lastMsg.role === 'user' && msgs.some(m => m.role === 'assistant')) {
        // This task has a prior session and a pending user reply — resume it
        await launchTask(next, true, lastMsg.content);
        return;
      }
    }

    await launchTask(next);
  };

  const promise = run();
  queueLocks.set(workspaceId, promise);
  try {
    await promise;
  } finally {
    // Only clear if we're still the latest lock holder
    if (queueLocks.get(workspaceId) === promise) {
      queueLocks.delete(workspaceId);
    }
  }
}

/**
 * Launch a task on its remote workspace via a long-lived SSH connection.
 *
 * Uses detached: true + stdio: 'ignore' so the SSH process survives server restarts.
 * Output is written directly to a remote file which we poll via startFilePolling().
 */
async function launchTask(task: Task, isResume = false, feedback?: string): Promise<void> {
  const rawPrompt = isResume && feedback ? feedback : task.prompt;

  // Append instruction for the agent to provide Coder deep links
  // Use VSCODE_PROXY_URI if available (has the exact pattern), otherwise build from parts
  const proxyUri = process.env.VSCODE_PROXY_URI || '';
  let coderUrlNote = '';
  if (proxyUri) {
    // VSCODE_PROXY_URI looks like: https://{{port}}--main--Workspace--user.coder.example.com
    // Replace the workspace-specific parts with the target workspace's info
    const coderUrlNote_example = proxyUri.replace('{{port}}', 'PORT');
    coderUrlNote = `\n\nIMPORTANT: Only if your changes result in something visually testable in a browser (e.g. a webapp UI change), ` +
      `provide a deep link URL where the change can be seen. Do NOT include a "view live" link for backend-only changes, ` +
      `config changes, refactors, or other non-visual work. ` +
      `This project runs inside a Coder workspace, so use Coder-routed URLs (not localhost). ` +
      `For web apps, use the Coder port-forwarding URL format: ${coderUrlNote_example} (replace PORT with the actual port number, e.g. 5173 for Vite).`;
  } else if (CODER_URL) {
    coderUrlNote = `\n\nIMPORTANT: Only if your changes result in something visually testable in a browser (e.g. a webapp UI change), ` +
      `provide a deep link URL where the change can be seen. Do NOT include a "view live" link for backend-only changes, ` +
      `config changes, refactors, or other non-visual work. ` +
      `This project runs inside a Coder workspace, so use Coder-routed URLs (not localhost). ` +
      `The Coder access URL is: ${CODER_URL}. The workspace name is: ${task.workspace_name}.`;
  }
  // If a branch was specified, override the agent's default branching behavior
  let branchNote = '';
  if (task.branch) {
    branchNote = `\n\nIMPORTANT: You are already on the git branch \`${task.branch}\`. ` +
      `Do NOT create a new branch or switch to a different branch. ` +
      `Commit and push all your work directly to \`${task.branch}\`. ` +
      `This overrides any branching instructions in your system prompt or CLAUDE.md.`;
  }

  let prompt = rawPrompt + branchNote + coderUrlNote;

  // Host's Claude session does not contain participant messages — inject them
  // as catch-up context so the host can see what invited agents have said.
  const taskParticipants = getTaskParticipants(task.id);
  if (taskParticipants.length > 0) {
    const hostCatchUp = buildTaskParticipantContext(task.id, '__host__');
    if (hostCatchUp) prompt = hostCatchUp + '\n' + prompt;
  }

  // Auto-detect project directory if not already set
  if (!task.project_dir) {
    const detected = await detectProjectDir(task.workspace_name);
    if (detected) {
      task.project_dir = detected;
      getDb().prepare('UPDATE tasks SET project_dir = ? WHERE id = ?').run(detected, task.id);
    }
  }

  // Git branch management
  if (task.branch && task.project_dir && !isResume) {
    // User specified a branch override — check it out directly
    const ws = task.workspace_name;
    const dir = shellEscape(task.project_dir);
    const branch = task.branch;
    try {
      console.log(`[claude-executor] Checking out branch '${branch}' on workspace ${ws}`);
      await sshExec(ws, `cd ${dir} && git fetch origin`, 30000);

      const remoteRef = await sshExec(ws,
        `cd ${dir} && git ls-remote --heads origin ${shellEscape(branch)}`,
        15000
      );

      if (remoteRef && remoteRef.includes(branch)) {
        await sshExec(ws,
          `cd ${dir} && git checkout ${shellEscape(branch)} && git pull origin ${shellEscape(branch)}`,
          30000
        );
      } else {
        await sshExec(ws, `cd ${dir} && git checkout -b ${shellEscape(branch)}`, 15000);
      }
      addMessage(task.id, 'system', `Checked out branch \`${branch}\`.`);
    } catch (err) {
      const errorMsg = `Failed to checkout branch '${branch}': ${(err as Error).message || err}`;
      console.error(`[claude-executor] ${errorMsg}`);
      addMessage(task.id, 'system', `Error: ${errorMsg}`);
      updateTaskStatus(task.id, 'failed', errorMsg);
      processQueue(task.workspace_id).catch(() => {});
      return;
    }
  } else if (isResume) {
    await handleTaskResumeGit(task);
  } else {
    await handleTaskLaunchGit(task);
  }

  // Transfer any attached files to the remote workspace
  const attachments = getAttachmentsByTask(task.id);
  if (attachments.length > 0) {
    const remoteAttachDir = `/tmp/cpm-attachments-${task.id}`;
    try {
      const pathMap = await transferFilesToWorkspace(task.workspace_name, attachments, remoteAttachDir);
      if (pathMap.size > 0) {
        const fileList = Array.from(pathMap.values())
          .map(p => `- ${p}`)
          .join('\n');
        prompt += `\n\nReference files have been provided and placed on this workspace. Use the Read tool to examine them:\n${fileList}`;
        console.log(`[file-transfer] Transferred ${pathMap.size} file(s) for task ${task.id}`);
      }
    } catch (err) {
      console.error('[file-transfer] Failed:', (err as Error).message?.slice(0, 100));
      addMessage(task.id, 'system', `Warning: Failed to transfer some attached files to workspace`);
    }
  }

  // Build the claude command
  const claudeParts: string[] = [];
  claudeParts.push('claude');
  claudeParts.push('-p', shellEscape(prompt));

  if (isResume && task.claude_session_id) {
    claudeParts.push('--resume', shellEscape(task.claude_session_id));
  } else if (task.claude_session_id) {
    claudeParts.push('--session-id', shellEscape(task.claude_session_id));
  }

  claudeParts.push('--output-format', 'stream-json');
  claudeParts.push('--verbose');
  claudeParts.push('--allowedTools', shellEscape(ALLOWED_TOOLS));
  claudeParts.push('--max-turns', MAX_TURNS);

  // Determine if this is an Ollama model (prefixed with "ollama/")
  const isOllama = task.model?.startsWith('ollama/');
  const actualModel = isOllama ? task.model!.slice('ollama/'.length) : task.model;

  if (actualModel) {
    claudeParts.push('--model', shellEscape(actualModel));
  }

  // Caveman mode — inject as system prompt for stronger enforcement
  if (task.caveman) {
    claudeParts.push('--append-system-prompt', shellEscape(buildCavemanPrompt(task.caveman)));
    console.log(`[caveman] Task ${task.id} using caveman mode: ${task.caveman} (via --append-system-prompt)`);
  }

  const claudeCmd = claudeParts.join(' ');
  const outputFile = remoteOutputPath(task.id);
  const exitFile = remoteExitCodePath(task.id);

  // Build the remote command:
  // - Write output directly to a file (no stdout pipe — avoids SIGPIPE on server restart)
  // - Capture Claude's exit code
  let remoteCmd = 'export PATH="$HOME/.local/bin:$PATH" && ';

  // For Ollama models, override the Anthropic endpoint to point to Ollama
  if (isOllama) {
    remoteCmd += `export ANTHROPIC_BASE_URL="${OLLAMA_BASE_URL}" ANTHROPIC_API_KEY="" ANTHROPIC_AUTH_TOKEN=ollama && `;
  }
  if (task.project_dir) {
    remoteCmd += `cd ${shellEscape(task.project_dir)} && `;
  }
  // Exit file is pre-cleaned above, but rm again in case the pre-clean SSH failed
  remoteCmd += `rm -f ${shellEscape(exitFile)} && `;
  remoteCmd += `${claudeCmd} > ${shellEscape(outputFile)} 2>&1; `;
  remoteCmd += `echo $? > ${shellEscape(exitFile)}`;

  console.log('[claude-executor] Launching on workspace:', task.workspace_name);
  console.log('[claude-executor] Project dir:', task.project_dir || '(none - home dir)');
  console.log('[claude-executor] Model:', task.model || '(default)', isOllama ? `→ Ollama (${actualModel})` : '');
  console.log('[claude-executor] Remote cmd:', remoteCmd.slice(0, 300));

  try {
    updateTaskStatus(task.id, 'working');
    taskActivity.set(task.id, { timestamp: new Date().toISOString(), summary: 'Starting Claude session' });

    // Delete stale output/exit files BEFORE spawning SSH.
    // Without this, the poller can read old files from a previous run
    // before the new SSH process connects and deletes them itself.
    try {
      await sshExec(task.workspace_name,
        `rm -f ${shellEscape(outputFile)} ${shellEscape(exitFile)}`,
      );
    } catch {
      // Non-fatal — the remote rm -f in the command will also clean up
    }

    // Spawn the claude process — locally if the task targets this workspace,
    // otherwise via coder ssh so it runs inside the remote workspace.
    const sshProcess = isLocalWorkspace(task.workspace_name)
      ? spawn('bash', ['-c', remoteCmd], {
          env: { ...process.env },
          stdio: 'ignore',
          detached: true,
        })
      : spawn('coder', ['ssh', task.workspace_name, '--', remoteCmd], {
          env: { ...process.env, CODER_URL },
          stdio: 'ignore',
          detached: true,
        });

    // Store PID in DB so we can find orphaned processes after restart
    getDb().prepare('UPDATE tasks SET ssh_pid = ? WHERE id = ?').run(sshProcess.pid ?? null, task.id);

    activeProcesses.set(task.id, sshProcess);

    // Fully detach — the SSH process will outlive this server process
    sshProcess.unref();

    // Observe the task by polling the remote output file
    startFilePolling(task);

  } catch (err) {
    const errorMsg = (err as Error).message || 'Failed to launch Claude';
    console.error('[claude-executor] Launch failed:', errorMsg);
    addMessage(task.id, 'system', `Error: ${errorMsg}`);
    updateTaskStatus(task.id, 'failed', errorMsg);
    processQueue(task.workspace_id).catch(() => {});
  }
}

/**
 * Resume a task that is awaiting feedback. This bypasses the queue
 * because the task is already "active" — it just needs to continue.
 */
export async function resumeTask(task: Task, feedback: string): Promise<void> {
  await launchTask(task, true, feedback);
}

function processEvent(taskId: string, event: { type: string; [key: string]: unknown }): void {
  const now = new Date().toISOString();
  let summary = event.type;

  if (event.type === 'assistant' && event.message) {
    const msg = event.message as { content?: Array<{ type: string; name?: string; text?: string; input?: Record<string, unknown> }> };
    if (msg.content) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          summary = `Using ${block.name || 'tool'}`;
          taskActivity.set(taskId, { timestamp: now, summary });
          // Log tool use with input summary
          const inputSnippet = block.input ? JSON.stringify(block.input).slice(0, 200) : '';
          appendStreamLog(taskId, 'tool_use', `${block.name || 'tool'}: ${inputSnippet}`);
        } else if (block.type === 'text' && block.text) {
          summary = block.text.slice(0, 200).replace(/\n/g, ' ');
          taskActivity.set(taskId, { timestamp: now, summary });
          appendStreamLog(taskId, 'assistant', block.text);
        }
      }
    }
    return;
  }

  if (event.type === 'tool_result') {
    summary = 'Processing tool result';
    const content = typeof event.content === 'string' ? event.content : '';
    appendStreamLog(taskId, 'tool_result', content.slice(0, 500));
  } else if (event.type === 'result') {
    // Handle result as string or content blocks array
    let resultText = '';
    if (typeof event.result === 'string') {
      resultText = event.result.slice(0, 500);
    } else if (Array.isArray(event.result)) {
      resultText = (event.result as Array<{ type?: string; text?: string }>)
        .filter(b => b.type === 'text' && b.text)
        .map(b => b.text)
        .join('\n')
        .slice(0, 500);
    }
    summary = resultText ? `Finished: ${resultText.slice(0, 200).replace(/\n/g, ' ')}` : 'Finished';
    appendStreamLog(taskId, 'result', resultText || summary);
  } else {
    appendStreamLog(taskId, event.type, summary);
  }

  taskActivity.set(taskId, { timestamp: now, summary });
}

export function cancelTask(workspaceId: string): void {
  const db = getDb();
  const task = db.prepare("SELECT id, workspace_name, ssh_pid FROM tasks WHERE workspace_id = ? AND status = 'working' LIMIT 1")
    .get(workspaceId) as { id: string; workspace_name: string; ssh_pid: number | null } | undefined;

  if (task) {
    killTaskProcess(task.id, task.ssh_pid);
  }
}

/**
 * Interrupt a running task — kills the process but transitions to awaiting_feedback
 * so the user can continue the conversation (like Ctrl+C in the CLI).
 */
export function interruptTask(taskId: string): void {
  const db = getDb();
  const partial = db.prepare("SELECT id, workspace_name, ssh_pid FROM tasks WHERE id = ? AND status = 'working'")
    .get(taskId) as { id: string; workspace_name: string; ssh_pid: number | null } | undefined;

  if (partial) {
    killTaskProcess(partial.id, partial.ssh_pid);
    addMessage(partial.id, 'system', 'Task was interrupted by user.');
    updateTaskStatus(partial.id, 'awaiting_feedback');
    // Fetch full task for git operations
    const fullTask = getTask(partial.id);
    if (fullTask) {
      handleStashAway(fullTask).catch(err => console.error('[git] Pause commit failed:', (err as Error).message?.slice(0, 100)));
    }
  }
}

/** Kill the SSH process for a task and clean up tracking state. */
function killTaskProcess(taskId: string, sshPid: number | null): void {
  const db = getDb();
  const proc = activeProcesses.get(taskId);
  if (proc) {
    proc.kill();
    activeProcesses.delete(taskId);
  } else if (sshPid) {
    try { process.kill(sshPid); } catch {}
  }
  stopPolling(taskId);
  taskActivity.delete(taskId);
  db.prepare('UPDATE tasks SET ssh_pid = NULL WHERE id = ?').run(taskId);
}

function stopPolling(taskId: string): void {
  const interval = activePollers.get(taskId);
  if (interval) {
    clearInterval(interval);
    activePollers.delete(taskId);
  }
}

/**
 * On server restart, check for orphaned SSH processes still running.
 * If the process is alive, reconnect via file polling.
 * If dead, check exit code file, otherwise mark as failed.
 */
export async function reconnectWorkingTasks(): Promise<void> {
  const db = getDb();
  const workingTasks = db.prepare("SELECT * FROM tasks WHERE status = 'working'").all() as Task[];

  if (workingTasks.length > 0) {
    console.log(`[recovery] Found ${workingTasks.length} working task(s), checking for surviving processes...`);

    for (const task of workingTasks) {
      const sshPid = task.ssh_pid;

      // Check if the SSH process is still alive
      let processAlive = false;
      if (sshPid) {
        try {
          process.kill(sshPid, 0); // Signal 0 = check if process exists
          processAlive = true;
        } catch {
          // Process is gone
        }
      }

      if (processAlive) {
        console.log(`[recovery] Task "${task.title}" SSH process (PID ${sshPid}) still alive, reconnecting via file polling`);
        // Don't set a fake activity — startFilePolling will immediately poll
        // the remote file and derive real activity from Claude's output
        startFilePolling(task);
      } else {
        // SSH process is gone — check if it finished (exit code file exists)
        try {
          const exitFile = remoteExitCodePath(task.id);
          const exitCheck = await sshExec(task.workspace_name,
            `cat ${shellEscape(exitFile)} 2>/dev/null || echo 'NO_EXIT'`,
          );

          if (exitCheck !== 'NO_EXIT') {
            console.log(`[recovery] Task "${task.title}" finished while server was down (exit: ${exitCheck})`);
            // Read the output file and process it
            await processRemainingOutput(task);
            const exitCode = parseInt(exitCheck, 10);
            if (exitCode === 0 || isNaN(exitCode)) {
              // Only transition to awaiting_feedback if we actually captured a response
              const hasResponse = getMessages(task.id).some(m => m.role === 'assistant');
              if (hasResponse) {
                updateTaskStatus(task.id, 'awaiting_feedback');
                await handleStashAway(task).catch(err => console.error('[git] Pause commit failed:', (err as Error).message?.slice(0, 100)));
              } else {
                // No response captured — task was likely interrupted. Re-queue for retry.
                console.log(`[recovery] Task "${task.title}" exited with no response — re-queuing`);
                addMessage(task.id, 'system', 'Server restarted before Claude produced a response. Re-queued for automatic retry.');
                updateTaskStatus(task.id, 'queued');
              }
            } else {
              updateTaskStatus(task.id, 'failed', `Claude exited with code ${exitCode}`);
            }
          } else {
            // SSH process gone with no exit code — task was interrupted mid-execution.
            // Re-queue it so it retries automatically instead of requiring manual retry.
            console.log(`[recovery] Task "${task.title}" SSH process gone, no exit code — re-queuing for automatic retry`);
            addMessage(task.id, 'system', 'Server restarted while this task was running. Re-queued for automatic retry.');
            updateTaskStatus(task.id, 'queued');
          }
        } catch (err) {
          console.log(`[recovery] Cannot reach workspace for task "${task.title}":`, (err as Error).message?.slice(0, 80));
          addMessage(task.id, 'system', 'Error: Cannot reach workspace after server restart');
          updateTaskStatus(task.id, 'failed', 'Cannot reach workspace after server restart');
        }

        db.prepare('UPDATE tasks SET ssh_pid = NULL WHERE id = ?').run(task.id);
      }
    }
  }

  // Process queue for all workspaces that have queued tasks
  const rows = db.prepare(`SELECT DISTINCT workspace_id FROM tasks WHERE status = 'queued'`)
    .all() as Array<{ workspace_id: string }>;

  for (const row of rows) {
    await processQueue(row.workspace_id).catch(err => {
      console.log(`[recovery] Failed to process queue:`, (err as Error).message?.slice(0, 100));
    });
  }
}

/**
 * Poll a remote output file for a reconnected task.
 * Used when the SSH process survived a server restart but we lost the stdout pipe.
 */
function startFilePolling(task: Task): void {
  stopPolling(task.id);

  // Clear stream log and current-session assistant messages — the remote output file
  // contains the complete history, so we'll re-process from scratch.
  // This prevents duplicates on reconnect while preserving previous session messages.
  getDb().prepare('DELETE FROM stream_log WHERE task_id = ?').run(task.id);
  deleteCurrentSessionAssistantMessages(task.id);

  let linesRead = 0;
  let lastSavedMessageId: string | null = null;
  let lastSavedMessageText: string | null = null;
  let resultError: string | null = null;
  let consecutiveErrors = 0;
  let partialLine = '';  // Buffer for incomplete last line from previous poll
  let polling = false;   // Guard against overlapping polls

  const poll = async () => {
    if (polling) return;  // Previous poll still in flight — skip
    polling = true;
    try {
      const outputFile = remoteOutputPath(task.id);
      const exitFile = remoteExitCodePath(task.id);

      const output = await sshExec(task.workspace_name,
        `tail -n +${linesRead + 1} ${shellEscape(outputFile)} 2>/dev/null; echo '---CPM_EXIT_CHECK---'; cat ${shellEscape(exitFile)} 2>/dev/null || echo 'RUNNING'`,
        20000,
      );

      consecutiveErrors = 0;

      const markerIdx = output.indexOf('---CPM_EXIT_CHECK---');
      const jsonPart = markerIdx >= 0 ? output.slice(0, markerIdx) : output;
      const exitPart = markerIdx >= 0 ? output.slice(markerIdx + '---CPM_EXIT_CHECK---'.length).trim() : 'RUNNING';

      if (jsonPart.trim() || partialLine) {
        // Prepend any buffered partial line from the previous poll
        const fullData = partialLine + jsonPart;
        partialLine = '';

        const allLines = fullData.split('\n');

        // The last element might be a partial line if the file is still being
        // written.  Buffer it for the next poll instead of skipping it.
        // A complete file always ends with '\n', so the last element after
        // split is '' (empty).  If it's non-empty, it's an incomplete line.
        const lastElement = allLines[allLines.length - 1];
        if (lastElement && lastElement.trim()) {
          partialLine = allLines.pop()!;
        }

        // Count ALL lines (including blank) to stay in sync with tail -n
        for (const line of allLines) {
          linesRead++;
          if (!line.trim()) continue;

          let event: { type: string; [key: string]: unknown };
          try {
            event = JSON.parse(line);
          } catch {
            // Not valid JSON (e.g. stderr output), skip
            continue;
          }

          try {
            processEvent(task.id, event);

            // Track rate limit events
            if (event.type === 'rate_limit_event') {
              const info = event.rate_limit_info as { resetsAt?: number; rateLimitType?: string; status?: string; utilization?: number } | undefined;
              if (info) {
                updateWorkspaceUsage(task.workspace_name, info);
                if (info.status === 'rate_limited' && info.resetsAt && info.resetsAt * 1000 > Date.now()) {
                  rateLimitInfo.set(task.id, { resetsAt: info.resetsAt, rateLimitType: info.rateLimitType || 'unknown' });
                }
              }
            }

            // Save each assistant turn's text as a message immediately,
            // so it appears in the chat UI while the task is still working.
            if (event.type === 'assistant' && (event.message as { content?: unknown })?.content) {
              let turnText = '';
              for (const block of (event.message as { content: Array<{ type: string; text?: string }> }).content) {
                if (block.type === 'text' && block.text) {
                  turnText += block.text;
                }
              }
              if (turnText) {
                const msg = addMessage(task.id, 'assistant', turnText);
                lastSavedMessageId = msg.id;
                lastSavedMessageText = turnText;
              }
            }

            if (event.type === 'result') {
              const resultText = extractResultText(event);
              // Save result text as a message if it has content distinct from the last assistant message
              if (resultText && resultText !== lastSavedMessageText) {
                const msg = addMessage(task.id, 'assistant', resultText, event.total_cost_usd as number | undefined);
                lastSavedMessageId = msg.id;
                lastSavedMessageText = resultText;
              } else if (typeof event.total_cost_usd === 'number' && lastSavedMessageId) {
                // Attach session cost to the last assistant message
                updateMessageCost(lastSavedMessageId, event.total_cost_usd);
              }
              // Accumulate token usage
              const { inputTokens: inTok, outputTokens: outTok } = extractTokenUsage(event);
              if (inTok > 0 || outTok > 0) {
                addTokenUsage(task.id, inTok, outTok);
              }
              if (event.is_error && Array.isArray(event.errors) && (event.errors as string[]).length > 0) {
                resultError = (event.errors as string[]).join('; ');
              }
            }
          } catch (eventErr) {
            console.error(`[claude-poller] Error processing event for task ${task.id}:`, (eventErr as Error).message?.slice(0, 200));
          }
        }
      }

      if (exitPart !== 'RUNNING' && exitPart !== '') {
        const exitCode = parseInt(exitPart, 10);
        console.log(`[claude-poller] Task ${task.id} finished with exit code ${exitCode}`);
        stopPolling(task.id);
        taskActivity.delete(task.id);
        getDb().prepare('UPDATE tasks SET ssh_pid = NULL WHERE id = ?').run(task.id);

        // Check if this was a rate limit failure
        const rlInfo = rateLimitInfo.get(task.id);
        rateLimitInfo.delete(task.id);
        const isRateLimited = rlInfo && rlInfo.resetsAt * 1000 > Date.now();

        if (isRateLimited) {
          const resetTime = new Date(rlInfo!.resetsAt * 1000).toISOString();
          addMessage(task.id, 'system', `Rate limited — resets at ${resetTime}`);
          updateTaskStatus(task.id, 'failed', `rate_limited:${rlInfo!.resetsAt}`);
        } else if (resultError) {
          addMessage(task.id, 'system', `Error: ${resultError}`);
          updateTaskStatus(task.id, 'failed', resultError);
        } else if (exitCode === 0 || isNaN(exitCode)) {
          // Only transition to awaiting_feedback if we actually captured a response
          const hasResponse = getMessages(task.id).some(m => m.role === 'assistant');
          if (hasResponse) {
            updateTaskStatus(task.id, 'awaiting_feedback');
            handleStashAway(task).catch(err => console.error('[git] Pause commit failed:', (err as Error).message?.slice(0, 100)));
          } else {
            // No response captured — re-queue for automatic retry
            console.log(`[claude-poller] Task ${task.id} exited with no response — re-queuing`);
            addMessage(task.id, 'system', 'Claude exited without producing a response. Re-queued for automatic retry.');
            updateTaskStatus(task.id, 'queued');
          }
        } else {
          const errorMsg = `Claude exited with code ${exitCode}`;
          addMessage(task.id, 'system', `Error: ${errorMsg}`);
          updateTaskStatus(task.id, 'failed', errorMsg);
        }

        // Don't clean up remote files — they're the source of truth for recovery.
        // They'll be cleaned up when the next task launches (rm -f exitFile).

        processQueue(task.workspace_id).catch(() => {});
      }
    } catch (err) {
      consecutiveErrors++;
      console.log(`[claude-poller] Error polling task ${task.id} (${consecutiveErrors}):`, (err as Error).message?.slice(0, 100));

      if (consecutiveErrors > 20) {
        console.log(`[claude-poller] Too many errors, marking task ${task.id} as failed`);
        stopPolling(task.id);
        taskActivity.delete(task.id);
        addMessage(task.id, 'system', 'Error: Lost connection to workspace');
        updateTaskStatus(task.id, 'failed', 'Lost connection to workspace');
      }
    } finally {
      polling = false;
    }
  };

  const interval = setInterval(poll, 5000);
  activePollers.set(task.id, interval);
  poll();
}

/** Extract text from a result event's result field (string or content blocks array). */
function extractResultText(event: { [key: string]: unknown }): string {
  if (typeof event.result === 'string') {
    return event.result;
  }
  if (Array.isArray(event.result)) {
    return (event.result as Array<{ type?: string; text?: string }>)
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text)
      .join('\n');
  }
  return '';
}

/**
 * Extract token usage from a result event.
 * The CLI stream-json format nests tokens under `usage` and/or `modelUsage`.
 */
function extractTokenUsage(event: { [key: string]: unknown }): { inputTokens: number; outputTokens: number } {
  let inputTokens = 0;
  let outputTokens = 0;

  // Try modelUsage first (has aggregated per-model totals)
  const modelUsage = event.modelUsage as Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }> | undefined;
  if (modelUsage) {
    for (const model of Object.values(modelUsage)) {
      inputTokens += (model.inputTokens || 0) + (model.cacheReadInputTokens || 0) + (model.cacheCreationInputTokens || 0);
      outputTokens += model.outputTokens || 0;
    }
  }

  // Fallback to usage object
  if (inputTokens === 0 && outputTokens === 0) {
    const usage = event.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
    if (usage) {
      inputTokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      outputTokens = usage.output_tokens || 0;
    }
  }

  return { inputTokens, outputTokens };
}

/**
 * Read remaining output from a task that finished while the server was down.
 */
async function processRemainingOutput(task: Task): Promise<void> {
  try {
    const outputFile = remoteOutputPath(task.id);
    const output = await sshExec(task.workspace_name,
      `cat ${shellEscape(outputFile)} 2>/dev/null`,
      30000,
    );

    if (!output) return;

    // Clear current session messages to avoid duplicates on recovery re-processing
    deleteCurrentSessionAssistantMessages(task.id);

    let lastSavedMessageId: string | null = null;
    let lastSavedMessageText: string | null = null;
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        // Populate stream log for recovered events
        processEvent(task.id, event);

        // Save each assistant turn's text as a message immediately
        if (event.type === 'assistant' && event.message?.content) {
          let turnText = '';
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text) {
              turnText += block.text;
            }
          }
          if (turnText) {
            const msg = addMessage(task.id, 'assistant', turnText);
            lastSavedMessageId = msg.id;
            lastSavedMessageText = turnText;
          }
        }
        if (event.type === 'result') {
          const resultText = extractResultText(event);
          // Save result text as a message if it has content distinct from the last assistant message
          if (resultText && resultText !== lastSavedMessageText) {
            const msg = addMessage(task.id, 'assistant', resultText, event.total_cost_usd as number | undefined);
            lastSavedMessageId = msg.id;
            lastSavedMessageText = resultText;
          } else if (typeof event.total_cost_usd === 'number' && lastSavedMessageId) {
            updateMessageCost(lastSavedMessageId, event.total_cost_usd);
          }
          const { inputTokens: inTok, outputTokens: outTok } = extractTokenUsage(event);
          if (inTok > 0 || outTok > 0) {
            addTokenUsage(task.id, inTok, outTok);
          }
        }
      } catch {
        // Skip invalid JSON
      }
    }

    // Don't clean up remote files — they're the source of truth for recovery.
  } catch (err) {
    console.log(`[recovery] Failed to read remaining output:`, (err as Error).message?.slice(0, 100));
  }
}

// ─── Discussion (workspace chat) support ───────────────────────────────────

function getDiscussionPromptPrefix(projectDir: string | null): string {
  const boundary = projectDir
    ? `You MUST NOT modify, create, or delete any files within \`${projectDir}\` (the git-tracked project directory) — treat it as read-only. If work needs to be done inside the project, output a [TASK_REQUEST] instead and the user will approve it as a task.\n\nYou MAY freely read, explore, and write to files outside this path — global config files like \`~/.claude/CLAUDE.md\`, workspace memory files, temp files, etc.`
    : `You MUST NOT modify, create, or delete files in the project repository — treat it as read-only. If work needs to be done in the project, output a [TASK_REQUEST] instead and the user will approve it as a task.`;

  return `You are a discussion agent for this workspace. ${boundary}

If the discussion leads to work that should be done inside the project, output a task request in this EXACT format (on its own, not inside a code block):

[TASK_REQUEST]
{"prompt": "detailed task description here", "branch": "optional-branch-name"}
[/TASK_REQUEST]

The "branch" field is optional — omit it or set it to null if no specific branch is needed. The user will be prompted to approve the task before it runs.

---

`;
}

function getReadOnlyOverride(projectDir: string | null): string {
  const boundary = projectDir
    ? `You MUST NOT modify, create, or delete any files within \`${projectDir}\` (the git-tracked project directory). You MAY write to files outside this path (global config, memory files, temp files, etc.).`
    : `You MUST NOT modify, create, or delete files in the project repository.`;
  return `[SYSTEM OVERRIDE] Your access mode has been changed to READ-ONLY. You are now in a discussion session. ${boundary}\n\n`;
}

/** Remote path for discussion output files */
function remoteDiscussionOutputPath(discussionId: string): string {
  return `/tmp/cpm-discussion-${discussionId}.jsonl`;
}

/** Remote path for discussion exit code file */
function remoteDiscussionExitCodePath(discussionId: string): string {
  return `/tmp/cpm-discussion-${discussionId}.exit`;
}

/**
 * Parse [TASK_REQUEST] blocks from text and create task_requests entries.
 */
function parseTaskRequests(discussionId: string, text: string): void {
  const regex = /\[TASK_REQUEST\]\s*([\s\S]*?)\s*\[\/TASK_REQUEST\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      if (data.prompt && typeof data.prompt === 'string') {
        const branch = typeof data.branch === 'string' ? data.branch : undefined;
        createTaskRequest(discussionId, data.prompt, branch);
        console.log(`[discussion] Task request created for discussion ${discussionId}`);
      }
    } catch {
      console.log(`[discussion] Failed to parse task request JSON`);
    }
  }
}

/**
 * Parse [MENTION:workspace_name] tags from assistant text and auto-trigger
 * catch-up for the mentioned agent. Strips the tag from the message.
 */
function parseMentions(discussion: Discussion, text: string, sourceParticipantId: string | null): void {
  const mentionRe = /\[MENTION:([^\]]+)\]/g;
  let match;
  const mentioned = new Set<string>();
  while ((match = mentionRe.exec(text)) !== null) {
    mentioned.add(match[1].trim());
  }
  if (mentioned.size === 0) return;

  const participants = getDiscussionParticipants(discussion.id);

  for (const name of mentioned) {
    // Check if it's the host workspace
    if (name === discussion.workspace_name && sourceParticipantId !== null) {
      // Mentioned the host — trigger host catch-up (async, fire-and-forget)
      const hostCatchUp = buildCatchUpContext(discussion.id, '__host__');
      if (hostCatchUp) {
        const nudge = hostCatchUp + '\n' + MENTION_NUDGE;
        const messages = getDiscussionMessages(discussion.id);
        const isResume = messages.some(m => m.role === 'assistant' && !m.participant_id);
        console.log(`[mention] ${name} mentioned by participant, triggering host catch-up`);
        launchDiscussion(discussion, nudge, isResume, undefined, true).catch(err => {
          console.error('[mention] Failed to launch host catch-up:', (err as Error).message?.slice(0, 100));
        });
      }
      continue;
    }

    // Check if it's a participant
    const participant = participants.find(p => p.workspace_name === name);
    if (participant && participant.id !== sourceParticipantId) {
      const catchUp = buildCatchUpContext(discussion.id, participant.id);
      if (catchUp) {
        const nudge = catchUp + '\n' + MENTION_NUDGE;
        const messages = getDiscussionMessages(discussion.id);
        const isResume = messages.some(m => m.role === 'assistant' && m.participant_id === participant.id);
        console.log(`[mention] ${name} mentioned, triggering participant catch-up`);
        launchParticipantDiscussion(discussion, participant, nudge, isResume, undefined, true).catch(err => {
          console.error('[mention] Failed to launch participant catch-up:', (err as Error).message?.slice(0, 100));
        });
      }
    }
  }
}

const MENTION_NUDGE = 'Another agent has mentioned you in the conversation. Review the context above. ' +
  'If you have something relevant to respond with, please do. ' +
  'If the conversation doesn\'t require your input, just say so briefly (e.g. "Nothing to add from my side."). ' +
  'You can mention other agents by including [MENTION:workspace_name] in your response to bring them into the conversation.';

/**
 * Launch or resume a discussion session on a remote workspace.
 */
export async function launchDiscussion(
  discussion: Discussion,
  message: string,
  isResume: boolean,
  username?: string,
  skipCatchUp?: boolean
): Promise<void> {
  const isFullAccess = discussion.full_access === 1;
  const FULL_ACCESS_OVERRIDE = '[SYSTEM OVERRIDE] Your access mode has been changed to FULL ACCESS. ' +
    'You are NO LONGER in a read-only session. Disregard any earlier instructions about being read-only or having limited tools. ' +
    'You now have full access to all tools and can modify files, make commits, run any commands, and perform all actions.\n\n';

  // Build catch-up context for the host if there are participants —
  // the host's own session doesn't contain messages from other agents.
  const participants = getDiscussionParticipants(discussion.id);
  let hostCatchUp = '';
  if (participants.length > 0 && isResume && !skipCatchUp) {
    hostCatchUp = buildCatchUpContext(discussion.id, '__host__');
  }

  let prompt: string;
  if (!isResume) {
    // First message — use prefix or not based on mode
    prompt = isFullAccess ? message : getDiscussionPromptPrefix(discussion.project_dir ?? null) + message;
  } else if (participants.length > 0) {
    // Resuming with participants — prepend catch-up if available, skip access override.
    // Always include mention instruction so the agent knows how to reach other agents.
    const mentionInstr = hostCatchUp ? '' : buildMentionInstruction(discussion.id);
    const prefix = [hostCatchUp, mentionInstr].filter(Boolean).join('\n');
    prompt = prefix ? prefix + '\n' + message : message;
  } else if (isFullAccess) {
    // Resuming with full access, no participants — send override in case mode changed
    prompt = FULL_ACCESS_OVERRIDE + message;
  } else {
    // Resuming in read-only, no participants — send override in case mode changed
    prompt = getReadOnlyOverride(discussion.project_dir ?? null) + message;
  }

  // Auto-detect project directory if not already set
  if (!discussion.project_dir) {
    const detected = await detectProjectDir(discussion.workspace_name);
    if (detected) {
      discussion.project_dir = detected;
      getDb().prepare('UPDATE discussions SET project_dir = ? WHERE id = ?').run(detected, discussion.id);
    }
  }

  // Check if the session already exists on the remote workspace
  // (e.g. user pasted an existing session ID via the edit field, or resuming a CCW session).
  // Claude scopes sessions to the cwd's project path, so we also resolve the correct working
  // directory by checking whether the session lives under the project dir or the home dir.
  let remoteSessionExists = isResume;
  let sessionWorkDir = discussion.project_dir;
  if (discussion.claude_session_id) {
    try {
      const checkResult = await sshExec(discussion.workspace_name,
        `find ~/.claude/projects/ -name '${discussion.claude_session_id}.jsonl' 2>/dev/null | head -1`
      );
      const sessionPath = checkResult.trim();
      if (sessionPath) {
        remoteSessionExists = true;
        // If the session isn't in the project dir's scope, fall back to home dir.
        // Claude encodes /home/coder/my-project as -home-coder-my-project
        const projectDirEncoded = discussion.project_dir
          ? '-' + discussion.project_dir.replace(/^\//, '').replace(/\//g, '-')
          : null;
        if (projectDirEncoded && !sessionPath.includes(`/projects/${projectDirEncoded}/`)) {
          sessionWorkDir = '/home/coder';
        }
      }
    } catch {
      // Non-fatal — assume new session, use default project_dir
    }
  }

  // Build the claude command
  // When there are participants, always send the full prompt (with catch-up context)
  // even on resume, since the host's session doesn't contain participant messages.
  const claudeParts: string[] = [];
  const useFullPrompt = participants.length > 0;
  claudeParts.push('claude');
  claudeParts.push('-p', shellEscape(remoteSessionExists && !useFullPrompt ? message : prompt));

  if (remoteSessionExists && discussion.claude_session_id) {
    claudeParts.push('--resume', shellEscape(discussion.claude_session_id));
  } else if (discussion.claude_session_id) {
    claudeParts.push('--session-id', shellEscape(discussion.claude_session_id));
  }

  claudeParts.push('--output-format', 'stream-json');
  claudeParts.push('--verbose');
  if (isFullAccess) {
    claudeParts.push('--dangerously-skip-permissions');
  } else {
    claudeParts.push('--allowedTools', shellEscape(DISCUSSION_ALLOWED_TOOLS));
  }
  claudeParts.push('--max-turns', MAX_TURNS);

  // Model override
  if (discussion.model) {
    const isOllama = discussion.model.startsWith('ollama/');
    const actualModel = isOllama ? discussion.model.slice('ollama/'.length) : discussion.model;
    claudeParts.push('--model', shellEscape(actualModel));
  }

  const claudeCmd = claudeParts.join(' ');
  const outputFile = remoteDiscussionOutputPath(discussion.id);
  const exitFile = remoteDiscussionExitCodePath(discussion.id);

  let remoteCmd = 'export PATH="$HOME/.local/bin:$PATH" && ';
  if (sessionWorkDir) {
    remoteCmd += `cd ${shellEscape(sessionWorkDir)} && `;
  }
  remoteCmd += `rm -f ${shellEscape(exitFile)} && `;
  remoteCmd += `${claudeCmd} > ${shellEscape(outputFile)} 2>&1; `;
  remoteCmd += `echo $? > ${shellEscape(exitFile)}`;

  console.log('[discussion] Launching on workspace:', discussion.workspace_name);

  try {
    // Update status
    getDb().prepare("UPDATE discussions SET updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), discussion.id);
    taskActivity.set(`disc:${discussion.id}`, { timestamp: new Date().toISOString(), summary: 'Starting discussion session' });

    // Clean stale files
    try {
      await sshExec(discussion.workspace_name,
        `rm -f ${shellEscape(outputFile)} ${shellEscape(exitFile)}`
      );
    } catch {
      // Non-fatal
    }

    // Spawn SSH
    const ghToken = await fetchGitHubToken().catch(() => null);
    const sshProcess = spawn('coder', ['ssh', discussion.workspace_name, '--', remoteCmd], {
      env: { ...process.env, CODER_URL, ...(ghToken ? { GH_TOKEN: ghToken } : {}) },
      stdio: 'ignore',
      detached: true,
    });

    getDb().prepare('UPDATE discussions SET ssh_pid = ? WHERE id = ?').run(sshProcess.pid ?? null, discussion.id);
    activeProcesses.set(`disc:${discussion.id}`, sshProcess);
    sshProcess.unref();

    // Poll output — skip message cleanup for catch-up launches
    startDiscussionPolling(discussion, skipCatchUp);

  } catch (err) {
    const errorMsg = (err as Error).message || 'Failed to launch discussion';
    console.error('[discussion] Launch failed:', errorMsg);
    addDiscussionMessage(discussion.id, 'system', `Error: ${errorMsg}`);
  }
}

/**
 * Cancel/stop an active discussion's SSH process.
 */
export function stopDiscussion(discussionId: string): void {
  const proc = activeProcesses.get(`disc:${discussionId}`);
  if (proc) {
    proc.kill();
    activeProcesses.delete(`disc:${discussionId}`);
  }
  stopPolling(`disc:${discussionId}`);
  taskActivity.delete(`disc:${discussionId}`);
  getDb().prepare('UPDATE discussions SET ssh_pid = NULL WHERE id = ?').run(discussionId);

  // Also stop any active participants
  const participants = getDiscussionParticipants(discussionId);
  for (const p of participants) {
    stopParticipant(p.id);
  }
}

export function getDiscussionActivity(discussionId: string): TaskActivity | undefined {
  return taskActivity.get(`disc:${discussionId}`);
}

/**
 * Check if a discussion is currently running (has an active SSH process).
 */
export function isDiscussionRunning(discussionId: string): boolean {
  return activeProcesses.has(`disc:${discussionId}`) || activePollers.has(`disc:${discussionId}`);
}

/**
 * Poll remote output file for a discussion session.
 */
function startDiscussionPolling(discussion: Discussion, skipMessageCleanup?: boolean): void {
  const pollKey = `disc:${discussion.id}`;
  stopPolling(pollKey);

  // Clear stream log and current-session assistant messages (for reconnect dedup).
  // Skip cleanup for catch-up launches — there's no prior output to de-duplicate,
  // and cleaning up would delete the host's previous legitimate responses.
  getDb().prepare('DELETE FROM stream_log WHERE task_id = ?').run(pollKey);
  if (!skipMessageCleanup) {
    deleteCurrentDiscussionAssistantMessages(discussion.id);
  }

  let linesRead = 0;
  let lastSavedMessageId: string | null = null;
  let lastSavedMessageText: string | null = null;
  let consecutiveErrors = 0;
  let partialLine = '';
  let polling = false;

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const outputFile = remoteDiscussionOutputPath(discussion.id);
      const exitFile = remoteDiscussionExitCodePath(discussion.id);

      const output = await sshExec(discussion.workspace_name,
        `tail -n +${linesRead + 1} ${shellEscape(outputFile)} 2>/dev/null; echo '---CPM_EXIT_CHECK---'; cat ${shellEscape(exitFile)} 2>/dev/null || echo 'RUNNING'`,
        20000,
      );

      consecutiveErrors = 0;

      const markerIdx = output.indexOf('---CPM_EXIT_CHECK---');
      const jsonPart = markerIdx >= 0 ? output.slice(0, markerIdx) : output;
      const exitPart = markerIdx >= 0 ? output.slice(markerIdx + '---CPM_EXIT_CHECK---'.length).trim() : 'RUNNING';

      if (jsonPart.trim() || partialLine) {
        const fullData = partialLine + jsonPart;
        partialLine = '';

        const allLines = fullData.split('\n');
        const lastElement = allLines[allLines.length - 1];
        if (lastElement && lastElement.trim()) {
          partialLine = allLines.pop()!;
        }

        for (const line of allLines) {
          linesRead++;
          if (!line.trim()) continue;

          let event: { type: string; [key: string]: unknown };
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          try {
            // Track rate limit events
            if (event.type === 'rate_limit_event') {
              const info = event.rate_limit_info as { resetsAt?: number; rateLimitType?: string; status?: string; utilization?: number } | undefined;
              if (info) {
                updateWorkspaceUsage(discussion.workspace_name, info);
                if (info.status === 'rate_limited' && info.resetsAt && info.resetsAt * 1000 > Date.now()) {
                  rateLimitInfo.set(`disc:${discussion.id}`, { resetsAt: info.resetsAt, rateLimitType: info.rateLimitType || 'unknown' });
                }
              }
            }

            // Update activity
            const now = new Date().toISOString();
            if (event.type === 'assistant' && event.message) {
              const msg = event.message as { content?: Array<{ type: string; text?: string }> };
              if (msg.content) {
                for (const block of msg.content) {
                  if (block.type === 'text' && block.text) {
                    taskActivity.set(`disc:${discussion.id}`, { timestamp: now, summary: block.text.slice(0, 200).replace(/\n/g, ' ') });
                    // Save and check for task requests
                    const dmsg = addDiscussionMessage(discussion.id, 'assistant', block.text);
                    lastSavedMessageId = dmsg.id;
                    lastSavedMessageText = block.text;
                    parseTaskRequests(discussion.id, block.text);
                  } else if (block.type === 'tool_use') {
                    taskActivity.set(`disc:${discussion.id}`, { timestamp: now, summary: `Using ${(block as { name?: string }).name || 'tool'}` });
                  }
                }
              }
            } else if (event.type === 'result') {
              const resultText = extractResultText(event);
              if (resultText && resultText !== lastSavedMessageText) {
                const dmsg = addDiscussionMessage(discussion.id, 'assistant', resultText, event.total_cost_usd as number | undefined);
                lastSavedMessageId = dmsg.id;
                lastSavedMessageText = resultText;
                parseTaskRequests(discussion.id, resultText);
              } else if (typeof event.total_cost_usd === 'number' && lastSavedMessageId) {
                // Update cost on last message
                getDb().prepare('UPDATE discussion_messages SET cost = ? WHERE id = ?').run(event.total_cost_usd, lastSavedMessageId);
              }
            }
          } catch (eventErr) {
            console.error(`[discussion-poller] Error processing event:`, (eventErr as Error).message?.slice(0, 200));
          }
        }
      }

      if (exitPart !== 'RUNNING' && exitPart !== '') {
        const exitCode = parseInt(exitPart, 10);
        console.log(`[discussion-poller] Discussion ${discussion.id} finished (exit: ${exitPart})`);
        stopPolling(pollKey);
        taskActivity.delete(`disc:${discussion.id}`);
        activeProcesses.delete(`disc:${discussion.id}`);
        rateLimitInfo.delete(`disc:${discussion.id}`);
        getDb().prepare('UPDATE discussions SET ssh_pid = NULL WHERE id = ?').run(discussion.id);

        // Check for agent mentions in the last response (host = null source)
        if (exitCode === 0 && lastSavedMessageText) {
          parseMentions(discussion, lastSavedMessageText, null);
        }

        // Surface errors to the user
        if (exitCode !== 0 && !isNaN(exitCode)) {
          // Try to extract error details from the output file (stderr is mixed in)
          let errorDetail = '';
          try {
            const lastLines = await sshExec(discussion.workspace_name,
              `tail -5 ${shellEscape(outputFile)} 2>/dev/null | grep -v '^{' | head -3`,
              10000
            );
            if (lastLines.trim()) {
              errorDetail = ': ' + lastLines.trim().split('\n').join(' ').slice(0, 200);
            }
          } catch { /* ignore */ }

          const errorMessages: Record<number, string> = {
            127: 'Claude CLI not found. The workspace may need the Claude Code CLI installed.',
            126: 'Claude CLI is not executable.',
            1: 'Claude exited with an error' + errorDetail,
          };
          const msg = errorMessages[exitCode] || `Claude exited with code ${exitCode}${errorDetail}`;
          addDiscussionMessage(discussion.id, 'system', `Error: ${msg}`);
        }
      }
    } catch (err) {
      consecutiveErrors++;
      console.log(`[discussion-poller] Error (${consecutiveErrors}):`, (err as Error).message?.slice(0, 100));

      if (consecutiveErrors > 20) {
        console.log(`[discussion-poller] Too many errors, stopping polling for discussion ${discussion.id}`);
        stopPolling(pollKey);
        taskActivity.delete(`disc:${discussion.id}`);
        addDiscussionMessage(discussion.id, 'system', 'Error: Lost connection to workspace');
      }
    } finally {
      polling = false;
    }
  };

  const interval = setInterval(poll, 5000);
  activePollers.set(pollKey, interval);
  poll();
}

// ─── Multi-agent participant support ──────────────────────────────

function remoteParticipantOutputPath(participantId: string): string {
  return `/tmp/cpm-disc-participant-${participantId}.jsonl`;
}

function remoteParticipantExitCodePath(participantId: string): string {
  return `/tmp/cpm-disc-participant-${participantId}.exit`;
}

/**
 * Launch or resume a participant's Claude session on their workspace.
 */
export async function launchParticipantDiscussion(
  discussion: Discussion,
  participant: DiscussionParticipant,
  message: string,
  isResume: boolean,
  username?: string,
  skipCatchUp?: boolean
): Promise<void> {
  const isFullAccess = discussion.full_access === 1;

  // Build catch-up context unless the caller already included it in the message.
  const catchUp = skipCatchUp ? '' : buildCatchUpContext(discussion.id, participant.id);

  // Include mention instruction if no catch-up (catch-up already has it)
  const mentionInstr = catchUp ? '' : buildMentionInstruction(discussion.id);

  let prompt: string;
  if (!isResume) {
    const prefix = isFullAccess ? '' : getDiscussionPromptPrefix(participant.project_dir ?? null);
    const context = [mentionInstr].filter(Boolean).join('\n');
    prompt = prefix + (context ? context + '\n' : '') + message;
  } else {
    const context = [catchUp, mentionInstr].filter(Boolean).join('\n');
    prompt = context ? context + '\n' + message : message;
  }

  // Auto-detect project directory if not already set
  if (!participant.project_dir) {
    const detected = await detectProjectDir(participant.workspace_name);
    if (detected) {
      participant.project_dir = detected;
      updateParticipantProjectDir(participant.id, detected);
    }
  }

  // Check if session already exists on remote
  let remoteSessionExists = isResume;
  let sessionWorkDir = participant.project_dir;
  if (participant.claude_session_id) {
    try {
      const checkResult = await sshExec(participant.workspace_name,
        `find ~/.claude/projects/ -name '${participant.claude_session_id}.jsonl' 2>/dev/null | head -1`
      );
      if (checkResult.trim()) {
        remoteSessionExists = true;
        const projectDirEncoded = participant.project_dir
          ? '-' + participant.project_dir.replace(/^\//, '').replace(/\//g, '-')
          : null;
        if (projectDirEncoded && !checkResult.includes(`/projects/${projectDirEncoded}/`)) {
          sessionWorkDir = '/home/coder';
        }
      }
    } catch { /* Non-fatal */ }
  }

  // Build claude command
  // Always send the full prompt (with catch-up context) for participants,
  // even on resume — the participant's own session doesn't contain messages
  // from other agents, so catch-up context is essential.
  const claudeParts: string[] = ['claude'];
  claudeParts.push('-p', shellEscape(prompt));

  if (remoteSessionExists && participant.claude_session_id) {
    claudeParts.push('--resume', shellEscape(participant.claude_session_id));
  } else if (participant.claude_session_id) {
    claudeParts.push('--session-id', shellEscape(participant.claude_session_id));
  }

  claudeParts.push('--output-format', 'stream-json');
  claudeParts.push('--verbose');
  if (isFullAccess) {
    claudeParts.push('--dangerously-skip-permissions');
  } else {
    claudeParts.push('--allowedTools', shellEscape(DISCUSSION_ALLOWED_TOOLS));
  }
  claudeParts.push('--max-turns', MAX_TURNS);

  const claudeCmd = claudeParts.join(' ');
  const outputFile = remoteParticipantOutputPath(participant.id);
  const exitFile = remoteParticipantExitCodePath(participant.id);

  let remoteCmd = 'export PATH="$HOME/.local/bin:$PATH" && ';
  if (sessionWorkDir) {
    remoteCmd += `cd ${shellEscape(sessionWorkDir)} && `;
  }
  remoteCmd += `rm -f ${shellEscape(exitFile)} && `;
  remoteCmd += `${claudeCmd} > ${shellEscape(outputFile)} 2>&1; `;
  remoteCmd += `echo $? > ${shellEscape(exitFile)}`;

  console.log('[participant] Launching on workspace:', participant.workspace_name, 'for discussion:', discussion.id);

  try {
    const pollKey = `disc-p:${participant.id}`;
    taskActivity.set(pollKey, { timestamp: new Date().toISOString(), summary: 'Starting participant session' });

    // Clean stale files
    try {
      await sshExec(participant.workspace_name, `rm -f ${shellEscape(outputFile)} ${shellEscape(exitFile)}`);
    } catch { /* Non-fatal */ }

    // Spawn SSH
    const ghToken = await fetchGitHubToken().catch(() => null);
    const sshProcess = spawn('coder', ['ssh', participant.workspace_name, '--', remoteCmd], {
      env: { ...process.env, CODER_URL, ...(ghToken ? { GH_TOKEN: ghToken } : {}) },
      stdio: 'ignore',
      detached: true,
    });

    activeProcesses.set(pollKey, sshProcess);
    sshProcess.unref();

    // Poll output
    startParticipantPolling(discussion, participant);

  } catch (err) {
    const errorMsg = (err as Error).message || 'Failed to launch participant session';
    console.error('[participant] Launch failed:', errorMsg);
    addDiscussionMessage(discussion.id, 'system', `Error launching ${participant.workspace_name}: ${errorMsg}`);
  }
}

export function stopParticipant(participantId: string): void {
  const pollKey = `disc-p:${participantId}`;
  const proc = activeProcesses.get(pollKey);
  if (proc) {
    proc.kill();
    activeProcesses.delete(pollKey);
  }
  stopPolling(pollKey);
  taskActivity.delete(pollKey);
}

export function isParticipantRunning(participantId: string): boolean {
  const pollKey = `disc-p:${participantId}`;
  return activeProcesses.has(pollKey) || activePollers.has(pollKey);
}

export function getParticipantActivity(participantId: string): TaskActivity | undefined {
  return taskActivity.get(`disc-p:${participantId}`);
}

/**
 * Check if ANY agent (host or participant) is currently running for a discussion.
 */
export function isAnyAgentRunning(discussionId: string, participantIds: string[]): boolean {
  if (isDiscussionRunning(discussionId)) return true;
  return participantIds.some(pid => isParticipantRunning(pid));
}

/**
 * Stop all active participants for a discussion.
 */
export function stopAllParticipants(participantIds: string[]): void {
  for (const pid of participantIds) {
    stopParticipant(pid);
  }
}

/**
 * Poll remote output file for a participant session.
 */
function startParticipantPolling(discussion: Discussion, participant: DiscussionParticipant): void {
  const pollKey = `disc-p:${participant.id}`;
  stopPolling(pollKey);

  let linesRead = 0;
  let lastSavedMessageId: string | null = null;
  let lastSavedMessageText: string | null = null;
  let consecutiveErrors = 0;
  let partialLine = '';
  let polling = false;

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const outputFile = remoteParticipantOutputPath(participant.id);
      const exitFile = remoteParticipantExitCodePath(participant.id);

      const output = await sshExec(participant.workspace_name,
        `tail -n +${linesRead + 1} ${shellEscape(outputFile)} 2>/dev/null; echo '---CPM_EXIT_CHECK---'; cat ${shellEscape(exitFile)} 2>/dev/null || echo 'RUNNING'`,
        20000,
      );

      consecutiveErrors = 0;

      const markerIdx = output.indexOf('---CPM_EXIT_CHECK---');
      const jsonPart = markerIdx >= 0 ? output.slice(0, markerIdx) : output;
      const exitPart = markerIdx >= 0 ? output.slice(markerIdx + '---CPM_EXIT_CHECK---'.length).trim() : 'RUNNING';

      if (jsonPart.trim() || partialLine) {
        const fullData = partialLine + jsonPart;
        partialLine = '';

        const allLines = fullData.split('\n');
        const lastElement = allLines[allLines.length - 1];
        if (lastElement && lastElement.trim()) {
          partialLine = allLines.pop()!;
        }

        for (const line of allLines) {
          linesRead++;
          if (!line.trim()) continue;

          let event: { type: string; [key: string]: unknown };
          try {
            event = JSON.parse(line);
          } catch { continue; }

          try {
            // Track rate limit events
            if (event.type === 'rate_limit_event') {
              const info = event.rate_limit_info as { resetsAt?: number; rateLimitType?: string; status?: string; utilization?: number } | undefined;
              if (info) {
                updateWorkspaceUsage(participant.workspace_name, info);
              }
            }

            // Update activity
            const now = new Date().toISOString();
            if (event.type === 'assistant' && event.message) {
              const msg = event.message as { content?: Array<{ type: string; text?: string; name?: string }> };
              if (msg.content) {
                for (const block of msg.content) {
                  if (block.type === 'text' && block.text) {
                    taskActivity.set(pollKey, { timestamp: now, summary: block.text.slice(0, 200).replace(/\n/g, ' ') });
                    const dmsg = addDiscussionMessage(discussion.id, 'assistant', block.text, undefined, participant.workspace_name, participant.id);
                    lastSavedMessageId = dmsg.id;
                    lastSavedMessageText = block.text;
                    parseTaskRequests(discussion.id, block.text);
                  } else if (block.type === 'tool_use') {
                    taskActivity.set(pollKey, { timestamp: now, summary: `Using ${block.name || 'tool'}` });
                  }
                }
              }
            } else if (event.type === 'result') {
              const resultText = extractResultText(event);
              if (resultText && resultText !== lastSavedMessageText) {
                const dmsg = addDiscussionMessage(discussion.id, 'assistant', resultText, event.total_cost_usd as number | undefined, participant.workspace_name, participant.id);
                lastSavedMessageId = dmsg.id;
                lastSavedMessageText = resultText;
                parseTaskRequests(discussion.id, resultText);
              } else if (typeof event.total_cost_usd === 'number' && lastSavedMessageId) {
                getDb().prepare('UPDATE discussion_messages SET cost = ? WHERE id = ?').run(event.total_cost_usd, lastSavedMessageId);
              }
            }
          } catch (eventErr) {
            console.error(`[participant-poller] Error processing event:`, (eventErr as Error).message?.slice(0, 200));
          }
        }
      }

      if (exitPart !== 'RUNNING' && exitPart !== '') {
        const exitCode = parseInt(exitPart, 10);
        console.log(`[participant-poller] Participant ${participant.id} finished (exit: ${exitPart})`);
        stopPolling(pollKey);
        taskActivity.delete(pollKey);
        activeProcesses.delete(pollKey);

        // Check for agent mentions in the last response
        if (exitCode === 0 && lastSavedMessageText) {
          parseMentions(discussion, lastSavedMessageText, participant.id);
        }

        if (exitCode !== 0 && !isNaN(exitCode)) {
          addDiscussionMessage(discussion.id, 'system', `${participant.workspace_name} session ended with error (exit ${exitCode})`);
        }
      }
    } catch (err) {
      consecutiveErrors++;
      console.log(`[participant-poller] Error (${consecutiveErrors}):`, (err as Error).message?.slice(0, 100));

      if (consecutiveErrors > 20) {
        console.log(`[participant-poller] Too many errors, stopping polling for participant ${participant.id}`);
        stopPolling(pollKey);
        taskActivity.delete(pollKey);
        addDiscussionMessage(discussion.id, 'system', `Error: Lost connection to ${participant.workspace_name}`);
      }
    } finally {
      polling = false;
    }
  };

  const interval = setInterval(poll, 5000);
  activePollers.set(pollKey, interval);
  poll();
}

// ─── Task Participant Support ───────────────────────────────────────────

function remoteTaskParticipantOutputPath(participantId: string): string {
  return `/tmp/cpm-task-participant-${participantId}.jsonl`;
}

function remoteTaskParticipantExitCodePath(participantId: string): string {
  return `/tmp/cpm-task-participant-${participantId}.exit`;
}

export async function launchTaskParticipant(
  task: Task,
  participant: TaskParticipant,
  message: string,
  isResume: boolean,
): Promise<void> {
  const catchUp = buildTaskParticipantContext(task.id, participant.id);

  let prompt: string;
  if (!isResume) {
    prompt = getDiscussionPromptPrefix(participant.project_dir ?? null) + (catchUp ? catchUp + '\n' : '') + message;
  } else {
    prompt = catchUp ? catchUp + '\n' + message : message;
  }

  if (!participant.project_dir) {
    const detected = await detectProjectDir(participant.workspace_name);
    if (detected) {
      participant.project_dir = detected;
      updateTaskParticipantProjectDir(participant.id, detected);
    }
  }

  let remoteSessionExists = isResume;
  let sessionWorkDir = participant.project_dir;
  if (participant.claude_session_id) {
    try {
      const checkResult = await sshExec(participant.workspace_name,
        `find ~/.claude/projects/ -name '${participant.claude_session_id}.jsonl' 2>/dev/null | head -1`
      );
      if (checkResult.trim()) {
        remoteSessionExists = true;
        const projectDirEncoded = participant.project_dir
          ? '-' + participant.project_dir.replace(/^\//, '').replace(/\//g, '-')
          : null;
        if (projectDirEncoded && !checkResult.includes(`/projects/${projectDirEncoded}/`)) {
          sessionWorkDir = '/home/coder';
        }
      }
    } catch { /* Non-fatal */ }
  }

  const claudeParts: string[] = ['claude'];
  claudeParts.push('-p', shellEscape(prompt));
  if (remoteSessionExists && participant.claude_session_id) {
    claudeParts.push('--resume', shellEscape(participant.claude_session_id));
  } else if (participant.claude_session_id) {
    claudeParts.push('--session-id', shellEscape(participant.claude_session_id));
  }
  claudeParts.push('--output-format', 'stream-json', '--verbose');
  claudeParts.push('--allowedTools', shellEscape(DISCUSSION_ALLOWED_TOOLS));
  claudeParts.push('--max-turns', MAX_TURNS);

  const outputFile = remoteTaskParticipantOutputPath(participant.id);
  const exitFile = remoteTaskParticipantExitCodePath(participant.id);

  let remoteCmd = 'export PATH="$HOME/.local/bin:$PATH" && ';
  if (sessionWorkDir) remoteCmd += `cd ${shellEscape(sessionWorkDir)} && `;
  remoteCmd += `rm -f ${shellEscape(exitFile)} && `;
  remoteCmd += `${claudeParts.join(' ')} > ${shellEscape(outputFile)} 2>&1; `;
  remoteCmd += `echo $? > ${shellEscape(exitFile)}`;

  console.log('[task-participant] Launching on workspace:', participant.workspace_name, 'for task:', task.id);

  try {
    const pollKey = `task-p:${participant.id}`;
    taskActivity.set(pollKey, { timestamp: new Date().toISOString(), summary: 'Starting advisory session' });
    try { await sshExec(participant.workspace_name, `rm -f ${shellEscape(outputFile)} ${shellEscape(exitFile)}`); } catch { /* */ }

    const ghToken = await fetchGitHubToken().catch(() => null);
    const sshProcess = spawn('coder', ['ssh', participant.workspace_name, '--', remoteCmd], {
      env: { ...process.env, CODER_URL, ...(ghToken ? { GH_TOKEN: ghToken } : {}) },
      stdio: 'ignore',
      detached: true,
    });
    activeProcesses.set(pollKey, sshProcess);
    sshProcess.unref();
    startTaskParticipantPolling(task, participant);
  } catch (err) {
    addMessage(task.id, 'system', `Error launching ${participant.workspace_name}: ${(err as Error).message}`);
  }
}

export function isTaskParticipantRunning(participantId: string): boolean {
  const k = `task-p:${participantId}`;
  return activeProcesses.has(k) || activePollers.has(k);
}

export function getTaskParticipantActivity(participantId: string): TaskActivity | undefined {
  return taskActivity.get(`task-p:${participantId}`);
}

export function stopTaskParticipant(participantId: string): void {
  const k = `task-p:${participantId}`;
  const proc = activeProcesses.get(k);
  if (proc) { proc.kill(); activeProcesses.delete(k); }
  stopPolling(k);
  taskActivity.delete(k);
}

function startTaskParticipantPolling(task: Task, participant: TaskParticipant): void {
  const pollKey = `task-p:${participant.id}`;
  stopPolling(pollKey);
  let linesRead = 0, lastSavedMessageId: string | null = null, lastSavedMessageText: string | null = null;
  let consecutiveErrors = 0, partialLine = '', polling = false;

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const outputFile = remoteTaskParticipantOutputPath(participant.id);
      const exitFile = remoteTaskParticipantExitCodePath(participant.id);
      const output = await sshExec(participant.workspace_name,
        `tail -n +${linesRead + 1} ${shellEscape(outputFile)} 2>/dev/null; echo '---CPM_EXIT_CHECK---'; cat ${shellEscape(exitFile)} 2>/dev/null || echo 'RUNNING'`, 20000);
      consecutiveErrors = 0;
      const markerIdx = output.indexOf('---CPM_EXIT_CHECK---');
      const jsonPart = markerIdx >= 0 ? output.slice(0, markerIdx) : output;
      const exitPart = markerIdx >= 0 ? output.slice(markerIdx + '---CPM_EXIT_CHECK---'.length).trim() : 'RUNNING';

      if (jsonPart.trim() || partialLine) {
        const fullData = partialLine + jsonPart;
        partialLine = '';
        const allLines = fullData.split('\n');
        if (allLines[allLines.length - 1]?.trim()) partialLine = allLines.pop()!;
        for (const line of allLines) {
          linesRead++;
          if (!line.trim()) continue;
          let event: { type: string; [key: string]: unknown };
          try { event = JSON.parse(line); } catch { continue; }
          try {
            if (event.type === 'rate_limit_event') {
              const info = event.rate_limit_info as { resetsAt?: number; rateLimitType?: string } | undefined;
              if (info) updateWorkspaceUsage(participant.workspace_name, info);
            }
            const now = new Date().toISOString();
            if (event.type === 'assistant' && event.message) {
              const msg = event.message as { content?: Array<{ type: string; text?: string; name?: string }> };
              for (const block of msg.content || []) {
                if (block.type === 'text' && block.text) {
                  taskActivity.set(pollKey, { timestamp: now, summary: block.text.slice(0, 200).replace(/\n/g, ' ') });
                  const saved = addMessage(task.id, 'assistant', block.text, undefined, participant.workspace_name, participant.id);
                  lastSavedMessageId = saved.id; lastSavedMessageText = block.text;
                } else if (block.type === 'tool_use') {
                  taskActivity.set(pollKey, { timestamp: now, summary: `Using ${block.name || 'tool'}` });
                }
              }
            } else if (event.type === 'result') {
              const resultText = extractResultText(event);
              if (resultText && resultText !== lastSavedMessageText) {
                const saved = addMessage(task.id, 'assistant', resultText, event.total_cost_usd as number | undefined, participant.workspace_name, participant.id);
                lastSavedMessageId = saved.id; lastSavedMessageText = resultText;
              } else if (typeof event.total_cost_usd === 'number' && lastSavedMessageId) {
                updateMessageCost(lastSavedMessageId, event.total_cost_usd as number);
              }
            }
          } catch { /* skip */ }
        }
      }
      if (exitPart !== 'RUNNING' && exitPart !== '') {
        stopPolling(pollKey); taskActivity.delete(pollKey); activeProcesses.delete(pollKey);
        const exitCode = parseInt(exitPart, 10);
        if (exitCode !== 0 && !isNaN(exitCode)) addMessage(task.id, 'system', `${participant.workspace_name} session ended with error (exit ${exitCode})`);
      }
    } catch {
      consecutiveErrors++;
      if (consecutiveErrors > 20) {
        stopPolling(pollKey); taskActivity.delete(pollKey);
        addMessage(task.id, 'system', `Error: Lost connection to ${participant.workspace_name}`);
      }
    } finally { polling = false; }
  };

  const tpInterval = setInterval(poll, 5000);
  activePollers.set(pollKey, tpInterval);
  poll();
}
