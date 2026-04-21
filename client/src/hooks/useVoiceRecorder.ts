import { useRef, useState, useCallback, useEffect } from 'react';
import { transcribeAudio, ensureWhisperLoaded, onWhisperProgress } from '../utils/whisperSTT';

interface UseVoiceRecorderOptions {
  onTranscript: (text: string) => void;
  onError?: (msg: string) => void;
}

export function useVoiceRecorder({ onTranscript, onError }: UseVoiceRecorderOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [debugStatus, setDebugStatus] = useState('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // Preload the Whisper model in the background as soon as the hook mounts.
  // By the time the user clicks the mic, the model is typically already ready.
  useEffect(() => {
    const unsub = onWhisperProgress((pct) => {
      if (pct < 100) setDebugStatus(`Loading model (${pct}%)`);
      else setDebugStatus('');
    });

    ensureWhisperLoaded().catch((err) => {
      console.error('[Whisper] Preload failed:', err);
      setDebugStatus('Model unavailable');
    });

    return unsub;
  }, []);

  const stopRecording = useCallback(async () => {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
      setIsRecording(false);
      return;
    }

    return new Promise<void>((resolve) => {
      const recorder = mediaRecorderRef.current!;

      recorder.onstop = async () => {
        setIsRecording(false);

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        chunksRef.current = [];

        if (streamRef.current) {
          streamRef.current.getTracks().forEach(t => t.stop());
          streamRef.current = null;
        }

        if (blob.size < 1000) {
          setDebugStatus('Recording too short');
          resolve();
          return;
        }

        setIsTranscribing(true);
        setDebugStatus('Transcribing...');

        try {
          const text = await transcribeAudio(blob);
          if (text) {
            setDebugStatus(`"${text.slice(0, 40)}${text.length > 40 ? '…' : ''}"`);
            onTranscriptRef.current(text);
          } else {
            setDebugStatus('No speech detected');
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Transcription failed';
          console.error('[Whisper]', msg);
          setDebugStatus(msg);
          onErrorRef.current?.(msg);
        } finally {
          setIsTranscribing(false);
        }

        resolve();
      };

      recorder.stop();
    });
  }, []);

  const startRecording = useCallback(async () => {
    if (isRecording || isTranscribing) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setIsRecording(true);
      setDebugStatus('Recording… click to stop');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Mic access denied';
      setDebugStatus(msg);
      onErrorRef.current?.(msg);
    }
  }, [isRecording, isTranscribing]);

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current?.state !== 'inactive') {
        mediaRecorderRef.current?.stop();
      }
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  return {
    isSupported: !!navigator.mediaDevices?.getUserMedia,
    isRecording,
    isTranscribing,
    startRecording,
    stopRecording,
    debugStatus,
  };
}
