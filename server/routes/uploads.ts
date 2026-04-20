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
  res.setHeader('Content-Type', attachment.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${attachment.original_name}"`);
  createReadStream(attachment.storage_path).pipe(res);
});

export interface Attachment {
  id: string;
  task_id: string | null;
  filename: string;
  original_name: string;
  mime_type: string;
  size: number;
  storage_path: string;
  created_at: string;
}

export function linkAttachmentsToTask(attachmentIds: string[], taskId: string) {
  const db = getDb();
  const stmt = db.prepare('UPDATE attachments SET task_id = ? WHERE id = ? AND task_id IS NULL');
  for (const id of attachmentIds) {
    stmt.run(taskId, id);
  }
  return db.prepare('SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at ASC').all(taskId);
}

export function getAttachmentsByTask(taskId: string): any[] {
  return getDb().prepare('SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at ASC').all(taskId);
}

export function getAttachment(id: string): any {
  return getDb().prepare('SELECT * FROM attachments WHERE id = ?').get(id);
}

export default router;
