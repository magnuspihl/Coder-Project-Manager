import { Router, Request, Response } from 'express';
import multer from 'multer';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync, createReadStream, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { v4 as uuid } from 'uuid';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { getTask } from '../services/tasks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = join(__dirname, '../../data/uploads');

if (!existsSync(UPLOAD_DIR)) {
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
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
      'INSERT INTO attachments (id, user_id, filename, original_name, mime_type, size, storage_path) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, req.user!.id, file.filename, file.originalname, file.mimetype, file.size, file.path);

    attachments.push({
      id,
      task_id: null,
      user_id: req.user!.id,
      message_id: null, // set once linkAttachmentsToTask ties it to the prompt/reply message
      filename: file.filename,
      original_name: file.originalname,
      mime_type: file.mimetype,
      size: file.size,
      storage_path: file.path,
      source: 'user',
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
  // Attachment data is CPM's to scope, not Coder's — a missing owner and one
  // owned by someone else both 404, so ownership can't be probed by guessing
  // attachment ids the way task ids already can't (see requireTaskAccess).
  // user_id is stamped at creation time (upload or [OUTPUT_FILE] capture), so
  // this covers the brief pre-link window too, not just linked attachments.
  // Pre-existing rows from before that column existed fall back to the
  // task_id check, same as before.
  if (attachment.user_id) {
    if (!req.user || attachment.user_id !== req.user.id) {
      res.status(404).json({ error: 'Attachment not found' });
      return;
    }
  } else if (attachment.task_id) {
    const task = getTask(attachment.task_id);
    if (!task || !req.user || task.user_id !== req.user.id) {
      res.status(404).json({ error: 'Attachment not found' });
      return;
    }
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
  user_id: string | null;
  message_id: string | null;
  filename: string;
  original_name: string;
  mime_type: string;
  size: number;
  storage_path: string;
  source: 'user' | 'agent';
  content_hash: string | null;
  created_at: string;
}

export function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Record a file an agent produced for the user to download (an [OUTPUT_FILE]
 * block — see claude.ts's parseOutputFilesForTask), already fetched from the
 * workspace into `content`. Stored the same way as a user upload — same
 * directory, same table, same /api/uploads/:id download route — just with
 * task_id set immediately instead of linked later, and source='agent' so the
 * UI can tell the two apart. `userId` is the task's owner, not the agent —
 * it's what lets the download route enforce ownership. `messageId` is the
 * assistant message whose [OUTPUT_FILE] block produced this file, so the UI
 * can render the download inline with that message instead of in a separate
 * task-wide list.
 */
export function createAgentOutputAttachment(
  taskId: string,
  userId: string,
  messageId: string | null,
  content: Buffer,
  originalName: string,
  mimeType: string,
): Attachment {
  const id = uuid();
  const ext = originalName.includes('.') ? '.' + originalName.split('.').pop() : '';
  const filename = uuid() + ext;
  const storagePath = join(UPLOAD_DIR, filename);
  writeFileSync(storagePath, content);
  const contentHash = sha256Hex(content);

  getDb().prepare(
    'INSERT INTO attachments (id, task_id, user_id, message_id, filename, original_name, mime_type, size, storage_path, source, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, taskId, userId, messageId, filename, originalName, mimeType, content.length, storagePath, 'agent', contentHash);

  return {
    id,
    task_id: taskId,
    user_id: userId,
    message_id: messageId,
    filename,
    original_name: originalName,
    mime_type: mimeType,
    size: content.length,
    storage_path: storagePath,
    source: 'agent',
    content_hash: contentHash,
    created_at: new Date().toISOString(),
  };
}

/**
 * Has this task already captured an [OUTPUT_FILE] with this exact name and
 * content? Used to skip re-transferring a file whose block gets re-parsed —
 * e.g. every reconnect-after-restart replay of a task's current-session
 * stream_log hits the same [OUTPUT_FILE] blocks again, and without this each
 * replay would re-run the SSH transfer and add another duplicate attachment
 * row + file on disk for something already captured.
 *
 * Keyed on a content hash rather than size: two different regenerations of
 * the same file could coincidentally land on the same byte count, and a
 * size-only match would then silently discard a real, different file the
 * agent just produced. A hash match means the bytes are actually identical,
 * so there is nothing new for the user to see and staying silent is correct;
 * anything else is a genuinely new attachment.
 *
 * A replay also deletes and recreates the message the block lived in (see
 * deleteCurrentSessionAssistantMessages), so a found duplicate is re-pointed
 * at the freshly-passed `messageId` — otherwise the attachment would keep
 * pointing at a message row that no longer exists and disappear from the UI
 * even though the file itself is still there.
 */
export function hasAgentOutputAttachment(taskId: string, originalName: string, contentHash: string, messageId: string | null): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT id FROM attachments WHERE task_id = ? AND source = 'agent' AND original_name = ? AND content_hash = ? LIMIT 1"
  ).get(taskId, originalName, contentHash) as { id: string } | undefined;
  if (!row) return false;
  if (messageId) {
    db.prepare('UPDATE attachments SET message_id = ? WHERE id = ?').run(messageId, row.id);
  }
  return true;
}

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

export function getAttachment(id: string): any {
  return getDb().prepare('SELECT * FROM attachments WHERE id = ?').get(id);
}

export default router;
