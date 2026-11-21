/**
 * CPM-managed task previews.
 *
 * CPM — not the agent — starts each task's preview server. Agents that started
 * their own servers regularly hung their turn: they waited on, or polled, a
 * server attached to their own `claude -p` process, and the turn never ended.
 * So when an implementer turn ends, CPM (re)starts the preview itself, fully
 * detached, outside the agent's process:
 *
 *  - Command: the workspace's `preview_command` setting, else `npm run dev` when
 *    the working directory's package.json has a `dev` script, else no preview.
 *    The command sees $PORT (the first port of the task's range) and
 *    $CPM_PORT_RANGE.
 *  - Directory: the task's worktree, or project_dir when it has none.
 *  - Start: kill whatever the previous preview left behind, then
 *    `setsid nohup sh -c '<cmd>' > <log> 2>&1 < /dev/null &`. The remote call
 *    returns at once; nothing waits on the server.
 *  - Health: it is `running` only once a TCP connect to $PORT succeeds (on the
 *    workspace's loopback, as Coder's port forwarding sees it) — a live
 *    process on the wrong port is a dead link, not a preview. Settled previews
 *    are re-probed periodically (recheckAllPreviews).
 *  - Stop: cleanupPortRange at terminal states (unchanged), which also kills the
 *    preview's process group via its pid file.
 *
 * Everything that touches the workspace goes through an injected `exec`, so the
 * caller decides how to reach it (claude.ts wires sshExec) and tests can mock it.
 */

import { getDb } from '../db/index.js';
import type { Task } from './tasks.js';
import { DETECT_INSTALL_SH, INSTALL_LOCK_FN, INSTALL_MARKER } from './install-script.js';

export { DETECT_INSTALL_SH, INSTALL_LOCK_FN, INSTALL_MARKER };

/** Runs a shell command on the task's workspace and returns stdout. */
export type PreviewExec = (command: string, timeoutMs: number) => Promise<string>;

/**
 * `starting` while CPM is (re)starting it and waiting for it to answer on its
 * port, `installing` while the detached process installs missing dependencies
 * first, `running` once something answers on the port, `unreachable` when the
 * process is alive but nothing answers on the port (it never did, or stopped),
 * `failed` when it could not start or its process died, `stopped` once the
 * task reached a terminal state, `none` when CPM looked and found no command to
 * run. NULL = CPM never managed a preview for the task.
 */
export type PreviewStatus = 'starting' | 'installing' | 'running' | 'unreachable' | 'failed' | 'stopped' | 'none';

/** Statuses after which a task must never get a (new) preview. */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

const MAX_COMMAND_LENGTH = 1000;
export const MAX_LOG_LINES = 500;
/** Delay between checks while dependencies install (the port probe has its own interval). */
const DEFAULT_HEALTHCHECK_MS = parseInt(process.env.CPM_PREVIEW_HEALTHCHECK_MS || '10000', 10);
/** How long the health check keeps waiting on a dependency install before giving up watching. */
const DEFAULT_INSTALL_WATCH_MS = parseInt(process.env.CPM_PREVIEW_INSTALL_WATCH_MS || String(20 * 60_000), 10);
/** How often a starting preview's port is probed. */
const DEFAULT_PROBE_INTERVAL_MS = parseInt(process.env.CPM_PREVIEW_PROBE_INTERVAL_MS || '2000', 10);
/** How long a started preview may take to answer on its port before it is reported as not answering. */
const DEFAULT_PORT_WAIT_MS = parseInt(process.env.CPM_PREVIEW_PORT_WAIT_MS || '90000', 10);

export function previewLogPath(taskId: string): string {
  return `/tmp/cpm-preview-${safeId(taskId)}.log`;
}

export function previewPidPath(taskId: string): string {
  return `/tmp/cpm-preview-${safeId(taskId)}.pid`;
}

/** `installing` or `running` — which phase the detached preview process is in. */
export function previewStatePath(taskId: string): string {
  return `/tmp/cpm-preview-${safeId(taskId)}.state`;
}

/** Task ids are UUIDs; strip anything else so a path can never escape /tmp. */
function safeId(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9-]/g, '');
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Wrap a script so it survives `coder ssh` without any quoting surprises. */
function wrapScript(script: string): string {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return `printf %s '${b64}' | base64 -d | sh`;
}

/** The directory a task's preview runs in: its worktree, else its project dir. */
export function previewWorkDir(task: Pick<Task, 'worktree_path' | 'project_dir'>): string | null {
  return task.worktree_path || task.project_dir || null;
}

