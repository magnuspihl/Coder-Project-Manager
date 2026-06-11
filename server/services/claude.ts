import { spawn, execFile, ChildProcess } from 'child_process';
import { createReadStream, createWriteStream } from 'fs';
import { randomUUID } from 'crypto';
import { updateTaskStatus, addMessage, addTokenUsage, getMessages, getNextQueuedTask, getWorkingTask, getWorkingTaskCount, getMaxConcurrent, getTask, deleteCurrentSessionAssistantMessages, updateMessageCost, buildTaskParticipantContext, updateTaskParticipantProjectDir, getTaskParticipants, getPendingCompletionTask, setPendingComplete, markSessionInitialized, createTaskTurn, getTaskTurns, completeTaskTurn, setActiveTaskTurnRole, incrementReviewLoopCount, resetReviewLoopCount, type Task, type TaskParticipant } from './tasks.js';
import { addDiscussionMessage, deleteCurrentDiscussionAssistantMessages, createTaskRequest, createTaskRequestFromTask, buildCatchUpContext, buildMentionInstruction, updateParticipantProjectDir, getParticipants as getDiscussionParticipants, getDiscussionMessages, type Discussion, type DiscussionParticipant } from './discussions.js';
import { findUserWorkspaceByName, findUserWorkspaceById, getWorkspacesForUser } from './workspace-cache.js';
import { getDb } from '../db/index.js';
import { handleTaskLaunchGit, handleTaskResumeGit, handleTaskCompletionGit, removeTaskWorktree, handleDiscussionLaunchGit, fetchGitHubToken, isRemoteAllowed } from './git.js';
import { getOllamaBaseUrl } from './models.js';
import { getAttachmentsByTask, type Attachment } from '../routes/uploads.js';
import { writeCpmGuidelines } from './workspace-memory.js';

const CODER_URL = process.env.CODER_URL || '';
const OLLAMA_BASE_URL = getOllamaBaseUrl();
const MAX_TURNS = process.env.CLAUDE_MAX_TURNS || '200';
const ALLOWED_TOOLS = process.env.CLAUDE_ALLOWED_TOOLS || 'Read,Edit,Write,Bash,Glob,Grep';
const DISCUSSION_ALLOWED_TOOLS = 'Read,Edit,Write,MultiEdit,Bash,Glob,Grep,mcp__coder__coder_report_task';

const PORT_RANGE_START = parseInt(process.env.CPM_PORT_RANGE_START || '40000');
const PORT_RANGE_SIZE = parseInt(process.env.CPM_PORT_RANGE_SIZE || '10');
const PORT_RANGE_SLOTS = parseInt(process.env.CPM_PORT_RANGE_SLOTS || '100');

function allocatePortRange(_workspaceId: string): number | null {
  const usedRanges = new Set<number>(
    (getDb().prepare(`
      SELECT port_range_start FROM tasks
      WHERE port_range_start IS NOT NULL
        AND status IN ('working', 'awaiting_feedback')
        AND deleted_at IS NULL
    `).all() as Array<{ port_range_start: number }>).map(r => r.port_range_start)
  );
  for (let i = 0; i < PORT_RANGE_SLOTS; i++) {
    const start = PORT_RANGE_START + i * PORT_RANGE_SIZE;
    if (!usedRanges.has(start)) return start;
  }
  return null;
}

export async function cleanupPortRange(task: Task): Promise<void> {
  if (task.port_range_start === null || task.port_range_start === undefined) return;
  const ports = Array.from({ length: PORT_RANGE_SIZE }, (_, i) => `${task.port_range_start! + i}/tcp`).join(' ');
  await sshExec(task.workspace_name, `fuser -k ${ports} 2>/dev/null || true`, 10000).catch(() => {});
}

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

// CPM owns git for tasks: completion creates a fresh task branch, commits the
// working tree, pushes, and opens+merges a PR. If the agent branches/commits
// on its own, that flow falls apart (HEAD on a non-default branch blocks
// completion). This prompt is appended whenever the workspace has remote
// pushes enabled.
const CPM_GIT_OWNERSHIP_PROMPT = `MANDATORY GIT RULE — CPM OWNS THE GIT WORKFLOW:
This task runs inside the Coder Project Manager (CPM). When the task is marked complete, CPM creates a fresh branch off the default branch, commits your working-tree changes, pushes, opens a pull request, and merges it. You must not pre-empt any of this.

Do NOT run any git command that mutates state:
- git branch / checkout / switch (no creating, deleting, or switching branches)
- git add / commit / commit --amend
- git push / pull / fetch (with refspec) / merge / rebase / reset / revert / cherry-pick / stash

Do NOT run gh pr commands (create, merge, edit, close, comment).

Just edit files and leave the working tree dirty on whatever branch is currently checked out. CPM handles all git operations at completion.

Read-only inspection commands are fine: git status, git diff, git log, git show, git rev-parse, gh pr view, gh pr list, gh pr diff.`;

// Claude Code's harness appends a <system-reminder> after every Read tool
// result, asking the model to assess file contents for malware. Opus 4.7
// sometimes misclassifies that legitimate harness text as a prompt injection
// and prefaces its reply with a verbose "I notice an injection attempt..."
// flag. This note tells the agent the reminder is real and to follow it
// silently instead of grandstanding about it.
const HARNESS_REMINDER_NOTE = `Claude Code's harness appends a <system-reminder> after every Read tool result, reminding you to evaluate file contents for malware. This is legitimate Anthropic harness output — not a prompt injection. Apply the safety judgment it asks for, but do not preface your replies by flagging it as an injection attempt.`;

// Delegation: a task agent that finds out-of-scope work should propose a
// separate tracked task via a [TASK_REQUEST] block (surfaced for user approval)
// rather than fixing it inline or creating a task by calling the CPM API.
const TASK_DELEGATION_PROMPT = `WORK DELEGATION — when to split work into a separate task:
If you discover work that is out of scope for this task (a separate bug, a follow-up, or a common/general problem that isn't specific to what you're doing), do NOT fix it inline and do NOT create a task by calling the CPM API directly. Propose it as a tracked task by emitting a block in this EXACT format, on its own line (not inside a code block):

[TASK_REQUEST]
{"prompt": "detailed, self-contained description of the work to be done"}
[/TASK_REQUEST]

The user is prompted to approve it; an approved request becomes a new task branched from the default branch. If the user asks you to "create a task" for something, that means emitting a [TASK_REQUEST] — never create tasks via the API. To target a different workspace you have access to, add a "targetWorkspace" field (the workspace's name) to the JSON; otherwise it runs in this workspace.`;

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

// ---------------------------------------------------------------------------
// Auto-review (red team)
// ---------------------------------------------------------------------------

const REVIEWER_ALLOWED_TOOLS = 'Read,Glob,Grep,Bash';
const MAX_REVIEW_LOOPS = parseInt(process.env.CPM_REVIEW_MAX_LOOPS || '2', 10);

function remoteReviewerOutputPath(taskId: string): string {
  return `/tmp/cpm-task-${taskId}-review.jsonl`;
}

function remoteReviewerExitCodePath(taskId: string): string {
  return `/tmp/cpm-task-${taskId}-review.exit`;
}

