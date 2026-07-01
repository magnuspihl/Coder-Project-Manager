/**
 * Port janitor — a background sweep that keeps forwarded ports honest.
 *
 * Its default job is NON-destructive **ownership attribution** (#3): from one
 * lightweight remote /proc scan per active workspace, record `port -> taskId`
 * for servers owned by an ACTIVE task so the UI can show the port on that
 * task's card even when it drifted OUTSIDE the task's assigned numeric range
 * (e.g. Vite auto-incrementing when its default port is taken). Read via
 * getPortOwnerTaskId().
 *
 * Optionally, when CPM_PORT_JANITOR_REAP is enabled, it also performs
 * **orphan reaping** (#2): SIGTERM dev/preview servers still listening in CPM's
 * managed port space whose owning process runs out of a task worktree that is
 * terminal, deleted, or gone. This is OFF BY DEFAULT and gated because
 * worktrees persist after completion — a user may deliberately start a server
 * in a finished task's worktree, and we must not silently kill it. Processes
 * NOT under a CPM worktree (e.g. the workspace's own main-checkout dev server)
 * are never candidates, reaping or not.
 *
 * Attribution keys on the task id embedded in the worktree directory name
 * (`<base>/task-<id>`), which is exact and independent of the numeric range —
 * so an active task's process is never misclassified as an orphan.
 */

import { getDb } from '../db/index.js';
import {
  sshExec,
  PORT_RANGE_START,
  PORT_RANGE_SIZE,
  PORT_RANGE_SLOTS,
} from './claude.js';

const CPM_WORKTREE_BASE = process.env.CPM_WORKTREE_BASE || '/home/coder/.cpm/worktrees';
const SWEEP_INTERVAL_MS = parseInt(process.env.CPM_PORT_JANITOR_INTERVAL_MS || '30000');
const MANAGED_PORT_MIN = PORT_RANGE_START;
const MANAGED_PORT_MAX = PORT_RANGE_START + PORT_RANGE_SLOTS * PORT_RANGE_SIZE - 1;
// Destructive orphan reaping is opt-in. Attribution (the default) never kills.
const REAP_ENABLED = /^(1|true|yes|on)$/i.test(process.env.CPM_PORT_JANITOR_REAP || '');

const ACTIVE_STATUSES = ['working', 'awaiting_feedback', 'queued'];

/** port -> owning active taskId, plus when the entry was refreshed. */
interface OwnershipEntry {
  at: number;
  ports: Map<number, string>;
}
const ownershipByWorkspace = new Map<string, OwnershipEntry>();
// Entries older than this are treated as unknown, so a workspace that stops
// being scanned doesn't leave stale attributions pinned forever.
const OWNERSHIP_TTL_MS = SWEEP_INTERVAL_MS * 3;

/**
 * Which active task (if any) owns a given forwarded port on a workspace.
 * Returns null when unknown/stale — callers should fall back to the numeric
 * port-range heuristic.
 */
export function getPortOwnerTaskId(workspaceName: string, port: number): string | null {
  const entry = ownershipByWorkspace.get(workspaceName.toLowerCase());
  if (!entry) return null;
  if (Date.now() - entry.at > OWNERSHIP_TTL_MS) {
    ownershipByWorkspace.delete(workspaceName.toLowerCase());
    return null;
  }
  return entry.ports.get(port) ?? null;
}

/**
 * Remote scan command (base64-wrapped to avoid SSH shell-quoting pitfalls).
 * Emits three line kinds, joined and interpreted in Node:
 *   R <inode> <port>   — a LISTENing socket in the managed range
 *   P <inode> <pid>    — a process holding a socket fd for one of those inodes
 *   C <pid> <cwd>      — the cwd of a process that owns a managed listener
 *
 * Scoping keeps this cheap enough to run every sweep: the fd walk is a single
 * `ls -l` piped through awk that emits `P` lines ONLY for the managed-listener
 * inodes found in the `R` pass (not every socket fd system-wide), and `C` lines
 * are read only for the handful of matched pids. Uses only awk/ls/readlink/sh —
 * no fuser/ss/lsof, which many workspace images lack.
 */