/** `npm run dev` when package.json has a `dev` script, otherwise null. */
export function detectPreviewCommand(packageJson: string | null): string | null {
  if (!packageJson || !packageJson.trim()) return null;
  try {
    const pkg = JSON.parse(packageJson) as { scripts?: Record<string, unknown> };
    const dev = pkg?.scripts?.dev;
    return typeof dev === 'string' && dev.trim() ? 'npm run dev' : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Workspace setting
// ---------------------------------------------------------------------------

export function getPreviewCommandSetting(workspaceId: string): { command: string | null; detected: string | null } {
  const row = getDb().prepare('SELECT preview_command, preview_detected_command FROM workspace_settings WHERE workspace_id = ?')
    .get(workspaceId) as { preview_command: string | null; preview_detected_command: string | null } | undefined;
  return { command: row?.preview_command ?? null, detected: row?.preview_detected_command ?? null };
}

export function setPreviewCommandSetting(workspaceId: string, command: string | null): void {
  getDb().prepare(
    `INSERT INTO workspace_settings (workspace_id, preview_command, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET preview_command = excluded.preview_command, updated_at = excluded.updated_at`
  ).run(workspaceId, command, new Date().toISOString());
}

/** Remember what auto-detection last found, so settings can show it without a round-trip to the workspace. */
function recordDetectedCommand(workspaceId: string, command: string | null): void {
  getDb().prepare(
    `INSERT INTO workspace_settings (workspace_id, preview_detected_command, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET preview_detected_command = excluded.preview_detected_command, updated_at = excluded.updated_at`
  ).run(workspaceId, command, new Date().toISOString());
}

/**
 * Validate a user-entered preview command. Empty means "auto-detect" (null).
 * It is a shell command run in the user's own workspace — which they already
 * have a shell on — so shell syntax is allowed; only a single line, bounded.
 */
export function parsePreviewCommand(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'command must be a string or null' };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (/[\r\n\0]/.test(trimmed)) return { ok: false, error: 'command must be a single line' };
  if (trimmed.length > MAX_COMMAND_LENGTH) return { ok: false, error: `command must be at most ${MAX_COMMAND_LENGTH} characters` };
  return { ok: true, value: trimmed };
}

/** The workspace setting if set, else auto-detection in the task's working directory. */
export async function resolvePreviewCommand(
  task: Pick<Task, 'workspace_id' | 'worktree_path' | 'project_dir'>,
  exec: PreviewExec,
): Promise<{ command: string; source: 'setting' | 'detected' } | null> {
  const { command } = getPreviewCommandSetting(task.workspace_id);
  if (command) return { command, source: 'setting' };
  const dir = previewWorkDir(task);
  if (!dir) return null;
  const pkg = await exec(`cat ${shq(`${dir}/package.json`)} 2>/dev/null; exit 0`, 15000);
  const detected = detectPreviewCommand(pkg);
  recordDetectedCommand(task.workspace_id, detected);
  return detected ? { command: detected, source: 'detected' } : null;
}

// ---------------------------------------------------------------------------
// Preview URL
// ---------------------------------------------------------------------------

/**
 * Coder's port-forwarding URL pattern for a workspace, e.g.
 * `https://{{port}}--main--Workspace--user.coder.example.com`, or '' when unknown.
 * VSCODE_PROXY_URI is baked with CPM's own workspace name; swap that segment
 * when the task targets a different workspace.
 */
export function proxyUriForWorkspace(workspaceName: string): string {
  const proxyUri = process.env.VSCODE_PROXY_URI || '';
  const localName = process.env.CODER_WORKSPACE_NAME || '';
  if (!proxyUri || !localName || !workspaceName) return proxyUri;
  if (workspaceName.toLowerCase() === localName.toLowerCase()) return proxyUri;
  // Coder's wildcard host is case-insensitive and canonically lowercased, but
  // CODER_WORKSPACE_NAME may be cased differently than the baked proxy segment,
  // so match case-insensitively and emit the target name lowercased.
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return proxyUri.replace(new RegExp(`--${escaped}--`, 'i'), `--${workspaceName.toLowerCase()}--`);
}

/** The browser URL for a port on a workspace, or null when CPM can't build one. */
export function previewUrlForPort(workspaceName: string, port: number): string | null {
  const pattern = proxyUriForWorkspace(workspaceName);
  if (!pattern || !pattern.includes('{{port}}')) return null;
  return pattern.replace('{{port}}', String(port));
}

// ---------------------------------------------------------------------------
// Remote scripts
// ---------------------------------------------------------------------------

/**
 * Kill the preview CPM last started for this task: its whole process group
 * (setsid made the shell a group leader, so npm → vite → esbuild all go), then
 * wait briefly for it to let go of its port before the next start binds it.
 */
export function buildPreviewStopCommand(taskId: string): string {
  return wrapScript(`set +e
PIDF=${shq(previewPidPath(taskId))}
rm -f ${shq(previewStatePath(taskId))}
[ -f "$PIDF" ] || exit 0
pid=$(cat "$PIDF" 2>/dev/null)
rm -f "$PIDF"
case "$pid" in ''|*[!0-9]*) exit 0;; esac
# No "--": dash's kill builtin rejects it, and a negative pid already means the group.
kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
i=0
while [ $i -lt 15 ] && kill -0 "-$pid" 2>/dev/null; do sleep 0.2; i=$((i+1)); done
kill -KILL "-$pid" 2>/dev/null
echo "killed-preview pgid=$pid"
exit 0`);
}

export interface PreviewStartSpec {
  taskId: string;
  workDir: string;
  command: string;
  portStart: number;
  portEnd: number;
  /**
   * Install dependencies first when they are missing or stale — only for the
   * auto-detected `npm run dev`. A fresh worktree has no node_modules, so
   * without this nearly every new task's preview would fail. An explicit
   * workspace command is the user's call and never gets an install.
   */
  autoInstall: boolean;
}

/**
 * Runs inside the detached process: record the pid (== process group, thanks
 * to setsid), install dependencies if asked, then become the preview command.
 * The phase goes to the state file so the health check can tell a slow
 * install from a dead server. The install marker is written only after a
 * successful install, so a failed or killed one is retried next time. The
 * install holds the per-directory lock; one that finished while this waited
 * for it (the marker now matches) is not repeated.
 */
const PREVIEW_RUNNER = `echo $$ > "$CPM_PREVIEW_PIDFILE"
${INSTALL_LOCK_FN}
if [ -n "$CPM_PREVIEW_INSTALL" ]; then
  echo installing > "$CPM_PREVIEW_STATEFILE"
  cpm_install_lock 1200
  if [ "$(cat ${INSTALL_MARKER} 2>/dev/null)" = "$CPM_PREVIEW_DEPS_HASH" ]; then
    echo "[cpm] dependencies were installed meanwhile by another CPM install"
  else
    echo "[cpm] dependencies are missing or changed; installing: $CPM_PREVIEW_INSTALL"
    rm -f ${INSTALL_MARKER}
    sh -c "$CPM_PREVIEW_INSTALL" || { echo "[cpm] dependency install failed"; exit 1; }
    mkdir -p node_modules && printf '%s\\n' "$CPM_PREVIEW_DEPS_HASH" > ${INSTALL_MARKER}
  fi
  cpm_install_unlock
fi
echo running > "$CPM_PREVIEW_STATEFILE"
exec sh -c "$CPM_PREVIEW_CMD"`;

/**
 * Start the preview fully detached and return immediately. Prints
 * `cpm-preview-started <pid>` on success, plus ` installing` when the detached
 * process installs dependencies before starting the command.
 *
 * Installs when the marker in node_modules is missing or records a different
 * hash of the lockfile (package.json when there is none) — so a fresh
 * worktree, a failed/interrupted install, and dependencies the agent changed
 * this turn all get one, and an unchanged project never does.
 */
export function buildPreviewStartCommand(spec: PreviewStartSpec): string {
  const log = shq(previewLogPath(spec.taskId));
  return wrapScript(`set +e
cd ${shq(spec.workDir)} || { echo "cpm-preview-error: cannot cd to ${spec.workDir.replace(/["$`\\]/g, '')}"; exit 0; }
export PATH="$HOME/.local/bin:$PATH" PORT=${spec.portStart} CPM_PORT_RANGE="${spec.portStart}-${spec.portEnd}"
export CPM_PREVIEW_CMD=${shq(spec.command)}
export CPM_PREVIEW_PIDFILE=${shq(previewPidPath(spec.taskId))}
export CPM_PREVIEW_STATEFILE=${shq(previewStatePath(spec.taskId))}
export CPM_PREVIEW_RUNNER=${shq(PREVIEW_RUNNER)}
AUTO_INSTALL=${spec.autoInstall ? 1 : 0}
CPM_PREVIEW_INSTALL=
CPM_PREVIEW_DEPS_HASH=
if [ "$AUTO_INSTALL" = 1 ] && [ -f package.json ]; then
${DETECT_INSTALL_SH}
  CPM_PREVIEW_DEPS_HASH="$CPM_DEPS_HASH"
  if [ "$(cat ${INSTALL_MARKER} 2>/dev/null)" != "$CPM_PREVIEW_DEPS_HASH" ]; then CPM_PREVIEW_INSTALL="$CPM_INSTALL"; fi
