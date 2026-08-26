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

This has already happened once: an earlier version of `/upload-reference`
uploaded reference images to Discord under the account's own user token
(reserve an attachment slot, PUT the bytes, post a message — replicating
what the Discord client does). That specific pattern is a well-known
self-bot detection trigger, and it got the account **banned outright** after
three uploads — not just booted from one session. Reference images are no
longer uploaded to Discord at all (see "Image references" below); the
remaining ToS risk is Discord/Midjourney flagging the automated `Imagine` /
`Upscale` / etc. traffic itself, which is the risk this section already
warned about.

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
| `MJ_PUBLIC_BASE_URL` | Yes, for `/upload-reference` | The public URL this bridge itself is reachable at (e.g. `https://mj-bridge.example.com`), used to build the URLs `/upload-reference` hands back. Midjourney's bot fetches those URLs directly from the open internet — a LAN-only address (like a bare `192.168.x.x` IP) won't be reachable by it. |
| `MJ_BRIDGE_TOKEN` | No | If set, `/mcp` and `/upload-reference` require `Authorization: Bearer <token>`. Was "recommended even on a LAN" before; now that the bridge needs a public URL for `MJ_PUBLIC_BASE_URL`, treat it as required — without it, anyone who finds the URL can spend real Midjourney quota and post to your Discord channel. (`GET /references/*` is intentionally left unauthenticated regardless, since Midjourney's bot has no way to send a bearer token — see "Image references" below for why that's still safe.) |
| `MJ_PREVIEW_MAX_EDGE` | No | Long edge (px) of the inline preview image returned to agents (default `1024`) |
| `MJ_PREVIEW_QUALITY` | No | JPEG quality of the preview (default `82`) |
| `MJ_JOB_TIMEOUT_MS` | No | Max time (ms) to wait on a single Imagine/Upscale/Variation/Reroll round-trip before giving up (default `360000` = 6 min). See "Queueing and timeouts" below. |
| `PORT` | No | Listen port (default `8901`) |

## Queueing and timeouts

A single Discord account can only do one thing at a time, so every
Imagine/Upscale/Variation/Reroll call is serialized through one in-process
queue — callers waiting behind another job get a `notifications/progress`
update saying so (if their MCP client sent a `progressToken`; this is a
no-op otherwise), and each job also reports Midjourney's own generation
percentage via the same channel.

Every job is bounded by `MJ_JOB_TIMEOUT_MS`. This matters more than it might
look: nothing upstream (the `midjourney` npm client, Discord's websocket) has
its own timeout, and because calls are serialized, one job that never
resolves would otherwise wedge the queue **forever** — every later call, from
every task or agent sharing this bridge, would hang indefinitely with no
error and no way to recover short of restarting the process. This happened
for real on 2026-08-26: the bridge went silently unresponsive to every
caller for hours, invisible to `/healthz` because the old health check never
touched the queue at all. `/healthz` now reports the live queue depth and
current job, and returns `503` if a job is somehow still running past its
timeout (shouldn't happen, but flags it if it does). A timeout also drops
and reconnects the Discord client, since a connection that failed to
complete one round-trip may be in a bad state for the next one.

## Why previews are downscaled

Grid/upscale images from Midjourney can be several MB. Returning that at full
resolution as inline MCP image content would bloat every tool call — it flows
into the agent's context and back through whatever transport is streaming the
conversation (e.g. CPM's SSH → stream-json → WebSocket chain). The bridge
returns a small JPEG preview for the agent to *judge* with its own vision,
plus the original's direct URL (`full_resolution_url` in the tool result) so
the agent can `curl` down the real file only for the image(s) it actually
wants to keep.

## Image references (using an image as input, not just text)

Midjourney only accepts image input as a URL prepended to the prompt text —
the same thing you'd get by dragging an image into Discord and copying its
link. There's no way to hand it a local file directly.

`mj_imagine` takes an optional `reference_image_urls` array for when you
already have a public URL. For a local file, first mint a URL with a plain
HTTP upload (deliberately **not** an MCP tool — piping image bytes through an
MCP tool argument would mean base64-encoding them into the calling agent's
context, and a multi-MB photo becomes hundreds of thousands of tokens that
way):

```bash
curl -X POST --data-binary @photo.png \
  -H "Content-Type: image/png" \
  -H "Authorization: Bearer $MJ_BRIDGE_TOKEN" \
  "https://mj-bridge.example.com/upload-reference"
# => {"url": "https://mj-bridge.example.com/references/<uuid>.png"}
```

Pass the returned URL into `mj_imagine`'s `reference_image_urls`. (CPM's
system-prompt fragment for agents already includes this exact flow — see
`server/services/midjourney-mcp.ts`.)

The bridge saves the bytes to local disk (`./data/references`, bind-mounted
by `docker-compose.yml`) and serves them back itself at `GET
/references/<uuid>.png` — it no longer uploads anything to Discord to do
this (see "Risk" above for why). That serving route is intentionally left
unauthenticated even though everything else requires `MJ_BRIDGE_TOKEN`:
Midjourney's bot fetches it as a plain GET with no way to attach a bearer
token, and the filename is an unguessable random UUID minted only by
`/upload-reference`, so it's no more exposed than a Discord CDN link was.
This only works end-to-end if `MJ_PUBLIC_BASE_URL` (above) is actually
reachable from the open internet, not just your LAN.

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
