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

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
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
  const stoppingRef = useRef(false);

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

  const stopListening = useCallback(() => {
    stoppingRef.current = true;
    clearSilenceTimer();
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, [clearSilenceTimer]);

  const startListening = useCallback(() => {
    if (!SpeechRecognitionClass || isListening) return;

    stoppingRef.current = false;
    accumulatedRef.current = '';

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
        if (text && !stoppingRef.current) {
          onSilenceTimeout(text);
        }
        stopListening();
      }, silenceMs);
    };

    recognition.onerror = () => {
      stopListening();
    };

    recognition.onend = () => {
      if (!stoppingRef.current) {
        setIsListening(false);
        recognitionRef.current = null;
        clearSilenceTimer();
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [SpeechRecognitionClass, isListening, onTranscript, onSilenceTimeout, silenceMs, clearSilenceTimer, stopListening]);

  useEffect(() => {
    return () => {
      clearSilenceTimer();
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, [clearSilenceTimer]);

  return { isSupported, isListening, startListening, stopListening };
}