fi
export CPM_PREVIEW_INSTALL CPM_PREVIEW_DEPS_HASH
rm -f "$CPM_PREVIEW_PIDFILE" "$CPM_PREVIEW_STATEFILE"
SETSID=; command -v setsid >/dev/null 2>&1 && SETSID=setsid
$SETSID nohup sh -c "$CPM_PREVIEW_RUNNER" > ${log} 2>&1 < /dev/null &
i=0
while [ $i -lt 10 ] && [ ! -s "$CPM_PREVIEW_PIDFILE" ]; do sleep 0.1; i=$((i+1)); done
if [ -s "$CPM_PREVIEW_PIDFILE" ]; then echo "cpm-preview-started $(cat "$CPM_PREVIEW_PIDFILE")\${CPM_PREVIEW_INSTALL:+ installing}"; else echo "cpm-preview-error: the preview process did not start"; fi
exit 0`);
}

/**
 * Whether something accepts a TCP connection on a port, on 127.0.0.1 or ::1 —
 * the same loopback Coder's port forwarding connects to. bash's /dev/tcp makes
 * a real connect; without bash, a listening socket in /proc/net/tcp{,6} is the
 * closest thing a plain sh can tell.
 */
const PORT_OPEN_FN = `cpm_port_open() {
  if command -v bash >/dev/null 2>&1; then
    T=; command -v timeout >/dev/null 2>&1 && T="timeout 3"
    $T bash -c 'exec 3<>"/dev/tcp/127.0.0.1/$0"' "$1" 2>/dev/null && return 0
    $T bash -c 'exec 3<>"/dev/tcp/::1/$0"' "$1" 2>/dev/null && return 0
    return 1
  fi
  hex=$(printf '%04X' "$1")
  awk -v p=":$hex" 'FNR > 1 && $4 == "0A" && substr($2, length($2) - 4) == p { f = 1 } END { exit !f }' /proc/net/tcp /proc/net/tcp6 2>/dev/null
}`;

/**
 * Prints `cpm-health: alive <phase> [open|closed]` or `cpm-health: dead <phase>`.
 * While the server phase is alive and a port is given, it also connects to the
 * port: `open` when it answers, `closed` (followed by the log tail, which often
 * says where the app went instead) when it doesn't. A dead preview is followed
 * by its log tail. Prefixed so the parse doesn't depend on it being the first
 * line (`coder ssh` can put other output in front of it).
 */
export function buildPreviewHealthCommand(taskId: string, port: number | null): string {
  const p = port !== null && Number.isInteger(port) && port > 0 && port < 65536 ? String(port) : '';
  return wrapScript(`set +e
