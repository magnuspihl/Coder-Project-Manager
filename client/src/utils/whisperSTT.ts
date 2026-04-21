import WhisperWorkerConstructor from '../workers/whisperWorker?worker';

type ProgressListener = (pct: number) => void;
const progressListeners = new Set<ProgressListener>();

export function onWhisperProgress(cb: ProgressListener): () => void {
  progressListeners.add(cb);
  return () => progressListeners.delete(cb);
}

type Pending = { resolve: (v: string) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
let msgCounter = 0;
const pending = new Map<number, Pending>();

let loadPromise: Promise<void> | null = null;

function ensureWorker(): Worker {
  if (worker) return worker;

  const w = new WhisperWorkerConstructor();
  worker = w;

  w.onmessage = (evt: MessageEvent) => {
    const { id, type, ...data } = evt.data as Record<string, unknown>;
    const numId = id as number;

    if (type === 'progress') {
      const info = data.info as Record<string, unknown> | undefined;
      const pct = typeof info?.progress === 'number' ? Math.round(info.progress as number) : null;
      if (pct !== null) progressListeners.forEach(cb => cb(pct));
      return;
    }

    const p = pending.get(numId);
    if (!p) return;
    pending.delete(numId);

    if (type === 'error') p.reject(new Error(data.error as string));
    else p.resolve((data.text as string | undefined) ?? '');
  };

  w.onerror = (err) => {
    console.error('[Whisper] Worker error:', err.message);
    for (const p of pending.values()) p.reject(new Error(err.message || 'Worker error'));
    pending.clear();
    worker = null;
    loadPromise = null;
  };

  return w;
}

function workerCall(type: string, data: Record<string, unknown> = {}, transfer?: Transferable[]): Promise<string> {
  const id = ++msgCounter;
  const w = ensureWorker();
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, type, ...data }, transfer ?? []);
  });
}

export function ensureWhisperLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = workerCall('load').then(() => {
      progressListeners.forEach(cb => cb(100));
      console.log('[Whisper] Model ready');
    }).catch(err => {
      loadPromise = null;
      throw err;
    });
  }
  return loadPromise;
}

export async function transcribeAudio(blob: Blob): Promise<string> {
  await ensureWhisperLoaded();
  const samples = await decodeAndResample(blob);
  return workerCall('transcribe', { audio: samples }, [samples.buffer]);
}

async function decodeAndResample(blob: Blob, targetHz = 16000): Promise<Float32Array> {
  const arrayBuf = await blob.arrayBuffer();

  // Decode at original sample rate
  const tmpCtx = new AudioContext();
  let audioBuf: AudioBuffer;
  try {
    audioBuf = await tmpCtx.decodeAudioData(arrayBuf);
  } finally {
    tmpCtx.close().catch(() => {});
  }

  // Fast path: already mono 16 kHz
  if (audioBuf.sampleRate === targetHz && audioBuf.numberOfChannels === 1) {
    return audioBuf.getChannelData(0).slice();
  }

  // Resample + mix down to mono via OfflineAudioContext
  const numFrames = Math.ceil(audioBuf.duration * targetHz);
  const offCtx = new OfflineAudioContext(1, numFrames, targetHz);
  const src = offCtx.createBufferSource();
  src.buffer = audioBuf;
  src.connect(offCtx.destination);
  src.start(0);
  const resampled = await offCtx.startRendering();
  return resampled.getChannelData(0).slice();
}
