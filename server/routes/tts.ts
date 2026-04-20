import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL'; // "Sarah" — clear, natural
const DEFAULT_MODEL = 'eleven_multilingual_v2';

router.get('/tts/voices', requireAuth, async (_req: Request, res: Response) => {
  if (!ELEVENLABS_API_KEY) {
    res.json({ voices: [], enabled: false });
    return;
  }

  try {
    const resp = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
    });
    if (!resp.ok) {
      res.json({ voices: [], enabled: true, error: 'Failed to fetch voices' });
      return;
    }
    const data = await resp.json() as { voices: Array<{ voice_id: string; name: string; category: string; labels?: Record<string, string> }> };
    const voices = data.voices.map(v => ({
      id: v.voice_id,
      name: v.name,
      category: v.category,
      accent: v.labels?.accent || '',
    }));
    res.json({ voices, enabled: true, defaultVoiceId: DEFAULT_VOICE_ID });
  } catch {
    res.json({ voices: [], enabled: true, error: 'ElevenLabs API unreachable' });
  }
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
  } catch (err) {
    res.status(500).json({ error: 'TTS request failed' });
  }
});

export default router;
