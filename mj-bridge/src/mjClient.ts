import { Midjourney, MJBot, NijiBot } from 'midjourney';
import type { MJMessage } from 'midjourney';
import { config } from './config.js';

export interface MjResult {
  id: string;
  hash: string;
  flags: number;
  prompt: string;
  uri: string;
}

function toResult(prompt: string, msg: MJMessage | null): MjResult {
  if (!msg) throw new Error('Midjourney returned no message (job may have failed, timed out, or been filtered).');
  if (!msg.id || !msg.hash) throw new Error('Midjourney message is missing id/hash — cannot be used for follow-up actions.');
  return { id: msg.id, hash: msg.hash, flags: msg.flags, prompt, uri: msg.uri };
}

let client: Midjourney | null = null;
let initPromise: Promise<Midjourney> | null = null;

async function getClient(): Promise<Midjourney> {
  if (client) return client;
  if (!initPromise) {
    initPromise = (async () => {
      const c = new Midjourney({
        ServerId: config.serverId,
        ChannelId: config.channelId,
        SalaiToken: config.salaiToken,
        BotId: config.botId === 'niji' ? NijiBot : MJBot,
        Remix: config.remix,
        Debug: config.debug,
        Ws: true,
      });
      await c.init();
      client = c;
      return c;
    })();
  }
  return initPromise;
}

// A single Discord account can only really do one thing at a time, and the
// client's websocket wait-state is keyed per call — serializing here avoids
// interleaving jobs and matches the natural one-at-a-time creative loop this
// bridge is designed for.
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  // Swallow so one failed job doesn't wedge the queue for the next caller.
  queue = run.catch(() => {});
  return run;
}

export function imagine(prompt: string): Promise<MjResult> {
  return serialize(async () => {
    const c = await getClient();
    const msg = await c.Imagine(prompt);
    return toResult(prompt, msg);
  });
}

export function upscale(prompt: string, msgId: string, hash: string, flags: number, index: 1 | 2 | 3 | 4): Promise<MjResult> {
  return serialize(async () => {
    const c = await getClient();
    const msg = await c.Upscale({ index, msgId, hash, flags, content: prompt });
    return toResult(prompt, msg);
  });
}

export function variation(prompt: string, msgId: string, hash: string, flags: number, index: 1 | 2 | 3 | 4): Promise<MjResult> {
  return serialize(async () => {
    const c = await getClient();
    const msg = await c.Variation({ index, msgId, hash, flags, content: prompt });
    return toResult(prompt, msg);
  });
}

export function reroll(prompt: string, msgId: string, hash: string, flags: number): Promise<MjResult> {
  return serialize(async () => {
    const c = await getClient();
    const msg = await c.Reroll({ msgId, hash, flags, content: prompt });
    return toResult(prompt, msg);
  });
}

/**
 * Upload raw image bytes to Discord and return a durable CDN URL, so it can
 * be prepended to an mj_imagine prompt as an image reference (that's the
 * only way Midjourney accepts image input — a URL at the start of the
 * prompt text, the same as pasting a link after dragging an image into
 * Discord). Two-step under the hood, replicating what the Discord client
 * itself does: reserve an upload slot + PUT the bytes (MJApi.UploadImageByBole),
 * then post it as a real channel message so it gets a stable CDN URL back
 * (`MJApi.upImageApi` does the post but discards the response body, so this
 * redoes that call directly to capture the URL).
 *
 * The `midjourney` package's DiscordImage type names the reserved-slot path
 * `upload_filename`, but Discord's message-create payload requires that same
 * value under the key `uploaded_filename` — passing the object straight
 * through (as the package's own `upImageApi` does) sends a malformed
 * attachments descriptor and Discord 400s unconditionally, before it ever
 * looks at the image bytes. Rebuild the descriptor with the right key.
 */
export function uploadReferenceImage(buf: Buffer, mimeType: string, filename = 'reference.png'): Promise<string> {
  return serialize(async () => {
    const c = await getClient();
    const blob = new Blob([Uint8Array.from(buf)], { type: mimeType });
    const image = await c.MJApi.UploadImageByBole(blob, filename);
    const attachment = { id: image.id, filename: image.filename, uploaded_filename: image.upload_filename };
    const url = new URL(`${c.config.DiscordBaseUrl}/api/v9/channels/${c.config.ChannelId}/messages`);
    const resp = await c.config.fetch(url, {
      method: 'POST',
      headers: { Authorization: c.config.SalaiToken, 'content-type': 'application/json' },
      body: JSON.stringify({ content: '', nonce: Date.now().toString(), channel_id: c.config.ChannelId, type: 0, sticker_ids: [], attachments: [attachment] }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error(`[mj-bridge] reference image message create failed (${resp.status}): ${body}`);
      throw new Error(`Failed to post reference image message (${resp.status}): ${body}`);
    }
    const data = (await resp.json()) as { attachments?: Array<{ url?: string }> };
    const cdnUrl = data.attachments?.[0]?.url;
    if (!cdnUrl) throw new Error('Discord did not return a CDN URL for the uploaded reference image.');
    return cdnUrl;
  });
}
