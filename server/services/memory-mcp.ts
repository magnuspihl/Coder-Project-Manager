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
 * Two configuration sources (read via dotenv from `.env`), checked in order:
 *
 * 1. CPM_MEMORY_MCP_URLS — a JSON object mapping Coder username → endpoint. The
 *    value is either the SSE URL string, or an object `{ "url": "...", "type":
 *    "sse" | "http" }` when the transport isn't SSE. Use this for users on a
 *    different server, or to opt a specific user in/out. Example:
 *
 *      CPM_MEMORY_MCP_URLS={"magnus":"http://192.168.1.199:8765/mcp/openmemory/sse/magnus"}
 *
 * 2. CPM_MEMORY_MCP_URL_TEMPLATE — a single URL with `{username}` (required) and
 *    optional `{workspace}` placeholders. When a user has no explicit map entry,
 *    their endpoint is derived by substituting their Coder username and the
 *    target workspace name. `{workspace}` lets each workspace write under its own
 *    OpenMemory app (the `/mcp/<app>/` path segment), e.g. `cpm-{workspace}`:
 *
 *      CPM_MEMORY_MCP_URL_TEMPLATE=http://192.168.1.199:8765/mcp/cpm-{workspace}/sse/{username}
 *
 * Both sources support `{username}` and `{workspace}`. An explicit map entry
 * always wins over the template.
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
      if (!url) {
        console.warn(`[memory-mcp] Skipping memory entry for user "${username}" — no URL`);
        continue;
      }
      // The URL is stored raw: it may contain {username}/{workspace} placeholders
      // that are resolved per task (workspace varies), so the final http(s) check
      // happens at resolution time, not here.
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

// Only allow URL-safe values into a URL path segment (Coder usernames and
// workspace names are lowercase alphanumerics + hyphens).
const URL_SAFE = /^[a-zA-Z0-9_-]+$/;

/**
 * Substitute the `{username}` and `{workspace}` placeholders in a URL. Returns
 * null when a placeholder is present but its value isn't URL-safe, or when the
 * result isn't an http(s) URL.
 */
function resolveUrl(rawUrl: string, username: string, workspaceName: string): string | null {
  let url = rawUrl;
  if (url.includes('{username}')) {
    if (!URL_SAFE.test(username)) {
      console.warn(`[memory-mcp] Username "${username}" is not URL-safe — skipping`);
      return null;
    }
    url = url.replaceAll('{username}', username);
  }
  if (url.includes('{workspace}')) {
    if (!URL_SAFE.test(workspaceName)) {
      console.warn(`[memory-mcp] Workspace "${workspaceName}" is not URL-safe — skipping`);
      return null;
    }
    url = url.replaceAll('{workspace}', workspaceName);
  }
  if (!/^https?:\/\//.test(url)) {
    console.warn('[memory-mcp] Memory URL did not resolve to an http(s) URL — ignoring');
    return null;
  }
  return url;
}

/**
 * Derive an endpoint from CPM_MEMORY_MCP_URL_TEMPLATE by substituting the
 * username/workspace placeholders. Returns null when no template is set or it
 * lacks the `{username}` placeholder.
 */
function endpointFromTemplate(username: string, workspaceName: string): MemoryEndpoint | null {
  const template = process.env.CPM_MEMORY_MCP_URL_TEMPLATE;
  if (!template || !template.includes('{username}')) return null;
  const url = resolveUrl(template, username, workspaceName);
  return url ? { url, type: 'sse' } : null;
}

/**
 * Get the configured memory endpoint for a Coder user_id on a given workspace,
 * or null if none. An explicit CPM_MEMORY_MCP_URLS entry wins; otherwise fall
 * back to the CPM_MEMORY_MCP_URL_TEMPLATE. Both support `{username}` and
 * `{workspace}` placeholders (the latter lets each workspace write under its
 * own app, e.g. `cpm-{workspace}`).
 */
export function getMemoryEndpointForUser(
  userId: string | null | undefined,
  workspaceName: string,
): MemoryEndpoint | null {
  const username = usernameForUserId(userId);
  if (!username) return null;
  const mapEntry = getConfig()[username];
  if (mapEntry) {
    const url = resolveUrl(mapEntry.url, username, workspaceName);
    return url ? { url, type: mapEntry.type } : null;
  }
  return endpointFromTemplate(username, workspaceName);
}

/**
 * Build the JSON string for `claude --mcp-config` that registers the user's
 * memory server for a workspace, or null when there's no configured endpoint.
 */
export function buildMemoryMcpConfig(
  userId: string | null | undefined,
  workspaceName: string,
): string | null {
  const endpoint = getMemoryEndpointForUser(userId, workspaceName);
  if (!endpoint) return null;
  return JSON.stringify({
    mcpServers: {
      [MEMORY_MCP_SERVER_NAME]: { type: endpoint.type, url: endpoint.url },
    },
  });
}

