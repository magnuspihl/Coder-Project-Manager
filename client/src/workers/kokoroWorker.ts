import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';

// Force browser fetch mode — same as main thread
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
  const { id, type, text, voice, dtype } = event.data as {
    id: number;
    type: 'load' | 'synthesize';
    text?: string;
    voice?: string;
    dtype?: string;
  };

  try {
    if (type === 'load') {
      if (!loadPromise) {
        loadPromise = (async () => {
          tts = await KokoroTTS.from_pretrained(MODEL_ID, {
            dtype: (dtype || 'q4') as never,
            progress_callback: (info: Record<string, unknown>) => {
              send({ type: 'progress', info });
            },
          } as never);
        })();
      }
      await loadPromise;
      send({ id, type: 'loaded' });
      return;
    }

    if (type === 'synthesize') {
      if (!tts) throw new Error('Model not loaded');
      const out = await tts.generate(text!, { voice: voice as never });
      const audio = out.audio as Float32Array;
      send({ id, type: 'audio', audio, sampling_rate: out.sampling_rate }, [audio.buffer]);
      return;
    }
  } catch (err) {
    send({ id, type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
});

export {};
