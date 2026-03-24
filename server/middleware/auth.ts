import { Request, Response, NextFunction } from 'express';
import { getSession, getUserForSession, type Session } from '../services/sessions.js';
import type { CoderUser } from '../services/coder.js';

declare global {
  namespace Express {
    interface Request {
      session?: Session;
      user?: CoderUser;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
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

  // Re-use the user_id we already have from the session to avoid a second query
  const user = getUserForSession(session);
  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return;
  }

  req.session = session;
  req.user = user;
  next();
}
