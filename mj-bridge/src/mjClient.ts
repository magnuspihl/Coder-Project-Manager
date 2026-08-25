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