async function worktreeHasChanges(worktreePath: string, workspaceName: string): Promise<boolean> {
  try {
    const out = await sshExec(workspaceName, `git -C ${shellEscape(worktreePath)} status --porcelain 2>/dev/null`, 10000);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

async function getGitDiff(worktreePath: string, workspaceName: string): Promise<string> {
  try {
    const diff = await sshExec(workspaceName, `git -C ${shellEscape(worktreePath)} diff HEAD 2>/dev/null`, 15000);
    const untracked = await sshExec(workspaceName, `git -C ${shellEscape(worktreePath)} ls-files --others --exclude-standard 2>/dev/null`, 10000);
    const parts: string[] = [];
    if (diff.trim()) parts.push(diff.trim());
    if (untracked.trim()) parts.push(`Untracked files:\n${untracked.trim()}`);
    const combined = parts.join('\n\n');
    // Truncate if very large (~8000 tokens ≈ 32000 chars)
    if (combined.length > 32000) {
      return combined.slice(0, 32000) + '\n\n[diff truncated — use Read tool to inspect remaining files]';
    }
    return combined || '(no diff output)';
  } catch {
    return '(could not retrieve diff)';
  }
}

function buildReviewerSystemPrompt(): string {
  return `MANDATORY REVIEW RULES — RED TEAM MODE:

You are a code reviewer who did not write this code. Your job is to find problems the implementer missed, not to confirm that things work.

YOUR ROLE IS READ-ONLY ANALYSIS ONLY. You are one step in an automated pipeline:
- A separate implementer agent wrote the code.
- You review it and emit a structured verdict.
- If you emit "fail", the pipeline automatically routes your issues back to the implementer for fixing. You do NOT fix anything yourself.
- You do NOT ask the user whether to fix anything. You do NOT interact with the user at all. The pipeline handles routing automatically.

Focus on:
- Does the implementation actually fulfill the original task?
- Missing input validation or boundary checks
- Unhandled error paths and edge cases
- Incorrect logic that would produce wrong results under specific conditions
- Missing or wrong tests for critical behaviour
- Security issues (injection, auth gaps, unsafe operations)

Do NOT:
- Praise the implementation
- Describe what the code does (assume the reader knows)
- Create, edit, or delete any files
- Run commands that modify state (no git commits, no writes, no installs)
- Offer to fix issues, ask the user what they want to do, or request any input

You MAY run read-only commands: git diff, git log, git status, cat, grep, find, npm test / go test / pytest (read test results — do not write new test files).

REQUIRED — your response MUST end with exactly this block as the very last line, with no text after it:

REVIEW_DECISION: {"outcome":"pass","summary":"<one sentence>"}
   or
REVIEW_DECISION: {"outcome":"fail","summary":"<one sentence>","issues":["<specific issue>","..."]}

"pass" means: no significant issues found.
"fail" means: specific actionable issues were found. The pipeline will forward your issues list to the implementer — you do not need to do anything else.

This signal is parsed by an automated system — omitting it breaks the pipeline. Do NOT skip it, do NOT ask for confirmation, do NOT add any text after it.`;
}

interface ReviewDecision {
  outcome: 'pass' | 'fail';
  summary: string;
  issues?: string[];
}

function parseReviewDecision(text: string): ReviewDecision | null {
  const match = text.match(/^REVIEW_DECISION:\s*(\{.+\})$/m);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (parsed.outcome !== 'pass' && parsed.outcome !== 'fail') return null;
    return {
      outcome: parsed.outcome,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      issues: Array.isArray(parsed.issues) ? parsed.issues : undefined,
    };
  } catch {
    return null;
  }
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
 * Read new lines from a remote output file and the remote exit-code file in a
 * single SSH round trip, separated by a nonce marker so Claude's output can
 * never be mistaken for the marker.
 *
 * A previous implementation used a fixed marker ("---CPM_EXIT_CHECK---"); when
 * Claude read CPM's own source code, the marker appeared in a tool_result
 * block, and the first indexOf matched the fake marker — corrupting exitPart
 * and triggering a premature task completion with exitCode=NaN.
 */
async function pollOutputAndExit(
  workspaceName: string,
  outputFile: string,
  exitFile: string,
  linesRead: number,
  timeout = 20000,
): Promise<{ jsonPart: string; exitPart: string }> {
  const marker = `---CPM-EXIT-${randomUUID()}---`;
  const command =
    `tail -n +${linesRead + 1} ${shellEscape(outputFile)} 2>/dev/null; ` +
    `echo ${shellEscape(marker)}; ` +
    `cat ${shellEscape(exitFile)} 2>/dev/null || echo 'RUNNING'`;
  const output = await sshExec(workspaceName, command, timeout);
  // Use lastIndexOf as a belt-and-suspenders guard: even in the pathological
  // case where Claude's output echoed the exact nonce, the real marker is
  // always appended after the tail, so the last occurrence wins.
  const markerIdx = output.lastIndexOf(marker);
  if (markerIdx < 0) {
    return { jsonPart: output, exitPart: 'RUNNING' };
  }
  return {
    jsonPart: output.slice(0, markerIdx),
    exitPart: output.slice(markerIdx + marker.length).trim(),
  };
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
          // `head -c <size>` reads exactly `size` bytes then exits cleanly —
          // unlike `cat`, it doesn't depend on stdin EOF, which `coder ssh`
          // does not reliably propagate to the remote side (observed: 5+ min
          // hangs after data fully transferred).
          const proc = spawn('coder', [
            'ssh', workspaceName, '--',
            `head -c ${att.size} > ${shellEscape(remotePath)}`,
          ], {
            env: { ...process.env, CODER_URL },
            stdio: ['pipe', 'ignore', 'pipe'],
          });
          // Belt-and-suspenders timeout in case SSH itself hangs (network /
          // workspace stall). 30s base + ~1ms/KB scales to the 20MB cap.
          const timeoutMs = 30_000 + Math.ceil(att.size / 1024);
          const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error(`File transfer timed out for ${att.original_name} (${att.size} bytes, ${timeoutMs}ms)`));
          }, timeoutMs);
          const fileStream = createReadStream(att.storage_path);
          fileStream.pipe(proc.stdin);
          // Suppress EPIPE if remote closes stdin once it has its bytes —
          // proc.on('close') is authoritative.
          proc.stdin.on('error', () => {});
          fileStream.on('error', (err) => { clearTimeout(timer); proc.kill(); reject(err); });
          proc.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`SCP failed for ${att.original_name} (exit ${code})`));
          });
          proc.on('error', (err) => { clearTimeout(timer); reject(err); });
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

// Per-workspace lock covering any mutation that could spawn a task, kill a
// task, or run git ops on the workspace. All three must serialize to keep
// the "one working task per workspace" invariant honest and avoid racing
// launch vs cancel vs complete.
const workspaceLocks = new Map<string, Promise<unknown>>();

export async function withWorkspaceLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = workspaceLocks.get(workspaceId);
  const run = async (): Promise<T> => {
    if (prev) await prev.catch(() => {});
    return fn();
  };
  const promise = run();
  workspaceLocks.set(workspaceId, promise);
  try {
    return await promise;
  } finally {
    if (workspaceLocks.get(workspaceId) === promise) {
      workspaceLocks.delete(workspaceId);
    }
  }
}

/**
 * Central queue processor. This is the ONLY way tasks get started.
 * Call this whenever the queue state might have changed for a workspace.
 */
export async function processQueue(workspaceId: string): Promise<void> {
  await withWorkspaceLock(workspaceId, async () => {
    // Flush any tasks whose completion was deferred while a task was working.
    let pending = getPendingCompletionTask(workspaceId);
    while (pending) {
      try {
        const allowed = await handleTaskCompletionGit(pending);
        if (allowed) {
          setPendingComplete(pending.id, false);
          updateTaskStatus(pending.id, 'completed');
        } else {
          setPendingComplete(pending.id, false);
          addMessage(pending.id, 'system', 'Queued completion could not proceed — uncommitted changes and remote pushes are disabled. Resolve manually and try again.');
        }
      } catch (err: any) {
        setPendingComplete(pending.id, false);
        addMessage(pending.id, 'system', `Queued completion failed: ${err?.message || err}. Please retry.`);
      }
      pending = getPendingCompletionTask(workspaceId);
    }

    // Launch queued tasks up to the concurrency limit
    const maxConcurrent = getMaxConcurrent(workspaceId);
    while (true) {
      const workingCount = getWorkingTaskCount(workspaceId);
      if (workingCount >= maxConcurrent) break;

      const next = getNextQueuedTask(workspaceId);
      if (!next) break;

      // Detect resume-pending task (was awaiting_feedback, user replied, got re-queued)
      if (next.claude_session_id) {
        const msgs = getMessages(next.id);
        const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
        if (lastMsg && lastMsg.role === 'user' && msgs.some(m => m.role === 'assistant')) {
          await launchTask(next, true, lastMsg.content);
          continue;
        }
      }

      await launchTask(next);
    }
  });
}

/**
 * Launch a task on its remote workspace via a long-lived SSH connection.
 *
 * Uses detached: true + stdio: 'ignore' so the SSH process survives server restarts.
 * Output is written directly to a remote file which we poll via startFilePolling().
 */
