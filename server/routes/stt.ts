import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import multer from 'multer';

const router = Router();

const WHISPER_URL = process.env.WHISPER_URL || '';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.get('/stt/status', requireAuth, (_req: Request, res: Response) => {
  res.json({ enabled: !!WHISPER_URL });
});

router.post('/stt/transcribe', requireAuth, upload.single('audio'), async (req: Request, res: Response) => {
  if (!WHISPER_URL) {
    res.status(503).json({ error: 'STT not configured — set WHISPER_URL env var' });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: 'No audio file provided' });
    return;
  }

  try {
    const formData = new FormData();
    const uint8 = new Uint8Array(req.file.buffer);
    formData.append('file', new Blob([uint8], { type: req.file.mimetype }), 'audio.webm');
    formData.append('model', 'base');
    formData.append('response_format', 'json');

    const resp = await fetch(`${WHISPER_URL}/v1/audio/transcriptions`, {
      method: 'POST',
      body: formData,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[stt] Whisper error:', resp.status, errText.slice(0, 200));
      res.status(resp.status).json({ error: 'Transcription failed', details: errText.slice(0, 500) });
      return;
    }

    const data = await resp.json() as { text?: string };
    res.json({ text: data.text || '' });
  } catch (err) {
    console.error('[stt] Whisper unreachable:', err instanceof Error ? err.message : err);
    res.status(502).json({ error: 'Whisper server unreachable' });
  }
});

export default router;
