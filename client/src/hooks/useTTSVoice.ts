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

  const speak = useCallback(async (text: string, msgId?: string): Promise<void> => {
    // Stop any current playback
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

    if (speakingId === msgId) {
      setSpeakingId(null);
      return;
    }
    if (!text.trim()) return;

    const id = selectedId;

    if (id.startsWith('kokoro:')) {
      const voiceName = id.replace(/^kokoro:/, '');
      setSpeakingId(msgId || 'anon');

      const unsub = onKokoroProgress((pct) => setKokoroProgress(pct));

      try {
        setKokoroLoading(true);
        const synth = await getKokoroPipeline();
        setKokoroLoading(false);
        unsub();

        // Create AudioContext once for the whole utterance so we can schedule
        // each sentence chunk to play immediately after the previous one.
        const ctx = new AudioContext({ sampleRate: 24000 });
        kokoroContextRef.current = ctx;
        kokoroSourceRef.current = null;
        let nextStart = ctx.currentTime;
        let lastSource: AudioBufferSourceNode | null = null;

        synth.stream(
          text.slice(0, 3000),
          voiceName,
          (audio, samplingRate) => {
            if (kokoroContextRef.current !== ctx) return; // stopped mid-stream
            const buf = ctx.createBuffer(1, audio.length, samplingRate);
            buf.getChannelData(0).set(audio);
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(ctx.destination);
            // Small lookahead buffer so scheduling is gapless even under load
            const startAt = Math.max(ctx.currentTime + 0.05, nextStart);
            src.start(startAt);
            nextStart = startAt + buf.duration;
            lastSource = src;
          },
          () => {
            // All sentences synthesised — wait for last source to finish
            if (kokoroContextRef.current !== ctx) return;
            const finish = () => {
              setSpeakingId(null);
              ctx.close().catch(() => {});
              if (kokoroContextRef.current === ctx) kokoroContextRef.current = null;
            };
            if (lastSource) lastSource.onended = finish;
            else finish();
          },
          (errMsg) => {
            console.error('[Kokoro] Stream error:', errMsg);
            setKokoroError(errMsg);
            setSpeakingId(null);
            ctx.close().catch(() => {});
            if (kokoroContextRef.current === ctx) kokoroContextRef.current = null;
          },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Kokoro] Error:', msg);
        setKokoroError(msg);
        setSpeakingId(null);
        setKokoroLoading(false);
        unsub();
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
        if (!resp.ok) throw new Error('TTS failed');
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => { setSpeakingId(null); URL.revokeObjectURL(url); audioRef.current = null; };
        audio.onerror = () => { setSpeakingId(null); URL.revokeObjectURL(url); audioRef.current = null; };
        await audio.play();
      } catch {
        setSpeakingId(null);
      }
      return;
    }

    // Browser TTS
    const uri = id.replace(/^br:/, '');
    const utter = new SpeechSynthesisUtterance(text);
    const bv = speechSynthesis.getVoices().find(v => v.voiceURI === uri);
    if (bv) utter.voice = bv;
    utter.rate = 1.1;
    setSpeakingId(msgId || 'anon');
    utter.onend = () => setSpeakingId(null);
    utter.onerror = () => setSpeakingId(null);
    speechSynthesis.speak(utter);
  }, [selectedId, speakingId]);

  const stopSpeaking = useCallback(() => {
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
    setSpeakingId(null);
    setKokoroLoading(false);
  }, []);

  return { voices, selectedId, provider, selectVoice, speak, stopSpeaking, speakingId, kokoroLoading, kokoroProgress, kokoroError };
}