async function launchTask(task: Task, isResume = false, feedback?: string): Promise<void> {
  const rawPrompt = isResume && feedback ? feedback : task.prompt;

  // Slash commands (e.g. /compact) must reach Claude Code as the bare prompt —
  // skip all prepends/appends so the harness recognizes the command.
  const isSlashCommand = isResume && !!feedback && rawPrompt.startsWith('/') && !rawPrompt.includes('\n');

  // Allocate port range for new tasks before building prompts/system messages —
  // the coderUrlNote and portNote below both read task.port_range_start.
  if (!isResume && (task.port_range_start === null || task.port_range_start === undefined)) {
    const allocated = allocatePortRange(task.workspace_id);
    if (allocated !== null) {
      getDb().prepare('UPDATE tasks SET port_range_start = ? WHERE id = ?').run(allocated, task.id);
      task.port_range_start = allocated;
      console.log(`[claude-executor] Allocated port range ${allocated}-${allocated + PORT_RANGE_SIZE - 1} for task ${task.id}`);
    }
  }

  // Append instruction for the agent to provide Coder deep links
  // Use VSCODE_PROXY_URI if available (has the exact pattern), otherwise build from parts
  const proxyUri = process.env.VSCODE_PROXY_URI || '';
  // VSCODE_PROXY_URI is baked with CPM's own workspace name. If the task targets a
  // different workspace, swap that segment so the preview URL points at the right host.
  const proxyUriForTask = (() => {
    if (!proxyUri || !LOCAL_WORKSPACE_NAME || !task.workspace_name) return proxyUri;
    if (task.workspace_name.toLowerCase() === LOCAL_WORKSPACE_NAME.toLowerCase()) return proxyUri;
    // Coder's wildcard host is case-insensitive and canonically lowercased, but
    // CODER_WORKSPACE_NAME may be cased differently than the baked proxy segment,
    // so match case-insensitively and emit the target name lowercased.
    const escaped = LOCAL_WORKSPACE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return proxyUri.replace(new RegExp(`--${escaped}--`, 'i'), `--${task.workspace_name.toLowerCase()}--`);
  })();
  const portStart = task.port_range_start ?? null;
  const portEnd = portStart !== null ? portStart + PORT_RANGE_SIZE - 1 : null;
  let coderUrlNote = '';
  if (!isSlashCommand && proxyUriForTask) {
    // VSCODE_PROXY_URI looks like: https://{{port}}--main--Workspace--user.coder.example.com
    if (portStart !== null) {
      const previewUrl = proxyUriForTask.replace('{{port}}', String(portStart));
      coderUrlNote = `\n\nIMPORTANT: Only if your changes result in something visually testable in a browser (e.g. a webapp UI change), ` +
        `provide a deep link URL where the change can be seen. Do NOT include a "view live" link for backend-only changes, ` +
        `config changes, refactors, or other non-visual work. ` +
        `This project runs inside a Coder workspace, so use Coder-routed URLs (not localhost). ` +
        `This task runs in a dedicated git worktree with ports ${portStart}–${portEnd} reserved for it. ` +
        `Bind any dev/preview server you start to a port in that range (the env var $PORT is already set to ${portStart}). ` +
        `Do NOT use default ports like 3000 or 5173 — those belong to the main checkout and would show the user main's preview, not yours. ` +
        `Your primary preview URL is: ${previewUrl} (substitute another port from your range if you bind multiple services).`;
    } else {
      const coderUrlNote_example = proxyUriForTask.replace('{{port}}', 'PORT');
      coderUrlNote = `\n\nIMPORTANT: Only if your changes result in something visually testable in a browser (e.g. a webapp UI change), ` +
        `provide a deep link URL where the change can be seen. Do NOT include a "view live" link for backend-only changes, ` +
        `config changes, refactors, or other non-visual work. ` +
        `This project runs inside a Coder workspace, so use Coder-routed URLs (not localhost). ` +
        `For web apps, use the Coder port-forwarding URL format: ${coderUrlNote_example} (replace PORT with the actual port number, e.g. 5173 for Vite).`;
    }
  } else if (!isSlashCommand && CODER_URL) {
    if (portStart !== null) {
      coderUrlNote = `\n\nIMPORTANT: Only if your changes result in something visually testable in a browser (e.g. a webapp UI change), ` +
        `provide a deep link URL where the change can be seen. Do NOT include a "view live" link for backend-only changes, ` +
        `config changes, refactors, or other non-visual work. ` +
        `This project runs inside a Coder workspace, so use Coder-routed URLs (not localhost). ` +
        `This task runs in a dedicated git worktree with ports ${portStart}–${portEnd} reserved for it. ` +
        `Bind any dev/preview server to a port in that range (env var $PORT is set to ${portStart}). ` +
        `Do NOT use default ports like 3000 or 5173 — those belong to the main checkout. ` +
        `The Coder access URL is: ${CODER_URL}. The workspace name is: ${task.workspace_name}.`;
    } else {
      coderUrlNote = `\n\nIMPORTANT: Only if your changes result in something visually testable in a browser (e.g. a webapp UI change), ` +
        `provide a deep link URL where the change can be seen. Do NOT include a "view live" link for backend-only changes, ` +
        `config changes, refactors, or other non-visual work. ` +
        `This project runs inside a Coder workspace, so use Coder-routed URLs (not localhost). ` +
        `The Coder access URL is: ${CODER_URL}. The workspace name is: ${task.workspace_name}.`;
    }
  }
  let prompt = rawPrompt + coderUrlNote;

  // Host's Claude session does not contain participant messages — inject them
  // as catch-up context so the host can see what invited agents have said.
  if (!isSlashCommand) {
    const taskParticipants = getTaskParticipants(task.id);
    if (taskParticipants.length > 0) {
      const hostCatchUp = buildTaskParticipantContext(task.id, '__host__');
      if (hostCatchUp) prompt = hostCatchUp + '\n' + prompt;
    }
  }

  // Auto-detect project directory if not already set
  if (!task.project_dir) {
    const detected = await detectProjectDir(task.workspace_name);
    if (detected) {
      task.project_dir = detected;
      getDb().prepare('UPDATE tasks SET project_dir = ? WHERE id = ?').run(detected, task.id);
    }
  }

  // Git: worktree creation on launch, no-op on resume
  if (isResume) {
    await handleTaskResumeGit(task);
  } else {
    await handleTaskLaunchGit(task);
  }

  // Transfer any attached files to the remote workspace (skip for slash commands)
  const attachments = isSlashCommand ? [] : getAttachmentsByTask(task.id);
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

  // Use --resume only when the current session_id has actually been created
  // by a prior Claude run. After a session reset, session_initialized=0 forces
  // --session-id (creates a fresh session on disk) even though we have a
  // user-supplied continuation message.
  //
  // The session_initialized flag alone is not enough: the session .jsonl can
  // disappear from the workspace (rebuild, ~/.claude cleared, etc.) even though
  // the DB still says initialized. Resuming a missing session makes Claude exit
  // with "No conversation found with session ID", which surfaced when reopening
  // tasks. Verify the file exists on the workspace first (as discussions do) and
  // fall back to --session-id so the turn starts a fresh session in place.
  let canResume = isResume && !!task.claude_session_id && task.session_initialized !== 0;
  if (canResume) {
    try {
      const found = await sshExec(task.workspace_name,
        `find ~/.claude/projects/ -name '${task.claude_session_id!.replace(/[^a-zA-Z0-9-]/g, '')}.jsonl' 2>/dev/null | head -1`
      );
      if (!found.trim()) {
        canResume = false;
        console.warn(`[claude-executor] Session ${task.claude_session_id} not found on ${task.workspace_name}; starting fresh session (CPM history preserved)`);
        addMessage(task.id, 'system', 'The previous Claude session was not found on the workspace, so a new session was started. Your task history here is preserved, but the agent does not retain the earlier conversation context.');
      }
    } catch {
      // Non-fatal — if the check itself fails, fall through to --resume and let
      // Claude report any real error rather than silently dropping context.
    }
  }
  if (canResume) {
    claudeParts.push('--resume', shellEscape(task.claude_session_id!));
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

  // Port range instruction — tell agent which ports to use
  if (!isSlashCommand && portStart !== null && proxyUriForTask) {
    const previewUrl = proxyUriForTask.replace('{{port}}', String(portStart));
    const portNote = `This task runs in a dedicated git worktree. Use ports ${portStart}–${portEnd} for any services you start — do not use default ports like 3000 or 5173 (those are reserved). Your primary preview URL is: ${previewUrl}`;
    claudeParts.push('--append-system-prompt', shellEscape(portNote));
  }

  // CPM owns git when remote pushes are enabled — tell the agent to stay out
  // of branching/committing so completion's fresh-branch+PR+merge flow works.
  if (isRemoteAllowed(task.workspace_id)) {
    claudeParts.push('--append-system-prompt', shellEscape(CPM_GIT_OWNERSHIP_PROMPT));
  }

  if (!isSlashCommand) {
    claudeParts.push('--append-system-prompt', shellEscape(TASK_DELEGATION_PROMPT));
  }

  claudeParts.push('--append-system-prompt', shellEscape(HARNESS_REMINDER_NOTE));

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

  // Expose port range to the agent
  if (task.port_range_start !== null && task.port_range_start !== undefined) {
    const portEnd = task.port_range_start + PORT_RANGE_SIZE - 1;
    remoteCmd += `export PORT=${task.port_range_start} CPM_PORT_RANGE="${task.port_range_start}-${portEnd}" && `;
  }

  const workDir = task.worktree_path || task.project_dir;
  if (workDir) {
    remoteCmd += `cd ${shellEscape(workDir)} && `;
  }
  // Exit file was archived to .prev above; rm -f is idempotent as a second
  // layer in case the archive SSH failed.
  remoteCmd += `rm -f ${shellEscape(exitFile)} && `;
  remoteCmd += `${claudeCmd} > ${shellEscape(outputFile)} 2>&1; `;
  remoteCmd += `echo $? > ${shellEscape(exitFile)}`;

  console.log('[claude-executor] Launching on workspace:', task.workspace_name);
  console.log('[claude-executor] Project dir:', (task.worktree_path || task.project_dir) || '(none - home dir)');
  console.log('[claude-executor] Model:', task.model || '(default)', isOllama ? `→ Ollama (${actualModel})` : '');
  console.log('[claude-executor] Remote cmd:', remoteCmd.slice(0, 300));

  try {
    // Re-read status immediately before we commit to spawning. If the task
    // was cancelled/deleted between the caller's check and here, bail out
    // instead of creating an orphan working row + SSH process.
    const current = getTask(task.id);
    if (!current || current.status === 'cancelled' || current.status === 'completed') {
      console.log(`[claude-executor] Task ${task.id} no longer launchable (status=${current?.status ?? 'deleted'}); aborting`);
      return;
    }
    // Fail fast if the workspace is already at the concurrency limit.
    // The workspace lock should prevent this, but the DB is the source of truth.
    const workingCount = getWorkingTaskCount(task.workspace_id);
    const maxConcurrent = getMaxConcurrent(task.workspace_id);
    if (workingCount >= maxConcurrent) {
      console.log(`[claude-executor] Refusing to launch ${task.id}: workspace at concurrency limit ${maxConcurrent}`);
      return;
    }

    updateTaskStatus(task.id, 'working');
    setActiveTaskTurnRole(task.id, 'implementer');
    taskActivity.set(task.id, { timestamp: new Date().toISOString(), summary: 'Starting Claude session' });

    // Archive the previous run's output/exit to .prev before spawning SSH.
    // Archiving (not deleting) preserves the prior turn's content for forensic
    // recovery if parsing failed the first time — e.g. a marker-collision bug
    // that drops the final turn from the DB but leaves it on disk.
    try {
      await sshExec(task.workspace_name,
        `mv -f ${shellEscape(outputFile)} ${shellEscape(outputFile + '.prev')} 2>/dev/null; ` +
        `mv -f ${shellEscape(exitFile)} ${shellEscape(exitFile + '.prev')} 2>/dev/null; true`,
      );
    } catch {
      // Non-fatal — the remote command will also overwrite
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

    // Once the launch has spawned, the session_id will be (or already is)
    // committed on disk by Claude, so subsequent turns can safely --resume.
    if (task.session_initialized === 0) {
      markSessionInitialized(task.id);
    }

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
 * Resume a task that is awaiting feedback. Must hold the workspace lock
 * so it can't race against processQueue spawning a different task on the
 * same workspace.
 */
export async function resumeTask(task: Task, feedback: string): Promise<void> {
  await withWorkspaceLock(task.workspace_id, async () => {
    // Re-check the task is still awaiting feedback under the lock
    const current = getTask(task.id);
    if (!current || current.status !== 'awaiting_feedback') return;

    // If at concurrency limit, re-queue to be picked up when a slot frees
    const workingCount = getWorkingTaskCount(task.workspace_id);
    const maxConcurrent = getMaxConcurrent(task.workspace_id);
    if (workingCount >= maxConcurrent) {
      updateTaskStatus(task.id, 'queued');
      return;
    }

    await launchTask(task, true, feedback);
  });
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

export function cancelTask(taskId: string): void {
  const db = getDb();
  const task = db.prepare("SELECT id, workspace_name, ssh_pid, claude_session_id FROM tasks WHERE id = ?")
    .get(taskId) as { id: string; workspace_name: string; ssh_pid: number | null; claude_session_id: string | null } | undefined;
  if (task) {
    killTaskProcess(task.id, task.ssh_pid, task.workspace_name, task.claude_session_id);
  }
}

/**
 * Interrupt a running task — kills the process but transitions to awaiting_feedback
 * so the user can continue the conversation (like Ctrl+C in the CLI).
 */
export function interruptTask(taskId: string): void {
  const db = getDb();
  const partial = db.prepare("SELECT id, workspace_name, ssh_pid, claude_session_id FROM tasks WHERE id = ? AND status = 'working'")
    .get(taskId) as { id: string; workspace_name: string; ssh_pid: number | null; claude_session_id: string | null } | undefined;

  if (partial) {
    killTaskProcess(partial.id, partial.ssh_pid, partial.workspace_name, partial.claude_session_id);
    addMessage(partial.id, 'system',
      'Task was interrupted by user. Note: token usage and cost for the in-flight turn may not be fully reflected — Claude only reports final totals at the end of a turn.'
    );
    updateTaskStatus(partial.id, 'awaiting_feedback');
  }
}

/** Kill the SSH process for a task and clean up tracking state. */
function killTaskProcess(
  taskId: string,
  sshPid: number | null,
  workspaceName?: string,
  claudeSessionId?: string | null,
): void {
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

  // Remote fallback: killing the local SSH client doesn't guarantee the
  // remote `claude` process dies (detached/background). Pkill on the
  // workspace using the unique session-id to scope precisely to this task.
  if (workspaceName && claudeSessionId) {
    const pattern = claudeSessionId.replace(/[^a-zA-Z0-9-]/g, '');
    if (pattern.length >= 8) {
      sshExec(workspaceName, `pkill -f ${pattern} || true`, 10000)
        .catch(err => console.error(`[kill] Remote pkill failed for task ${taskId}:`, (err as Error).message?.slice(0, 120)));
    }
  }
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
        addMessage(task.id, 'system', 'Server restarted while task was running — reconnecting to remote session. Any assistant output produced during the restart will be reloaded from the remote output file.');
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
            const { resultError } = await processRemainingOutput(task);
            const exitCode = parseInt(exitCheck, 10);
            if (resultError) {
              addMessage(task.id, 'system', `Error: ${resultError}`);
              updateTaskStatus(task.id, 'failed', resultError);
            } else if (exitCode === 0 || isNaN(exitCode)) {
              // Only transition to awaiting_feedback if we actually captured a response
              const hasResponse = getMessages(task.id).some(m => m.role === 'assistant');
              if (hasResponse) {
                updateTaskStatus(task.id, 'awaiting_feedback');
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
            // SSH process gone with no exit code. The CLI may have hung post-result
            // (Claude finished, but a child held stdout open). Read whatever output
            // is on disk — if a `result` event is present, finalize like a normal
            // completion. Only re-queue if Claude truly produced nothing.
            const { resultSeen, resultError } = await processRemainingOutput(task);
            if (resultSeen) {
              if (resultError) {
                console.log(`[recovery] Task "${task.title}" result event has error — failing`);
                addMessage(task.id, 'system', `Error: ${resultError}`);
                updateTaskStatus(task.id, 'failed', resultError);
              } else {
                console.log(`[recovery] Task "${task.title}" produced a result before SSH died — finalizing as awaiting_feedback`);
                updateTaskStatus(task.id, 'awaiting_feedback');
              }
            } else {
              console.log(`[recovery] Task "${task.title}" SSH process gone, no exit code, no result — re-queuing for automatic retry`);
              addMessage(task.id, 'system', 'Server restarted while this task was running. Re-queued for automatic retry.');
              updateTaskStatus(task.id, 'queued');
            }
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

  const db = getDb();
  // Deferred wipe: stream_log + current-session messages are cleared only
  // after the first poll confirms ≥1 parseable event, and the wipe + reparse
  // happen in a single transaction so a crash mid-way rolls back to prior state.
  let wiped = false;

  let linesRead = 0;
  let lastSavedMessageId: string | null = null;
  let lastSavedMessageText: string | null = null;
  let resultError: string | null = null;
  let consecutiveErrors = 0;
  let lastPollError = '';
  let partialLine = '';  // Buffer for incomplete last line from previous poll
  let polling = false;   // Guard against overlapping polls
  let finalized = false; // Set once we've transitioned status (via result event or exit code)
  let resultSeen = false; // Set when we observe Claude's terminal `result` event

  // Per-line processor — extracted so the first poll can run it inside the
  // wipe+reparse transaction without duplicating logic.
  const processLine = (line: string): void => {
    linesRead++;
    if (!line.trim()) return;

    let event: { type: string; [key: string]: unknown };
    try {
      event = JSON.parse(line);
    } catch {
      // Not valid JSON (e.g. stderr output), skip
      return;
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
          parseTaskRequestsForTask(task, turnText);
        }
      }

      if (event.type === 'result') {
        const fatal = extractFatalError(event);
        const resultText = extractResultText(event);
        // For non-error results, save the result text as an assistant message
        // (when distinct from the last). For errors, skip — finalizeTask will
        // write a structured system message instead of leaking the raw error
        // string as a confusing "assistant said: Prompt is too long" entry.
        if (!fatal && resultText && resultText !== lastSavedMessageText) {
          const msg = addMessage(task.id, 'assistant', resultText, event.total_cost_usd as number | undefined);
          lastSavedMessageId = msg.id;
          lastSavedMessageText = resultText;
          parseTaskRequestsForTask(task, resultText);
        } else if (typeof event.total_cost_usd === 'number' && lastSavedMessageId) {
          updateMessageCost(lastSavedMessageId, event.total_cost_usd);
        }
        const { inputTokens: inTok, outputTokens: outTok } = extractTokenUsage(event);
        if (inTok > 0 || outTok > 0) {
          addTokenUsage(task.id, inTok, outTok);
        }
        if (fatal) resultError = fatal;
        resultSeen = true;
      }
    } catch (eventErr) {
      console.error(`[claude-poller] Error processing event for task ${task.id}:`, (eventErr as Error).message?.slice(0, 200));
    }
  };

  const poll = async () => {
    if (polling) return;  // Previous poll still in flight — skip
    polling = true;
    try {
      const outputFile = remoteOutputPath(task.id);
      const exitFile = remoteExitCodePath(task.id);

      const { jsonPart, exitPart } = await pollOutputAndExit(
        task.workspace_name, outputFile, exitFile, linesRead,
      );

      consecutiveErrors = 0;

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

        if (!wiped) {
          // Staging check: don't wipe existing DB state until we have ≥1
          // parseable event to replace it with. If the remote file is empty,
          // stderr-only, or the SSH call returned garbage, keep prior state
          // and retry next poll.
          let hasValidEvent = false;
          for (const line of allLines) {
            if (!line.trim()) continue;
            try { JSON.parse(line); hasValidEvent = true; break; } catch { continue; }
          }
          if (!hasValidEvent) {
            // Restore buffer; do NOT advance linesRead; do NOT wipe.
            partialLine = fullData;
          } else {
            // Atomic wipe + reparse: rolls back if any insert throws.
            db.transaction(() => {
              db.prepare('DELETE FROM stream_log WHERE task_id = ?').run(task.id);
              deleteCurrentSessionAssistantMessages(task.id);
              for (const line of allLines) processLine(line);
            })();
            wiped = true;
          }
        } else {
          // Normal incremental path after first successful wipe.
          for (const line of allLines) processLine(line);
        }
      }

      // Finalize on `result` event arrival — Claude has logically finished even
      // if the OS process hasn't exited yet (e.g. lingering subprocess holds the
      // stdout pipe open, blocking exit). Don't wait for the exit code.
      if (resultSeen && !finalized) {
        finalized = true;
        console.log(`[claude-poller] Task ${task.id} finalized via result event`);
        finalizeTask(task, resultError);
      } else if (exitPart !== 'RUNNING' && exitPart !== '' && !finalized) {
        const exitCode = parseInt(exitPart, 10);
        if (isNaN(exitCode)) {
          // Non-numeric exit content means something went wrong reading the
          // exit file (corruption, partial write, or — historically — a
          // marker collision). Treat as still running; a later poll resolves.
          console.warn(`[claude-poller] Task ${task.id} got non-numeric exit content (${exitPart.slice(0, 60)}) — continuing to poll`);
          return;
        }
        finalized = true;
        console.log(`[claude-poller] Task ${task.id} finished with exit code ${exitCode} (no result event)`);
        stopPolling(task.id);
        taskActivity.delete(task.id);
        getDb().prepare('UPDATE tasks SET ssh_pid = NULL WHERE id = ?').run(task.id);

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
        } else if (exitCode === 0) {
          const hasResponse = getMessages(task.id).some(m => m.role === 'assistant');
          if (hasResponse) {
            updateTaskStatus(task.id, 'awaiting_feedback');
          } else {
            console.log(`[claude-poller] Task ${task.id} finished with no response — re-queuing`);
            addMessage(task.id, 'system', 'Claude exited without producing a response. Re-queued for automatic retry.');
            updateTaskStatus(task.id, 'queued');
          }
        } else {
          const errorMsg = `Claude exited with code ${exitCode}`;
          addMessage(task.id, 'system', `Error: ${errorMsg}`);
          updateTaskStatus(task.id, 'failed', errorMsg);
        }

        processQueue(task.workspace_id).catch(() => {});
      }
    } catch (err) {
      consecutiveErrors++;
      lastPollError = (err as Error).message?.slice(0, 300) || String(err);
      console.log(`[claude-poller] Error polling task ${task.id} (${consecutiveErrors}):`, lastPollError.slice(0, 100));

      if (consecutiveErrors > 20) {
        console.log(`[claude-poller] Too many errors, marking task ${task.id} as failed`);
        stopPolling(task.id);
        taskActivity.delete(task.id);
        const reason = lastPollError
          ? `Lost connection to workspace: ${lastPollError}`
          : 'Lost connection to workspace';
        addMessage(task.id, 'system', `Error: ${reason}`);
        updateTaskStatus(task.id, 'failed', reason);
      }
    } finally {
      polling = false;
    }
  };

  const interval = setInterval(poll, 5000);
  activePollers.set(task.id, interval);
  poll();
}

/**
 * Called after the implementer turn completes successfully. Decides whether
 * to launch the reviewer or transition directly to awaiting_feedback.
 */
async function onImplementerTurnComplete(task: Task): Promise<void> {
  const current = getTask(task.id);
  if (!current) return;

  // No auto-review: check the flag, and also skip if no worktree (pre-worktrees task)
  if (!current.auto_review || !current.worktree_path) {
    setActiveTaskTurnRole(task.id, null);
    updateTaskStatus(task.id, 'awaiting_feedback');
    processQueue(task.workspace_id).catch(() => {});
    return;
  }

  const hasChanges = await worktreeHasChanges(current.worktree_path, current.workspace_name);

  if (!hasChanges) {
    // Worktree clean — skip review (discussion/speccing turn or stuck loop)
    const wasLooping = current.review_loop_count > 0;
    if (wasLooping) {
      // Implementer ran after a failed review but made no changes — escalate
      const latestTurn = getTaskTurns(task.id).filter(t => t.role === 'reviewer').pop();
      const issues = latestTurn?.review_issues ? (JSON.parse(latestTurn.review_issues) as string[]) : [];
      const issueList = issues.map((s, i) => `${i + 1}. ${s}`).join('\n');
      addMessage(task.id, 'system',
        `Auto-review escalated: the implementer made no changes after reviewer feedback.\n\nUnresolved issues:\n${issueList || '(see reviewer output above)'}`
      );
    }
    setActiveTaskTurnRole(task.id, null);
    updateTaskStatus(task.id, 'awaiting_feedback');
    processQueue(task.workspace_id).catch(() => {});
    return;
  }

  // Changes detected — launch reviewer
  await launchReviewerOnTask(current);
}

/**
 * Launch a read-only reviewer Claude instance for a task.
 * The reviewer runs a fresh session, sees the git diff, and emits a
 * REVIEW_DECISION line that the server parses to determine next action.
 */
async function launchReviewerOnTask(task: Task): Promise<void> {
  const reviewerSessionId = randomUUID();
  const turn = createTaskTurn({
    taskId: task.id,
    role: 'reviewer',
    claudeSessionId: reviewerSessionId,
    filesChanged: 1,
  });

  setActiveTaskTurnRole(task.id, 'reviewer');
  appendStreamLog(task.id, 'reviewer_start', `Reviewer turn ${turn.turn_number} starting`);

  const gitDiff = await getGitDiff(task.worktree_path!, task.workspace_name);

  const reviewerPrompt = `Original task:\n${task.prompt}\n\nChanges made by the implementer:\n${gitDiff}`;

  const claudeParts: string[] = [];
  claudeParts.push('claude');
  claudeParts.push('-p', shellEscape(reviewerPrompt));
  claudeParts.push('--session-id', shellEscape(reviewerSessionId));
  claudeParts.push('--output-format', 'stream-json');
  claudeParts.push('--verbose');
  claudeParts.push('--allowedTools', shellEscape(REVIEWER_ALLOWED_TOOLS));
  claudeParts.push('--max-turns', '20');
  if (task.model && !task.model.startsWith('ollama/')) {
    claudeParts.push('--model', shellEscape(task.model));
  }
  claudeParts.push('--append-system-prompt', shellEscape(buildReviewerSystemPrompt()));
  claudeParts.push('--append-system-prompt', shellEscape(HARNESS_REMINDER_NOTE));

  const claudeCmd = claudeParts.join(' ');
  const outputFile = remoteReviewerOutputPath(task.id);
  const exitFile = remoteReviewerExitCodePath(task.id);

  let remoteCmd = 'export PATH="$HOME/.local/bin:$PATH" && ';
  const workDir = task.worktree_path || task.project_dir;
  if (workDir) {
    remoteCmd += `cd ${shellEscape(workDir)} && `;
  }
  remoteCmd += `rm -f ${shellEscape(outputFile)} ${shellEscape(exitFile)} && `;
  remoteCmd += `${claudeCmd} > ${shellEscape(outputFile)} 2>&1; `;
  remoteCmd += `echo $? > ${shellEscape(exitFile)}`;

  console.log(`[auto-review] Launching reviewer for task ${task.id} (turn ${turn.turn_number})`);

  try {
    const sshProcess = isLocalWorkspace(task.workspace_name)
      ? spawn('bash', ['-c', remoteCmd], { env: { ...process.env }, stdio: 'ignore', detached: true })
      : spawn('coder', ['ssh', task.workspace_name, '--', remoteCmd], {
          env: { ...process.env, CODER_URL },
          stdio: 'ignore',
          detached: true,
        });

    sshProcess.unref();
    startReviewerPolling(task, turn.id, reviewerSessionId);
  } catch (err) {
    const errorMsg = (err as Error).message || 'Failed to launch reviewer';
    console.error('[auto-review] Launch failed:', errorMsg);
    completeTaskTurn(turn.id, 'fail', `Reviewer launch failed: ${errorMsg}`);
    setActiveTaskTurnRole(task.id, null);
    updateTaskStatus(task.id, 'awaiting_feedback');
    processQueue(task.workspace_id).catch(() => {});
  }
}

function startReviewerPolling(task: Task, turnId: string, reviewerSessionId: string): void {
  const pollKey = `review:${task.id}`;
  stopPolling(pollKey);

  let linesRead = 0;
  let partialLine = '';
  let polling = false;
  let finalized = false;
  let allAssistantText = '';

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const outputFile = remoteReviewerOutputPath(task.id);
      const exitFile = remoteReviewerExitCodePath(task.id);
      const { jsonPart, exitPart } = await pollOutputAndExit(task.workspace_name, outputFile, exitFile, linesRead);

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
          try { event = JSON.parse(line); } catch { continue; }

          if (event.type === 'assistant' && (event.message as { content?: unknown })?.content) {
            let turnText = '';
            for (const block of (event.message as { content: Array<{ type: string; text?: string }> }).content) {
              if (block.type === 'text' && block.text) turnText += block.text;
            }
            if (turnText) {
              allAssistantText += turnText;
              addMessage(task.id, 'assistant', turnText, undefined, undefined, undefined, undefined, undefined, turnId);
              appendStreamLog(task.id, 'reviewer_output', `[Reviewer] ${turnText.slice(0, 200)}`);
            }
          } else if (event.type === 'tool_use') {
            const block = event as { name?: string };
            appendStreamLog(task.id, 'tool_use', `[Reviewer] ${block.name || 'tool'}`);
          } else if (event.type === 'result') {
            const resultText = extractResultText(event);
            if (resultText && resultText !== allAssistantText.slice(-resultText.length)) {
              allAssistantText += resultText;
              addMessage(task.id, 'assistant', resultText, event.total_cost_usd as number | undefined, undefined, undefined, undefined, undefined, turnId);
            }
            const { inputTokens, outputTokens } = extractTokenUsage(event);
            if (inputTokens > 0 || outputTokens > 0) addTokenUsage(task.id, inputTokens, outputTokens);
          }
        }
      }

      const done = exitPart !== 'RUNNING' && exitPart !== '';
      if (done && !finalized) {
        finalized = true;
        stopPolling(pollKey);
        finalizeReviewer(task, turnId, allAssistantText);
      }
    } catch (err) {
      console.error(`[auto-review] Poll error for task ${task.id}:`, (err as Error).message?.slice(0, 100));
    } finally {
      polling = false;
    }
  };

  const interval = setInterval(poll, 3000) as unknown as NodeJS.Timeout;
  activePollers.set(pollKey, interval);
  poll();
}

