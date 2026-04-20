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
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onspeechstart: (() => void) | null;
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
const RESTART_DELAY_MS = 500;
const MAX_RESTARTS = 3;

interface UseVoiceModeOptions {
  onTranscript: (text: string) => void;
  onSilenceTimeout: (finalText: string) => void;
  silenceMs?: number;
}

export function useVoiceMode({ onTranscript, onSilenceTimeout, silenceMs = 2000 }: UseVoiceModeOptions) {
  const [isListening, setIsListening] = useState(false);
  const [debugStatus, setDebugStatus] = useState('');
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accumulatedRef = useRef('');
  const wantListeningRef = useRef(false);
  const restartCountRef = useRef(0);
  const gotResultRef = useRef(false);

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

  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  const stopInternal = useCallback(() => {
    wantListeningRef.current = false;
    clearSilenceTimer();
    clearRestartTimer();
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, [clearSilenceTimer, clearRestartTimer]);

  const createAndStart = useCallback(() => {
    if (!SpeechRecognitionClass) return false;

    const recognition = new SpeechRecognitionClass();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      setDebugStatus('Waiting for speech...');
    };

    recognition.onaudiostart = () => {
      setDebugStatus('Mic active, speak now...');
    };

    recognition.onspeechstart = () => {
      setDebugStatus('Hearing speech...');
    };

    recognition.onresult = (event) => {
      gotResultRef.current = true;
      restartCountRef.current = 0;
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
      setDebugStatus(finalTranscript ? 'Waiting for silence...' : 'Transcribing...');

      if (displayText) {
        onTranscriptRef.current(displayText);
      }

      silenceTimerRef.current = setTimeout(() => {
        const text = accumulatedRef.current.trim() || displayText;
        wantListeningRef.current = false;
        clearSilenceTimer();
        clearRestartTimer();
        if (recognitionRef.current) {
          recognitionRef.current.stop();
          recognitionRef.current = null;
        }
        setIsListening(false);
        setDebugStatus('Sending...');
        if (text) {
          onSilenceTimeoutRef.current(text);
        }
      }, silenceMsRef.current);
    };

    recognition.onerror = (event) => {
      if (FATAL_ERRORS.has(event.error)) {
        setDebugStatus(`Error: ${event.error}`);
        stopInternal();
      } else {
        setDebugStatus(`${event.error} — retrying...`);
      }
    };

    recognition.onend = () => {
      recognitionRef.current = null;

      if (!wantListeningRef.current) {
        clearSilenceTimer();
        setIsListening(false);
        return;
      }

      restartCountRef.current++;
      if (restartCountRef.current > MAX_RESTARTS) {
        const msg = gotResultRef.current
          ? 'Connection lost — click mic to retry'
          : 'Speech service unavailable — try Chrome or Edge';
        setDebugStatus(msg);
        clearSilenceTimer();
        setIsListening(false);
        wantListeningRef.current = false;
        return;
      }

      setDebugStatus(`Reconnecting (${restartCountRef.current})...`);
      restartTimerRef.current = setTimeout(() => {
        if (wantListeningRef.current) {
          createAndStart();
        }
      }, RESTART_DELAY_MS);
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      return true;
    } catch (e) {
      setDebugStatus(`Start failed: ${e}`);
      recognitionRef.current = null;
      return false;
    }
  }, [SpeechRecognitionClass, clearSilenceTimer, clearRestartTimer, stopInternal]);

  const stopListening = stopInternal;

  const startListening = useCallback(() => {
    if (!SpeechRecognitionClass || wantListeningRef.current) return;

    accumulatedRef.current = '';
    restartCountRef.current = 0;
    gotResultRef.current = false;
    wantListeningRef.current = true;
    setDebugStatus('Starting...');

    if (createAndStart()) {
      setIsListening(true);
    } else {
      wantListeningRef.current = false;
      setDebugStatus('Failed to start');
    }
  }, [SpeechRecognitionClass, createAndStart]);

  useEffect(() => {
    return () => {
      wantListeningRef.current = false;
      clearSilenceTimer();
      clearRestartTimer();
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }
    };
  }, [clearSilenceTimer, clearRestartTimer]);

  return { isSupported, isListening, startListening, stopListening, debugStatus };
}
