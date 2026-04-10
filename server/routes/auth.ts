import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { createSession, createSessionFromOAuth, deleteSession } from '../services/sessions.js';
import { requireAuth } from '../middleware/auth.js';

const CODER_URL = process.env.CODER_URL || '';
const APP_URL = process.env.APP_URL || '';
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || '';
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || '';

const router = Router();

// In-memory PKCE store (code_verifier keyed by state)
const pkceStore = new Map<string, { verifier: string; createdAt: number }>();

// Clean up old PKCE entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, val] of pkceStore) {
    if (val.createdAt < cutoff) pkceStore.delete(key);
  }
}, 5 * 60 * 1000);

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Initiate OAuth2 login — redirects to Coder's authorize endpoint
router.get('/login', (req: Request, res: Response) => {
  if (!OAUTH_CLIENT_ID) {
    res.status(500).json({ error: 'OAuth not configured — set OAUTH_CLIENT_ID' });
    return;
  }

  const state = base64url(crypto.randomBytes(32));
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());

  pkceStore.set(state, { verifier, createdAt: Date.now() });

  const callbackUrl = `${APP_URL}/auth/callback`;

  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    response_type: 'code',
    redirect_uri: callbackUrl,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  res.redirect(`${CODER_URL}/oauth2/authorize?${params}`);
});

// OAuth2 callback — exchange code for tokens
router.get('/callback', async (req: Request, res: Response) => {
  const { code, state } = req.query;

  if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
    res.status(400).send('Missing code or state parameter');
    return;
  }

  const pkce = pkceStore.get(state);
  if (!pkce) {
    res.status(400).send('Invalid or expired state parameter');
    return;
  }
  pkceStore.delete(state);

  const callbackUrl = `${APP_URL}/auth/callback`;

  try {
    // Exchange authorization code for tokens
    const tokenRes = await fetch(`${CODER_URL}/oauth2/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl,
        code_verifier: pkce.verifier,
      }),
    });

    if (!tokenRes.ok) {
      const errorBody = await tokenRes.text();
      console.error('[oauth] Token exchange failed:', tokenRes.status, errorBody);
      res.status(502).send('OAuth token exchange failed');
      return;
    }

    const tokens = await tokenRes.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    const { session } = await createSessionFromOAuth(
      tokens.access_token,
      tokens.refresh_token || null,
      expiresAt,
    );

    res.cookie('session_id', session.id, {
      httpOnly: true,
      secure: APP_URL.startsWith('https'),
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    // Redirect to the app
    res.redirect('/');
  } catch (err) {
    console.error('[oauth] Callback error:', err);
    res.status(500).send('OAuth login failed');
  }
});

// Return OAuth config so the client knows whether to show OAuth button
router.get('/config', (_req: Request, res: Response) => {
  res.json({
    oauth_enabled: !!OAUTH_CLIENT_ID,
    coder_url: CODER_URL,
    self_workspace_id: process.env.CODER_WORKSPACE_ID || null,
    self_workspace_name: process.env.CODER_WORKSPACE_NAME || null,
  });
});

// API token login (fallback)
router.post('/token-login', async (req: Request, res: Response) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'Token is required' });
    return;
  }

  try {
    const { session, user } = await createSession(token.trim());
    res.cookie('session_id', session.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json({ user });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token. Please check your Coder API token.' });
  }
});

router.post('/logout', requireAuth, (req: Request, res: Response) => {
  if (req.session) {
    deleteSession(req.session.id);
  }
  res.clearCookie('session_id');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req: Request, res: Response) => {
  res.json({ user: req.user });
});

export default router;
