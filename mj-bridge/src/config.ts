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
} as const;
