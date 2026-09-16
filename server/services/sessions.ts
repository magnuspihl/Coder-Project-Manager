import { getDb } from '../db/index.js';
import { v4 as uuid } from 'uuid';
import { validateToken, type CoderUser } from './coder.js';
import { encryptSecret, decryptSecret } from './secrets.js';

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

/** Row shape as stored in the DB — tokens are ciphertext (or, for rows written
 * before encryption was added, legacy plaintext). Never expose this outside
 * this module; always hydrate into a `Session` first. */
type SessionRow = Session;

function isEncryptedToken(value: string): boolean {
  const parts = value.split(':');
  return parts.length === 4 && parts[0] === 'v1';
}

/** Decrypt a stored token, transparently passing through legacy plaintext
 * rows written before this column was encrypted. */
function decryptToken(stored: string): string {
  return isEncryptedToken(stored) ? decryptSecret(stored) : stored;
}

function decryptTokenNullable(stored: string | null): string | null {
  return stored == null ? null : decryptToken(stored);
}

/**
 * Convert a raw DB row into a Session with plaintext tokens, so the rest of
 * the app can keep treating `Session.coder_access_token` as a usable token.
 * Throws if the ciphertext can't be decrypted (e.g. the encryption key
 * changed) — callers should treat that as an invalid session.
 */
function hydrateSession(row: SessionRow): Session {
  return {
    ...row,
    coder_access_token: decryptToken(row.coder_access_token),
    coder_refresh_token: decryptTokenNullable(row.coder_refresh_token),
  };
}

/** Decrypt a row, deleting it and returning undefined if the ciphertext is
 * unreadable rather than throwing — used on read paths where an unreadable
 * token should just force re-authentication instead of crashing. */
function hydrateSessionOrInvalidate(db: ReturnType<typeof getDb>, row: SessionRow): Session | undefined {
  try {
    return hydrateSession(row);
  } catch (err) {
    console.error('[session] Failed to decrypt stored token, invalidating session:', err);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    return undefined;
  }
}

export async function createSession(coderToken: string): Promise<{ session: Session; user: CoderUser }> {
  const user = await validateToken(coderToken);
  const db = getDb();

  upsertUser(db, user);

  const encToken = encryptSecret(coderToken);

  // Update all existing sessions for this user with the fresh token
  db.prepare(
    `UPDATE sessions SET coder_access_token = ? WHERE user_id = ?`
  ).run(encToken, user.id);

  // Create session (expires in 7 days)
  const sessionId = uuid();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    `INSERT INTO sessions (id, user_id, coder_access_token, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(sessionId, user.id, encToken, expiresAt);

  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow;
  return { session: hydrateSession(row), user };
}

export async function createSessionFromOAuth(
  accessToken: string,
  refreshToken: string | null,
  tokenExpiresAt: string | null,
): Promise<{ session: Session; user: CoderUser }> {
  const user = await validateToken(accessToken);
  const db = getDb();

  upsertUser(db, user);

  const encAccessToken = encryptSecret(accessToken);
  const encRefreshToken = refreshToken == null ? null : encryptSecret(refreshToken);

  // Update all existing sessions for this user with the fresh tokens,
  // so other devices don't get stale tokens when Coder invalidates old ones
  db.prepare(
    `UPDATE sessions SET coder_access_token = ?, coder_refresh_token = ?, token_expires_at = ?
     WHERE user_id = ?`
  ).run(encAccessToken, encRefreshToken, tokenExpiresAt, user.id);

  const sessionId = uuid();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    `INSERT INTO sessions (id, user_id, coder_access_token, coder_refresh_token, token_expires_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sessionId, user.id, encAccessToken, encRefreshToken, tokenExpiresAt, expiresAt);

  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow;
  return { session: hydrateSession(row), user };
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
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
  if (!row) return undefined;
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return undefined;
  }
  return hydrateSessionOrInvalidate(db, row);
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

    const newRefreshToken = tokens.refresh_token || session.coder_refresh_token;

    // Update all sessions for this user with new tokens (keeps other devices in sync)
    const db = getDb();
    db.prepare(
      `UPDATE sessions SET coder_access_token = ?, coder_refresh_token = ?, token_expires_at = ?
       WHERE user_id = ?`
    ).run(
      encryptSecret(tokens.access_token),
      newRefreshToken == null ? null : encryptSecret(newRefreshToken),
      tokenExpiresAt,
      session.user_id,
    );

    return tokens.access_token;
  } catch (err) {
    console.error('[session] Token refresh error:', err);
    return null;
  }
}

// How long before expiry we proactively refresh. The OAuth access token is
// short-lived; refreshing a couple of minutes early means long-running
// background work (SSH pollers) never hands a token to `coder` that lapses
// mid-call.
const TOKEN_REFRESH_BUFFER_MS = 2 * 60 * 1000;

// Collapse concurrent refreshes for the same user into one in-flight request.
// Background pollers fire every few seconds across many tasks owned by the same
// user; without this they would stampede Coder's token endpoint the moment a
// token crosses the refresh threshold.
const refreshInFlight = new Map<string, Promise<string | null>>();

function latestSessionForUser(userId: string): Session | undefined {
  const db = getDb();
  const row = db.prepare(
    `SELECT * FROM sessions WHERE user_id = ? AND coder_access_token IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
  ).get(userId) as SessionRow | undefined;
  if (!row) return undefined;
  return hydrateSessionOrInvalidate(db, row);
}

function dedupedRefresh(userId: string, session: Session): Promise<string | null> {
  let inflight = refreshInFlight.get(userId);
  if (!inflight) {
    inflight = refreshAccessToken(session).finally(() => refreshInFlight.delete(userId));
    refreshInFlight.set(userId, inflight);
  }
  return inflight;
}

/**
 * Resolve a usable Coder access token for a user from their stored OAuth
 * session, refreshing proactively when it is at/near expiry. Returns null when
 * the user has no stored session (e.g. API-token clients) so callers can fall
 * back to the ambient workspace token.
 *
 * This is the credential source for background `coder ssh` work, which has no
 * HTTP request context and therefore can't use the request-path token-refresh
 * helpers. It's what keeps a long-lived deployment from depending on the
 * frozen, build-time CODER_SESSION_TOKEN that lapses with the OIDC session.
 */
export async function getValidCoderTokenForUser(userId: string): Promise<string | null> {
  const session = latestSessionForUser(userId);
  if (!session) return null;

  const nearExpiry = !!session.token_expires_at &&
    new Date(session.token_expires_at).getTime() - Date.now() < TOKEN_REFRESH_BUFFER_MS;

  if (nearExpiry && session.coder_refresh_token) {
    const refreshed = await dedupedRefresh(userId, session);
    // On refresh failure keep returning the existing token — it may still have
    // a few seconds of life, and the caller's own retry path can react to a
    // hard auth rejection.
    return refreshed || session.coder_access_token || null;
  }

  return session.coder_access_token || null;
}

/**
 * Force a token refresh regardless of expiry, for the reactive path when a
 * `coder` call has already been rejected for auth. Returns the new token or
 * null when refresh isn't possible (no refresh token, or the refresh token
 * itself has expired — at which point the user must re-authenticate).
 */
export async function forceRefreshCoderTokenForUser(userId: string): Promise<string | null> {
  const session = latestSessionForUser(userId);
  if (!session || !session.coder_refresh_token) return null;
  return (await dedupedRefresh(userId, session)) || null;
}