function finalizeReviewer(task: Task, turnId: string, allText: string): void {
  const current = getTask(task.id);
  if (!current) return;

  const decision = parseReviewDecision(allText);

  if (!decision) {
    console.warn(`[auto-review] No REVIEW_DECISION found for task ${task.id} — surfacing to user`);
    completeTaskTurn(turnId, 'fail', 'Reviewer did not produce a structured decision');
    addMessage(task.id, 'system',
      "The reviewer completed its check but did not emit a structured verdict. See the reviewer's response above — proceed when ready or reply to ask for clarification.");
    resetReviewLoopCount(task.id);
    setActiveTaskTurnRole(task.id, null);
    updateTaskStatus(task.id, 'awaiting_feedback');
    processQueue(task.workspace_id).catch(() => {});
    return;
  }

  completeTaskTurn(turnId, decision.outcome, decision.summary, decision.issues);
  appendStreamLog(task.id, decision.outcome === 'pass' ? 'reviewer_pass' : 'reviewer_fail',
    `[Reviewer] ${decision.outcome.toUpperCase()}: ${decision.summary}`);

  if (decision.outcome === 'pass') {
    console.log(`[auto-review] Task ${task.id} reviewer passed`);
    resetReviewLoopCount(task.id);
    setActiveTaskTurnRole(task.id, null);
    updateTaskStatus(task.id, 'awaiting_feedback');
    processQueue(task.workspace_id).catch(() => {});
    return;
  }

  // Reviewer failed — check loop limit
  incrementReviewLoopCount(task.id);
  const refreshed = getTask(task.id);
  if (!refreshed) return;

  if (refreshed.review_loop_count >= MAX_REVIEW_LOOPS) {
    escalateToUser(refreshed, decision.issues ?? [decision.summary]);
    return;
  }

  // Send issues back to the implementer as a new resume turn
  const issueList = (decision.issues ?? [decision.summary])
    .map((s, i) => `${i + 1}. ${s}`)
    .join('\n');
  const retryPrompt = `The reviewer found the following issues with your previous implementation:\n\n${issueList}\n\nPlease address these issues. Original task:\n${task.prompt}`;

  addMessage(task.id, 'system', `Auto-review found issues — resuming implementer:\n${issueList}`);
  setActiveTaskTurnRole(task.id, 'implementer');
  launchTask(refreshed, true, retryPrompt).catch(err => {
    console.error(`[auto-review] Failed to re-launch implementer for task ${task.id}:`, (err as Error).message?.slice(0, 200));
    setActiveTaskTurnRole(task.id, null);
    updateTaskStatus(task.id, 'awaiting_feedback');
    processQueue(task.workspace_id).catch(() => {});
  });
}

