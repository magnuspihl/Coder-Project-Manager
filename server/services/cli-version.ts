import { sshExec } from './claude.js';

/**
 * Per-workspace Claude Code CLI version tracking.
 *
 * Each workspace carries its own `claude` binary in its persistent home volume.
 * Nothing updates it on its own: the Coder template installs it only when the
 * binary is missing (`if ! command -v claude`), and the home volume survives
 * rebuilds, so the installer never runs a second time. The in-app updater is
 * disabled too (`autoUpdates: false` in ~/.claude.json). The practical effect is
 * that a workspace is pinned to whatever version was current the day it was
 * first created, which drifts arbitrarily far behind over time.
 *
 * That matters to CPM because the model dropdown is global while CLI support for
 * a model is per-workspace: offering Opus 5.5 on a workspace whose CLI predates
 * it produces a confusing runtime failure rather than a clear "too old" signal.
 * So we probe each workspace for its version and for the model IDs its binary
 * actually knows about, and let the UI warn before the task is launched.
 */

export interface CliInfo {
  /** Installed version, e.g. "2.1.247". Null when the probe failed. */
  version: string | null;
  /** Newest version on the `stable` release channel. Null when unreachable. */
  latest_stable: string | null;
  /** Newest version on the `latest` release channel. Null when unreachable. */
  latest: string | null;
  /** True only when both versions are known and the installed one is older. */
  update_available: boolean;
  /**
   * Model IDs found in the CLI binary. Empty when the probe failed — callers
   * must treat empty as "unknown", never as "supports nothing".
   */
  known_model_ids: string[];
}

const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { info: CliInfo; timestamp: number }>();

// Release channels are global, not per-workspace.
const CHANNEL_TTL_MS = 60 * 60 * 1000;
const RELEASES_BASE =
  'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases';
let channelCache: { stable: string | null; latest: string | null; timestamp: number } | null = null;

/** CPM launches the agent with this same PATH prefix, so probe what it will run. */
const PATH_PREFIX = 'export PATH="$HOME/.local/bin:$PATH"';

export async function getCliInfo(workspaceName: string, userId?: string | null): Promise<CliInfo> {
  const cached = cache.get(workspaceName);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.info;
  }

  const [probe, channels] = await Promise.all([
    probeWorkspace(workspaceName, userId),
    fetchChannels(),
  ]);

  const info: CliInfo = {
    version: probe.version,
    latest_stable: channels.stable,
    latest: channels.latest,
    update_available: !!(probe.version && channels.stable && compareVersions(probe.version, channels.stable) < 0),
    known_model_ids: probe.knownModelIds,
  };

  cache.set(workspaceName, { info, timestamp: Date.now() });
  return info;
}

/** Drop a workspace's cached probe — call after an update so the UI re-reads. */
export function invalidateCliInfo(workspaceName: string): void {
  cache.delete(workspaceName);
}

/**
 * Run `claude update` in a workspace. Returns the new version on success.
 *
 * The updater downloads a ~250MB binary, hence the generous timeout. It writes a
 * new file into ~/.local/share/claude/versions and repoints the launcher; already
 * running agents keep executing the binary they started with, so an update is
 * safe to trigger while tasks are in flight.
 */
export async function updateCli(
  workspaceName: string,
  userId?: string | null,
): Promise<{ ok: boolean; version: string | null; output: string }> {
  let output: string;
  try {
    output = await sshExec(
      workspaceName,
      `${PATH_PREFIX}; claude update 2>&1 | tail -20`,
      5 * 60 * 1000,
      userId,
    );
  } catch (err) {
    return { ok: false, version: null, output: (err as Error).message.slice(0, 2000) };
  }

  invalidateCliInfo(workspaceName);
  const after = await probeWorkspace(workspaceName, userId).catch(() => ({ version: null, knownModelIds: [] }));
  return { ok: after.version !== null, version: after.version, output: (output || '').trim().slice(0, 2000) };
}

// ─── Probing ────────────────────────────────────────────────────────────

interface Probe {
  version: string | null;
  knownModelIds: string[];
}

/**
 * One SSH round trip for both facts. The model-ID grep scans the whole CLI
 * binary (~250MB), which is why this is cached for half an hour rather than
 * fetched per render — but it is the only way to know what a given CLI supports
 * without maintaining a hand-written model-to-CLI-version table that would go
 * stale exactly as silently as the CLIs themselves.
 */
async function probeWorkspace(workspaceName: string, userId?: string | null): Promise<Probe> {
  try {
    const raw = await sshExec(
      workspaceName,
      `${PATH_PREFIX}
       echo "VERSION:$(claude --version 2>/dev/null | head -1)"
       BIN=$(readlink -f "$(command -v claude 2>/dev/null)" 2>/dev/null)
       if [ -n "$BIN" ] && [ -f "$BIN" ]; then
         echo "MODELS:$(grep -aoE 'claude-[a-z]+-[0-9][a-z0-9-]*' "$BIN" 2>/dev/null | sort -u | head -200 | tr '\\n' ',')"
       fi`,
      60000,
      userId,
    );

    const versionLine = /^VERSION:(.*)$/m.exec(raw || '')?.[1]?.trim() ?? '';
    // `claude --version` prints "2.1.247 (Claude Code)".
    const version = /^(\d+\.\d+\.\d+)/.exec(versionLine)?.[1] ?? null;

    const modelsLine = /^MODELS:(.*)$/m.exec(raw || '')?.[1] ?? '';
    const knownModelIds = modelsLine
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    return { version, knownModelIds };
  } catch {
    return { version: null, knownModelIds: [] };
  }
}

async function fetchChannels(): Promise<{ stable: string | null; latest: string | null }> {
  if (channelCache && Date.now() - channelCache.timestamp < CHANNEL_TTL_MS) {
    return { stable: channelCache.stable, latest: channelCache.latest };
  }

  const read = async (channel: string): Promise<string | null> => {
    try {
      const res = await fetch(`${RELEASES_BASE}/${channel}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const text = (await res.text()).trim();
      return /^\d+\.\d+\.\d+$/.test(text) ? text : null;
    } catch {
      return null;
    }
  };

  const [stable, latest] = await Promise.all([read('stable'), read('latest')]);
  channelCache = { stable, latest, timestamp: Date.now() };
  return { stable, latest };
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Numeric dotted compare. Returns <0 when a is older than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Whether a workspace's CLI is known to lack support for a model.
 *
 * Deliberately fails open: an empty probe, a non-Anthropic model, or a CLI whose
 * binary we could not read all return false. A false "unsupported" warning on a
 * model that works is worse than staying quiet.
 */
export function isModelUnsupported(info: CliInfo, modelId: string): boolean {
  if (!modelId || modelId.startsWith('ollama/')) return false;
  if (info.known_model_ids.length === 0) return false;
  return !info.known_model_ids.includes(modelId);
}