function buildScanCommand(): string {
  // String.raw so awk backslash escapes (\/, \[, \n) survive verbatim; only
  // ${MANAGED_PORT_MIN}/${MANAGED_PORT_MAX} interpolate (no shell ${...} here).
  const script = String.raw`set +e
R=$(awk -v start=${MANAGED_PORT_MIN} -v end=${MANAGED_PORT_MAX} 'function h2d(s, i,c,v,n){s=toupper(s);n=0;for(i=1;i<=length(s);i++){c=substr(s,i,1);v=index("0123456789ABCDEF",c)-1;n=n*16+v}return n} FNR>1 && $4=="0A"{split($2,L,":"); p=h2d(L[2]); if(p>=start&&p<=end) print "R "$10" "p}' /proc/net/tcp /proc/net/tcp6 2>/dev/null)
[ -n "$R" ] || exit 0
printf '%s\n' "$R"
WANT=$(printf '%s\n' "$R" | awk '{print $2}' | sort -u | tr '\n' ' ')
P=$(ls -l /proc/[0-9]*/fd/ 2>/dev/null | awk -v want="$WANT" 'BEGIN{n=split(want,a," ");for(i=1;i<=n;i++)w[a[i]]=1} /^\/proc\/[0-9]+\/fd\/?:$/{pid=$0; sub(/^\/proc\//,"",pid); sub(/\/fd\/?:$/,"",pid); next} /-> socket:\[/{ino=$NF; sub(/^socket:\[/,"",ino); sub(/\]$/,"",ino); if(ino in w) print "P "ino" "pid}')
[ -n "$P" ] || exit 0
printf '%s\n' "$P"
for pid in $(printf '%s\n' "$P" | awk '{print $3}' | sort -u); do c=$(readlink /proc/$pid/cwd 2>/dev/null) && echo "C $pid $c"; done
exit 0`;
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return `printf %s '${b64}' | base64 -d | sh`;
}

interface Listener {
  port: number;
  pid: string;
  cwd: string;
}

