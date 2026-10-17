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
 *  - Stop: cleanupPortRange at terminal states (unchanged), which also kills the
 *    preview's process group via its pid file.
 *
 * Everything that touches the workspace goes through an injected `exec`, so the
 * caller decides how to reach it (claude.ts wires sshExec) and tests can mock it.
 */

import { getDb } from '../db/index.js';
import type { Task } from './tasks.js';

/** Runs a shell command on the task's workspace and returns stdout. */
export type PreviewExec = (command: string, timeoutMs: number) => Promise<string>;

/**
 * `starting` while CPM is (re)starting it, `installing` while the detached
 * process installs missing dependencies first, `running` once started (and still
 * alive at the health check), `failed` when it could not start or died right
 * away, `stopped` once the task reached a terminal state, `none` when CPM looked
 * and found no command to run. NULL = CPM never managed a preview for the task.
 */
export type PreviewStatus = 'starting' | 'installing' | 'running' | 'failed' | 'stopped' | 'none';

/** Statuses after which a task must never get a (new) preview. */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

const MAX_COMMAND_LENGTH = 1000;
export const MAX_LOG_LINES = 500;
const DEFAULT_HEALTHCHECK_MS = parseInt(process.env.CPM_PREVIEW_HEALTHCHECK_MS || '10000', 10);
/** How long the health check keeps waiting on a dependency install before giving up watching. */
const DEFAULT_INSTALL_WATCH_MS = parseInt(process.env.CPM_PREVIEW_INSTALL_WATCH_MS || String(20 * 60_000), 10);

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
   * Install dependencies first when node_modules is missing — only for the
   * auto-detected `npm run dev`. A fresh worktree has no node_modules, so
   * without this nearly every new task's preview would fail. An explicit
   * workspace command is the user's call and never gets an install.
   */
  autoInstall: boolean;
}

/**
 * Runs inside the detached process: record the pid (== process group, thanks
 * to setsid), install missing dependencies if asked, then become the preview
 * command. The phase goes to the state file so the health check can tell a
 * slow install from a dead server.
 */
const PREVIEW_RUNNER = `echo $$ > "$CPM_PREVIEW_PIDFILE"
if [ -n "$CPM_PREVIEW_INSTALL" ]; then
  echo installing > "$CPM_PREVIEW_STATEFILE"
  echo "[cpm] node_modules is missing; installing dependencies: $CPM_PREVIEW_INSTALL"
  sh -c "$CPM_PREVIEW_INSTALL" || { echo "[cpm] dependency install failed"; exit 1; }
fi
echo running > "$CPM_PREVIEW_STATEFILE"
exec sh -c "$CPM_PREVIEW_CMD"`;

/**
 * Start the preview fully detached and return immediately. Prints
 * `cpm-preview-started <pid>` on success, plus ` installing` when the detached
 * process installs dependencies before starting the command.
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
if [ "$AUTO_INSTALL" = 1 ] && [ -f package.json ] && [ ! -d node_modules ]; then
  if [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then CPM_PREVIEW_INSTALL="pnpm install --frozen-lockfile"
  elif [ -f yarn.lock ] && command -v yarn >/dev/null 2>&1; then CPM_PREVIEW_INSTALL="yarn install --frozen-lockfile"
  elif [ -f package-lock.json ]; then CPM_PREVIEW_INSTALL="npm ci"
  else CPM_PREVIEW_INSTALL="npm install"; fi
fi
export CPM_PREVIEW_INSTALL
rm -f "$CPM_PREVIEW_PIDFILE" "$CPM_PREVIEW_STATEFILE"
SETSID=; command -v setsid >/dev/null 2>&1 && SETSID=setsid
$SETSID nohup sh -c "$CPM_PREVIEW_RUNNER" > ${log} 2>&1 < /dev/null &
i=0
while [ $i -lt 10 ] && [ ! -s "$CPM_PREVIEW_PIDFILE" ]; do sleep 0.1; i=$((i+1)); done
if [ -s "$CPM_PREVIEW_PIDFILE" ]; then echo "cpm-preview-started $(cat "$CPM_PREVIEW_PIDFILE")\${CPM_PREVIEW_INSTALL:+ installing}"; else echo "cpm-preview-error: the preview process did not start"; fi
exit 0`);
}

/** `alive <phase>`, or `dead <phase>` followed by the log tail. */
function buildHealthCheckCommand(taskId: string): string {
  return wrapScript(`set +e
pid=$(cat ${shq(previewPidPath(taskId))} 2>/dev/null)
phase=$(cat ${shq(previewStatePath(taskId))} 2>/dev/null)
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "alive \${phase:-running}"; exit 0; fi
echo "dead \${phase:-running}"
tail -n 20 ${shq(previewLogPath(taskId))} 2>/dev/null
exit 0`);
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
  /** Delay before checking the preview is still alive; 0 disables the check. */
  healthCheckMs?: number;
  /** How long to keep re-checking while dependencies install. */
  installWatchMs?: number;
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

/**
 * (Re)start a task's preview. Never throws — a failure is recorded on the task
 * (preview_status 'failed' + preview_error) and returned, because a preview that
 * won't start must never fail the task or hold up its state transitions.
 */
export function restartTaskPreview(taskId: string, opts: RestartOptions): Promise<RestartOutcome> {
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

    const url = previewUrlForPort(task.workspace_name, portStart);
    const startedAt = new Date().toISOString();
    const installing = !!started[2];
    setPreviewState(taskId, { status: installing ? 'installing' : 'running', startedAt, url });
    console.log(`[preview] task ${taskId}: started "${resolved.command}" in ${workDir} on :${portStart} (pid ${started[1]})${installing ? ', installing dependencies first' : ''}`);

    // Raced with a terminal transition after the start? Then cleanupPortRange
    // may already have run and missed this server — stop it ourselves.
    const after = getTaskRow(taskId);
    if (!isPreviewable(after)) {
      await opts.exec(buildPreviewStopCommand(taskId), 20000).catch(() => '');
      setPreviewState(taskId, { status: 'stopped', url: null });
      return { status: 'stopped' };
    }

    scheduleHealthCheck(taskId, startedAt, opts, Date.now(), installing);
    return { status: installing ? 'installing' : 'running', url };
  } catch (err) {
    const error = (err as Error)?.message?.slice(0, 500) || String(err);
    console.warn(`[preview] task ${taskId}: restart failed: ${error.slice(0, 200)}`);
    setPreviewState(taskId, { status: 'failed', error });
    return { status: 'failed', error };
  }
}