function escalateToUser(task: Task, issues: string[]): void {
  const issueList = issues.map((s, i) => `${i + 1}. ${s}`).join('\n');
  addMessage(task.id, 'system',
    `Auto-review reached the loop limit (${MAX_REVIEW_LOOPS} passes) without resolving all issues. Your input is needed.\n\nUnresolved issues:\n${issueList}`
  );
  resetReviewLoopCount(task.id);
  setActiveTaskTurnRole(task.id, null);
  updateTaskStatus(task.id, 'awaiting_feedback');
  processQueue(task.workspace_id).catch(() => {});
}

/**
 * Transition a task to its terminal state and kick the queue.
 *
 * Called when Claude emits a `result` event — at that point Claude has
 * logically finished even if the OS process hasn't exited yet (e.g. a child
 * shell holds the stdout pipe open). We kill the lingering SSH process so the
 * remote command isn't stranded, then move the task forward.
 */
function finalizeTask(task: Task, resultError: string | null): void {
  const db = getDb();
  // Read the latest ssh_pid before we clear it, so killTaskProcess can target it.
  const row = db.prepare('SELECT ssh_pid FROM tasks WHERE id = ?').get(task.id) as { ssh_pid: number | null } | undefined;
  killTaskProcess(task.id, row?.ssh_pid ?? null);

  const rlInfo = rateLimitInfo.get(task.id);
  rateLimitInfo.delete(task.id);
  const isRateLimited = rlInfo && rlInfo.resetsAt * 1000 > Date.now();

  if (isRateLimited) {
    const resetTime = new Date(rlInfo!.resetsAt * 1000).toISOString();
    addMessage(task.id, 'system', `Rate limited — resets at ${resetTime}`);
    setActiveTaskTurnRole(task.id, null);
    updateTaskStatus(task.id, 'failed', `rate_limited:${rlInfo!.resetsAt}`);
    cleanupPortRange(task).catch(() => {});
    processQueue(task.workspace_id).catch(() => {});
  } else if (resultError) {
    addMessage(task.id, 'system', `Error: ${resultError}`);
    setActiveTaskTurnRole(task.id, null);
    updateTaskStatus(task.id, 'failed', resultError);
    cleanupPortRange(task).catch(() => {});
    processQueue(task.workspace_id).catch(() => {});
  } else {
    const hasResponse = getMessages(task.id).some(m => m.role === 'assistant');
    if (hasResponse) {
      onImplementerTurnComplete(task).catch(err => {
        console.error(`[auto-review] Error in post-implementer hook for task ${task.id}:`, (err as Error).message?.slice(0, 200));
        setActiveTaskTurnRole(task.id, null);
        updateTaskStatus(task.id, 'awaiting_feedback');
        processQueue(task.workspace_id).catch(() => {});
      });
    } else {
      console.log(`[claude-poller] Task ${task.id} finalized with no response — re-queuing`);
      addMessage(task.id, 'system', 'Claude exited without producing a response. Re-queued for automatic retry.');
      setActiveTaskTurnRole(task.id, null);
      updateTaskStatus(task.id, 'queued');
      processQueue(task.workspace_id).catch(() => {});
    }
  }
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

export const CONTEXT_WINDOW_ERROR_PREFIX = 'context_window_exceeded:';

/**
 * Extract a fatal error from a result event. Handles both shapes:
 * - `is_error: true` with an `errors[]` array (older / normal CLI errors)
 * - `is_error: true` with no errors array, where the failure message is in the
 *   `result` field itself (e.g. API 400s like "Prompt is too long")
 *
 * Returns null if the result event is not an error.
 *
 * Context-window failures are tagged with CONTEXT_WINDOW_ERROR_PREFIX so the UI
 * can offer a session-reset recovery path instead of showing a generic error.
 */
function extractFatalError(event: { [key: string]: unknown }): string | null {
  if (!event.is_error) return null;
  const errors = Array.isArray(event.errors) ? (event.errors as string[]) : [];
  let errMsg = errors.length > 0 ? errors.join('; ') : extractResultText(event);
  if (!errMsg) return null;
  if (/prompt is too long|input is too long|context.*length|too many tokens/i.test(errMsg)) {
    return `${CONTEXT_WINDOW_ERROR_PREFIX}${errMsg}`;
  }
  return errMsg;
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
 * Returns whether a terminal `result` event was observed and any error from it.
 */
async function processRemainingOutput(task: Task): Promise<{ resultSeen: boolean; resultError: string | null }> {
  let resultSeen = false;
  let resultError: string | null = null;
  try {
    const outputFile = remoteOutputPath(task.id);
    const output = await sshExec(task.workspace_name,
      `cat ${shellEscape(outputFile)} 2>/dev/null`,
      30000,
    );

    if (!output) return { resultSeen, resultError };

    // Stage 1: parse all events into staging arrays WITHOUT touching the DB.
    // Only if we successfully extract ≥1 message do we wipe existing
    // messages and insert staged ones. Prevents a wipe-without-replacement
    // if parsing yields nothing (empty/corrupt output file).
    type Staged = { text: string; cost?: number };
    const stagedMessages: Staged[] = [];
    const stagedStreamEvents: Array<{ type: string; [k: string]: unknown }> = [];
    let stagedInputTokens = 0;
    let stagedOutputTokens = 0;
    let lastStagedText: string | null = null;

    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        stagedStreamEvents.push(event);

        if (event.type === 'assistant' && event.message?.content) {
          let turnText = '';
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text) {
              turnText += block.text;
            }
          }
          if (turnText) {
            stagedMessages.push({ text: turnText });
            lastStagedText = turnText;
          }
        }
        if (event.type === 'result') {
          const fatal = extractFatalError(event);
          const resultText = extractResultText(event);
          const cost = typeof event.total_cost_usd === 'number' ? event.total_cost_usd as number : undefined;
          // Skip staging the result text as an assistant message when it's a
          // fatal error — finalizeTask will surface it as a system error instead.
          if (!fatal && resultText && resultText !== lastStagedText) {
            stagedMessages.push({ text: resultText, cost });
            lastStagedText = resultText;
          } else if (cost !== undefined && stagedMessages.length > 0) {
            stagedMessages[stagedMessages.length - 1].cost = cost;
          }
          const { inputTokens: inTok, outputTokens: outTok } = extractTokenUsage(event);
          stagedInputTokens += inTok;
          stagedOutputTokens += outTok;
          resultSeen = true;
          if (fatal) resultError = fatal;
        }
      } catch {
        // Skip invalid JSON
      }
    }

    // Stage 2: if nothing parsed, do NOT wipe existing messages.
    if (stagedMessages.length === 0) {
      console.log(`[recovery] Task ${task.id}: parsed 0 messages from ${stagedStreamEvents.length} events — preserving existing messages`);
      for (const event of stagedStreamEvents) {
        processEvent(task.id, event);
      }
      return { resultSeen, resultError };
    }

    // Stage 3: atomically wipe current-session messages and insert staged ones.
    const db = getDb();
    db.transaction(() => {
      deleteCurrentSessionAssistantMessages(task.id);
      for (const m of stagedMessages) {
        addMessage(task.id, 'assistant', m.text, m.cost);
      }
      if (stagedInputTokens > 0 || stagedOutputTokens > 0) {
        addTokenUsage(task.id, stagedInputTokens, stagedOutputTokens);
      }
    })();

    // Populate stream_log outside the message transaction — it's regenerable
    // diagnostic data and shouldn't block the critical message insert.
    for (const event of stagedStreamEvents) {
      processEvent(task.id, event);
    }

    // Don't clean up remote files — they're the source of truth for recovery.
  } catch (err) {
    console.log(`[recovery] Failed to read remaining output:`, (err as Error).message?.slice(0, 100));
  }
  return { resultSeen, resultError };
}