pid=$(cat ${shq(previewPidPath(taskId))} 2>/dev/null)
phase=$(cat ${shq(previewStatePath(taskId))} 2>/dev/null)
phase=\${phase:-running}
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  if [ "$phase" != running ] || [ -z "${p}" ]; then echo "cpm-health: alive $phase"; exit 0; fi
${PORT_OPEN_FN}
  if cpm_port_open ${p || '0'}; then echo "cpm-health: alive running open"; exit 0; fi
  echo "cpm-health: alive running closed"
  tail -n 40 ${shq(previewLogPath(taskId))} 2>/dev/null
  exit 0
fi
echo "cpm-health: dead $phase"
tail -n 20 ${shq(previewLogPath(taskId))} 2>/dev/null
exit 0`);
}

export interface PreviewHealth {
  state: 'alive' | 'dead';
  phase: string;
  /** Whether the port answered; null when it wasn't probed (installing, dead, or no port). */
  port: 'open' | 'closed' | null;
  tail: string;
}

/** Find the health line anywhere in the output; the log tail is whatever follows it. */
export function parseHealthOutput(out: string): PreviewHealth | null {
  const lines = out.replace(/\r\n?/g, '\n').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /cpm-health: (alive|dead)(?: ([a-z]+))?(?: (open|closed))?/.exec(lines[i]);
    if (m) {
      return {
        state: m[1] as 'alive' | 'dead',
        phase: m[2] || 'running',
        port: (m[3] as 'open' | 'closed' | undefined) ?? null,
        tail: lines.slice(i + 1).join('\n').trim(),
      };
    }
  }
  return null;
}

/**
 * What the log says about where the app actually went, when it isn't on the
 * port CPM gave it: a "Port X is in use" / EADDRINUSE / EACCES line, or the
 * last URL it printed on another port (vite's `Local: http://localhost:40072/`).
 * Null when the log says nothing useful.
 */
