import { getDb } from '../db/index.js';

/**
 * Meshy (meshy.ai) 3D/image generation exposed to agents as an MCP server.
 *
 * Unlike [[midjourney-mcp.ts]], Meshy ships its own official MCP server
 * (`@meshy-ai/meshy-mcp-server`) with an official REST API behind it — there
 * is no unofficial-automation risk here, and no standalone bridge to host.
 * CPM just needs to register it as a local `stdio` MCP server (Claude Code
 * spawns it via `npx` inside the workspace) with the user's API key in its
 * env. The key never touches the workspace's disk or CPM's database; it
 * rides the `--mcp-config` argument for that one launch (same exposure
 * profile as the memory/Midjourney bearer tokens already handled this way —
 * visible via `ps aux` on the workspace to anyone with shell access there).
 *
 * Configuration, same two-source shape as memory-mcp/midjourney-mcp:
 *
 * 1. CPM_MESHY_API_KEYS — JSON object mapping Coder username → API key, for
 *    opting specific users in/out or giving them their own key:
 *
 *      CPM_MESHY_API_KEYS={"magnus":"msy_..."}
 *
 * 2. CPM_MESHY_API_KEY — a single shared key applied to every user who has no
 *    explicit map entry (the common case — one Meshy account/plan shared by
 *    whoever is allowed to use it, same as the Midjourney bridge default).
 *
 * Users who resolve to no key simply get no Meshy MCP.
 */

export const MESHY_MCP_SERVER_NAME = 'meshy';
export const MESHY_MCP_ALLOWED_TOOL = `mcp__${MESHY_MCP_SERVER_NAME}`;

let parsed: Record<string, string> | null = null;
let parsedRaw: string | undefined;

function getConfig(): Record<string, string> {
  const raw = process.env.CPM_MESHY_API_KEYS;
  if (parsed && raw === parsedRaw) return parsed;
  parsedRaw = raw;
  parsed = {};
  if (!raw || !raw.trim()) return parsed;

  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      console.warn('[meshy-mcp] CPM_MESHY_API_KEYS is not a JSON object — ignoring');
      return parsed;
    }
    for (const [username, value] of Object.entries(obj)) {
      if (typeof value !== 'string' || !value) {
        console.warn(`[meshy-mcp] Skipping entry for user "${username}" — value must be a non-empty string`);
        continue;
      }
      parsed[username] = value;
    }
  } catch (err) {
    console.warn('[meshy-mcp] Failed to parse CPM_MESHY_API_KEYS:', (err as Error).message?.slice(0, 120));
  }
  return parsed;
}

function usernameForUserId(userId: string | null | undefined): string | null {
  if (!userId) return null;
  try {
    const row = getDb().prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username?: string } | undefined;
    return row?.username ?? null;
  } catch {
    return null;
  }
}

/** Resolve the configured Meshy API key for a user, or null if none. */
export function getMeshyApiKeyForUser(userId: string | null | undefined): string | null {
  const username = usernameForUserId(userId);
  if (!username) return null;
  const mapEntry = getConfig()[username];
  if (mapEntry) return mapEntry;
  return process.env.CPM_MESHY_API_KEY || null;
}

/**
 * Build the `--mcp-config` server entry (merged with other MCP servers by
 * the caller) registering Meshy's official stdio MCP server for a user, or
 * null when there's no configured key for them.
 */
export function buildMeshyMcpServerEntry(userId: string | null | undefined): Record<string, unknown> | null {
  const apiKey = getMeshyApiKeyForUser(userId);
  if (!apiKey) return null;
  return {
    [MESHY_MCP_SERVER_NAME]: {
      command: 'npx',
      args: ['-y', '@meshy-ai/meshy-mcp-server'],
      env: { MESHY_API_KEY: apiKey },
    },
  };
}

/**
 * System-prompt fragment. Meshy's own tools are well self-described, so this
 * only adds what the tool descriptions can't know: the credit-spend framing
 * and the same generate → judge → iterate → curate loop used for Midjourney.
 */
export function buildMeshyUsagePrompt(): string {
  return `MESHY 3D/IMAGE GENERATION — you have access to a Meshy account via the \`${MESHY_MCP_SERVER_NAME}\` MCP server (tools prefixed \`mcp__${MESHY_MCP_SERVER_NAME}__meshy_*\`, e.g. text-to-3d, image-to-3d, remesh, retexture, rig, animate, text-to-image, plus task management and \`check-balance\`). Every generation call spends real account credits, so use it deliberately:

- Generation tasks are async — create the task, then poll get-task-status (or list-tasks) until it completes before acting on the result.
- JUDGE before committing further credits: once a task completes, look at the preview/thumbnail it returns and assess it against the brief before refining, retexturing, rigging, or spending more credits on it.
- ITERATE with intent — refine the prompt or inputs based on what you saw, rather than repeatedly regenerating from scratch.
- CURATE: once you have result(s) worth keeping, use download-model (or the equivalent for images) to save into a path INSIDE your current working directory — a relative path or an explicit \`$(pwd)/...\` path. NEVER an absolute path outside it (e.g. \`/home/coder/...\`) — CPM's OUTPUT_FILE delivery rejects anything outside your task's working directory. Then hand the file(s) to the user via the OUTPUT_FILE convention, with a short rationale for what you picked.
- If a call fails or balance looks low, check-balance and surface that to the user rather than silently retrying.

Never claim a model/image was generated or modified unless a tool call actually returned it.`;
}
