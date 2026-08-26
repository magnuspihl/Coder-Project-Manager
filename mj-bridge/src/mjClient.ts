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

// Called with human-readable status updates while a job waits in queue and
// while it's actively generating, so a caller can surface real signal
// ("queued behind 2 jobs", "38%") instead of the request going dark for
// minutes with nothing observable on either end.
export type ProgressReporter = (message: string) => void;

class MjTimeoutError extends Error {}

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
    // Let a failed init be retried by the next caller instead of every
    // future call reusing (and re-throwing from) the same dead promise.
    initPromise.catch(() => { initPromise = null; });
  }
  return initPromise;
}

// Drop the current connection so the next call opens a fresh one, instead of
// reusing a client left in an unknown state after a timeout — the websocket
// wait-state that a timed-out call was listening on may still fire late and
// confuse the next job's correlation if we kept using the same client.
function resetClient(): void {
  const stale = client;
  client = null;
  initPromise = null;
  if (stale) {
    try { stale.Close(); } catch { /* best effort — we're discarding it anyway */ }
  }
}

export interface QueueStatus {
  queueLength: number;
  currentJob: { kind: string; startedAt: number; elapsedMs: number } | null;
}

let queueLength = 0;
let currentJob: { kind: string; startedAt: number } | null = null;

// Exposed for /healthz — the bridge's own health check previously only ever
// checked that the Express process was up, which stayed green for hours
// while every real call silently hung behind a wedged queue.
export function getQueueStatus(): QueueStatus {
  return {
    queueLength,
    currentJob: currentJob
      ? { kind: currentJob.kind, startedAt: currentJob.startedAt, elapsedMs: Date.now() - currentJob.startedAt }
      : null,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, kind: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new MjTimeoutError(
        `${kind} timed out after ${Math.round(ms / 1000)}s waiting on Midjourney/Discord. ` +
        'The request may still complete on Discord\'s side, but this bridge gave up waiting for it — try again.',
      ));
    }, ms);
    // Both branches fire even after the timer above already settled the
    // outer promise (settling an already-settled promise is a no-op), which
    // is what keeps a late resolve/reject from `p` from becoming an
    // unhandled rejection once we've stopped waiting on it.
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// A single Discord account can only really do one thing at a time, and the
// client's websocket wait-state is keyed per call — serializing here avoids
// interleaving jobs and matches the natural one-at-a-time creative loop this
// bridge is designed for.
//
// `run` MUST settle within config.jobTimeoutMs no matter what `fn()` does —
// otherwise `queue` never re-advances and every future call, from every
// task/agent sharing this bridge, hangs behind it forever. That happened for
// real: this bridge went silently unresponsive to every caller for hours
// after one Discord round-trip never came back, invisible to /healthz since
// it never exercised this path (see mj-bridge incident, 2026-08-26).
let queue: Promise<void> = Promise.resolve();
function serialize<T>(kind: string, fn: () => Promise<T>, onProgress?: ProgressReporter): Promise<T> {
  const position = queueLength;
  queueLength++;
  if (position > 0) onProgress?.(`Queued behind ${position} other job${position === 1 ? '' : 's'} on this bridge — waiting my turn.`);

  const run: Promise<T> = queue.then(async () => {
    queueLength--;
    currentJob = { kind, startedAt: Date.now() };
    const startedAt = currentJob.startedAt;
    onProgress?.('Sending to Midjourney...');
    console.log(`[mj-bridge] ${kind} start${position > 0 ? ` (waited behind ${position})` : ''}`);
    try {
      const result = await withTimeout(fn(), config.jobTimeoutMs, kind);
      console.log(`[mj-bridge] ${kind} done in ${Date.now() - startedAt}ms`);
      return result;
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      if (err instanceof MjTimeoutError) {
        console.error(`[mj-bridge] ${kind} TIMED OUT after ${elapsed}ms — resetting connection`);
        resetClient();
      } else {
        console.error(`[mj-bridge] ${kind} failed after ${elapsed}ms: ${(err as Error).message}`);
      }
      throw err;
    } finally {
      currentJob = null;
    }
  });

  // Swallow so one failed/timed-out job never blocks the next caller's turn
  // — this is exactly what was missing before: nothing here ever timed out
  // the inner call, so `queue` could be left permanently unsettled.
  queue = run.then(() => undefined, () => undefined);
  return run;
}

export function imagine(prompt: string, onProgress?: ProgressReporter): Promise<MjResult> {
  return serialize('mj_imagine', async () => {
    const c = await getClient();
    const msg = await c.Imagine(prompt, (_uri, progress) => onProgress?.(`Generating... ${progress}`));
    return toResult(prompt, msg);
  }, onProgress);
}

export function upscale(prompt: string, msgId: string, hash: string, flags: number, index: 1 | 2 | 3 | 4, onProgress?: ProgressReporter): Promise<MjResult> {
  return serialize('mj_upscale', async () => {
    const c = await getClient();
    const msg = await c.Upscale({ index, msgId, hash, flags, content: prompt, loading: (_uri, progress) => onProgress?.(`Upscaling... ${progress}`) });
    return toResult(prompt, msg);
  }, onProgress);
}

export function variation(prompt: string, msgId: string, hash: string, flags: number, index: 1 | 2 | 3 | 4, onProgress?: ProgressReporter): Promise<MjResult> {
  return serialize('mj_variation', async () => {
    const c = await getClient();
    const msg = await c.Variation({ index, msgId, hash, flags, content: prompt, loading: (_uri, progress) => onProgress?.(`Generating variation... ${progress}`) });
    return toResult(prompt, msg);
  }, onProgress);
}

export function reroll(prompt: string, msgId: string, hash: string, flags: number, onProgress?: ProgressReporter): Promise<MjResult> {
  return serialize('mj_reroll', async () => {
    const c = await getClient();
    const msg = await c.Reroll({ msgId, hash, flags, content: prompt, loading: (_uri, progress) => onProgress?.(`Rerolling... ${progress}`) });
    return toResult(prompt, msg);
  }, onProgress);
}