// ─── Discussion (workspace chat) support ───────────────────────────────────

function getDiscussionPromptPrefix(
  projectDir: string | null,
  ownWorkspaceName: string,
  userId: string | null,
  worktreePath: string | null = null,
): string {
  const boundary = worktreePath
    ? `You are working in an isolated git branch (\`${worktreePath}\`). You have full access to read and modify files — your changes are isolated from the main project branch and will only be merged if you or the user decides to. You can also output a [TASK_REQUEST] to create a formal tracked task.`
    : projectDir
      ? `You MUST NOT modify, create, or delete any files within \`${projectDir}\` (the git-tracked project directory) — treat it as read-only. If work needs to be done inside the project, output a [TASK_REQUEST] instead and the user will approve it as a task.\n\nYou MAY freely read, explore, and write to files outside this path — global config files like \`~/.claude/CLAUDE.md\`, workspace memory files, temp files, etc.`
      : `You MUST NOT modify, create, or delete files in the project repository — treat it as read-only. If work needs to be done in the project, output a [TASK_REQUEST] instead and the user will approve it as a task.`;

  const workspaces = userId ? getWorkspacesForUser(userId) : null;
  const otherRunning = (workspaces ?? [])
    .filter(w => w.running && w.name !== ownWorkspaceName)
    .map(w => w.name);

  const targetingBlock = otherRunning.length > 0
    ? `By default, a [TASK_REQUEST] runs in this workspace (\`${ownWorkspaceName}\`). If the work clearly belongs to a DIFFERENT workspace the user has access to, you may suggest it there by adding a \`targetWorkspace\` field with that workspace's name. The user will see the chosen target and can change it before approving.

Other running workspaces you can target:
${otherRunning.map(n => `  - ${n}`).join('\n')}

Only set \`targetWorkspace\` when you have specific reason to believe the task belongs elsewhere (e.g. the user asked you to relay it). When unsure, omit the field.`
    : `By default, a [TASK_REQUEST] runs in this workspace (\`${ownWorkspaceName}\`). You may also suggest a task in a different workspace by adding \`"targetWorkspace": "workspace-name"\` to the [TASK_REQUEST] JSON — the user can confirm the target before approving.`;

  return `You are a discussion agent for this workspace (\`${ownWorkspaceName}\`). ${boundary}

If the discussion leads to work that should be done inside the project, output a task request in this EXACT format (on its own, not inside a code block):

[TASK_REQUEST]
{"prompt": "detailed task description here"}
[/TASK_REQUEST]

${targetingBlock}

The user will be prompted to approve the task before it runs.

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
 * Resolves an optional targetWorkspace name against the user's cached
 * workspace list. Unresolved/missing target falls back to the discussion's
 * own workspace at approval time.
 */
function parseTaskRequests(discussion: Discussion, text: string): void {
  const regex = /\[TASK_REQUEST\]\s*([\s\S]*?)\s*\[\/TASK_REQUEST\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      if (!data.prompt || typeof data.prompt !== 'string') continue;

      let target: { workspace_id: string; workspace_name: string } | null = null;
      const requested = typeof data.targetWorkspace === 'string' ? data.targetWorkspace.trim() : null;
      if (requested && requested !== discussion.workspace_name) {
        const found = findUserWorkspaceByName(discussion.user_id, requested);
        if (found) {
          target = { workspace_id: found.id, workspace_name: found.name };
        } else {
          console.log(`[discussion] Task request targetWorkspace "${requested}" not in user's workspace list — falling back to host`);
        }
      }
      createTaskRequest(discussion.id, data.prompt, target);
      console.log(`[discussion] Task request created for discussion ${discussion.id}${target ? ` (target: ${target.workspace_name})` : ''}`);
    } catch {
      console.log(`[discussion] Failed to parse task request JSON`);
    }
  }
}

