import { pipeline, env } from '@huggingface/transformers';
// @ts-expect-error onnxruntime-web exports field lacks 'types' condition; resolves at runtime
import * as ort from 'onnxruntime-web';

(env as Record<string, unknown>).allowLocalModels = false;
(env as Record<string, unknown>).allowRemoteModels = true;

// Same preferredOutputLocation:'cpu' patch as kokoroWorker — required so that
// @huggingface/transformers' synchronous tensor.data access works on WebGPU.
{
  type CreateFn = (...args: unknown[]) => Promise<unknown>;
  const IS = ort.InferenceSession as unknown as { create: CreateFn };
  const orig = IS.create;
  IS.create = function (...args: unknown[]) {
    const opts = ((args[1] ?? {}) as Record<string, unknown>);
    const eps = (opts.executionProviders as unknown[]) ?? [];
    if (eps.some(ep => (typeof ep === 'string' ? ep : (ep as Record<string, string>).name) === 'webgpu')) {
      args[1] = { ...opts, preferredOutputLocation: 'cpu' };
    }
    return orig.apply(this, args as Parameters<CreateFn>);
  };
}

const MODEL = 'Xenova/whisper-tiny.en';
type ASRPipeline = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string }>;

let asr: ASRPipeline | null = null;
let loadPromise: Promise<void> | null = null;
let currentDevice: 'webgpu' | 'wasm' = 'wasm';

function send(msg: unknown) {
  (self as unknown as { postMessage(m: unknown): void }).postMessage(msg);
}

async function loadWasm(progress: (info: unknown) => void) {
  console.log('[Whisper Worker] Loading device=wasm dtype=q8');
  asr = await pipeline('automatic-speech-recognition', MODEL, {
    dtype: 'q8', device: 'wasm', progress_callback: progress,
  } as never) as unknown as ASRPipeline;
  currentDevice = 'wasm';
}

self.addEventListener('message', async (e: MessageEvent) => {
  const { id, type, audio } = e.data as {
    id: number;
    type: 'load' | 'transcribe';
    audio?: Float32Array;
  };

  try {
    if (type === 'load') {
      if (!loadPromise) {
        loadPromise = (async () => {
          const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
          const progress = (info: unknown) => send({ type: 'progress', info });

          if (hasWebGPU) {
            try {
              // fp32 avoids the fp16 softmax-overflow NaN issue seen on some GPUs.
              console.log('[Whisper Worker] Loading device=webgpu dtype=fp32');
              asr = await pipeline('automatic-speech-recognition', MODEL, {
                dtype: 'fp32', device: 'webgpu', progress_callback: progress,
              } as never) as unknown as ASRPipeline;
              currentDevice = 'webgpu';
            } catch (err) {
              console.warn('[Whisper Worker] WebGPU load failed, falling back to WASM:', err);
              await loadWasm(progress);
            }
          } else {
            await loadWasm(progress);
          }
        })();
      }
      await loadPromise;
      send({ id, type: 'loaded', device: currentDevice });
      return;
    }

    if (type === 'transcribe') {
      if (!asr) throw new Error('Model not loaded');
      console.log('[Whisper Worker] Transcribing', audio!.length, 'samples at 16 kHz');
      const result = await asr(audio!, { sampling_rate: 16000 });
      const text = result.text.trim();
      console.log('[Whisper Worker] Result:', text);
      send({ id, type: 'result', text });
      return;
    }
  } catch (err) {
    send({ id, type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
});

export {};