// The Shared Memory Standard — Magnus's "second brain" conventions. Embedded
// verbatim into every memory-enabled agent's system prompt so all writes follow
// one schema (types, atomic entries, dedup, no secrets). §6's server-side config
// is an operator action, not an agent action — the wrapper prompt notes this.
const MEMORY_STANDARD = `# Shared Memory Standard — Magnus's Second Brain

> Hand this document to any AI agent that reads from or writes to the shared
> memory store. It defines how memories are structured, typed, and sourced so
> that every tool contributes to one coherent brain instead of fragmenting it.

## 1. What this store is

This is a single, shared long-term memory for one person, **Magnus**, used by
*all* of his AI assistants (Claude across Chat/Cowork/Code, and any other tools).

- **One user.** Every memory is stored under \`user_id = magnus\`. Retrieval is
  scoped by user, so all agents read the same pool. Do **not** create other users
  to separate topics — that re-fragments the brain.
- **The "app"/\`client_name\` is provenance, not a wall.** It records *which agent*
  wrote a memory. All apps can read all of Magnus's memories by default; the app
  label exists for attribution, auditing, and the ability to pause a misbehaving
  source — not to silo knowledge.

## 2. Your job as a writing agent

**Save** durable, reusable knowledge — things that will still matter in weeks or
months: facts about Magnus and his world, his preferences, decisions, hard rules,
and project context.

**Do not save:**
- Transient state, small talk, or anything tied to a single throwaway task.
- Secrets (passwords, API keys, tokens). Store *where to find* a secret, never the
  secret itself.
- Duplicates. Before writing, search for an existing memory on the same subject and
  **update/supersede** it instead of adding a near-copy.

**Write atomically.** Prefer one idea per memory, phrased so it stands on its own
without the surrounding conversation. Large reference docs are acceptable when the
content is genuinely one topic, but split unrelated ideas apart.

## 3. Memory format

Every memory uses YAML frontmatter followed by a markdown body:

\`\`\`
---
type: <profile|preference|rule|project|fact|event>   # required, see §4
name: <short human-readable title>                    # required
domain: <optional subject area, e.g. homelab|family|finance|work|health>
created: <YYYY-MM-DD>                                  # date written
source: <writing agent, e.g. claude-cowork>            # who wrote this
supersedes: <optional: name/id of memory this replaces>
---

<body — the actual knowledge>
\`\`\`

For \`type: rule\`, the body **must** include a short **"How to apply"** section with
concrete, checkable steps, and preserve the original reasoning ("Why") in full.

## 4. The \`type\` taxonomy (fixed set)

Use exactly one of these. If a memory doesn't clearly fit, default to \`fact\`.

| type | Use for | Not for |
|------|---------|---------|
| \`profile\` | Durable facts about Magnus, his people, and his environment/systems (who/what things are). | How he likes things done (→ \`preference\`). |
| \`preference\` | How Magnus likes things done — reversible choices, style, defaults, likes/dislikes. | Hard constraints that must never be broken (→ \`rule\`). |
| \`rule\` | Non-negotiable constraints, usually safety/ops lessons. Always/never. | Soft preferences; one-off decisions (→ \`event\`). |
| \`project\` | Goals, context, and current status of ongoing work or initiatives. | Stable background facts (→ \`profile\`). |
| \`fact\` | Discrete reference facts *not* about Magnus personally — endpoints, locations, values, how a system is wired. | Anything about Magnus himself (→ \`profile\`). |
| \`event\` | Something that happened, with a date — decisions made, incidents, milestones. | Standing rules derived from an incident (→ \`rule\`). |

### Examples

\`\`\`
---
type: rule
name: Never split FUSE backup sync into per-tier syncs
domain: homelab
created: 2026-03-25
source: claude-code
---
Always sync /mnt/user/Docker/Data (FUSE merged view) as a single blanket sync.
NEVER optimize by syncing physical tiers separately.

**Why:** Per-tier deduplication has caused data loss twice (2026-03-23, 2026-03-25);
a container's files can be split across disks, so a per-tier sync silently drops data.

**How to apply:**
1. Backup source is always the FUSE path, never a physical disk path.
2. If you find yourself checking "is this container on NVMe?" in the backup script — stop.
3. Verify backups by restoring/size-comparing against all physical disks, not by listing.
\`\`\`

\`\`\`
---
type: preference
name: Prefer prose over bullet points
domain: communication
created: 2026-06-22
source: claude-chat
---
Magnus prefers concise, direct answers in prose. Avoid heavy formatting, bullet
lists, and bold unless a comparison genuinely needs a table.
\`\`\`

## 5. Source naming (\`client_name\` / app)

Give each tool a stable, descriptive source name so provenance stays meaningful.
Recommended convention: \`<vendor>-<surface>\`, e.g.:

- \`claude-cowork\`, \`claude-code\`, \`claude-chat\`
- \`cursor\`, \`chatgpt\`, \`homelab-agent\`

Avoid the generic default (\`openmemory\`) — if everything shares one app name you
lose all provenance signal.

## 6. \`custom_instructions\` (for inferred writes)

Two write modes exist:

- **Curated (preferred):** the agent writes a fully-formed memory following §3–§4
  with inference off. This document is what enforces the standard.
- **Inferred:** the agent passes raw text and the memory layer's LLM extracts facts.
  Only in this mode does \`custom_instructions\` apply.

Set the store's \`custom_instructions\` to the following so inferred writes match the
same standard (paste into the OpenMemory config / \`PUT /api/v1/config/openmemory\`):

\`\`\`
These memories form a single shared second brain for one person, Magnus, used by all
of his AI assistants across tools. When extracting memories:
1. Capture only durable, reusable knowledge (facts, preferences, decisions, rules,
   project context) that will still matter in weeks or months. Ignore small talk,
   transient state, and anything tied to a single throwaway task.
2. Classify every memory with exactly one \`type\`: profile, preference, rule, project,
   fact, or event. If none fits, use \`fact\`.
3. Write each memory as a self-contained statement understandable without the
   surrounding conversation. Prefer one idea per memory.
4. Preserve imperative safety/operational rules ("always…/never…") verbatim and in
   full, including the reasoning and how-to-apply steps.
5. Before adding, check for an existing memory on the same subject and update or
   supersede it rather than duplicating.
6. Never store secrets (passwords, API keys, tokens) as content — only where to find them.
\`\`\`

## 7. Maintenance

- **Dedup on write** (search first; supersede, don't duplicate).
- Periodically review \`rule\` and \`project\` memories for staleness; mark superseded
  ones via the \`supersedes\` field or archive them.
- Keep \`type\` and \`domain\` values inside their controlled vocabularies; if you need a
  new value, it should be a deliberate, documented addition — not ad hoc.`;

