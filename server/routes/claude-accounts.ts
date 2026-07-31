import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getAccountRateLimits, type RateLimitUsage } from '../services/claude.js';
import {
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
  resolveAccountToken,
  isPlausibleToken,
  verifyToken,
  isLabelTaken,
  countAccounts,
  MAX_ACCOUNTS_PER_USER,
} from '../services/claude-accounts.js';

/**
 * Claude subscription accounts. Every route is scoped to the calling user: a
 * stored token is a bearer credential for their paid subscription, so accounts
 * are never listed, used, or mutated across users. Unknown-or-not-yours returns
 * 404 (not 403) so ids aren't probeable, matching requireTaskAccess.
 */
const router = Router();

const MAX_LABEL_LENGTH = 60;
const TOKEN_HELP = 'Run `claude setup-token` and paste the sk-ant-oat… value it prints.';

function readLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  if (!label || label.length > MAX_LABEL_LENGTH) return null;
  return label;
}

/**
 * GET /api/claude-accounts — list the caller's accounts (tokens never leave the
 * server), plus each one's observed rate-limit usage so the panel can answer
 * "which subscription has headroom right now?".
 */
router.get('/claude-accounts', requireAuth, (req: Request, res: Response) => {
  const accounts = listAccounts(req.user!.id);
  const allUsage = getAccountRateLimits();
  const rateLimits: Record<string, Record<string, RateLimitUsage>> = {};
  for (const account of accounts) {
    const usage = allUsage[account.id];
    if (usage) rateLimits[account.id] = usage;
  }
  res.json({ accounts, rateLimits });
});

/** POST /api/claude-accounts — add a subscription token minted by `claude setup-token`. */
router.post('/claude-accounts', requireAuth, (req: Request, res: Response) => {
  const label = readLabel(req.body?.label);
  if (!label) {
    res.status(400).json({ error: `label is required (max ${MAX_LABEL_LENGTH} characters)` });
    return;
  }

  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!token) {
    res.status(400).json({ error: 'token is required' });
    return;
  }
  if (!isPlausibleToken(token)) {
    res.status(400).json({ error: `That does not look like a Claude Code subscription token. ${TOKEN_HELP}` });
    return;
  }
  if (countAccounts(req.user!.id) >= MAX_ACCOUNTS_PER_USER) {
    res.status(409).json({ error: `You already have ${MAX_ACCOUNTS_PER_USER} subscriptions saved. Remove one first.` });
    return;
  }
  // Labels are the only thing distinguishing subscriptions in the pickers.
  if (isLabelTaken(req.user!.id, label)) {
    res.status(409).json({ error: `You already have a subscription labelled "${label}". Pick a different label.` });
    return;
  }

  const account = createAccount({
    userId: req.user!.id,
    label,
    token,
    isDefault: req.body?.isDefault === true,
  });
  res.status(201).json({ account });
});

/** PATCH /api/claude-accounts/:id — rename, rotate the token, or set as default. */
router.patch('/claude-accounts/:id', requireAuth, (req: Request, res: Response) => {
  const patch: { label?: string; token?: string; isDefault?: boolean } = {};

  if (req.body?.label !== undefined) {
    const label = readLabel(req.body.label);
    if (!label) {
      res.status(400).json({ error: `label must be 1-${MAX_LABEL_LENGTH} characters` });
      return;
    }
    if (isLabelTaken(req.user!.id, label, req.params.id)) {
      res.status(409).json({ error: `You already have a subscription labelled "${label}". Pick a different label.` });
      return;
    }
    patch.label = label;
  }

  if (req.body?.token !== undefined) {
    const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
    if (!isPlausibleToken(token)) {
      res.status(400).json({ error: `Invalid token. ${TOKEN_HELP}` });
      return;
    }
    patch.token = token;
  }

  if (req.body?.isDefault !== undefined) {
    patch.isDefault = req.body.isDefault === true;
  }

  const account = updateAccount(req.params.id, req.user!.id, patch);
  if (!account) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }
  res.json({ account });
});

/** DELETE /api/claude-accounts/:id */
router.delete('/claude-accounts/:id', requireAuth, (req: Request, res: Response) => {
  if (!deleteAccount(req.params.id, req.user!.id)) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }
  res.json({ ok: true });
});

/** POST /api/claude-accounts/:id/verify — confirm a stored token still works. */
router.post('/claude-accounts/:id/verify', requireAuth, async (req: Request, res: Response) => {
  if (!getAccount(req.params.id, req.user!.id)) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }

  let resolved;
  try {
    resolved = resolveAccountToken(req.params.id, req.user!.id);
  } catch (err) {
    res.json({ ok: false, detail: (err as Error).message });
    return;
  }
  if (!resolved) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }

  res.json(await verifyToken(resolved.token));
});

export default router;