export function describeLogPortHint(log: string, expectedPort: number): string | null {
  // eslint-disable-next-line no-control-regex
  const text = log.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const hints: string[] = [];
  const problem = text.split('\n').map(l => l.trim()).filter(l =>
    /port \d+ is (already )?in use|EADDRINUSE|EACCES|address already in use|permission denied/i.test(l));
  if (problem.length) hints.push(`The log says: "${problem[problem.length - 1].slice(0, 200)}"`);
  const urls = [...text.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[[0-9a-f:]+\]|[\w.-]+):(\d{2,5})\S*/gi)]
    .filter(m => Number(m[1]) !== expectedPort);
  if (urls.length) {
    const last = urls[urls.length - 1];
    hints.push(`The log shows the app on port ${last[1]} instead (${last[0]}).`);
  }
  return hints.length ? hints.join(' ') : null;
}

function notAnsweringError(port: number, tail: string, wasRunning: boolean): string {
  const head = wasRunning
    ? `Preview stopped answering on port ${port}; its process is still running. Check the log.`
    : `Preview process is running but nothing is listening on port ${port} (the app may be ignoring $PORT). Check the log.`;
  const hint = describeLogPortHint(tail, port);
  return `${head}${hint ? `\n${hint}` : ''}${tail ? `\n\n${tail.slice(-1500)}` : ''}`;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface RestartOptions {
  exec: PreviewExec;
  /** Size of a task's port range (claude.ts's PORT_RANGE_SIZE). */
  rangeSize: number;
  /** Extra kill command for listeners on the task's ports (claude.ts's port-range kill). */
  portKillCommand?: (portStart: number) => string;
  /**
   * Delay between checks while dependencies install. Never switches the
   * port probe off: a started preview is always watched until it answers.
   */
  healthCheckMs?: number;
  /** How long to keep re-checking while dependencies install. */
  installWatchMs?: number;
  /** Delay between port probes while waiting for the server to answer. */
  probeIntervalMs?: number;
  /** How long the server may take to answer on its port before it is reported as not answering. */
  portWaitMs?: number;
}

export interface RestartOutcome {
  status: PreviewStatus | 'skipped';
  url?: string | null;
  error?: string;
}

function getTaskRow(taskId: string): Task | undefined {
  return getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
}

function isPreviewable(task: Task | undefined): task is Task & { port_range_start: number } {
  return !!task && !task.deleted_at && !TERMINAL_STATUSES.has(task.status)
    && task.port_range_start !== null && task.port_range_start !== undefined;
}

function setPreviewState(taskId: string, fields: {
  status: PreviewStatus | null;
  error?: string | null;
  command?: string | null;
  startedAt?: string | null;
  url?: string | null;
}): void {
  const sets = ['preview_status = ?', 'preview_error = ?'];
  const args: unknown[] = [fields.status, fields.error ?? null];
  if (fields.command !== undefined) { sets.push('preview_command = ?'); args.push(fields.command); }
  if (fields.startedAt !== undefined) { sets.push('preview_started_at = ?'); args.push(fields.startedAt); }
  if (fields.url !== undefined) { sets.push('verification_url = ?'); args.push(fields.url); }
  args.push(taskId);
  getDb().prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args);
}

function firstLine(s: string): string {
  return (s.split(/\r?\n/).find(l => l.trim()) ?? '').trim();
}

// One restart at a time per task: a turn ending while the user clicks Restart
// must not interleave two kill/start sequences on the same ports.
const inFlight = new Map<string, Promise<RestartOutcome>>();

// Bumped on every restart request, so the watch and rechecks of an older start
// never write over a newer one — even before the newer one has a start time.
const generations = new Map<string, number>();
const generationOf = (taskId: string) => generations.get(taskId) ?? 0;

// Tasks whose fresh start is being watched in this process. A starting preview
// with no watcher (CPM restarted mid-watch) is left to the periodic recheck.
// Maps the task to the generation whose watch is running, so a watch that was
// superseded still clears its own entry when the newer restart started none.
const activeWatches = new Map<string, number>();

