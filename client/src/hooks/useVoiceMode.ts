import { useRef, useState, useCallback, useEffect } from 'react';

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: { transcript: string; confidence: number };
}

interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  readonly results: SpeechRecognitionResultList;
  readonly resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const FATAL_ERRORS = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported']);

interface UseVoiceModeOptions {
  onTranscript: (text: string) => void;
  onSilenceTimeout: (finalText: string) => void;
  silenceMs?: number;
}

export function useVoiceMode({ onTranscript, onSilenceTimeout, silenceMs = 2000 }: UseVoiceModeOptions) {
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accumulatedRef = useRef('');
  const wantListeningRef = useRef(false);

  const SpeechRecognitionClass = typeof window !== 'undefined'
    ? (window.SpeechRecognition || window.webkitSpeechRecognition) || null
    : null;

  const isSupported = !!SpeechRecognitionClass;

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const createRecognition = useCallback(() => {
    if (!SpeechRecognitionClass) return null;

    const recognition = new SpeechRecognitionClass();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
      clearSilenceTimer();

      let finalTranscript = '';
      let interimTranscript = '';

      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interimTranscript += result[0].transcript;
        }
      }

      accumulatedRef.current = finalTranscript;
      const displayText = (finalTranscript + interimTranscript).trim();
      if (displayText) {
        onTranscript(displayText);
      }

      silenceTimerRef.current = setTimeout(() => {
        const text = accumulatedRef.current.trim() || displayText;
        wantListeningRef.current = false;
        clearSilenceTimer();
        if (recognitionRef.current) {
          recognitionRef.current.stop();
          recognitionRef.current = null;
        }
        setIsListening(false);
        if (text) {
          onSilenceTimeout(text);
        }
      }, silenceMs);
    };

    recognition.onerror = (event) => {
      if (FATAL_ERRORS.has(event.error)) {
        wantListeningRef.current = false;
        clearSilenceTimer();
        recognitionRef.current = null;
        setIsListening(false);
      }
      // Non-fatal errors (no-speech, aborted, network) — let onend handle restart
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      if (wantListeningRef.current && SpeechRecognitionClass) {
        // Restart after transient end (no-speech timeout, network blip)
        try {
          const next = createRecognition();
          if (next) {
            recognitionRef.current = next;
            next.start();
            return;
          }
        } catch {
          // fall through to stop
        }
      }
      clearSilenceTimer();
      setIsListening(false);
      wantListeningRef.current = false;
    };

    return recognition;
  }, [SpeechRecognitionClass, onTranscript, onSilenceTimeout, silenceMs, clearSilenceTimer]);

  const stopListening = useCallback(() => {
    wantListeningRef.current = false;
    clearSilenceTimer();
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, [clearSilenceTimer]);

  const startListening = useCallback(() => {
    if (!SpeechRecognitionClass || wantListeningRef.current) return;

    accumulatedRef.current = '';
    wantListeningRef.current = true;

    const recognition = createRecognition();
    if (!recognition) {
      wantListeningRef.current = false;
      return;
    }

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setIsListening(true);
    } catch {
      wantListeningRef.current = false;
      recognitionRef.current = null;
    }
  }, [SpeechRecognitionClass, createRecognition]);

  useEffect(() => {
    return () => {
      wantListeningRef.current = false;
      clearSilenceTimer();
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }
    };
  }, [clearSilenceTimer]);

  return { isSupported, isListening, startListening, stopListening };
}
