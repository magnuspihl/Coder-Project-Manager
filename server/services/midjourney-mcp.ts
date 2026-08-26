import { getDb } from '../db/index.js';

/**
 * Midjourney image generation exposed to agents as an MCP server, backed by
 * `mj-bridge` — a standalone service (see `mj-bridge/README.md`) that holds a
 * real Discord account and drives the Midjourney bot, since Midjourney still
 * has no official API.
 *
 * Same shape as [[memory-mcp.ts]]'s Mem0/OpenMemory wiring on purpose: the
 * bridge is USER-SPECIFIC (each Coder user resolves to their own endpoint —
 * there is no shared default), configured via two sources checked in order:
 *
 * 1. CPM_MIDJOURNEY_MCP_URLS — JSON object mapping Coder username → endpoint.
 *    Value is the URL string, or `{ "url": "...", "token": "..." }` when the
 *    bridge is token-protected (sent as `Authorization: Bearer <token>`).
 *
 *      CPM_MIDJOURNEY_MCP_URLS={"magnus":{"url":"http://192.168.1.199:8901/mcp","token":"..."}}
 *
 * 2. CPM_MIDJOURNEY_MCP_URL_TEMPLATE / CPM_MIDJOURNEY_MCP_TOKEN — a single
 *    shared bridge (there's normally only one Midjourney account, so unlike
 *    memory this is usually the same endpoint for every user who's enabled).
 *    Template supports `{username}` only if you're actually running one
 *    bridge per user; a plain fixed URL with no placeholders is the common
 *    case:
 *
 *      CPM_MIDJOURNEY_MCP_URL_TEMPLATE=http://192.168.1.199:8901/mcp
 *      CPM_MIDJOURNEY_MCP_TOKEN=...
 *
 *    Falls back to MJ_BRIDGE_TOKEN (the bridge's own auth env var, see
 *    mj-bridge/README.md) if CPM_MIDJOURNEY_MCP_TOKEN isn't set — the two are
 *    almost always the same value, and it's an easy var to set once for the
 *    bridge deployment and forget to also mirror into CPM's config.
 *
 * A bridge whose token can't be resolved is treated as unconfigured (no MCP
 * entry, no `authenticate`-only tool stub, no system-prompt fragment) rather
 * than wired up without a credential — mj-bridge rejects unauthenticated
 * requests outright, so an entry with no `headers` would just hand the agent
 * broken tools. Users without a configured endpoint simply get no Midjourney
 * MCP.
 */

export const MIDJOURNEY_MCP_SERVER_NAME = 'midjourney';
export const MIDJOURNEY_MCP_ALLOWED_TOOL = `mcp__${MIDJOURNEY_MCP_SERVER_NAME}`;

interface MjEndpoint {
  url: string;
  /** Never null — an endpoint with no resolvable token is treated as unconfigured (see getConfig/endpointFromTemplate). */
  token: string;
}

/** Raw CPM_MIDJOURNEY_MCP_URLS entry, before the missing-token check that turns it into (or drops) an MjEndpoint. */
interface RawMjEndpoint {
  url: string;
  token: string | null;
}

let parsed: Record<string, RawMjEndpoint> | null = null;
let parsedRaw: string | undefined;

