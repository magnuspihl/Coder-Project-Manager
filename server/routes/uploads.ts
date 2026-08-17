import { Router, Request, Response } from 'express';
import multer from 'multer';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync, createReadStream } from 'fs';
import { v4 as uuid } from 'uuid';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../db/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = join(__dirname, '../../data/uploads');

if (!existsSync(UPLOAD_DIR)) {
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_FILES = 10;

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = file.originalname.includes('.') ? '.' + file.originalname.split('.').pop() : '';
    cb(null, uuid() + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
});

const router = Router();

router.post('/uploads', requireAuth, upload.array('files', MAX_FILES), (req: Request, res: Response) => {
  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) {
    res.status(400).json({ error: 'No files uploaded' });
    return;
  }

  const db = getDb();
  const attachments: any[] = [];

  for (const file of files) {
    const id = uuid();
    db.prepare(
      'INSERT INTO attachments (id, filename, original_name, mime_type, size, storage_path) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, file.filename, file.originalname, file.mimetype, file.size, file.path);

    attachments.push({
      id,
      task_id: null,
      message_id: null,
      filename: file.filename,
      original_name: file.originalname,
      mime_type: file.mimetype,
      size: file.size,
      storage_path: file.path,
      created_at: new Date().toISOString(),
    });
  }

  res.status(201).json({ attachments });
});

router.get('/uploads/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const attachment = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id) as any;
  if (!attachment) {
    res.status(404).json({ error: 'Attachment not found' });
    return;
  }
  if (!existsSync(attachment.storage_path)) {
    res.status(404).json({ error: 'File not found on disk' });
    return;
  }
  // Serve untrusted uploads defensively. The stored mime_type and original_name
  // are attacker-controlled, so:
  //  - Only render inline for a strict image allow-list; everything else is
  //    forced to download (attachment) as octet-stream, so an uploaded .html /
  //    .svg can't execute JS on this origin (stored XSS).
  //  - X-Content-Type-Options: nosniff stops the browser from MIME-sniffing a
  //    "download" back into HTML.
  //  - The filename is percent-encoded via filename* so quotes/CRLF/control
  //    chars in original_name can't break out of the header.
  const INLINE_IMAGE_TYPES = new Set([
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon',
  ]);
  const declaredType = typeof attachment.mime_type === 'string' ? attachment.mime_type.split(';')[0].trim().toLowerCase() : '';
  const inlineOk = INLINE_IMAGE_TYPES.has(declaredType);
  const disposition = inlineOk ? 'inline' : 'attachment';
  const encodedName = encodeURIComponent(attachment.original_name || 'file').replace(/['()*]/g, escape);
  res.setHeader('Content-Type', inlineOk ? declaredType : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodedName}`);
  const stream = createReadStream(attachment.storage_path);
  stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
  stream.pipe(res);
});

export interface Attachment {
  id: string;
  task_id: string | null;
  message_id: string | null;
  filename: string;
  original_name: string;
  mime_type: string;
  size: number;
  storage_path: string;
  created_at: string;
}

/**
 * Link freshly uploaded attachments to the task AND the specific message that
 * sent them, so a later turn can tell "sent just now" apart from "sent in an
 * earlier turn" instead of treating every attachment the task ever received
 * as part of the current prompt.
 */
export function linkAttachmentsToTask(attachmentIds: string[], taskId: string, messageId?: string | null) {
  const db = getDb();
  const stmt = db.prepare('UPDATE attachments SET task_id = ?, message_id = ? WHERE id = ? AND task_id IS NULL');
  for (const id of attachmentIds) {
    stmt.run(taskId, messageId ?? null, id);
  }
  return db.prepare('SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at ASC').all(taskId);
}

export function getAttachmentsByTask(taskId: string): any[] {
  return getDb().prepare('SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at ASC').all(taskId);
}

export function getAttachmentsByMessage(messageId: string): any[] {
  return getDb().prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at ASC').all(messageId);
}

export function getAttachment(id: string): any {
  return getDb().prepare('SELECT * FROM attachments WHERE id = ?').get(id);
}

export default router;
