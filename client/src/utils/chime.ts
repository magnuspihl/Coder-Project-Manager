let audioCtx: AudioContext | null = null;

function getAudioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

/** Play a short two-tone chime using the Web Audio API. */
export function playChime() {
  const ctx = getAudioCtx();
  if (!ctx) return;

  // Resume context if suspended (browsers require user gesture)
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }

  const now = ctx.currentTime;

  // Two ascending tones for a pleasant "ding-ding"
  const frequencies = [523.25, 659.25]; // C5, E5
  const duration = 0.15;
  const gap = 0.1;

  frequencies.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.3, now + i * (duration + gap));
    gain.gain.exponentialRampToValueAtTime(0.001, now + i * (duration + gap) + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + i * (duration + gap));
    osc.stop(now + i * (duration + gap) + duration);
  });
}
