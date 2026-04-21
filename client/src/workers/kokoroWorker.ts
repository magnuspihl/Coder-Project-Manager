import { KokoroTTS, TextSplitterStream } from 'kokoro-js';
import { env } from '@huggingface/transformers';
// @ts-expect-error onnxruntime-web exports field lacks 'types' condition; resolves at runtime
import * as ort from 'onnxruntime-web';

(env as Record<string, unknown>).useFS = false;
(env as Record<string, unknown>).allowLocalModels = false;
(env as Record<string, unknown>).allowRemoteModels = true;

// @huggingface/transformers uses tensor.data (sync) which returns zeros for WebGPU
// gpu-buffer tensors. Forcing preferredOutputLocation:'cpu' makes ONNX RT copy
// inference outputs to CPU memory before resolving, so .data works correctly.
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

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

let tts: KokoroTTS | null = null;
let loadPromise: Promise<void> | null = null;
let currentDevice: 'webgpu' | 'wasm' = 'wasm';

function send(msg: unknown, transfer?: Transferable[]) {
  (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(msg, transfer);
}

async function loadWasm(progress: (info: Record<string, unknown>) => void) {
  console.log('[Kokoro Worker] Loading device=wasm dtype=q4');
  tts = await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype: 'q4', device: 'wasm', progress_callback: progress,
  } as never);
  currentDevice = 'wasm';
}

async function runStream(id: number, text: string, voice: string) {
  if (!tts) throw new Error('Model not loaded');
  const splitter = new TextSplitterStream();
  const stream = tts.stream(splitter, { voice: voice as never });
  splitter.push(text);
  splitter.close();

  let chunkCount = 0;
  for await (const chunk of stream) {
    const raw = chunk.audio.audio as Float32Array;
    const audio = new Float32Array(raw);
    const maxAmp = audio.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    console.log('[Kokoro Worker] chunk', ++chunkCount, 'samples:', audio.length, 'maxAmp:', maxAmp.toFixed(4));

    // If first chunk has invalid data from WebGPU, reload with WASM and retry.
    if (chunkCount === 1 && (isNaN(maxAmp) || maxAmp === 0) && currentDevice === 'webgpu') {
      console.warn('[Kokoro Worker] WebGPU produced bad audio — reloading with WASM');
      tts = null;
      loadPromise = null;
      await loadWasm(() => {});
      await runStream(id, text, voice);
      return;
    }

    send({ id, type: 'audio-chunk', audio, sampling_rate: chunk.audio.sampling_rate }, [audio.buffer]);
  }
  console.log('[Kokoro Worker] stream done, chunks:', chunkCount);
  send({ id, type: 'audio-done' });
}

self.addEventListener('message', async (event: MessageEvent) => {
  const { id, type, text, voice } = event.data as {
    id: number;
    type: 'load' | 'stream';
    text?: string;
    voice?: string;
  };

  try {
    if (type === 'load') {
      if (!loadPromise) {
        loadPromise = (async () => {
          const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
          const progress = (info: Record<string, unknown>) => send({ type: 'progress', info });

          if (hasWebGPU) {
            // Try fp32 first — fp16/q4f16 suffer NaN on some GPUs due to softmax
            // overflow in half-precision arithmetic. fp32 avoids this entirely.
            // Fall back to WASM if WebGPU load throws or runtime audio is bad.
            try {
              console.log('[Kokoro Worker] Loading device=webgpu dtype=fp32');
              tts = await KokoroTTS.from_pretrained(MODEL_ID, {
                dtype: 'fp32', device: 'webgpu', progress_callback: progress,
              } as never);
              currentDevice = 'webgpu';
            } catch (e) {
              console.warn('[Kokoro Worker] WebGPU fp32 load failed, falling back to WASM:', e);
              await loadWasm(progress);
            }
          } else {
            await loadWasm(progress);
          }
        })();
      }
      await loadPromise;
      send({ id, type: 'loaded' });
      return;
    }

    if (type === 'stream') {
      console.log('[Kokoro Worker] stream id=', id, 'text length:', text!.length);
      await runStream(id, text!, voice!);
      return;
    }
  } catch (err) {
    send({ id, type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
});

export {};
