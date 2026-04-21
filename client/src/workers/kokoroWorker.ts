import { KokoroTTS, TextSplitterStream } from 'kokoro-js';
import { env } from '@huggingface/transformers';

(env as Record<string, unknown>).useFS = false;
(env as Record<string, unknown>).allowLocalModels = false;
(env as Record<string, unknown>).allowRemoteModels = true;

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
          // Prefer WebGPU (much faster); fall back to WASM if unavailable or broken.
          const hasWebGPU =
            typeof navigator !== 'undefined' && 'gpu' in navigator;
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
      // tts.stream(string) passes text to a TextSplitterStream internally but never
      // calls close() on it, so the async iterator hangs after the last sentence.
      // Use TextSplitterStream directly and close it to flush remaining text.
      const splitter = new TextSplitterStream();
      const stream = tts.stream(splitter, { voice: voice as never });
      splitter.push(text!);
      splitter.close();
      for await (const chunk of stream) {
        const audio = chunk.audio.audio as Float32Array;
        send(
          { id, type: 'audio-chunk', audio, sampling_rate: chunk.audio.sampling_rate },
          [audio.buffer],
        );
      }
      send({ id, type: 'audio-done' });
      return;
    }
  } catch (err) {
    send({ id, type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
});

export {};
