import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'tts:voiceURI';

const PREFERRED_PATTERNS = [
  /\bnatural\b/i,
  /\benhanced\b/i,
  /\bpremium\b/i,
  /\bgoogle\b.*\b(us|uk)\b/i,
  /\bgoogle\b/i,
  /\bmicrosoft\b.*\b(aria|jenny|guy)\b/i,
  /\bsamantha\b/i,
];

function pickDefaultVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const english = voices.filter(v => v.lang.startsWith('en'));
  if (english.length === 0) return voices[0] || null;

  for (const pattern of PREFERRED_PATTERNS) {
    const match = english.find(v => pattern.test(v.name));
    if (match) return match;
  }

  return english.find(v => v.default) || english[0];
}

export function useTTSVoice() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedURI, setSelectedURI] = useState<string>(() => {
    try { return localStorage.getItem(STORAGE_KEY) || ''; }
    catch { return ''; }
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    const load = () => {
      const available = speechSynthesis.getVoices();
      if (available.length > 0) {
        setVoices(available);
        setSelectedURI(prev => {
          if (prev && available.some(v => v.voiceURI === prev)) return prev;
          const best = pickDefaultVoice(available);
          const uri = best?.voiceURI || '';
          try { localStorage.setItem(STORAGE_KEY, uri); } catch {}
          return uri;
        });
      }
    };

    load();
    speechSynthesis.addEventListener('voiceschanged', load);
    return () => speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);

  const selectVoice = useCallback((uri: string) => {
    setSelectedURI(uri);
    try { localStorage.setItem(STORAGE_KEY, uri); } catch {}
  }, []);

  const getVoice = useCallback((): SpeechSynthesisVoice | null => {
    return voices.find(v => v.voiceURI === selectedURI) || null;
  }, [voices, selectedURI]);

  return { voices, selectedURI, selectVoice, getVoice };
}