// The port wait each task's latest restart was given, for judging a start whose
// watch was cut short. Falls back to the default after a CPM restart.
const portWaits = new Map<string, number>();

/**
 * (Re)start a task's preview. Never throws — a failure is recorded on the task
 * (preview_status 'failed' + preview_error) and returned, because a preview that
 * won't start must never fail the task or hold up its state transitions.
 *
 * Returns once the process is started; whether it then answers on its port is
 * watched in the background (`starting` → `running` / `unreachable` / `failed`).
 */
export function restartTaskPreview(taskId: string, opts: RestartOptions): Promise<RestartOutcome> {
  generations.set(taskId, generationOf(taskId) + 1);
  const prev = inFlight.get(taskId) ?? Promise.resolve(null);
  const run = prev.catch(() => null).then(() => doRestart(taskId, opts));
  inFlight.set(taskId, run);
  run.finally(() => { if (inFlight.get(taskId) === run) inFlight.delete(taskId); }).catch(() => {});
  return run;
}

async function doRestart(taskId: string, opts: RestartOptions): Promise<RestartOutcome> {
  const task = getTaskRow(taskId);
  if (!isPreviewable(task)) return { status: 'skipped' };
  const workDir = previewWorkDir(task);
  if (!workDir) return { status: 'skipped' };
  const generation = generationOf(taskId);
  if (opts.portWaitMs !== undefined) portWaits.set(taskId, opts.portWaitMs); else portWaits.delete(taskId);

  try {
    const resolved = await resolvePreviewCommand(task, opts.exec);
    if (!resolved) {
      setPreviewState(taskId, { status: 'none', command: null });
      return { status: 'none' };
    }
    const portStart = task.port_range_start;
    const portEnd = portStart + opts.rangeSize - 1;
    setPreviewState(taskId, { status: 'starting', command: resolved.command });

    // Kill the previous preview (by process group) and anything else still
    // listening on the task's ports, so the new one can bind $PORT.
    const kill = buildPreviewStopCommand(taskId) + (opts.portKillCommand ? `; ${opts.portKillCommand(portStart)}` : '');
    await opts.exec(kill, 20000);

    // The task may have ended (and had its ports released) while we were
    // killing — never start a server for a task that's already gone.
    const current = getTaskRow(taskId);
    if (!isPreviewable(current) || current.port_range_start !== portStart) {
      setPreviewState(taskId, { status: current && TERMINAL_STATUSES.has(current.status) ? 'stopped' : null });
      return { status: 'skipped' };
    }

    const out = await opts.exec(buildPreviewStartCommand({
      taskId, workDir, command: resolved.command, portStart, portEnd, autoInstall: resolved.source === 'detected',
    }), 15000);
    const started = /cpm-preview-started (\d+)( installing)?/.exec(out);
    if (!started) {
      const error = firstLine(out.replace(/^.*cpm-preview-error:\s*/s, '')) || 'the preview process did not start';
      setPreviewState(taskId, { status: 'failed', error });
      console.warn(`[preview] task ${taskId}: failed to start "${resolved.command}": ${error}`);
      return { status: 'failed', error };
    }

    // The URL is known now, but the client only links it once the status is
    // `running` — i.e. once something actually answers on the port.
    const url = previewUrlForPort(task.workspace_name, portStart);
    const startedAt = new Date().toISOString();
    const installing = !!started[2];
    const status: PreviewStatus = installing ? 'installing' : 'starting';
    setPreviewState(taskId, { status, startedAt, url });
    console.log(`[preview] task ${taskId}: started "${resolved.command}" in ${workDir} on :${portStart} (pid ${started[1]})${installing ? ', installing dependencies first' : ''}`);

    // Raced with a terminal transition after the start? Then cleanupPortRange
    // may already have run and missed this server — stop it ourselves.
    const after = getTaskRow(taskId);
    if (!isPreviewable(after)) {
      await opts.exec(buildPreviewStopCommand(taskId), 20000).catch(() => '');
      setPreviewState(taskId, { status: 'stopped', url: null });
      return { status: 'stopped' };
    }

    activeWatches.set(taskId, generation);
    void watchPreview(taskId, generation, startedAt, portStart, opts, installing)
      .catch(err => console.warn(`[preview] task ${taskId}: watch failed: ${(err as Error)?.message?.slice(0, 200)}`))
      .finally(() => { if (activeWatches.get(taskId) === generation) activeWatches.delete(taskId); });
    return { status, url };
  } catch (err) {
    const error = (err as Error)?.message?.slice(0, 500) || String(err);
    console.warn(`[preview] task ${taskId}: restart failed: ${error.slice(0, 200)}`);
    setPreviewState(taskId, { status: 'failed', error });
    return { status: 'failed', error };
  }
}

