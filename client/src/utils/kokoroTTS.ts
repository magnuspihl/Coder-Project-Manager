import { pipeline, env } from '@huggingface/transformers';

// Don't use a local model cache — always fetch from HuggingFace CDN
env.allowLocalModels = false;

export interface KokoroVoice {
  id: string;
  name: string;
  accent: string;
  gender: string;
}

export const KOKORO_VOICES: KokoroVoice[] = [
  { id: 'af_heart',    name: 'Heart',    accent: 'American', gender: 'Female' },
  { id: 'af_bella',    name: 'Bella',    accent: 'American', gender: 'Female' },
  { id: 'af_nicole',   name: 'Nicole',   accent: 'American', gender: 'Female' },
  { id: 'af_sky',      name: 'Sky',      accent: 'American', gender: 'Female' },
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

  initPromise = pipeline('text-to-speech', 'onnx-community/Kokoro-82M-v1.0', {
    dtype: 'q8' as never,
    progress_callback: (info: Record<string, unknown>) => {
      if (info.status === 'progress' && typeof info.progress === 'number') {
        progressListeners.forEach(cb => cb(Math.round(info.progress as number)));
      }
    },
  }).then(p => {
    instance = p as unknown as Synthesizer;
    progressListeners.forEach(cb => cb(100));
    return instance;
  });

  return initPromise;
}
