# mj-bridge

A standalone MCP server that drives a real Midjourney account through Discord
(there is still no official Midjourney API). It exposes `mj_imagine`,
`mj_upscale`, `mj_variation`, and `mj_reroll` as MCP tools so any Claude Code
agent — a CPM task, an agent-box agent, anything that can register an MCP
server — can generate, judge, and iterate on Midjourney images as part of a
normal tool-use loop.

This is deliberately **not** part of the CPM app itself. It's a separate
long-lived process (it holds a persistent Discord connection) meant to run as
its own container, the same way `qwen-tts` and the Mem0/OpenMemory server do —
one shared service other things point at, not something bundled into CPM's
Express process.

## Risk — read this first

This automates a real Discord account against Midjourney's bot, which is
against Midjourney's Terms of Service and carries a real account-ban risk.
There is no way around this until Midjourney ships an official API. Only run
this against an account you're comfortable putting at risk.

## Getting credentials

1. **SalaiToken** — your Discord account's auth token. Open Discord in a
   browser, open dev tools → Network tab, trigger any request, and copy the
   `authorization` header value. Treat this exactly like a password — anyone
   with it has full access to the Discord account.
2. **ServerId / ChannelId** — a Discord server (yours or any server) with the
   Midjourney bot present, and a channel in it. Both IDs are in the channel's
   URL: `https://discord.com/channels/<ServerId>/<ChannelId>`.

## Configuration

| Env var | Required | Description |
|---|---|---|
| `MJ_SALAI_TOKEN` | Yes | Discord account token (see above) |
| `MJ_SERVER_ID` | Yes | Discord server (guild) ID |
| `MJ_CHANNEL_ID` | Yes | Discord channel ID where the MJ bot is present |
| `MJ_BOT_ID` | No | `mj` (default) or `niji` |
| `MJ_REMIX` | No | `true` to enable remix mode (requires it be enabled in Discord settings too) |
| `MJ_BRIDGE_TOKEN` | No | If set, `/mcp` requires `Authorization: Bearer <token>`. Recommended even on a private LAN — this endpoint can spend real quota and post to a real Discord account. |
| `MJ_PREVIEW_MAX_EDGE` | No | Long edge (px) of the inline preview image returned to agents (default `1024`) |
| `MJ_PREVIEW_QUALITY` | No | JPEG quality of the preview (default `82`) |
| `PORT` | No | Listen port (default `8901`) |

## Why previews are downscaled

Grid/upscale images from Midjourney can be several MB. Returning that at full
resolution as inline MCP image content would bloat every tool call — it flows
into the agent's context and back through whatever transport is streaming the
conversation (e.g. CPM's SSH → stream-json → WebSocket chain). The bridge
returns a small JPEG preview for the agent to *judge* with its own vision,
plus the original's direct URL (`full_resolution_url` in the tool result) so
the agent can `curl` down the real file only for the image(s) it actually
wants to keep.

## Running

```bash
npm install
npm run build
npm start
# or during development:
npm run dev
```

### Docker Compose (Odin deployment — recommended)

```bash
cp .env.example .env   # fill in MJ_SALAI_TOKEN / MJ_SERVER_ID / MJ_CHANNEL_ID / MJ_BRIDGE_TOKEN
docker compose up -d --build
```

`docker-compose.yml` builds the image, restarts it automatically, and runs a
`GET /healthz` healthcheck. To update after a code change: `docker compose up
-d --build` again. Logs: `docker compose logs -f`.

### Plain `docker run` (equivalent, no compose)

```bash
docker build -t mj-bridge .
docker run -d --name mj-bridge --restart unless-stopped \
  -p 8901:8901 \
  -e MJ_SALAI_TOKEN=... \
  -e MJ_SERVER_ID=... \
  -e MJ_CHANNEL_ID=... \
  -e MJ_BRIDGE_TOKEN=... \
  mj-bridge
```

Health check: `GET /healthz`. MCP endpoint: `POST /mcp` (streamable HTTP,
stateless — same transport CPM's own `/mcp` uses).

## Wiring it into CPM

See `docs/SPEC.md` §9 ("Per-user Midjourney bridge") — set
`CPM_MIDJOURNEY_MCP_URL` (or the per-user map/template variant) to this
service's `/mcp` URL and restart CPM. Task agents then get the four tools
above plus a system-prompt fragment describing the generate → judge → iterate
→ curate workflow.

## Reuse in agent-box

This container has no CPM-specific code or dependency — it's a plain MCP
server over HTTP. agent-box (or anything else) can point at the same running
container and register it the same way, without redeploying anything here.