const sleep = (ms: number) => new Promise<void>(r => { const t = setTimeout(r, ms); t.unref?.(); });

/**
 * Follow a freshly started preview until it settles:
 *  - installing: re-check every healthCheckMs, so a slow install is never
 *    mistaken for a dead preview; give up (stop it, `failed`) after installWatchMs.
 *  - starting: probe the port every probeIntervalMs. `running` only once it
 *    answers; `failed` (with the log) if the process dies first; `unreachable`
 *    if it is alive but still not answering after portWaitMs — usually an app
 *    that ignores $PORT.
 */
async function watchPreview(
  taskId: string, generation: number, startedAt: string, port: number, opts: RestartOptions, installing: boolean,
): Promise<void> {
  const probeDelay = opts.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  const installDelay = (opts.healthCheckMs ?? DEFAULT_HEALTHCHECK_MS) > 0 ? (opts.healthCheckMs ?? DEFAULT_HEALTHCHECK_MS) : probeDelay;
  const portWaitMs = opts.portWaitMs ?? DEFAULT_PORT_WAIT_MS;
  const installWatchMs = opts.installWatchMs ?? DEFAULT_INSTALL_WATCH_MS;
  const since = Date.now();
  let serverSince: number | null = installing ? null : Date.now();
  let lastProblem = '';

  // A newer restart (or a stop) supersedes this one.
  const current = () => {
    if (generationOf(taskId) !== generation) return false;
    const t = getTaskRow(taskId);
    return !!t && t.preview_started_at === startedAt && (t.preview_status === 'starting' || t.preview_status === 'installing');
  };

  for (;;) {
    await sleep(serverSince === null ? installDelay : probeDelay);
    if (!current()) return;
    let health: PreviewHealth | null = null;
    try {
      health = parseHealthOutput(await opts.exec(buildPreviewHealthCommand(taskId, port), 15000));
      if (!health) lastProblem = 'the health check gave no answer';
    } catch (err) {
      lastProblem = (err as Error)?.message?.slice(0, 300) || String(err);
    }
    if (!current()) return;

    if (!health) {
      // Can't tell this time — keep trying, but never stay `starting` forever.
      if (serverSince !== null && Date.now() - serverSince >= portWaitMs) {
        setPreviewState(taskId, { status: 'unreachable', error: `CPM could not check whether the preview answers on port ${port}: ${lastProblem}` });
        return;
      }
      continue;
    }

    const { state, phase, tail } = health;
    if (state === 'dead') {
      const what = phase === 'installing' ? 'Installing the dependencies failed.' : 'The preview exited shortly after starting.';
      setPreviewState(taskId, { status: 'failed', error: `${what}${tail ? `\n${tail.slice(-1500)}` : ''}` });
      return;
    }

    if (phase === 'installing') {
      if (Date.now() - since < installWatchMs) {
        setPreviewState(taskId, { status: 'installing' });
        continue;
      }
      // Never leave it "installing" forever: give up, stop it (the marker
      // is only written on success, so the next start retries), and say why.
      const log = await opts.exec(`tail -n 20 ${shq(previewLogPath(taskId))} 2>/dev/null; exit 0`, 15000).catch(() => '');
      await opts.exec(buildPreviewStopCommand(taskId), 20000).catch(() => '');
      if (!current()) return;
      setPreviewState(taskId, {
        status: 'failed',
        error: `The dependency install did not finish within ${formatDuration(installWatchMs)}, so it was stopped.${log.trim() ? `\n${log.trim().slice(-1500)}` : ''}`,
      });
      return;
    }

    // The server phase: the install (if any) is done, now wait for the port.
    if (serverSince === null) {
      serverSince = Date.now();
      setPreviewState(taskId, { status: 'starting' });
    }
    if (health.port === 'open') {
      setPreviewState(taskId, { status: 'running' });
      return;
    }
    if (Date.now() - serverSince >= portWaitMs) {
      setPreviewState(taskId, { status: 'unreachable', error: notAnsweringError(port, tail, false) });
      console.warn(`[preview] task ${taskId}: process is up but nothing answers on :${port} after ${formatDuration(portWaitMs)}`);
      return;
    }
  }
}

