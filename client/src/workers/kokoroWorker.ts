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

function send(msg: unknown, transfer?: Transferable[]) {
  (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(msg, transfer);
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
          const dtype = hasWebGPU ? 'q4f16' : 'q4';
          const device = hasWebGPU ? 'webgpu' : 'wasm';
          const progress = (info: Record<string, unknown>) => send({ type: 'progress', info });

          try {
            console.log(`[Kokoro Worker] Loading device=${device} dtype=${dtype}`);
            tts = await KokoroTTS.from_pretrained(MODEL_ID, {
              dtype, device, progress_callback: progress,
            } as never);
          } catch (e) {
            if (hasWebGPU) {
              console.warn('[Kokoro Worker] WebGPU failed, retrying with WASM q4:', e);
              tts = await KokoroTTS.from_pretrained(MODEL_ID, {
                dtype: 'q4', device: 'wasm', progress_callback: progress,
              } as never);
            } else {
              throw e;
            }
          }
        })();
      }
      await loadPromise;
      send({ id, type: 'loaded' });
      return;
    }

    if (type === 'stream') {
      if (!tts) throw new Error('Model not loaded');
      console.log('[Kokoro Worker] stream id=', id, 'text length:', text!.length);
      // tts.stream(string) passes text to a TextSplitterStream internally but never
      // calls close() on it, so the async iterator hangs after the last sentence.
      // Use TextSplitterStream directly and close it to flush remaining text.
      const splitter = new TextSplitterStream();
      const stream = tts.stream(splitter, { voice: voice as never });
      splitter.push(text!);
      splitter.close();
      let chunkCount = 0;
      for await (const chunk of stream) {
        const raw = chunk.audio.audio as Float32Array;
        // Copy into a fresh ArrayBuffer — avoids aliasing with ONNX internal buffers.
        const audio = new Float32Array(raw);
        const maxAmp = audio.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
        console.log('[Kokoro Worker] chunk', ++chunkCount, 'samples:', audio.length, 'maxAmp:', maxAmp.toFixed(4));
        send(
          { id, type: 'audio-chunk', audio, sampling_rate: chunk.audio.sampling_rate },
          [audio.buffer],
        );
      }
      console.log('[Kokoro Worker] stream done, chunks:', chunkCount);
      send({ id, type: 'audio-done' });
      return;
    }
  } catch (err) {
    send({ id, type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
});

export {};
