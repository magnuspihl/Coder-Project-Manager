import { getDb } from '../db/index.js';
import { v4 as uuid } from 'uuid';
import { validateToken, type CoderUser } from './coder.js';

const CODER_URL = process.env.CODER_URL || '';
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || '';
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || '';

export interface Session {
  id: string;
  user_id: string;
  coder_access_token: string;
  coder_refresh_token: string | null;
  token_expires_at: string | null;
  created_at: string;
  expires_at: string;
}

export async function createSession(coderToken: string): Promise<{ session: Session; user: CoderUser }> {
  const user = await validateToken(coderToken);
  const db = getDb();

  upsertUser(db, user);

  // Update all existing sessions for this user with the fresh token
  db.prepare(
    `UPDATE sessions SET coder_access_token = ? WHERE user_id = ?`
  ).run(coderToken, user.id);

  // Create session (expires in 7 days)
  const sessionId = uuid();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    `INSERT INTO sessions (id, user_id, coder_access_token, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(sessionId, user.id, coderToken, expiresAt);

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Session;
  return { session, user };
}

export async function createSessionFromOAuth(
  accessToken: string,
  refreshToken: string | null,
  tokenExpiresAt: string | null,
): Promise<{ session: Session; user: CoderUser }> {
  const user = await validateToken(accessToken);
  const db = getDb();

  upsertUser(db, user);

  // Update all existing sessions for this user with the fresh tokens,
  // so other devices don't get stale tokens when Coder invalidates old ones
  db.prepare(
    `UPDATE sessions SET coder_access_token = ?, coder_refresh_token = ?, token_expires_at = ?
     WHERE user_id = ?`
  ).run(accessToken, refreshToken, tokenExpiresAt, user.id);

  const sessionId = uuid();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    `INSERT INTO sessions (id, user_id, coder_access_token, coder_refresh_token, token_expires_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sessionId, user.id, accessToken, refreshToken, tokenExpiresAt, expiresAt);

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Session;
  return { session, user };
}

function upsertUser(db: ReturnType<typeof getDb>, user: CoderUser): void {
  db.prepare(
    `INSERT INTO users (id, username, email, avatar_url)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET username = ?, email = ?, avatar_url = ?, updated_at = datetime('now')`
  ).run(user.id, user.username, user.email, user.avatar_url, user.username, user.email, user.avatar_url);
}

export function getSession(sessionId: string): Session | undefined {
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Session | undefined;
  if (session && new Date(session.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return undefined;
  }
  return session;
}

export function deleteSession(sessionId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function getUserForSession(session: Session): CoderUser | undefined {
  const db = getDb();
  const row = db.prepare(
    `SELECT id, username, email, avatar_url FROM users WHERE id = ?`
  ).get(session.user_id) as CoderUser | undefined;
  return row;
}

/**
 * Attempt to refresh the Coder OAuth access token using the stored refresh token.
 * Returns the new access token on success, or null if refresh is not possible/failed.
 */
export async function refreshAccessToken(session: Session): Promise<string | null> {
  if (!session.coder_refresh_token || !OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    return null;
  }

  try {
    const res = await fetch(`${CODER_URL}/oauth2/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: session.coder_refresh_token,
      }),
    });

    if (!res.ok) {
      console.error('[session] Token refresh failed:', res.status);
      return null;
    }

    const tokens = await res.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const tokenExpiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    // Update all sessions for this user with new tokens (keeps other devices in sync)
    const db = getDb();
    db.prepare(
      `UPDATE sessions SET coder_access_token = ?, coder_refresh_token = ?, token_expires_at = ?
       WHERE user_id = ?`
    ).run(
      tokens.access_token,
      tokens.refresh_token || session.coder_refresh_token,
      tokenExpiresAt,
      session.user_id,
    );

    return tokens.access_token;
  } catch (err) {
    console.error('[session] Token refresh error:', err);
    return null;
  }
}