// MEMORY_STANDARD above is Magnus's personal "second brain" spec — it names him
// throughout (and his homelab examples) and asserts `user_id = magnus`. It is
// therefore only meaningful for, and only attached to, this owner's sessions.
// Other Coder users get the generic user-scoped prompt without it. (If another
// user later supplies their own standard, give it its own owner entry.)
const MEMORY_STANDARD_OWNER = 'magnus';

/**
 * Build the system-prompt fragment instructing the agent to recall from and save
 * to the user's long-term memory store. Parameterized by the resolving user so
 * its identity references are correct per Coder user (the store is user-scoped).
 * `workspaceName` becomes the `cpm-<workspace>` source/app the writes attribute
 * to. The Shared Memory Standard is appended only for the user who owns it. Only
 * called when the user has a memory endpoint configured.
 */
export function buildMemoryUsagePrompt(userId: string | null | undefined, workspaceName: string): string {
  const username = usernameForUserId(userId);
  const source = `cpm-${workspaceName}`;
  // Possessive/identity phrasing for whoever owns this store.
  const owner = username ? `\`${username}\`` : 'the user who owns this work';
  const userScope = username ? `the single user \`${username}\`` : 'a single user';

  let prompt = `PERSISTENT MEMORY — you have a long-term memory store (Mem0/OpenMemory):
You have access to ${owner}'s long-term memory via the \`${MEMORY_MCP_SERVER_NAME}\` MCP server (its tools are prefixed \`mcp__${MEMORY_MCP_SERVER_NAME}__\`, e.g. tools to add and to search/recall memories). It is a coherent memory shared across that user's AI assistants, scoped to ${userScope} — never mix in or assume another user's memories. Your writes are attributed to the app/source \`${source}\`.

- RECALL on start: before diving in, search memory for anything relevant to the task — the user's preferences, prior decisions, project context, rules, and known gotchas. Let what you find shape your approach, and recall again whenever you hit something they have likely told you before.
- SAVE as you go: whenever you learn something durable and worth keeping (a preference, a decision, a hard rule, project context, or a non-obvious fact), save it promptly — don't batch it to the end, context can be lost before you finish.

HOW TO WRITE:
- Write CURATED entries with inference OFF: when the add/write tool exposes an \`infer\` parameter, set \`infer=false\`. YOU author the final memory — do not hand raw text to the server to re-extract.
- Author each memory as a self-contained entry, one idea each, that stands on its own without the surrounding conversation. Give it a short header — its \`type\` (exactly one of: profile, preference, rule, project, fact, event), a clear \`name\`, today's date, and \`source: ${source}\` — followed by the content. For a \`rule\`, include the original reasoning ("Why") and a concrete "How to apply" section.
- Search before writing and update/supersede an existing memory on the same subject instead of adding a near-duplicate.
- Never store secrets, tokens, or credentials as content — only where to find them.

This memory store is the primary place for cross-task knowledge; use it in addition to any local memory files.`;

  // Attach the owner's personal standard, when it's theirs. It defines the
  // schema/taxonomy curated writes must follow. CPM agents write curated
  // (infer=false), which is exactly the standard's preferred mode (§6), so its
  // §3 frontmatter+body format applies directly.
  if (username === MEMORY_STANDARD_OWNER) {
    prompt += `

Follow ${owner}'s Shared Memory Standard below exactly: author curated writes in its §3 frontmatter+body format using the §4 \`type\` taxonomy (with \`source: ${source}\`). Its §6 server \`custom_instructions\` govern inferred writes only and are managed by the operator — since you write curated (infer=false), they don't apply to you.

================= SHARED MEMORY STANDARD =================
${MEMORY_STANDARD}
=============== END SHARED MEMORY STANDARD ===============`;
  }

  return prompt;
}
