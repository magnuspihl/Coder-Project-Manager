import KokoroWorkerConstructor from '../workers/kokoroWorker?worker';

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

type ProgressListener = (pct: number) => void;
const progressListeners = new Set<ProgressListener>();

export function onKokoroProgress(cb: ProgressListener): () => void {
  progressListeners.add(cb);
  return () => progressListeners.delete(cb);
}

type Pending = { resolve: (data: unknown) => void; reject: (err: Error) => void };

let worker: Worker | null = null;
let msgCounter = 0;
const pending = new Map<number, Pending>();

let loadPromise: Promise<void> | null = null;
let loaded = false;

function ensureWorker(): Worker {
  if (worker) return worker;

  const w = new KokoroWorkerConstructor();
  worker = w;

  w.onmessage = (evt: MessageEvent) => {
    const { id, type, ...data } = evt.data as Record<string, unknown>;

    if (type === 'progress') {
      const info = data.info as Record<string, unknown>;
      const pct = typeof info.progress === 'number' ? Math.round(info.progress) : null;
      if (pct !== null) progressListeners.forEach(cb => cb(pct));
      return;
    }

    const p = pending.get(id as number);
    if (!p) return;
    pending.delete(id as number);

    if (type === 'error') {
      p.reject(new Error(data.error as string));
    } else {
      p.resolve(data);
    }
  };

  w.onerror = (err) => {
    console.error('[Kokoro Worker] Uncaught error:', err.message);
    for (const p of pending.values()) p.reject(new Error(err.message || 'Worker error'));
    pending.clear();
    worker = null;
    loadPromise = null;
    loaded = false;
  };

  return w;
}

function workerCall<T>(type: string, data: Record<string, unknown> = {}): Promise<T> {
  const id = ++msgCounter;
  const w = ensureWorker();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (d: unknown) => void, reject });
    w.postMessage({ id, type, ...data });
  });
}

export function isKokoroLoaded(): boolean {
  return loaded;
}

export interface KokoroHandle {
  generate(text: string, opts: { voice: string }): Promise<{ audio: Float32Array; sampling_rate: number }>;
}

export async function getKokoroPipeline(): Promise<KokoroHandle> {
  if (!loadPromise) {
    console.log('[Kokoro] Starting worker…');
    loadPromise = workerCall<void>('load', { dtype: 'q4' }).then(() => {
      loaded = true;
      console.log('[Kokoro] Worker ready');
      progressListeners.forEach(cb => cb(100));
    }).catch(err => {
      loadPromise = null;
      throw err;
    });
  }

  await loadPromise;

  return {
    generate(text: string, { voice }: { voice: string }) {
      return workerCall<{ audio: Float32Array; sampling_rate: number }>(
        'synthesize', { text, voice }
      );
    },
  };
}
