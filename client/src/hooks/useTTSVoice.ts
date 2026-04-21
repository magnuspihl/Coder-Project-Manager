import { useState, useEffect, useCallback, useRef } from 'react';
import { getKokoroPipeline, onKokoroProgress, KOKORO_VOICES } from '../utils/kokoroTTS';

const STORAGE_KEY = 'tts:voiceId';
const STORAGE_PROVIDER_KEY = 'tts:provider';

export interface TTSVoice {
  id: string;
  name: string;
  provider: 'elevenlabs' | 'browser' | 'kokoro';
  accent?: string;
  category?: string;
  isCustom?: boolean;
  description?: string;
}

interface ElevenLabsVoice {
  id: string;
  name: string;
  category?: string;
  accent?: string;
  style?: string;
  description?: string;
  isCustom?: boolean;
}

interface ElevenLabsResponse {
  voices: ElevenLabsVoice[];
  enabled: boolean;
  defaultVoiceId?: string;
}

const DEFAULT_VOICE_ID = 'kokoro:af_sarah';

export function useTTSVoice() {
  const [voices, setVoices] = useState<TTSVoice[]>(() =>
    KOKORO_VOICES.map(v => ({
      id: `kokoro:${v.id}`,
      name: `${v.name} — ${v.accent} ${v.gender}`,
      provider: 'kokoro' as const,
      accent: v.accent,
    }))
  );

  const [selectedId, setSelectedId] = useState<string>(() => {
    try { return localStorage.getItem(STORAGE_KEY) || DEFAULT_VOICE_ID; }
    catch { return DEFAULT_VOICE_ID; }
  });

  const [provider, setProvider] = useState<'elevenlabs' | 'browser' | 'kokoro'>(() => {
    try {
      return (localStorage.getItem(STORAGE_PROVIDER_KEY) as 'elevenlabs' | 'browser' | 'kokoro') || 'kokoro';
    } catch { return 'kokoro'; }
  });

  const [kokoroLoading, setKokoroLoading] = useState(false);
  const [kokoroProgress, setKokoroProgress] = useState(0);
  const [kokoroError, setKokoroError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const kokoroSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const kokoroContextRef = useRef<AudioContext | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);

  // Load additional voices (ElevenLabs + browser) without replacing Kokoro
  useEffect(() => {
    let cancelled = false;

    const loadExtra = async () => {
      const extra: TTSVoice[] = [];

      try {
        const resp = await fetch('/api/tts/voices', { credentials: 'include' });
        if (resp.ok) {
          const data: ElevenLabsResponse = await resp.json();
          if (data.enabled && data.voices.length > 0) {
            for (const v of data.voices) {
              const parts = [v.name];
              if (v.description) parts.push(v.description);
              else if (v.accent) parts.push(v.accent);
              extra.push({
                id: `el:${v.id}`,
                name: parts.join(' — '),
                provider: 'elevenlabs',
                accent: v.accent,
                category: v.category,
                isCustom: !!v.isCustom,
                description: v.description,
              });
            }
          }
        }
      } catch {
        // ElevenLabs unavailable
      }

      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        const loadBrowser = () => {
          const bv = speechSynthesis.getVoices();
          const english = bv.filter(v => v.lang.startsWith('en'));
          for (const v of english) {
            extra.push({ id: `br:${v.voiceURI}`, name: `${v.name} (browser)`, provider: 'browser' });
          }
          if (!cancelled) {
            setVoices(prev => {
              const kokoro = prev.filter(v => v.provider === 'kokoro');
              return [...kokoro, ...extra];
            });
          }
        };
        const bv = speechSynthesis.getVoices();
        if (bv.length > 0) loadBrowser();
        else speechSynthesis.addEventListener('voiceschanged', loadBrowser, { once: true });
      } else if (!cancelled && extra.length > 0) {
        setVoices(prev => {
          const kokoro = prev.filter(v => v.provider === 'kokoro');
          return [...kokoro, ...extra];
        });
      }
    };

    loadExtra();
    return () => { cancelled = true; };
  }, []);

  const selectVoice = useCallback((id: string) => {
    setSelectedId(id);
    const prov = id.startsWith('el:') ? 'elevenlabs' : id.startsWith('kokoro:') ? 'kokoro' : 'browser';
    setProvider(prov);
    try { localStorage.setItem(STORAGE_KEY, id); } catch {}
    try { localStorage.setItem(STORAGE_PROVIDER_KEY, prov); } catch {}
  }, []);

  const stopCurrent = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    speechSynthesis.cancel();
    if (kokoroSourceRef.current) {
      try { kokoroSourceRef.current.stop(); } catch {}
      kokoroSourceRef.current = null;
    }
    if (kokoroContextRef.current) {
      kokoroContextRef.current.close().catch(() => {});
      kokoroContextRef.current = null;
    }
  }, []);

  // Core speaking logic for a specific voice. Does NOT stop current playback or
  // check toggle — callers are responsible for that. Throws on synthesis error so
  // speakAs() can fall through to the next voice in the priority list.
  const speakWithVoiceId = useCallback(async (text: string, msgId: string | undefined, id: string): Promise<void> => {
    if (!text.trim()) return;

    if (id.startsWith('kokoro:')) {
      const voiceName = id.replace(/^kokoro:/, '');
      setSpeakingId(msgId || 'anon');
      const unsub = onKokoroProgress((pct) => setKokoroProgress(pct));
      try {
        setKokoroLoading(true);
        const synth = await getKokoroPipeline();
        setKokoroLoading(false);
        unsub();

        const ctx = new AudioContext({ sampleRate: 24000 });
        await ctx.resume();
        kokoroContextRef.current = ctx;
        kokoroSourceRef.current = null;

        const chunks: Array<{ audio: Float32Array; samplingRate: number }> = [];
        console.log('[Kokoro] Buffering synthesis, voice:', voiceName);

        await new Promise<void>((resolve, reject) => {
          synth.stream(
            text.slice(0, 3000),
            voiceName,
            (audio, samplingRate) => {
              if (kokoroContextRef.current !== ctx) { resolve(); return; }
              console.log('[Kokoro] Chunk buffered, samples:', audio.length);
              chunks.push({ audio, samplingRate });
            },
            () => resolve(),
            (errMsg) => reject(new Error(errMsg)),
          );
        });

        if (kokoroContextRef.current !== ctx) return;

        let nextStart = ctx.currentTime + 0.05;
        for (const { audio, samplingRate } of chunks) {
          const buf = ctx.createBuffer(1, audio.length, samplingRate);
          buf.getChannelData(0).set(audio);
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(ctx.destination);
          src.start(nextStart);
          nextStart += buf.duration;
        }

        const timeLeft = Math.max(0, nextStart - ctx.currentTime);
        console.log('[Kokoro] Playing', chunks.length, 'chunks, ends in', timeLeft.toFixed(2), 's');
        setTimeout(() => {
          setSpeakingId(null);
          ctx.close().catch(() => {});
          if (kokoroContextRef.current === ctx) kokoroContextRef.current = null;
        }, timeLeft * 1000 + 150);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Kokoro] Error:', msg);
        setKokoroError(msg);
        setSpeakingId(null);
        setKokoroLoading(false);
        unsub();
        throw err;
      }
      return;
    }

    if (id.startsWith('el:')) {
      const voiceId = id.replace(/^el:/, '');
      setSpeakingId(msgId || 'anon');
      try {
        const resp = await fetch('/api/tts/speak', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: text.slice(0, 5000), voiceId }),
        });
        if (!resp.ok) throw new Error(`TTS failed: ${resp.status}`);
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audioRef.current = audio;
        await new Promise<void>((resolve, reject) => {
          audio.onended = () => { setSpeakingId(null); URL.revokeObjectURL(url); audioRef.current = null; resolve(); };
          audio.onerror = () => { setSpeakingId(null); URL.revokeObjectURL(url); audioRef.current = null; reject(new Error('Audio playback error')); };
          audio.play().catch(reject);
        });
      } catch (err) {
        setSpeakingId(null);
        throw err;
      }
      return;
    }

    // Browser TTS — best-effort, no error propagation (can't reliably detect voice absence)
    const uri = id.replace(/^br:/, '');
    const utter = new SpeechSynthesisUtterance(text);
    const bv = speechSynthesis.getVoices().find(v => v.voiceURI === uri);
    if (bv) utter.voice = bv;
    utter.rate = 1.1;
    setSpeakingId(msgId || 'anon');
    utter.onend = () => setSpeakingId(null);
    utter.onerror = () => setSpeakingId(null);
    speechSynthesis.speak(utter);
  }, [stopCurrent]);

  // Manual speak: stops current, toggles off if same message, uses selectedId
  const speak = useCallback(async (text: string, msgId?: string): Promise<void> => {
    stopCurrent();
    if (speakingId === msgId) { setSpeakingId(null); return; }
    try {
      await speakWithVoiceId(text, msgId, selectedId);
    } catch {
      // swallow — error already logged inside speakWithVoiceId
    }
  }, [selectedId, speakingId, stopCurrent, speakWithVoiceId]);

  // Speaks using a priority-ordered list of voice IDs, falling back on error.
  // Caller is responsible for toggle behavior (stop if same msgId is already speaking).
  const speakAs = useCallback(async (text: string, msgId: string | undefined, voiceIds: string[]): Promise<void> => {
    stopCurrent();
    setSpeakingId(null);
    // Always append selectedId as the final fallback so workspace voices
    // (e.g. ElevenLabs) can fall through to the global default on failure.
    const seen = new Set<string>();
    const ids = [...voiceIds, selectedId].filter(id => seen.has(id) ? false : (seen.add(id), true));
    for (const vid of ids) {
      try {
        await speakWithVoiceId(text, msgId, vid);
        return;
      } catch (err) {
        console.warn('[TTS] Voice', vid, 'failed, trying next:', err instanceof Error ? err.message : err);
        setSpeakingId(null);
      }
    }
  }, [selectedId, stopCurrent, speakWithVoiceId]);

  const stopSpeaking = useCallback(() => {
    stopCurrent();
    setSpeakingId(null);
    setKokoroLoading(false);
  }, [stopCurrent]);

  return { voices, selectedId, provider, selectVoice, speak, speakAs, stopSpeaking, speakingId, kokoroLoading, kokoroProgress, kokoroError };
}
