import { getDb } from '../db/index.js';

/**
 * Per-user long-term memory store (Mem0 / OpenMemory) exposed to agents as an
 * MCP server.
 *
 * The store is USER-SPECIFIC: each Coder user points at their own memory
 * endpoint (the URL embeds the user's namespace). We never share one user's
 * memories with another. Users without a configured endpoint simply get no
 * memory MCP — agents fall back to the local file-based memory only.
 *
 * Configuration lives in the CPM_MEMORY_MCP_URLS environment variable (read via
 * dotenv from `.env`), a JSON object mapping Coder username → endpoint. The
 * value is either the SSE URL string, or an object `{ "url": "...", "type":
 * "sse" | "http" }` when the transport isn't SSE. Example `.env` line:
 *
 *   CPM_MEMORY_MCP_URLS={"magnus":"http://192.168.1.199:8765/mcp/openmemory/sse/magnus"}
 */

// The MCP server name agents see; tools are exposed as `mcp__openmemory__*`.
export const MEMORY_MCP_SERVER_NAME = 'openmemory';

// Allow every tool from the memory server so calls auto-approve in headless
// (`claude -p`) mode. Append this to the task's --allowedTools list.
export const MEMORY_MCP_ALLOWED_TOOL = `mcp__${MEMORY_MCP_SERVER_NAME}`;

interface MemoryEndpoint {
  url: string;
  type: 'sse' | 'http';
}

let parsed: Record<string, MemoryEndpoint> | null = null;
let parsedRaw: string | undefined;

/** Parse (and cache) the CPM_MEMORY_MCP_URLS env var into a username→endpoint map. */
function getConfig(): Record<string, MemoryEndpoint> {
  const raw = process.env.CPM_MEMORY_MCP_URLS;
  // Re-parse only if the env value changed (it normally never does at runtime).
  if (parsed && raw === parsedRaw) return parsed;
  parsedRaw = raw;
  parsed = {};
  if (!raw || !raw.trim()) return parsed;

  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      console.warn('[memory-mcp] CPM_MEMORY_MCP_URLS is not a JSON object — ignoring');
      return parsed;
    }
    for (const [username, value] of Object.entries(obj)) {
      let url: string | undefined;
      let type: 'sse' | 'http' = 'sse';
      if (typeof value === 'string') {
        url = value;
      } else if (value && typeof value === 'object') {
        const v = value as { url?: unknown; type?: unknown };
        if (typeof v.url === 'string') url = v.url;
        if (v.type === 'http' || v.type === 'sse') type = v.type;
      }
      if (!url || !/^https?:\/\//.test(url)) {
        console.warn(`[memory-mcp] Skipping invalid memory URL for user "${username}"`);
        continue;
      }
      parsed[username] = { url, type };
    }
  } catch (err) {
    console.warn('[memory-mcp] Failed to parse CPM_MEMORY_MCP_URLS:', (err as Error).message?.slice(0, 120));
  }
  return parsed;
}

/** Resolve a Coder username from a user_id via the cached users table. */
function usernameForUserId(userId: string | null | undefined): string | null {
  if (!userId) return null;
  try {
    const row = getDb().prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username?: string } | undefined;
    return row?.username ?? null;
  } catch {
    return null;
  }
}

/** Get the configured memory endpoint for a Coder user_id, or null if none. */
export function getMemoryEndpointForUser(userId: string | null | undefined): MemoryEndpoint | null {
  const username = usernameForUserId(userId);
  if (!username) return null;
  const cfg = getConfig();
  return cfg[username] ?? null;
}

/**
 * Build the JSON string for `claude --mcp-config` that registers the user's
 * memory server, or null when the user has no configured endpoint.
 */
export function buildMemoryMcpConfig(userId: string | null | undefined): string | null {
  const endpoint = getMemoryEndpointForUser(userId);
  if (!endpoint) return null;
  return JSON.stringify({
    mcpServers: {
      [MEMORY_MCP_SERVER_NAME]: { type: endpoint.type, url: endpoint.url },
    },
  });
}

/**
 * System-prompt fragment instructing the agent to use the memory store for both
 * saving durable knowledge and recalling it. Only appended when the user has a
 * memory endpoint configured.
 */
export const MEMORY_USAGE_PROMPT = `PERSISTENT MEMORY — you have a long-term memory store:
You have access to a personal long-term memory store via the \`${MEMORY_MCP_SERVER_NAME}\` MCP server (its tools are prefixed \`mcp__${MEMORY_MCP_SERVER_NAME}__\`, e.g. tools to add and to search/recall memories). This memory persists across tasks and sessions and belongs to the user who owns this work — treat it as the durable record of what you've learned for them.

- RECALL on start: before diving in, search your memory for anything relevant to the task — the user's preferences, prior decisions, project conventions, and known gotchas. Let what you find shape your approach. Recall again whenever you hit something the user has likely told you before.
- SAVE as you go: whenever you learn something durable and worth keeping — a user preference, a project decision or convention, a non-obvious fact, or how a tricky problem was resolved — save it to memory promptly. Don't batch it to the end of the task; write it the moment you learn it, because context can be lost before you finish.
- Keep entries concise and factual. Do NOT store secrets, tokens, credentials, or throwaway details that won't matter later.

This MCP memory store is the primary place for cross-task knowledge; use it in addition to any local memory files.`;