function getConfig(): Record<string, RawMjEndpoint> {
  const raw = process.env.CPM_MIDJOURNEY_MCP_URLS;
  if (parsed && raw === parsedRaw) return parsed;
  parsedRaw = raw;
  parsed = {};
  if (!raw || !raw.trim()) return parsed;

  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      console.warn('[midjourney-mcp] CPM_MIDJOURNEY_MCP_URLS is not a JSON object — ignoring');
      return parsed;
    }
    for (const [username, value] of Object.entries(obj)) {
      let url: string | undefined;
      let token: string | null = null;
      if (typeof value === 'string') {
        url = value;
      } else if (value && typeof value === 'object') {
        const v = value as { url?: unknown; token?: unknown };
        if (typeof v.url === 'string') url = v.url;
        if (typeof v.token === 'string') token = v.token;
      }
      if (!url) {
        console.warn(`[midjourney-mcp] Skipping entry for user "${username}" — no URL`);
        continue;
      }
      parsed[username] = { url, token };
    }
  } catch (err) {
    console.warn('[midjourney-mcp] Failed to parse CPM_MIDJOURNEY_MCP_URLS:', (err as Error).message?.slice(0, 120));
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

const URL_SAFE = /^[a-zA-Z0-9_-]+$/;

function resolveUrl(rawUrl: string, username: string): string | null {
  let url = rawUrl;
  if (url.includes('{username}')) {
    if (!URL_SAFE.test(username)) {
      console.warn(`[midjourney-mcp] Username "${username}" is not URL-safe — skipping`);
      return null;
    }
    url = url.replaceAll('{username}', username);
  }
  if (!/^https?:\/\//.test(url)) {
    console.warn('[midjourney-mcp] Midjourney bridge URL did not resolve to an http(s) URL — ignoring');
    return null;
  }
  return url;
}

function endpointFromTemplate(username: string): MjEndpoint | null {
  const template = process.env.CPM_MIDJOURNEY_MCP_URL_TEMPLATE;
  if (!template) return null;
  const url = resolveUrl(template, username);
  if (!url) return null;
  const token = process.env.CPM_MIDJOURNEY_MCP_TOKEN || process.env.MJ_BRIDGE_TOKEN || null;
  if (!token) {
    console.warn('[midjourney-mcp] CPM_MIDJOURNEY_MCP_URL_TEMPLATE is set but no token was found ' +
      '(CPM_MIDJOURNEY_MCP_TOKEN / MJ_BRIDGE_TOKEN) — treating the bridge as unconfigured');
    return null;
  }
  return { url, token };
}

/** Resolve the configured Midjourney bridge endpoint for a user, or null if none. */
export function getMidjourneyEndpointForUser(userId: string | null | undefined): MjEndpoint | null {
  const username = usernameForUserId(userId);
  if (!username) return null;
  const mapEntry = getConfig()[username];
  if (mapEntry) {
    const url = resolveUrl(mapEntry.url, username);
    if (!url) return null;
    if (!mapEntry.token) {
      console.warn(`[midjourney-mcp] CPM_MIDJOURNEY_MCP_URLS entry for "${username}" has no token — treating as unconfigured`);
      return null;
    }
    return { url, token: mapEntry.token };
  }
  return endpointFromTemplate(username);
}

/**
 * Build the `--mcp-config` fragment (as a plain object, merged with other MCP
 * servers by the caller) registering the user's Midjourney bridge, or null
 * when there's no configured (and authenticated) endpoint for them.
 */
export function buildMidjourneyMcpServerEntry(userId: string | null | undefined): Record<string, unknown> | null {
  const endpoint = getMidjourneyEndpointForUser(userId);
  if (!endpoint) return null;
  return {
    [MIDJOURNEY_MCP_SERVER_NAME]: {
      type: 'http',
      url: endpoint.url,
      headers: { Authorization: `Bearer ${endpoint.token}` },
    },
  };
}

/**
 * System-prompt fragment teaching the agent the generate → judge → iterate →
 * curate loop, plus the two things that don't work by default: image
 * references (neither backend accepts a local file, only a URL) and where
 * downloaded files must land (CPM's OUTPUT_FILE delivery refuses paths
 * outside the task's own working directory). Only appended when the user has
 * a configured endpoint. Covers both tools this MCP server may expose —
 * Midjourney (always, if the endpoint is configured) and FLUX
 * (flux_generate/flux_edit, only if the bridge itself has BFL_API_KEY set —
 * there's no separate CPM-side signal for that, so this fragment just
 * describes both and lets the agent notice which tools are actually present).
 */
export function buildMidjourneyUsagePrompt(userId: string | null | undefined): string {
  const endpoint = getMidjourneyEndpointForUser(userId);
  const bridgeBase = endpoint ? endpoint.url.replace(/\/mcp\/?$/, '') : null;
  const uploadCmd = (filename: string) =>
    `curl -s -X POST --data-binary @<local-file-path> -H "Content-Type: image/png"${bridgeBase ? ` "${bridgeBase}/upload-reference?filename=${filename}"` : ` "<bridge-base-url>/upload-reference?filename=${filename}"`}`;

  return `IMAGE GENERATION — you have access to a real Midjourney account, and possibly also Black Forest Labs' FLUX, via the \`${MIDJOURNEY_MCP_SERVER_NAME}\` MCP server (tools prefixed \`mcp__${MIDJOURNEY_MCP_SERVER_NAME}__\`). Check which of the following tools actually show up in your tool list before using them — FLUX is only present when the operator has enabled it on the bridge.

CHOOSING A BACKEND:
- Use Midjourney (mj_imagine) for open-ended aesthetic exploration — you don't have a fixed source image, or you're fine with the whole image being resampled together.
- Use FLUX (flux_generate / flux_edit) when something has to be held fixed while something else changes — geometry, a specific mark, a palette, a character's identity across shots — or when you're editing an existing image and want everything NOT mentioned in the instruction left alone. Midjourney's \`--iw\`/\`--sref\`/\`--ow\` are global similarity leashes on the whole re-sampled image, not per-attribute controls, so it structurally cannot do this; FLUX can.

MIDJOURNEY (mj_imagine, mj_upscale, mj_variation, mj_reroll):
- GENERATE: call mj_imagine with a well-formed prompt for the user's brief. It returns a 2x2 grid as an inline preview image plus job metadata (id/hash/flags).
- REFERENCE IMAGES: if the user attaches an image, points at an existing file, or asks you to match a style/composition/character, ALWAYS consider passing it to mj_imagine as an image reference via its \`reference_image_urls\` parameter — don't silently skip this because you only have a local file. Midjourney only accepts image input as a URL prepended to the prompt, never a file, so for a local file mint one first:
  \`\`\`
  ${uploadCmd('ref.png')}
  \`\`\`
  This returns \`{"url": "..."}\` — pass that URL in \`reference_image_urls\`. Do this instead of trying to inline the image bytes anywhere; only the small resulting URL should ever appear in a tool call.
- JUDGE: actually look at the returned preview image with your own vision before deciding anything. Compare each quadrant against the brief — composition, subject fidelity, artifacts, whether it matches what was asked.
- ITERATE: based on that judgment, either (a) mj_upscale the best quadrant, (b) mj_variation to explore near a promising quadrant, (c) mj_reroll for a fresh grid on the same prompt, or (d) refine the prompt text and mj_imagine again. Keep the loop bounded — a handful of rounds is normally enough; don't spin indefinitely chasing marginal improvement.

FLUX (flux_generate, flux_edit) — if present:
- flux_generate takes a prompt plus up to 8 \`reference_image_urls\` (refer to them by number in the prompt, e.g. "the subject from image 1 in the environment from image 2"). Same local-file rule as Midjourney — mint a URL first via \`${bridgeBase ? `${bridgeBase}/upload-reference` : '/upload-reference'}\` (\`${uploadCmd('ref.png')}\`).
- flux_edit takes a \`source_image_url\` plus a short, specific imperative \`instruction\` describing only the change to make ("cool the stone to bone-white, add fine hairline cracks, change nothing else") — vague instructions get vague preservation, so be precise about what should and shouldn't change.
- Both return one full-resolution image directly per call — no grid, no separate upscale step. Judge the result the same way (compare against the brief, and for flux_edit specifically compare against the source to confirm only the instructed change happened) before treating it as final; re-run with a refined prompt/instruction if it's off.

CURATE (either backend): once you have image(s) worth keeping, download the full-resolution file into a path INSIDE your current working directory — e.g. \`curl -o result.png "<full_resolution_url>"\` run from your working directory (the \`full_resolution_url\` field in the tool result — the preview image is deliberately downscaled and not the deliverable). Use a relative path or an explicit \`$(pwd)/...\` path — NEVER an absolute path like \`/home/coder/...\`, which is outside your task's working directory and will be rejected when you try to hand it off. Present the final picks to the user with a short rationale for why each was chosen, and hand off the file(s) via the OUTPUT_FILE convention described elsewhere in this prompt.

Never claim an image was generated, upscaled, varied, or edited unless a tool call actually returned it.`;
}
