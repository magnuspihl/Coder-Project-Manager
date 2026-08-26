import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8901),
  // Optional shared-secret gate. This endpoint can drive spend and real
  // Discord activity on a live account, so it's worth locking down even on a
  // trusted LAN — but kept optional to match the other self-hosted services
  // (qwen-tts, mem0) that assume a private network boundary.
  bridgeToken: process.env.MJ_BRIDGE_TOKEN || null,

  // Public URL this bridge itself is reachable at (e.g. https://mj-bridge.example.com),
  // used to build URLs for /references/*. Required for /upload-reference to work at
  // all — Midjourney's bot fetches those URLs directly, so they have to resolve from
  // the open internet, not just this bridge's own LAN.
  publicBaseUrl: process.env.MJ_PUBLIC_BASE_URL || null,

  salaiToken: required('MJ_SALAI_TOKEN'),
  serverId: required('MJ_SERVER_ID'),
  channelId: required('MJ_CHANNEL_ID'),
  // 'mj' | 'niji' — selects the Midjourney vs Niji bot.
  botId: (process.env.MJ_BOT_ID ?? 'mj') as 'mj' | 'niji',
  remix: process.env.MJ_REMIX === 'true',
  debug: process.env.MJ_DEBUG === 'true',

  // Long edge (px) of the inline preview image returned in tool results.
  // Kept small deliberately — the preview only needs to be good enough for
  // the calling agent's own vision to judge composition/quality; the full
  // resolution original is always available via its direct URL for anyone
  // who wants to download the real file.
  previewMaxEdge: Number(process.env.MJ_PREVIEW_MAX_EDGE ?? 1024),
  previewQuality: Number(process.env.MJ_PREVIEW_QUALITY ?? 82),

  // Hard ceiling on a single Imagine/Upscale/Variation/Reroll round-trip.
  // Nothing upstream (the `midjourney` npm client, Discord's websocket) has
  // its own timeout, and every call is serialized through one queue — a
  // single call that never resolves would otherwise wedge every future call,
  // from every task, forever. 6 minutes comfortably covers normal Midjourney
  // generation time (usually well under 2 minutes) with headroom.
  jobTimeoutMs: Number(process.env.MJ_JOB_TIMEOUT_MS ?? 6 * 60 * 1000),

  // Black Forest Labs (FLUX) API key. Optional and independent of the
  // Midjourney credentials above — flux_generate/flux_edit are simply not
  // registered as MCP tools when this is unset, rather than the whole
  // process failing to start (see server.ts). Get one at
  // https://dashboard.bfl.ai/get-started.
  bflApiKey: process.env.BFL_API_KEY || null,

  // Which FLUX.2 model backs both flux_generate and flux_edit. `flux-2-pro`
  // is BFL's balanced production tier and is what the per-call cost log
  // (fluxCostLog.ts) assumes by default; bump to flux-2-max for quality or
  // flux-2-klein-4b/9b for cheaper/faster iteration.
  fluxModel: process.env.FLUX_MODEL || 'flux-2-pro',

  // Hard ceiling on a single flux_generate/flux_edit round-trip (submit +
  // poll). FLUX generations typically finish in well under a minute, but
  // this is the same kind of guard as jobTimeoutMs above — a stuck poll loop
  // should fail loudly instead of hanging a tool call forever. Unlike MJ,
  // FLUX calls aren't serialized through a shared queue (BFL's API is a
  // normal rate-limited REST API, not a single Discord session), so a slow
  // FLUX call can't wedge anything else.
  fluxJobTimeoutMs: Number(process.env.FLUX_JOB_TIMEOUT_MS ?? 3 * 60 * 1000),

  // Optional spend guard. When set, flux_generate/flux_edit are refused once
  // this bridge's own cost log (data/flux-cost-log.jsonl, estimated from
  // BFL's published per-model rates — not a real billing figure) shows the
  // current UTC calendar month has already reached this total. Unset by
  // default: a typical art-direction session is 10-30 calls at a few cents
  // each, so the real risk this guards against is a runaway agent loop, not
  // normal use.
  fluxMonthlyCapUsd: process.env.FLUX_MONTHLY_CAP_USD ? Number(process.env.FLUX_MONTHLY_CAP_USD) : null,
} as const;
