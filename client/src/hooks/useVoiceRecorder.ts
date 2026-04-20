import { useRef, useState, useCallback, useEffect } from 'react';

interface UseVoiceRecorderOptions {
  onTranscript: (text: string) => void;
  onError?: (msg: string) => void;
}

export function useVoiceRecorder({ onTranscript, onError }: UseVoiceRecorderOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [sttEnabled, setSttEnabled] = useState(false);
  const [debugStatus, setDebugStatus] = useState('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    fetch('/api/stt/status', { credentials: 'include' })
      .then(r => r.json())
      .then((data: { enabled: boolean }) => setSttEnabled(data.enabled))
      .catch(() => setSttEnabled(false));
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
          const formData = new FormData();
          formData.append('audio', blob, 'recording.webm');

          const resp = await fetch('/api/stt/transcribe', {
            method: 'POST',
            credentials: 'include',
            body: formData,
          });

          if (!resp.ok) {
            const err = await resp.json().catch(() => ({ error: 'Transcription failed' }));
            const msg = (err as { error?: string }).error || 'Transcription failed';
            setDebugStatus(msg);
            onErrorRef.current?.(msg);
          } else {
            const data = await resp.json() as { text: string };
            if (data.text?.trim()) {
              setDebugStatus(`"${data.text.trim().slice(0, 40)}..."`);
              onTranscriptRef.current(data.text.trim());
            } else {
              setDebugStatus('No speech detected');
            }
          }
        } catch {
          setDebugStatus('Whisper server unreachable');
          onErrorRef.current?.('Whisper server unreachable');
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
      setDebugStatus('Recording... click to stop');
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
    isSupported: sttEnabled && !!navigator.mediaDevices?.getUserMedia,
    isRecording,
    isTranscribing,
    startRecording,
    stopRecording,
    debugStatus,
  };
}
