import { KokoroTTS } from 'kokoro-js';

export interface KokoroVoice {
  id: string;
  name: string;
  accent: string;
  gender: string;
}

export const KOKORO_VOICES: KokoroVoice[] = [
  { id: 'af_heart',    name: 'Heart',    accent: 'American', gender: 'Female' },
  { id: 'af_bella',    name: 'Bella',    accent: 'American', gender: 'Female' },
  { id: 'af_sarah',    name: 'Sarah',    accent: 'American', gender: 'Female' },
  { id: 'af_sky',      name: 'Sky',      accent: 'American', gender: 'Female' },
  { id: 'af_nicole',   name: 'Nicole',   accent: 'American', gender: 'Female' },
  { id: 'am_fenrir',   name: 'Fenrir',   accent: 'American', gender: 'Male'   },
  { id: 'am_michael',  name: 'Michael',  accent: 'American', gender: 'Male'   },
  { id: 'am_puck',     name: 'Puck',     accent: 'American', gender: 'Male'   },
  { id: 'am_adam',     name: 'Adam',     accent: 'American', gender: 'Male'   },
  { id: 'bf_emma',     name: 'Emma',     accent: 'British',  gender: 'Female' },
  { id: 'bf_isabella', name: 'Isabella', accent: 'British',  gender: 'Female' },
  { id: 'bm_george',   name: 'George',   accent: 'British',  gender: 'Male'   },
  { id: 'bm_fable',    name: 'Fable',    accent: 'British',  gender: 'Male'   },
  { id: 'bm_lewis',    name: 'Lewis',    accent: 'British',  gender: 'Male'   },
];

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

type ProgressListener = (pct: number) => void;
const progressListeners = new Set<ProgressListener>();

export function onKokoroProgress(cb: ProgressListener): () => void {
  progressListeners.add(cb);
  return () => progressListeners.delete(cb);
}

let instance: KokoroTTS | null = null;
let initPromise: Promise<KokoroTTS> | null = null;

export function isKokoroLoaded(): boolean {
  return instance !== null;
}

export async function getKokoroPipeline(): Promise<KokoroTTS> {
  if (instance) return instance;
  if (initPromise) return initPromise;

  console.log('[Kokoro] Loading pipeline...');

  initPromise = KokoroTTS.from_pretrained(MODEL_ID, {
    dtype: 'q4',
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
  } as Parameters<typeof KokoroTTS.from_pretrained>[1]).then(tts => {
    console.log('[Kokoro] Pipeline ready');
    instance = tts;
    progressListeners.forEach(cb => cb(100));
    return instance;
  }).catch(err => {
    console.error('[Kokoro] Pipeline load failed:', err);
    initPromise = null;
    throw err;
  });

  return initPromise;
}
