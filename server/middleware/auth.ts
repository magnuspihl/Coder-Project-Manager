import { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index.js';
import { getSession, getUserForSession, type Session } from '../services/sessions.js';
import { validateToken, type CoderUser } from '../services/coder.js';
import { getTask, type Task } from '../services/tasks.js';

declare global {
  namespace Express {
    interface Request {
      session?: Session;
      user?: CoderUser;
      authSource?: 'ui' | 'api';
      clientLabel?: string | null;
      task?: Task;
    }
  }
}

// Bearer token validation cache. Keeps revocation responsive (~60s) while
// avoiding a Coder round-trip on every API call.
interface CachedTokenValidation {
  user: CoderUser;
  validatedAt: number;
}
const TOKEN_CACHE_TTL_MS = 60_000;
const tokenCache = new Map<string, CachedTokenValidation>();

function upsertCoderUser(user: CoderUser): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO users (id, username, email, avatar_url)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET username = ?, email = ?, avatar_url = ?, updated_at = datetime('now')`,
  ).run(user.id, user.username, user.email, user.avatar_url, user.username, user.email, user.avatar_url);
}

async function validateBearerToken(token: string): Promise<CoderUser | null> {
  const cached = tokenCache.get(token);
  if (cached && Date.now() - cached.validatedAt < TOKEN_CACHE_TTL_MS) {
    return cached.user;
  }
  try {
    const user = await validateToken(token);
    tokenCache.set(token, { user, validatedAt: Date.now() });
    upsertCoderUser(user);
    return user;
  } catch {
    tokenCache.delete(token);
    return null;
  }
}

function extractClientLabel(req: Request): string | null {
  const raw = req.headers['x-client-name'];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, 64);
  return trimmed || null;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Bearer token path — used by API clients like OpenClaw. The token is a
  // Coder API token; we validate it against Coder and synthesise a Session
  // so downstream handlers can reuse `req.session!.coder_access_token`.
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      res.status(401).json({ error: 'Invalid bearer token' });
      return;
    }
    const user = await validateBearerToken(token);
    if (!user) {
      res.status(401).json({ error: 'Invalid bearer token' });
      return;
    }
    // `id` is prefixed with "api:" so deleteSession() is a harmless no-op
    // against the real `sessions` table if a downstream handler invokes it.
    req.session = {
      id: `api:${user.id}`,
      user_id: user.id,
      coder_access_token: token,
      coder_refresh_token: null,
      token_expires_at: null,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
    req.user = user;
    req.authSource = 'api';
    req.clientLabel = extractClientLabel(req);
    next();
    return;
  }

  // Cookie session path — used by the web UI.
  const sessionId = req.cookies?.session_id;
  if (!sessionId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const session = getSession(sessionId);
  if (!session) {
    res.status(401).json({ error: 'Session expired' });
    return;
  }

  const user = getUserForSession(session);
  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return;
  }

  req.session = session;
  req.user = user;
  req.authSource = 'ui';
  req.clientLabel = null;
  next();
}

/**
 * Per-resource authorization for task-scoped routes. Loads the task named by
 * `:taskId`, and denies access unless it belongs to the authenticated user.
 *
 * CPM is multi-user and task IDs are handed out in workspace listings, stream
 * logs, and port records — without this gate any authenticated user could
 * read/reply/complete/delete another user's task by ID. A missing task and a
 * task owned by someone else both return an identical 404 so ownership can't be
 * probed by enumeration. Must run after `requireAuth` (needs `req.user`).
 */
export function requireTaskAccess(req: Request, res: Response, next: NextFunction): void {
  const task = getTask(req.params.taskId);
  if (!task || !req.user || task.user_id !== req.user.id) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  req.task = task;
  next();
}