/** Parse the R/P/C scan output into one row per in-range listener. */
function parseScan(out: string): Listener[] {
  const portByInode = new Map<string, number>();
  const pidsByInode = new Map<string, string[]>();
  const cwdByPid = new Map<string, string>();
  for (const raw of out.split(/\r?\n/)) { // coder ssh emits CRLF — split on both
    const parts = raw.split(' ');
    if (parts[0] === 'R') {
      portByInode.set(parts[1], parseInt(parts[2], 10));
    } else if (parts[0] === 'P') {
      const list = pidsByInode.get(parts[1]) ?? pidsByInode.set(parts[1], []).get(parts[1])!;
      list.push(parts[2]);
    } else if (parts[0] === 'C') {
      cwdByPid.set(parts[1], parts.slice(2).join(' '));
    }
  }
  const rows: Listener[] = [];
  for (const [inode, port] of portByInode) {
    if (!Number.isFinite(port)) continue;
    for (const pid of pidsByInode.get(inode) ?? []) {
      rows.push({ port, pid, cwd: cwdByPid.get(pid) ?? '' });
    }
  }
  return rows;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// Matches a cwd that lives inside a CPM task worktree, capturing the task id.
const WORKTREE_RE = new RegExp(
  '^' + escapeRegex(CPM_WORKTREE_BASE) + '/task-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:/|$)',
);

interface TaskRow {
  id: string;
  status: string;
  deleted: boolean;
}

/**
 * Sweep one workspace. Always attributes active-owned ports (non-destructive).
 * Only when reaping is enabled does it additionally SIGTERM orphaned servers.
 */
async function sweepWorkspace(workspaceName: string, userId: string, tasksById: Map<string, TaskRow>): Promise<void> {
  let out: string;
  try {
    out = await sshExec(workspaceName, buildScanCommand(), 25000, userId);
  } catch (err) {
    // Stopped/unreachable workspace, transient SSH failure, etc. Leave any
    // existing ownership entry to age out via its TTL.
    console.warn(`[port-janitor] scan failed for ${workspaceName}: ${(err as Error).message?.slice(0, 150)}`);
    return;
  }

  const listeners = parseScan(out);
  const owned = new Map<number, string>();
  const orphanPids = new Set<string>();
  const orphanDetail: string[] = [];

  for (const l of listeners) {
    const m = WORKTREE_RE.exec(l.cwd);
    if (!m) continue; // not under a CPM worktree — not ours to attribute or reap
    const taskId = m[1];
    const task = tasksById.get(taskId);
    const isActive = task && !task.deleted && ACTIVE_STATUSES.includes(task.status);
    if (isActive) {
      owned.set(l.port, taskId);
    } else if (REAP_ENABLED) {
      // Terminal, deleted, or unknown task still holding a managed port → leak.
      orphanPids.add(l.pid);
      orphanDetail.push(`:${l.port} (task ${taskId.slice(0, 8)} ${task ? (task.deleted ? 'deleted' : task.status) : 'missing'})`);
    }
  }

  ownershipByWorkspace.set(workspaceName.toLowerCase(), { at: Date.now(), ports: owned });

  if (orphanPids.size > 0) {
    const pids = [...orphanPids];
    const killCmd = `for p in ${pids.join(' ')}; do kill "$p" 2>/dev/null; done; exit 0`;
    try {
      await sshExec(workspaceName, killCmd, 10000, userId);
      console.log(`[port-janitor] ${workspaceName}: reaped ${pids.length} orphaned dev server(s): ${orphanDetail.join(', ')}`);
    } catch (err) {
      console.warn(`[port-janitor] ${workspaceName}: orphan kill failed: ${(err as Error).message?.slice(0, 150)}`);
    }
  }
}

let sweeping = false;

/** One full sweep across every workspace that currently has an active task. */
export async function sweepPorts(): Promise<void> {
  if (sweeping) return; // never overlap sweeps
  sweeping = true;
  try {
    const db = getDb();
    // One representative (most recently updated) active task per workspace gives
    // us a workspace to scan and a user whose OAuth token can auth the SSH.
    const targets = db.prepare(
      `SELECT workspace_name, user_id, MAX(updated_at) AS mu
         FROM tasks
        WHERE status IN ('working','awaiting_feedback','queued')
          AND deleted_at IS NULL
        GROUP BY workspace_name`,
    ).all() as Array<{ workspace_name: string; user_id: string }>;
    if (targets.length === 0) return;

    // All tasks that ever got a worktree, keyed by id, so we can classify each
    // listening process by the task embedded in its worktree path.
    const taskRows = db.prepare(
      `SELECT id, status, deleted_at FROM tasks WHERE worktree_path IS NOT NULL`,
    ).all() as Array<{ id: string; status: string; deleted_at: string | null }>;
    const tasksById = new Map<string, TaskRow>();
    for (const r of taskRows) tasksById.set(r.id, { id: r.id, status: r.status, deleted: r.deleted_at != null });

    await Promise.all(
      targets.map((t) => sweepWorkspace(t.workspace_name, t.user_id, tasksById)
        .catch((err) => console.warn(`[port-janitor] sweep error for ${t.workspace_name}: ${(err as Error).message?.slice(0, 150)}`))),
    );
  } finally {
    sweeping = false;
  }
}

let janitorTimer: NodeJS.Timeout | null = null;

/** Start the periodic port janitor. Idempotent. */
export function startPortJanitor(): void {
  if (janitorTimer) return;
  janitorTimer = setInterval(() => {
    sweepPorts().catch((err) => console.error(`[port-janitor] sweep failed: ${(err as Error).message?.slice(0, 200)}`));
  }, SWEEP_INTERVAL_MS);
  janitorTimer.unref?.();
  console.log(`[port-janitor] started (every ${Math.round(SWEEP_INTERVAL_MS / 1000)}s, managed ports ${MANAGED_PORT_MIN}-${MANAGED_PORT_MAX}, reaping ${REAP_ENABLED ? 'ON (CPM_PORT_JANITOR_REAP)' : 'OFF'})`);
}
