import { Request, Response, NextFunction } from 'express';

const APP_URL = process.env.APP_URL || '';

/** True when this deployment is served over TLS. Derived from APP_URL rather
 * than `req.secure`/NODE_ENV: APP_URL is the one value that is always set
 * correctly (OAuth callbacks break otherwise), while `req.secure` depends on
 * the proxy-hop count being right and NODE_ENV is routinely unset in
 * production here. Used for the `secure` flag on every cookie we set, so all
 * of them agree. */
export const SERVED_OVER_HTTPS = APP_URL.startsWith('https');

/**
 * Cookie attributes shared by every cookie CPM sets.
 *
 * Previously `/auth/callback` used `APP_URL.startsWith('https')` while
 * `/auth/token-login` used `NODE_ENV === 'production'` — and NODE_ENV is not
 * set in this deployment, so the token-login cookie was sent without `Secure`
 * over an HTTPS origin. One helper keeps them from drifting again.
 */
export function cookieSecurity() {
  return {
    httpOnly: true as const,
    secure: SERVED_OVER_HTTPS,
    sameSite: 'lax' as const,
  };
}

/**
 * Baseline security response headers.
 *
 * Deliberately limited to headers that cannot break the app. Notably absent is
 * a Content-Security-Policy: the client pulls ONNX/WASM runtimes into blob:
 * workers for Kokoro TTS and Whisper STT, renders user Markdown, and iframes
 * arbitrary workspace-preview origins. A policy tight enough to be worth
 * having needs each of those allowed explicitly, and getting it wrong fails
 * silently in the browser rather than loudly on the server. Set CPM_CSP to opt
 * a deployment in once its policy has actually been tested in a browser.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  // Stop browsers from MIME-sniffing a response into something executable.
  // uploads.ts relies on this alongside its own Content-Disposition handling.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // SAMEORIGIN, not DENY: CPM frames workspace previews, and a future embedded
  // view of CPM itself under its own origin should keep working.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

  if (SERVED_OVER_HTTPS) {
    // No includeSubDomains/preload: CPM shares a wildcard domain with every
    // other Coder workspace app, and it has no business forcing HSTS on them.
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }

  const csp = process.env.CPM_CSP;
  if (csp) res.setHeader('Content-Security-Policy', csp);

  next();
}

/**
 * Origins allowed to make credentialed cross-origin calls.
 *
 * The browser app is same-origin (the client fetches relative URLs and Vite
 * proxies /api and /auth to the backend), so this allowlist is normally
 * unused — which is exactly why `origin: true` was unsafe: it reflected any
 * requesting origin back with credentials, letting any site the user visited
 * drive their tasks, and a task is arbitrary code execution inside their
 * workspaces. Add extra origins with CPM_ALLOWED_ORIGINS (comma-separated).
 */
export function allowedOrigins(): Set<string> {
  const extra = (process.env.CPM_ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return new Set([APP_URL.replace(/\/$/, ''), ...extra].filter(Boolean));
}

export function corsOriginCheck(allowed: Set<string>) {
  return (origin: string | undefined, cb: (err: Error | null, ok?: boolean) => void): void => {
    // No Origin header means a non-browser client (curl, the MCP transport,
    // server-to-server). CORS is a browser mechanism; nothing to assert here.
    if (!origin) return cb(null, true);
    // Returning false — rather than an error — omits the CORS headers and lets
    // the browser block the read, instead of turning it into a 500.
    cb(null, allowed.has(origin.replace(/\/$/, '')));
  };
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Minimal fixed-window rate limiter, keyed by client IP.
 *
 * Hand-rolled rather than pulling in express-rate-limit: two endpoints need it
 * and the whole mechanism is a Map plus a sweep. Buckets are swept on write so
 * the Map cannot grow without bound from unique IPs.
 *
 * Accuracy depends on Express's `trust proxy` setting resolving the real client
 * IP (see server/index.ts). If it is wrong, every request collapses onto the
 * proxy's IP and the limit becomes global — degraded, but still a brake.
 */
export function rateLimit(opts: { windowMs: number; max: number; message: string }) {
  const buckets = new Map<string, Bucket>();
  let lastSweep = Date.now();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();

    if (now - lastSweep > opts.windowMs) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
      lastSweep = now;
    }

    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > opts.max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: opts.message, retry_after_seconds: retryAfter });
      return;
    }

    next();
  };
}
