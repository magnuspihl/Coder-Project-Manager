import { useState, useEffect, useCallback, useRef } from 'react';

const STORAGE_KEY = 'tts:voiceId';
const STORAGE_PROVIDER_KEY = 'tts:provider';

export interface TTSVoice {
  id: string;
  name: string;
  provider: 'elevenlabs' | 'browser';
  accent?: string;
  category?: string;
}

interface ElevenLabsVoice {
  id: string;
  name: string;
  category: string;
  accent: string;
}

interface ElevenLabsResponse {
  voices: ElevenLabsVoice[];
  enabled: boolean;
  defaultVoiceId?: string;
}

export function useTTSVoice() {
  const [voices, setVoices] = useState<TTSVoice[]>([]);
  const [selectedId, setSelectedId] = useState<string>(() => {
    try { return localStorage.getItem(STORAGE_KEY) || ''; }
    catch { return ''; }
  });
  const [provider, setProvider] = useState<'elevenlabs' | 'browser'>(() => {
    try { return (localStorage.getItem(STORAGE_PROVIDER_KEY) as 'elevenlabs' | 'browser') || 'browser'; }
    catch { return 'browser'; }
  });
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadVoices = async () => {
      const allVoices: TTSVoice[] = [];

      // Try ElevenLabs
      try {
        const resp = await fetch('/api/tts/voices', { credentials: 'include' });
        if (resp.ok) {
          const data: ElevenLabsResponse = await resp.json();
          if (data.enabled && data.voices.length > 0) {
            for (const v of data.voices) {
              allVoices.push({
                id: `el:${v.id}`,
                name: v.name,
                provider: 'elevenlabs',
                accent: v.accent,
                category: v.category,
              });
            }
            // Auto-select ElevenLabs default if no selection yet
            if (!cancelled) {
              setSelectedId(prev => {
                if (prev && allVoices.some(v => v.id === prev)) return prev;
                const defaultId = `el:${data.defaultVoiceId || data.voices[0].id}`;
                try { localStorage.setItem(STORAGE_KEY, defaultId); } catch {}
                try { localStorage.setItem(STORAGE_PROVIDER_KEY, 'elevenlabs'); } catch {}
                setProvider('elevenlabs');
                return defaultId;
              });
            }
          }
        }
      } catch {
        // ElevenLabs unavailable, continue with browser voices
      }

      // Add browser voices as fallback
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        const loadBrowser = () => {
          const bv = speechSynthesis.getVoices();
          const english = bv.filter(v => v.lang.startsWith('en'));
          for (const v of english) {
            allVoices.push({
              id: `br:${v.voiceURI}`,
              name: `${v.name} (browser)`,
              provider: 'browser',
            });
          }
          if (!cancelled) setVoices([...allVoices]);
        };

        const bv = speechSynthesis.getVoices();
        if (bv.length > 0) {
          loadBrowser();
        } else {
          speechSynthesis.addEventListener('voiceschanged', loadBrowser, { once: true });
        }
      }

      if (!cancelled) setVoices(prev => prev.length > 0 ? prev : [...allVoices]);
    };

    loadVoices();
    return () => { cancelled = true; };
  }, []);

  const selectVoice = useCallback((id: string) => {
    setSelectedId(id);
    const prov = id.startsWith('el:') ? 'elevenlabs' : 'browser';
    setProvider(prov);
    try { localStorage.setItem(STORAGE_KEY, id); } catch {}
    try { localStorage.setItem(STORAGE_PROVIDER_KEY, prov); } catch {}
  }, []);

  const speak = useCallback(async (text: string, msgId?: string): Promise<void> => {
    // Stop any current playback
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    speechSynthesis.cancel();

    if (speakingId === msgId) {
      setSpeakingId(null);
      return;
    }

    if (!text.trim()) return;

    const voice = voices.find(v => v.id === selectedId);
    const isElevenLabs = voice?.provider === 'elevenlabs' || selectedId.startsWith('el:');

    if (isElevenLabs) {
      const voiceId = selectedId.replace(/^el:/, '');
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
        audio.onended = () => {
          setSpeakingId(null);
          URL.revokeObjectURL(url);
          audioRef.current = null;
        };
        audio.onerror = () => {
          setSpeakingId(null);
          URL.revokeObjectURL(url);
          audioRef.current = null;
        };
        await audio.play();
      } catch {
        setSpeakingId(null);
      }
    } else {
      const uri = selectedId.replace(/^br:/, '');
      const utter = new SpeechSynthesisUtterance(text);
      const bv = speechSynthesis.getVoices().find(v => v.voiceURI === uri);
      if (bv) utter.voice = bv;
      utter.rate = 1.1;
      setSpeakingId(msgId || 'anon');
      utter.onend = () => setSpeakingId(null);
      utter.onerror = () => setSpeakingId(null);
      speechSynthesis.speak(utter);
    }
  }, [voices, selectedId, speakingId]);

  const stopSpeaking = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    speechSynthesis.cancel();
    setSpeakingId(null);
  }, []);

  return { voices, selectedId, selectVoice, speak, stopSpeaking, speakingId };
}
