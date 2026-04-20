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

  // Callback refs — always point to the latest version, avoiding stale closures
  // in long-lived SpeechRecognition event handlers
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onSilenceTimeoutRef = useRef(onSilenceTimeout);
  onSilenceTimeoutRef.current = onSilenceTimeout;
  const silenceMsRef = useRef(silenceMs);
  silenceMsRef.current = silenceMs;

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

  const stopInternal = useCallback(() => {
    wantListeningRef.current = false;
    clearSilenceTimer();
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, [clearSilenceTimer]);

  const createAndStart = useCallback(() => {
    if (!SpeechRecognitionClass) return false;

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
        onTranscriptRef.current(displayText);
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
          onSilenceTimeoutRef.current(text);
        }
      }, silenceMsRef.current);
    };

    recognition.onerror = (event) => {
      if (FATAL_ERRORS.has(event.error)) {
        stopInternal();
      }
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      if (wantListeningRef.current) {
        try {
          createAndStart();
          return;
        } catch {
          // fall through to stop
        }
      }
      clearSilenceTimer();
      setIsListening(false);
      wantListeningRef.current = false;
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      return true;
    } catch {
      recognitionRef.current = null;
      return false;
    }
  }, [SpeechRecognitionClass, clearSilenceTimer, stopInternal]);

  const stopListening = stopInternal;

  const startListening = useCallback(() => {
    if (!SpeechRecognitionClass || wantListeningRef.current) return;

    accumulatedRef.current = '';
    wantListeningRef.current = true;

    if (createAndStart()) {
      setIsListening(true);
    } else {
      wantListeningRef.current = false;
    }
  }, [SpeechRecognitionClass, createAndStart]);

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