/**
 * A dev server that crashes on boot (missing deps, syntax error) shows as
 * failed, with its log. While dependencies are still installing the check
 * keeps coming back instead of judging; once the install is done the server
 * gets its own check, so a slow install is never mistaken for a dead preview.
 */
function scheduleHealthCheck(taskId: string, startedAt: string, opts: RestartOptions, since: number, wasInstalling: boolean): void {
  const delay = opts.healthCheckMs ?? DEFAULT_HEALTHCHECK_MS;
  if (!(delay > 0)) return;
  const timer = setTimeout(() => {
    void (async () => {
      const current = () => {
        const t = getTaskRow(taskId) as (Task & { preview_started_at?: string | null; preview_status?: string | null }) | undefined;
        // A newer restart (or a stop) supersedes this one.
        return !!t && t.preview_started_at === startedAt && (t.preview_status === 'running' || t.preview_status === 'installing');
      };
      if (!current()) return;
      let out: string;
      try {
        out = await opts.exec(buildHealthCheckCommand(taskId), 15000);
      } catch {
        return; // can't tell — leave it as it is rather than guess
      }
      if (!current()) return;
      const [state, phase] = firstLine(out).split(/\s+/);
      if (state === 'alive') {
        if (phase === 'installing') {
          setPreviewState(taskId, { status: 'installing' });
          if (Date.now() - since < (opts.installWatchMs ?? DEFAULT_INSTALL_WATCH_MS)) {
            scheduleHealthCheck(taskId, startedAt, opts, since, true);
          }
        } else if (wasInstalling) {
          // Install finished and the command is up: give the server its own check.
          setPreviewState(taskId, { status: 'running' });
          scheduleHealthCheck(taskId, startedAt, opts, since, false);
        }
        return;
      }
      if (state !== 'dead') return;
      const tail = out.replace(/^[^\n]*\r?\n?/, '').trim();
      const what = phase === 'installing' ? 'Installing the dependencies failed.' : 'The preview exited shortly after starting.';
      setPreviewState(taskId, { status: 'failed', error: `${what}${tail ? `\n${tail.slice(-1500)}` : ''}` });
    })().catch(() => {});
  }, delay);
  timer.unref?.();
}

/** The last `lines` lines of the task's preview log ('' when there is none yet). */
export async function readPreviewLog(taskId: string, exec: PreviewExec, lines: number): Promise<string> {
  const n = Math.max(1, Math.min(MAX_LOG_LINES, Math.floor(lines) || 0));
  const out = await exec(`tail -n ${n} ${shq(previewLogPath(taskId))} 2>/dev/null; exit 0`, 15000);
  return out.replace(/\r\n?/g, '\n');
}