/**
 * Parse [TASK_REQUEST] blocks emitted by a task session (delegation) and
 * create pending task_requests entries tied to the task. Mirrors
 * parseTaskRequests but for a task origin. Resolves an optional
 * targetWorkspace against the task owner's cached workspace list.
 */
function parseTaskRequestsForTask(task: Task, text: string): void {
  const regex = /\[TASK_REQUEST\]\s*([\s\S]*?)\s*\[\/TASK_REQUEST\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      if (!data.prompt || typeof data.prompt !== 'string') continue;

      let target: { workspace_id: string; workspace_name: string } | null = null;
      const requested = typeof data.targetWorkspace === 'string' ? data.targetWorkspace.trim() : null;
      if (requested && requested !== task.workspace_name) {
        const found = findUserWorkspaceByName(task.user_id, requested);
        if (found) {
          target = { workspace_id: found.id, workspace_name: found.name };
        } else {
          console.log(`[task] Task request targetWorkspace "${requested}" not in user's workspace list — falling back to host`);
        }
      }
      createTaskRequestFromTask(task.id, data.prompt, target);
      console.log(`[task] Task request created for task ${task.id}${target ? ` (target: ${target.workspace_name})` : ''}`);
    } catch {
      console.log(`[task] Failed to parse task request JSON`);
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
  // Build catch-up context for the host if there are participants —
  // the host's own session doesn't contain messages from other agents.
  const participants = getDiscussionParticipants(discussion.id);
  let hostCatchUp = '';
  if (participants.length > 0 && isResume && !skipCatchUp) {
    hostCatchUp = buildCatchUpContext(discussion.id, '__host__');
  }

  // Auto-detect project directory if not already set
  if (!discussion.project_dir) {
    const detected = await detectProjectDir(discussion.workspace_name);
    if (detected) {
      discussion.project_dir = detected;
      getDb().prepare('UPDATE discussions SET project_dir = ? WHERE id = ?').run(detected, discussion.id);
    }
  }

  // Create a worktree on first launch so the discussion is isolated from tasks
  if (!isResume && !discussion.worktree_path) {
    await handleDiscussionLaunchGit(discussion);
  }

  let prompt: string;
  if (!isResume) {
    prompt = getDiscussionPromptPrefix(discussion.project_dir ?? null, discussion.workspace_name, discussion.user_id, discussion.worktree_path) + message;
  } else if (participants.length > 0) {
    // Resuming with participants — prepend catch-up if available.
    const mentionInstr = hostCatchUp ? '' : buildMentionInstruction(discussion.id);
    const prefix = [hostCatchUp, mentionInstr].filter(Boolean).join('\n');
    prompt = prefix ? prefix + '\n' + message : message;
  } else {
    prompt = message;
  }

  // Check if the session already exists on the remote workspace.
  // Worktree path is the preferred working directory; fall back to project_dir or home.
  const preferredWorkDir = discussion.worktree_path || discussion.project_dir;
  let remoteSessionExists = isResume;
  let sessionWorkDir = preferredWorkDir;
  if (discussion.claude_session_id) {
    try {
      const checkResult = await sshExec(discussion.workspace_name,
        `find ~/.claude/projects/ -name '${discussion.claude_session_id}.jsonl' 2>/dev/null | head -1`
      );
      const sessionPath = checkResult.trim();
      if (sessionPath) {
        remoteSessionExists = true;
        const workDirEncoded = preferredWorkDir
          ? preferredWorkDir.replace(/[^a-zA-Z0-9]/g, '-')
          : null;
        if (workDirEncoded && !sessionPath.includes(`/projects/${workDirEncoded}/`)) {
          sessionWorkDir = '/home/coder';
        }
      }
    } catch {
      // Non-fatal — assume new session, use default working dir
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
  // Discussions always run with full permissions — the worktree provides filesystem isolation
  claudeParts.push('--dangerously-skip-permissions');
  claudeParts.push('--max-turns', MAX_TURNS);

  claudeParts.push('--append-system-prompt', shellEscape(HARNESS_REMINDER_NOTE));

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

    // Pre-launch prep: archive stale output files + write the CPM guidelines
    // memory file. Both are independent SSH calls and both are non-fatal.
    await Promise.all([
      sshExec(discussion.workspace_name,
        `mv -f ${shellEscape(outputFile)} ${shellEscape(outputFile + '.prev')} 2>/dev/null; ` +
        `mv -f ${shellEscape(exitFile)} ${shellEscape(exitFile + '.prev')} 2>/dev/null; true`
      ).catch(() => { /* Non-fatal */ }),
      writeCpmGuidelines(discussion.workspace_name),
    ]);

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

  // Wipe stream_log and (optionally) current-session messages atomically.
  // Skip cleanup for catch-up launches — there's no prior output to dedupe,
  // and cleaning up would delete the host's previous legitimate responses.
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM stream_log WHERE task_id = ?').run(pollKey);
    if (!skipMessageCleanup) {
      deleteCurrentDiscussionAssistantMessages(discussion.id);
    }
  })();

  let linesRead = 0;
  let lastSavedMessageId: string | null = null;
  let lastSavedMessageText: string | null = null;
  let consecutiveErrors = 0;
  let lastPollError = '';
  let partialLine = '';
  let polling = false;
  let finalized = false;
  let resultSeen = false;
  let resultError: string | null = null;

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const outputFile = remoteDiscussionOutputPath(discussion.id);
      const exitFile = remoteDiscussionExitCodePath(discussion.id);

      const { jsonPart, exitPart } = await pollOutputAndExit(
        discussion.workspace_name, outputFile, exitFile, linesRead,
      );

      consecutiveErrors = 0;

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
                    parseTaskRequests(discussion, block.text);
                  } else if (block.type === 'tool_use') {
                    taskActivity.set(`disc:${discussion.id}`, { timestamp: now, summary: `Using ${(block as { name?: string }).name || 'tool'}` });
                  }
                }
              }
            } else if (event.type === 'result') {
              const fatal = extractFatalError(event);
              const resultText = extractResultText(event);
              if (!fatal && resultText && resultText !== lastSavedMessageText) {
                const dmsg = addDiscussionMessage(discussion.id, 'assistant', resultText, event.total_cost_usd as number | undefined);
                lastSavedMessageId = dmsg.id;
                lastSavedMessageText = resultText;
                parseTaskRequests(discussion, resultText);
              } else if (typeof event.total_cost_usd === 'number' && lastSavedMessageId) {
                getDb().prepare('UPDATE discussion_messages SET cost = ? WHERE id = ?').run(event.total_cost_usd, lastSavedMessageId);
              }
              if (fatal) resultError = fatal;
              resultSeen = true;
            }
          } catch (eventErr) {
            console.error(`[discussion-poller] Error processing event:`, (eventErr as Error).message?.slice(0, 200));
          }
        }
      }

      // Finalize on `result` event arrival — Claude has logically finished even
      // if the OS process hasn't exited yet (e.g. lingering subprocess holds the
      // stdout pipe open, blocking exit). Don't wait for the exit code.
      if (resultSeen && !finalized) {
        finalized = true;
        console.log(`[discussion-poller] Discussion ${discussion.id} finalized via result event`);
        const proc = activeProcesses.get(`disc:${discussion.id}`);
        if (proc) proc.kill();
        stopPolling(pollKey);
        taskActivity.delete(`disc:${discussion.id}`);
        activeProcesses.delete(`disc:${discussion.id}`);
        rateLimitInfo.delete(`disc:${discussion.id}`);
        getDb().prepare('UPDATE discussions SET ssh_pid = NULL WHERE id = ?').run(discussion.id);

        if (resultError) {
          addDiscussionMessage(discussion.id, 'system', `Error: ${resultError}`);
        } else if (lastSavedMessageText) {
          parseMentions(discussion, lastSavedMessageText, null);
        }
      } else if (exitPart !== 'RUNNING' && exitPart !== '' && !finalized) {
        const exitCode = parseInt(exitPart, 10);
        if (isNaN(exitCode)) {
          console.warn(`[discussion-poller] Discussion ${discussion.id} got non-numeric exit content (${exitPart.slice(0, 60)}) — continuing to poll`);
          return;
        }
        finalized = true;
        console.log(`[discussion-poller] Discussion ${discussion.id} finished (exit: ${exitPart})`);
        stopPolling(pollKey);
        taskActivity.delete(`disc:${discussion.id}`);
        activeProcesses.delete(`disc:${discussion.id}`);
        rateLimitInfo.delete(`disc:${discussion.id}`);
        getDb().prepare('UPDATE discussions SET ssh_pid = NULL WHERE id = ?').run(discussion.id);

        if (exitCode === 0 && lastSavedMessageText) {
          parseMentions(discussion, lastSavedMessageText, null);
        }

        if (exitCode !== 0) {
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
      lastPollError = (err as Error).message?.slice(0, 300) || String(err);
      console.log(`[discussion-poller] Error (${consecutiveErrors}):`, lastPollError.slice(0, 100));

      if (consecutiveErrors > 20) {
        console.log(`[discussion-poller] Too many errors, stopping polling for discussion ${discussion.id}`);
        stopPolling(pollKey);
        taskActivity.delete(`disc:${discussion.id}`);
        const reason = lastPollError
          ? `Lost connection to workspace: ${lastPollError}`
          : 'Lost connection to workspace';
        addDiscussionMessage(discussion.id, 'system', `Error: ${reason}`);
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
    const prefix = isFullAccess ? '' : getDiscussionPromptPrefix(participant.project_dir ?? null, participant.workspace_name, discussion.user_id);
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
          ? participant.project_dir.replace(/[^a-zA-Z0-9]/g, '-')
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
  claudeParts.push('--append-system-prompt', shellEscape(HARNESS_REMINDER_NOTE));

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

    // Pre-launch prep: archive stale output files + write the CPM guidelines
    // memory file. Both are independent SSH calls and both are non-fatal.
    await Promise.all([
      sshExec(participant.workspace_name,
        `mv -f ${shellEscape(outputFile)} ${shellEscape(outputFile + '.prev')} 2>/dev/null; ` +
        `mv -f ${shellEscape(exitFile)} ${shellEscape(exitFile + '.prev')} 2>/dev/null; true`
      ).catch(() => { /* Non-fatal */ }),
      writeCpmGuidelines(participant.workspace_name),
    ]);

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
    addDiscussionMessage(discussion.id, 'system', `Error launching ${participant.workspace_name}: ${errorMsg}`, undefined, undefined, participant.id);
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
  let finalized = false;
  let resultSeen = false;
  let resultError: string | null = null;

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const outputFile = remoteParticipantOutputPath(participant.id);
      const exitFile = remoteParticipantExitCodePath(participant.id);

      const { jsonPart, exitPart } = await pollOutputAndExit(
        participant.workspace_name, outputFile, exitFile, linesRead,
      );

      consecutiveErrors = 0;

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
                    parseTaskRequests(discussion, block.text);
                  } else if (block.type === 'tool_use') {
                    taskActivity.set(pollKey, { timestamp: now, summary: `Using ${block.name || 'tool'}` });
                  }
                }
              }
            } else if (event.type === 'result') {
              const fatal = extractFatalError(event);
              const resultText = extractResultText(event);
              if (!fatal && resultText && resultText !== lastSavedMessageText) {
                const dmsg = addDiscussionMessage(discussion.id, 'assistant', resultText, event.total_cost_usd as number | undefined, participant.workspace_name, participant.id);
                lastSavedMessageId = dmsg.id;
                lastSavedMessageText = resultText;
                parseTaskRequests(discussion, resultText);
              } else if (typeof event.total_cost_usd === 'number' && lastSavedMessageId) {
                getDb().prepare('UPDATE discussion_messages SET cost = ? WHERE id = ?').run(event.total_cost_usd, lastSavedMessageId);
              }
              if (fatal) resultError = fatal;
              resultSeen = true;
            }
          } catch (eventErr) {
            console.error(`[participant-poller] Error processing event:`, (eventErr as Error).message?.slice(0, 200));
          }
        }
      }

      // Finalize on `result` event arrival — Claude has logically finished even
      // if the OS process hasn't exited yet (e.g. lingering subprocess holds the
      // stdout pipe open, blocking exit). Don't wait for the exit code.
      if (resultSeen && !finalized) {
        finalized = true;
        console.log(`[participant-poller] Participant ${participant.id} finalized via result event`);
        const proc = activeProcesses.get(pollKey);
        if (proc) proc.kill();
        stopPolling(pollKey);
        taskActivity.delete(pollKey);
        activeProcesses.delete(pollKey);

        if (resultError) {
          addDiscussionMessage(discussion.id, 'system', `${participant.workspace_name} session ended with error: ${resultError}`, undefined, undefined, participant.id);
        } else if (lastSavedMessageText) {
          parseMentions(discussion, lastSavedMessageText, participant.id);
        }
      } else if (exitPart !== 'RUNNING' && exitPart !== '' && !finalized) {
        const exitCode = parseInt(exitPart, 10);
        if (isNaN(exitCode)) {
          console.warn(`[participant-poller] Participant ${participant.id} got non-numeric exit content (${exitPart.slice(0, 60)}) — continuing to poll`);
          return;
        }
        finalized = true;
        console.log(`[participant-poller] Participant ${participant.id} finished (exit: ${exitPart})`);
        stopPolling(pollKey);
        taskActivity.delete(pollKey);
        activeProcesses.delete(pollKey);

        if (exitCode === 0 && lastSavedMessageText) {
          parseMentions(discussion, lastSavedMessageText, participant.id);
        }

        if (exitCode !== 0) {
          addDiscussionMessage(discussion.id, 'system', `${participant.workspace_name} session ended with error (exit ${exitCode})`, undefined, undefined, participant.id);
        }
      }
    } catch (err) {
      consecutiveErrors++;
      console.log(`[participant-poller] Error (${consecutiveErrors}):`, (err as Error).message?.slice(0, 100));

      if (consecutiveErrors > 20) {
        console.log(`[participant-poller] Too many errors, stopping polling for participant ${participant.id}`);
        stopPolling(pollKey);
        taskActivity.delete(pollKey);
        addDiscussionMessage(discussion.id, 'system', `Error: Lost connection to ${participant.workspace_name}`, undefined, undefined, participant.id);
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
    prompt = getDiscussionPromptPrefix(participant.project_dir ?? null, participant.workspace_name, task.user_id) + (catchUp ? catchUp + '\n' : '') + message;
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
          ? participant.project_dir.replace(/[^a-zA-Z0-9]/g, '-')
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
  claudeParts.push('--append-system-prompt', shellEscape(HARNESS_REMINDER_NOTE));

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
    try {
      await sshExec(participant.workspace_name,
        `mv -f ${shellEscape(outputFile)} ${shellEscape(outputFile + '.prev')} 2>/dev/null; ` +
        `mv -f ${shellEscape(exitFile)} ${shellEscape(exitFile + '.prev')} 2>/dev/null; true`);
    } catch { /* */ }

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
  let finalized = false, resultSeen = false;
  let resultError: string | null = null;

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const outputFile = remoteTaskParticipantOutputPath(participant.id);
      const exitFile = remoteTaskParticipantExitCodePath(participant.id);
      const { jsonPart, exitPart } = await pollOutputAndExit(
        participant.workspace_name, outputFile, exitFile, linesRead,
      );
      consecutiveErrors = 0;

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
                  parseTaskRequestsForTask(task, block.text);
                } else if (block.type === 'tool_use') {
                  taskActivity.set(pollKey, { timestamp: now, summary: `Using ${block.name || 'tool'}` });
                }
              }
            } else if (event.type === 'result') {
              const fatal = extractFatalError(event);
              const resultText = extractResultText(event);
              if (!fatal && resultText && resultText !== lastSavedMessageText) {
                const saved = addMessage(task.id, 'assistant', resultText, event.total_cost_usd as number | undefined, participant.workspace_name, participant.id);
                lastSavedMessageId = saved.id; lastSavedMessageText = resultText;
                parseTaskRequestsForTask(task, resultText);
              } else if (typeof event.total_cost_usd === 'number' && lastSavedMessageId) {
                updateMessageCost(lastSavedMessageId, event.total_cost_usd as number);
              }
              if (fatal) resultError = fatal;
              resultSeen = true;
            }
          } catch { /* skip */ }
        }
      }
      // Finalize on `result` event arrival — Claude has logically finished even
      // if the OS process hasn't exited yet (e.g. lingering subprocess holds the
      // stdout pipe open, blocking exit). Don't wait for the exit code.
      if (resultSeen && !finalized) {
        finalized = true;
        const proc = activeProcesses.get(pollKey);
        if (proc) proc.kill();
        stopPolling(pollKey); taskActivity.delete(pollKey); activeProcesses.delete(pollKey);
        if (resultError) {
          addMessage(task.id, 'system', `${participant.workspace_name} session ended with error: ${resultError}`);
        }
      } else if (exitPart !== 'RUNNING' && exitPart !== '' && !finalized) {
        const exitCode = parseInt(exitPart, 10);
        if (isNaN(exitCode)) {
          console.warn(`[task-participant-poller] Participant ${participant.id} got non-numeric exit content (${exitPart.slice(0, 60)}) — continuing to poll`);
          return;
        }
        finalized = true;
        stopPolling(pollKey); taskActivity.delete(pollKey); activeProcesses.delete(pollKey);
        if (exitCode !== 0) {
          addMessage(task.id, 'system', `${participant.workspace_name} session ended with error (exit ${exitCode})`);
        }
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
