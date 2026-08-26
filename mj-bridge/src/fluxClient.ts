import { config } from './config.js';

// Black Forest Labs' own official API integration guide (2026) recommends
// FLUX.2's native image-to-image editing (`input_image` on the same
// generation endpoint) over the older, separate FLUX.1 Kontext endpoints for
// instruction-based editing — so flux_edit in server.ts is built on the same
// FLUX.2 model/endpoint as flux_generate, just with a single input_image and
// no other references. See https://docs.bfl.ai and
// https://github.com/black-forest-labs/skills (skills/bfl-api).
const BASE_URL = 'https://api.bfl.ai';

export class FluxConfigError extends Error {}
export class FluxApiError extends Error {}
export class FluxTimeoutError extends Error {}

export interface FluxResult {
  model: string;
  /** The prompt (flux_generate) or edit instruction (flux_edit) that produced this result. */
  promptOrInstruction: string;
  seed?: number;
  /** BFL's own result URL. Expires ~10 minutes after generation — download immediately. */
  imageUrl: string;
}

function headers(): Record<string, string> {
  if (!config.bflApiKey) {
    throw new FluxConfigError('BFL_API_KEY is not configured on this bridge.');
  }
  return { 'x-key': config.bflApiKey, 'Content-Type': 'application/json' };
}

async function submit(model: string, payload: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${BASE_URL}/v1/${model}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => null) as { id?: string; polling_url?: string; detail?: unknown } | null;
  if (!res.ok) {
    throw new FluxApiError(`BFL ${model} request failed (${res.status}): ${body?.detail ? JSON.stringify(body.detail) : res.statusText}`);
  }
  if (!body?.polling_url) {
    throw new FluxApiError(`BFL ${model} response had no polling_url: ${JSON.stringify(body)}`);
  }
  return body.polling_url;
}

interface FluxPollResult { sample: string; seed?: number }

// BFL's own guide recommends exponential backoff with a cap, plus an overall
// deadline — matches the guard `jobTimeoutMs` already applies to Midjourney
// calls in mjClient.ts, for the same reason (never poll indefinitely).
async function poll(pollingUrl: string, timeoutMs: number): Promise<FluxPollResult> {
  const start = Date.now();
  let delayMs = 1000;
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(pollingUrl, { headers: headers(), signal: AbortSignal.timeout(15_000) });
    const data = await res.json().catch(() => null) as { status?: string; result?: { sample?: string; seed?: number }; error?: string } | null;
    if (!res.ok) throw new FluxApiError(`BFL poll failed (${res.status}): ${res.statusText}`);
    if (data?.status === 'Pending') {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 1.5, 5000);
      continue;
    }
    if (data?.status === 'Ready') {
      if (!data.result?.sample) throw new FluxApiError('BFL result marked Ready but had no sample URL.');
      return { sample: data.result.sample, seed: data.result.seed };
    }
    // Any other status (Error, Content Moderated, Request Moderated, Task not
    // found, ...) is terminal — fail closed rather than polling forever on a
    // status we don't recognize.
    throw new FluxApiError(`BFL generation did not succeed: ${data?.status ?? 'unknown status'}${data?.error ? ` — ${data.error}` : ''}`);
  }
  throw new FluxTimeoutError(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for BFL to finish generating.`);
}

function withInputImages(payload: Record<string, unknown>, urls: string[] | undefined): Record<string, unknown> {
  if (!urls?.length) return payload;
  const out = { ...payload };
  urls.forEach((url, i) => {
    out[i === 0 ? 'input_image' : `input_image_${i + 1}`] = url;
  });
  return out;
}

export async function generateImage(prompt: string, referenceImageUrls: string[] | undefined, model = config.fluxModel): Promise<FluxResult> {
  const pollingUrl = await submit(model, withInputImages({ prompt }, referenceImageUrls));
  const result = await poll(pollingUrl, config.fluxJobTimeoutMs);
  return { model, promptOrInstruction: prompt, seed: result.seed, imageUrl: result.sample };
}

export async function editImage(instruction: string, sourceImageUrl: string, model = config.fluxModel): Promise<FluxResult> {
  const pollingUrl = await submit(model, { prompt: instruction, input_image: sourceImageUrl });
  const result = await poll(pollingUrl, config.fluxJobTimeoutMs);
  return { model, promptOrInstruction: instruction, seed: result.seed, imageUrl: result.sample };
}