/** Statuses a recheck looks at: a preview that should be answering, or wasn't last time. */
const RECHECKED_STATUSES = ['running', 'unreachable'];
/** Also rechecked, but only when nothing in this process is watching them (an interrupted watch). */
const UNWATCHED_STATUSES = ['starting', 'installing'];

function isRecheckable(task: Task): boolean {
  const status = task.preview_status ?? '';
  if (inFlight.has(task.id)) return false;
  return RECHECKED_STATUSES.includes(status) || (UNWATCHED_STATUSES.includes(status) && !activeWatches.has(task.id));
}

/**
 * Re-probe a settled preview. A running preview that stopped answering becomes
 * `unreachable`, one whose process died becomes `failed`, and an unreachable one
 * that answers again is `running` again. Nothing is killed — Restart is the
 * remedy. Returns the status it recorded, or 'skipped' when it changed nothing
 * it could vouch for (not a settled preview, a restart in progress, no answer).
 */
export async function recheckTaskPreview(
  taskId: string, exec: PreviewExec, opts: { portWaitMs?: number } = {},
): Promise<PreviewStatus | 'skipped'> {
  const task = getTaskRow(taskId);
  if (!isPreviewable(task) || !isRecheckable(task)) return 'skipped';
  const generation = generationOf(taskId);
  const port = task.port_range_start;
  let health: PreviewHealth | null;
  try {
    health = parseHealthOutput(await exec(buildPreviewHealthCommand(taskId, port), 15000));
  } catch {
    return 'skipped'; // can't tell — leave it as it is rather than guess
  }
  if (!health) return 'skipped';

  // Only write if nothing restarted or stopped the preview meanwhile.
  const now = getTaskRow(taskId);
  if (generationOf(taskId) !== generation || !isPreviewable(now) || !isRecheckable(now)
    || now.preview_started_at !== task.preview_started_at || now.preview_status !== task.preview_status) {
    return 'skipped';
  }
  const settled = RECHECKED_STATUSES.includes(now.preview_status ?? '');

  if (health.state === 'dead') {
    setPreviewState(taskId, { status: 'failed', error: `The preview process exited.${health.tail ? `\n${health.tail.slice(-1500)}` : ''}` });
    console.warn(`[preview] task ${taskId}: preview process exited`);
    return 'failed';
  }
  if (health.port === 'open') {
    if (now.preview_status !== 'running') setPreviewState(taskId, { status: 'running' });
    return 'running';
  }
  if (health.port === 'closed') {
    // An orphaned start still within its grace period gets more time.
    const age = Date.now() - Date.parse(now.preview_started_at ?? '');
    if (!settled && age < (opts.portWaitMs ?? portWaits.get(taskId) ?? DEFAULT_PORT_WAIT_MS)) return 'skipped';
    if (now.preview_status === 'running') console.warn(`[preview] task ${taskId}: preview stopped answering on :${port}`);
    // Keep the original wording for one that never answered at all.
    const wasRunning = now.preview_status === 'running'
      || (now.preview_status === 'unreachable' && /stopped answering/.test(now.preview_error ?? ''));
    setPreviewState(taskId, { status: 'unreachable', error: notAnsweringError(port, health.tail, wasRunning) });
    return 'unreachable';
  }
  return 'skipped';
}

/** Recheck every settled preview, one at a time (each is a remote call). */
export async function recheckAllPreviews(execFor: (task: Task) => PreviewExec): Promise<void> {
  const rows = getDb().prepare(
    `SELECT * FROM tasks WHERE preview_status IN ('running', 'unreachable', 'starting', 'installing')
       AND deleted_at IS NULL AND port_range_start IS NOT NULL
       AND status NOT IN ('completed', 'failed', 'cancelled')`
  ).all() as Task[];
  for (const task of rows) {
    await recheckTaskPreview(task.id, execFor(task)).catch(() => 'skipped');
  }
}

function formatDuration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
}

/** The last `lines` lines of the task's preview log ('' when there is none yet). */
export async function readPreviewLog(taskId: string, exec: PreviewExec, lines: number): Promise<string> {
  const n = Math.max(1, Math.min(MAX_LOG_LINES, Math.floor(lines) || 0));
  const out = await exec(`tail -n ${n} ${shq(previewLogPath(taskId))} 2>/dev/null; exit 0`, 15000);
  return out.replace(/\r\n?/g, '\n');
}
