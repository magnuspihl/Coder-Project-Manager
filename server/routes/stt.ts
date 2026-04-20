import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { spawn } from 'child_process';
import net from 'net';
import multer from 'multer';

const router = Router();

const WHISPER_HOST = process.env.WHISPER_HOST || '192.168.1.199';
const WHISPER_PORT = parseInt(process.env.WHISPER_PORT || '10300', 10);
const WHISPER_ENABLED = !!(process.env.WHISPER_HOST || process.env.WHISPER_PORT || process.env.WHISPER_URL);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function convertToPCM(inputBuffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-f', 's16le',
      '-ar', '16000',
      '-ac', '1',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const chunks: Buffer[] = [];
    ffmpeg.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
    ffmpeg.on('error', reject);
    ffmpeg.stdin.write(inputBuffer);
    ffmpeg.stdin.end();
  });
}

function wyomingTranscribe(pcmAudio: Buffer, language: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(WHISPER_PORT, WHISPER_HOST, () => {
      const audioStart = JSON.stringify({
        type: 'audio-start',
        data: { rate: 16000, width: 2, channels: 1 },
        payload_length: 0,
      });
      socket.write(audioStart + '\n');

      const CHUNK_SIZE = 3200; // 100ms at 16kHz 16-bit mono
      for (let offset = 0; offset < pcmAudio.length; offset += CHUNK_SIZE) {
        const chunk = pcmAudio.subarray(offset, Math.min(offset + CHUNK_SIZE, pcmAudio.length));
        const audioChunk = JSON.stringify({
          type: 'audio-chunk',
          data: { rate: 16000, width: 2, channels: 1 },
          payload_length: chunk.length,
        });
        socket.write(audioChunk + '\n');
        socket.write(chunk);
      }

      const audioStop = JSON.stringify({
        type: 'audio-stop',
        data: { ...(language ? { language } : {}) },
        payload_length: 0,
      });
      socket.write(audioStop + '\n');
    });

    let buf = '';
    let gotTranscript = false;

    socket.on('data', (data) => {
      buf += data.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'transcript') {
            gotTranscript = true;
          } else if (msg.text !== undefined && gotTranscript) {
            socket.end();
            resolve(msg.text || '');
          }
        } catch {
          // partial JSON, wait for more
        }
      }
    });

    socket.on('end', () => {
      if (!gotTranscript) reject(new Error('No transcript received'));
    });

    socket.on('error', (err) => reject(err));

    setTimeout(() => {
      socket.destroy();
      reject(new Error('Wyoming transcription timed out'));
    }, 30000);
  });
}

router.get('/stt/status', requireAuth, (_req: Request, res: Response) => {
  res.json({ enabled: WHISPER_ENABLED });
});

router.post('/stt/transcribe', requireAuth, upload.single('audio'), async (req: Request, res: Response) => {
  if (!WHISPER_ENABLED) {
    res.status(503).json({ error: 'STT not configured — set WHISPER_HOST/WHISPER_PORT env vars' });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: 'No audio file provided' });
    return;
  }

  try {
    const pcmAudio = await convertToPCM(req.file.buffer);
    if (pcmAudio.length < 1600) {
      res.json({ text: '' });
      return;
    }

    const text = await wyomingTranscribe(pcmAudio, 'en');
    res.json({ text });
  } catch (err) {
    console.error('[stt] Wyoming error:', err instanceof Error ? err.message : err);
    res.status(502).json({ error: 'Whisper server unreachable' });
  }
});

export default router;
