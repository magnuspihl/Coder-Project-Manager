import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL';
const DEFAULT_MODEL = 'eleven_multilingual_v2';

// Self-hosted Qwen3-TTS backend (e.g. http://192.168.1.199:8880). Optional —
// when unset, the Qwen routes report disabled and the UI omits these voices.
const QWEN_TTS_URL = (process.env.QWEN_TTS_URL || '').replace(/\/$/, '');
const QWEN_DEFAULT_VOICE = process.env.QWEN_TTS_DEFAULT_VOICE || 'Aiden';

const BUILTIN_VOICES = [
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', accent: 'American', style: 'Soft' },
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', accent: 'American', style: 'Calm' },
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', accent: 'British', style: 'Authoritative' },
  { id: 'XB0fDUnXU5powFXDhCwa', name: 'Charlotte', accent: 'Swedish', style: 'Seductive' },
  { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily', accent: 'British', style: 'Warm' },
  { id: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Liam', accent: 'American', style: 'Articulate' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', accent: 'British', style: 'Warm' },
  { id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica', accent: 'American', style: 'Expressive' },
  { id: 'iP95p4xoKVk53GoZ742B', name: 'Chris', accent: 'American', style: 'Casual' },
  { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian', accent: 'American', style: 'Deep' },
  { id: 'N2lVS1w4EtoT3dr4eOWO', name: 'Callum', accent: 'Transatlantic', style: 'Intense' },
];

router.get('/tts/voices', requireAuth, async (_req: Request, res: Response) => {
  if (!ELEVENLABS_API_KEY) {
    res.json({ voices: [], enabled: false });
    return;
  }

  // Try fetching from API first; fall back to built-in list
  try {
    const resp = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
    });
    if (resp.ok) {
      const data = await resp.json() as { voices: Array<{ voice_id: string; name: string; category: string; labels?: Record<string, string>; description?: string }> };
      if (data.voices?.length > 0) {
        // Check plan: try a test TTS with a professional voice to see if paid features work
        const proVoice = data.voices.find(v => v.category === 'professional');
        let hasPaidPlan = false;
        if (proVoice) {
          try {
            const testResp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${proVoice.voice_id}`, {
              method: 'POST',
              headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
              body: JSON.stringify({ text: '.', model_id: DEFAULT_MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
            });
            hasPaidPlan = testResp.ok;
          } catch {}
        }

        const mapVoice = (v: typeof data.voices[0], isCustom: boolean) => ({
          id: v.voice_id,
          name: v.name,
          category: v.category,
          accent: v.labels?.accent || '',
          description: v.labels?.description || v.description || '',
          isCustom,
        });

        const myVoices = hasPaidPlan
          ? data.voices.filter(v => v.category !== 'premade').map(v => mapVoice(v, true))
          : [];
        const premadeVoices = data.voices
          .filter(v => v.category === 'premade')
          .map(v => mapVoice(v, false));

        const voices = [...myVoices, ...premadeVoices];
        const defaultId = myVoices.length > 0 ? myVoices[0].id : DEFAULT_VOICE_ID;
        res.json({ voices, enabled: true, defaultVoiceId: defaultId });
        return;
      }
    }
  } catch {
    // Fall through to built-in list
  }

  res.json({
    voices: BUILTIN_VOICES,
    enabled: true,
    defaultVoiceId: DEFAULT_VOICE_ID,
  });
});

router.post('/tts/speak', requireAuth, async (req: Request, res: Response) => {
  if (!ELEVENLABS_API_KEY) {
    res.status(503).json({ error: 'TTS not configured' });
    return;
  }

  const { text, voiceId } = req.body as { text?: string; voiceId?: string };
  if (!text || typeof text !== 'string' || text.length === 0) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  if (text.length > 5000) {
    res.status(400).json({ error: 'Text too long (max 5000 chars)' });
    return;
  }

  const vid = voiceId || DEFAULT_VOICE_ID;

  try {
    const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: DEFAULT_MODEL,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      res.status(resp.status).json({ error: errText });
      return;
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    const arrayBuf = await resp.arrayBuffer();
    res.send(Buffer.from(arrayBuf));
  } catch {
    res.status(500).json({ error: 'TTS request failed' });
  }
});

// ---------------------------------------------------------------------------
// Qwen3-TTS — self-hosted backend proxied through CPM (third TTS option,
// alongside browser Kokoro and cloud ElevenLabs). Contract with the Odin
// container: GET /voices, POST /warmup, POST /speak {text, voice_id, language}.
// ---------------------------------------------------------------------------

router.get('/tts/qwen/voices', requireAuth, async (_req: Request, res: Response) => {
  if (!QWEN_TTS_URL) {
    res.json({ voices: [], enabled: false });
    return;
  }
  try {
    const resp = await fetch(`${QWEN_TTS_URL}/voices`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      res.json({ voices: [], enabled: false });
      return;
    }
    const data = await resp.json() as { voices?: Array<{ id: string; name?: string; description?: string }> };
    const voices = (data.voices ?? []).map(v => ({
      id: v.id,
      name: v.name || v.id,
      description: v.description || '',
    }));
    res.json({ voices, enabled: voices.length > 0, defaultVoiceId: QWEN_DEFAULT_VOICE });
  } catch {
    res.json({ voices: [], enabled: false });
  }
});

// Warm the model on the Odin box so the first utterance isn't slow. The
// container loads on demand and unloads after a keep-alive; the client calls
// this when voice mode is enabled. Best-effort — never fails the caller.
router.post('/tts/qwen/warmup', requireAuth, async (_req: Request, res: Response) => {
  if (!QWEN_TTS_URL) {
    res.json({ ok: false });
    return;
  }
  try {
    const resp = await fetch(`${QWEN_TTS_URL}/warmup`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    res.json({ ok: resp.ok });
  } catch {
    res.json({ ok: false });
  }
});

router.post('/tts/qwen/speak', requireAuth, async (req: Request, res: Response) => {
  if (!QWEN_TTS_URL) {
    res.status(503).json({ error: 'Qwen TTS not configured — set QWEN_TTS_URL env var' });
    return;
  }

  const { text, voiceId } = req.body as { text?: string; voiceId?: string };
  if (!text || typeof text !== 'string' || text.length === 0) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  if (text.length > 5000) {
    res.status(400).json({ error: 'Text too long (max 5000 chars)' });
    return;
  }

  const vid = voiceId || QWEN_DEFAULT_VOICE;

  try {
    const resp = await fetch(`${QWEN_TTS_URL}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'audio/wav' },
      body: JSON.stringify({ text, voice_id: vid, language: 'English' }),
      // Cold start (model load on Odin) can take several seconds; allow headroom.
      signal: AbortSignal.timeout(60000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      res.status(resp.status).json({ error: errText || 'Qwen TTS error' });
      return;
    }

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    const arrayBuf = await resp.arrayBuffer();
    res.send(Buffer.from(arrayBuf));
  } catch (err) {
    console.error('[tts] Qwen error:', err instanceof Error ? err.message : err);
    res.status(502).json({ error: 'Qwen TTS server unreachable' });
  }
});

export default router;
