import { pipeline, env } from '@huggingface/transformers';

// Force browser mode — Vite's process polyfill makes Transformers.js think
// it's running in Node.js and try to read local files instead of fetching.
env.useFS = false;
env.allowLocalModels = false;
env.allowRemoteModels = true;

export interface KokoroVoice {
  id: string;
  name: string;
  accent: string;
  gender: string;
}

export const KOKORO_VOICES: KokoroVoice[] = [
  { id: 'af_sarah',    name: 'Sarah',    accent: 'American', gender: 'Female' },
  { id: 'af_sky',      name: 'Sky',      accent: 'American', gender: 'Female' },
  { id: 'af_bella',    name: 'Bella',    accent: 'American', gender: 'Female' },
  { id: 'af_nicole',   name: 'Nicole',   accent: 'American', gender: 'Female' },
  { id: 'am_adam',     name: 'Adam',     accent: 'American', gender: 'Male'   },
  { id: 'am_michael',  name: 'Michael',  accent: 'American', gender: 'Male'   },
  { id: 'bf_emma',     name: 'Emma',     accent: 'British',  gender: 'Female' },
  { id: 'bf_isabella', name: 'Isabella', accent: 'British',  gender: 'Female' },
  { id: 'bm_george',   name: 'George',   accent: 'British',  gender: 'Male'   },
  { id: 'bm_lewis',    name: 'Lewis',    accent: 'British',  gender: 'Male'   },
];

type SynthesizerOutput = { audio: Float32Array; sampling_rate: number };
type Synthesizer = (text: string, options: { voice: string }) => Promise<SynthesizerOutput>;

let instance: Synthesizer | null = null;
let initPromise: Promise<Synthesizer> | null = null;

type ProgressListener = (pct: number) => void;
const progressListeners = new Set<ProgressListener>();

export function onKokoroProgress(cb: ProgressListener): () => void {
  progressListeners.add(cb);
  return () => progressListeners.delete(cb);
}

export function isKokoroLoaded(): boolean {
  return instance !== null;
}

export async function getKokoroPipeline(): Promise<Synthesizer> {
  if (instance) return instance;
  if (initPromise) return initPromise;

  console.log('[Kokoro] Loading pipeline...');

  initPromise = pipeline(
    'text-to-speech',
    'onnx-community/Kokoro-82M-ONNX',
    {
      dtype: 'q4' as never,
      progress_callback: (info: Record<string, unknown>) => {
        const status = info.status as string;
        const file = info.file as string | undefined;
        const pct = typeof info.progress === 'number' ? Math.round(info.progress) : null;
        if (pct !== null) {
          console.log(`[Kokoro] ${status} ${file || ''} ${pct}%`);
          progressListeners.forEach(cb => cb(pct));
        } else {
          console.log(`[Kokoro] ${status} ${file || ''}`);
        }
      },
    }
  ).then(p => {
    console.log('[Kokoro] Pipeline ready');
    instance = p as unknown as Synthesizer;
    progressListeners.forEach(cb => cb(100));
    return instance;
  }).catch(err => {
    console.error('[Kokoro] Pipeline load failed:', err);
    initPromise = null; // allow retry
    throw err;
  });

  return initPromise;
}
