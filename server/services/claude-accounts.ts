import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { encryptSecret, decryptSecret } from './secrets.js';

/**
 * Claude subscription accounts held by CPM.
 *
 * Normally the Claude subscription a task burns is owned by the target
 * workspace — whatever `claude login` was run inside it. An account here lets
 * CPM override that per task by exporting CLAUDE_CODE_OAUTH_TOKEN into the
 * remote shell, which the Claude Code CLI prefers over its on-disk login.
 *
 * Tokens are minted by the user running `claude setup-token` while logged into
 * the subscription they want, and pasted into CPM's settings panel.
 *
 * SECURITY: accounts are strictly per-user. A token is a bearer credential for a
 * paid subscription, and staging one into a workspace exposes it to anyone with a
 * shell there — so every read, write, and resolve is scoped by user_id. Without
 * that, any authenticated user could pin someone else's account to a task in a
 * workspace they control and read the token straight out of the environment.
 */

export interface ClaudeAccount {
  id: string;
  user_id: string;
  label: string;
  token_enc: string;
  token_hint: string;
  is_default: number;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

/** The shape sent to the client — never includes the token itself. */
export interface ClaudeAccountPublic {
  id: string;
  label: string;
  tokenHint: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

/**
 * Tokens from `claude setup-token` look like `sk-ant-oat01-…`. Deliberately does
 * not accept `sk-ant-api03-…` API keys: those authenticate a different way, so
 * exporting one as CLAUDE_CODE_OAUTH_TOKEN would fail confusingly at launch
 * rather than here at paste time.
 */
const TOKEN_PATTERN = /^sk-ant-oat\d{2}-[A-Za-z0-9._-]{20,}$/;

export function isPlausibleToken(token: string): boolean {
  return TOKEN_PATTERN.test(token.trim());
}

function toPublic(row: ClaudeAccount): ClaudeAccountPublic {
  return {
    id: row.id,
    label: row.label,
    tokenHint: row.token_hint,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

/** Last 4 characters, for "…aB3x" style display. */
function hintFor(token: string): string {
  return token.trim().slice(-4);
}

export function listAccounts(userId: string): ClaudeAccountPublic[] {
  const rows = getDb()
    .prepare('SELECT * FROM claude_accounts WHERE user_id = ? ORDER BY is_default DESC, label COLLATE NOCASE')
    .all(userId) as ClaudeAccount[];
  return rows.map(toPublic);
}

/** Returns null when the account doesn't exist OR belongs to someone else. */
export function getAccount(id: string, userId: string): ClaudeAccountPublic | null {
  const row = getDb()
    .prepare('SELECT * FROM claude_accounts WHERE id = ? AND user_id = ?')
    .get(id, userId) as ClaudeAccount | undefined;
  return row ? toPublic(row) : null;
}

/**
 * Cap per user. The label is the only thing distinguishing subscriptions in the
 * pickers, so an unbounded list is unusable long before it is a resource problem;
 * this is a sanity bound, not a licensing rule.
 */
export const MAX_ACCOUNTS_PER_USER = 20;

/**
 * Is this label already taken by another of the user's accounts?
 *
 * Labels must be distinguishable because they are the *only* identifier shown in
 * the new-task picker, the task-header picker, and the per-workspace rate-limit
 * attribution — two accounts both called "Max" would be impossible to tell apart
 * while silently billing different subscriptions. Compared case-insensitively for
 * the same reason ("Work" vs "work" is not a useful distinction).
 */
export function isLabelTaken(userId: string, label: string, exceptId?: string): boolean {
  const row = getDb().prepare(
    `SELECT id FROM claude_accounts
     WHERE user_id = ? AND label = ? COLLATE NOCASE AND id IS NOT ?`
  ).get(userId, label.trim(), exceptId ?? null) as { id: string } | undefined;
  return !!row;
}

export function countAccounts(userId: string): number {
  return (getDb()
    .prepare('SELECT COUNT(*) AS c FROM claude_accounts WHERE user_id = ?')
    .get(userId) as { c: number }).c;
}

export function createAccount(params: {
  userId: string;
  label: string;
  token: string;
  isDefault?: boolean;
}): ClaudeAccountPublic {
  const db = getDb();
  const id = randomUUID();
  const token = params.token.trim();

  db.transaction(() => {
    if (params.isDefault) {
      db.prepare('UPDATE claude_accounts SET is_default = 0 WHERE user_id = ?').run(params.userId);
    }
    db.prepare(
      `INSERT INTO claude_accounts (id, user_id, label, token_enc, token_hint, is_default)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, params.userId, params.label.trim(), encryptSecret(token), hintFor(token), params.isDefault ? 1 : 0);
  })();

  return getAccount(id, params.userId)!;
}

export function updateAccount(
  id: string,
  userId: string,
  params: { label?: string; token?: string; isDefault?: boolean },
): ClaudeAccountPublic | null {
  const db = getDb();
  if (!getAccount(id, userId)) return null;

  db.transaction(() => {
    if (params.label !== undefined) {
      db.prepare("UPDATE claude_accounts SET label = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
        .run(params.label.trim(), id, userId);
    }
    if (params.token) {
      const token = params.token.trim();
      db.prepare("UPDATE claude_accounts SET token_enc = ?, token_hint = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
        .run(encryptSecret(token), hintFor(token), id, userId);
    }
    if (params.isDefault !== undefined) {
      if (params.isDefault) {
        db.prepare('UPDATE claude_accounts SET is_default = 0 WHERE user_id = ?').run(userId);
      }
      db.prepare("UPDATE claude_accounts SET is_default = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
        .run(params.isDefault ? 1 : 0, id, userId);
    }
  })();

  return getAccount(id, userId);
}

/**
 * Delete an account. Tasks that referenced it keep the id so history still shows
 * what was intended, but their next turn can no longer resolve a token — which
 * fails the turn rather than silently running on a different subscription (see
 * resolveAccountToken's callers).
 */
export function deleteAccount(id: string, userId: string): boolean {
  const res = getDb().prepare('DELETE FROM claude_accounts WHERE id = ? AND user_id = ?').run(id, userId);
  return res.changes > 0;
}

export function getDefaultAccountId(userId: string): string | null {
  const row = getDb()
    .prepare('SELECT id FROM claude_accounts WHERE user_id = ? AND is_default = 1 LIMIT 1')
    .get(userId) as { id: string } | undefined;
  return row?.id ?? null;
}

export type ResolvedAccount = { id: string; label: string; token: string };

/**
 * Resolve an account id to its decrypted token for a given owner.
 *
 * Returns null when no account is pinned. THROWS when an account *is* pinned but
 * cannot be used — unknown id, wrong owner, or undecryptable ciphertext. The
 * distinction matters: pinning a subscription is a control, not a preference, so
 * callers must not quietly fall back to the workspace's own login (which could be
 * a different person's subscription) when the pinned one is unavailable.
 */
export function resolveAccountToken(
  accountId: string | null | undefined,
  userId: string,
): ResolvedAccount | null {
  if (!accountId) return null;

  const row = getDb()
    .prepare('SELECT * FROM claude_accounts WHERE id = ? AND user_id = ?')
    .get(accountId, userId) as ClaudeAccount | undefined;
  if (!row) {
    throw new Error(
      'The Claude subscription pinned to this task is no longer available (it was removed, or belongs to another user). ' +
      'Pick a subscription again in the task header, or switch it to the workspace login.',
    );
  }

  try {
    return { id: row.id, label: row.label, token: decryptSecret(row.token_enc) };
  } catch (err) {
    throw new Error(
      `The stored token for Claude subscription "${row.label}" could not be decrypted (${(err as Error).message}). ` +
      'Re-paste it in Settings → Claude subscriptions.',
    );
  }
}

export function markAccountUsed(id: string): void {
  try {
    getDb().prepare("UPDATE claude_accounts SET last_used_at = datetime('now') WHERE id = ?").run(id);
  } catch {
    // Non-fatal bookkeeping.
  }
}

/**
 * Best-effort lookup of who a token belongs to, used only to enrich the "valid"
 * message. Never decides validity: the endpoint is undocumented and its response
 * shape is unverified against a real token, so anything unexpected yields null and
 * the caller just omits the detail.
 */
async function describeTokenOwner(token: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null) as {
      account?: { email_address?: string };
      organization?: { name?: string };
    } | null;
    const parts = [body?.account?.email_address, body?.organization?.name].filter(Boolean);
    return parts.length ? parts.join(' / ') : null;
  } catch {
    return null;
  }
}

/**
 * Check whether a subscription token still works, so the settings panel can say so
 * instead of the user finding out when a task fails.
 *
 * Uses a minimal /v1/messages call: a documented endpoint, and the same operation a
 * task actually performs, so a pass means the token can serve model requests rather
 * than merely that some endpoint accepts it. `max_tokens: 1` keeps the cost
 * negligible. The Claude Code identity headers (`x-app: cli`, the OAuth beta, a
 * cli User-Agent) are sent because `sk-ant-oat…` tokens are scoped to Claude Code
 * requests — the values are taken from what the CLI itself sends.
 *
 * What is and isn't established empirically:
 * - VERIFIED: a bogus token here yields 401 "OAuth access token is invalid", so the
 *   request shape reaches OAuth authentication correctly (rather than, say, being
 *   rejected for a missing x-api-key).
 * - NOT VERIFIED: that a *valid* subscription token returns 2xx, because that needs
 *   a real `claude setup-token` credential to test with.
 *
 * Because of that gap, only a 401 is treated as "rejected". A 403 in particular is
 * what Anthropic returns for a valid credential used outside its authorized scope,
 * so calling it "revoked" would report every working subscription as broken —
 * strictly worse than saying nothing. Anything that isn't a clear pass or a clear
 * 401 is reported as inconclusive, carrying Anthropic's own message so the user can
 * see what actually happened.
 */
export interface TokenCheck {
  /** True when the token demonstrably works (including valid-but-throttled). */
  ok: boolean;
  detail: string;
  /** 'unknown' keeps an inconclusive result from being shown as a failure. */
  status: 'valid' | 'rejected' | 'unknown';
}

export async function verifyToken(token: string): Promise<TokenCheck> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        // Identity of the client these tokens are issued for; see above.
        'x-app': 'cli',
        'user-agent': 'claude-cli/2.1.178 (external, cli)',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) {
      const owner = await describeTokenOwner(token);
      return { ok: true, status: 'valid', detail: owner ? `Valid — ${owner}` : 'Valid.' };
    }

    // Valid credential, just no quota right now.
    if (res.status === 429) {
      return { ok: true, status: 'valid', detail: 'Valid, but currently rate-limited.' };
    }

    const message = await readApiErrorMessage(res);

    // The only status that unambiguously means the credential itself is bad.
    if (res.status === 401) {
      return { ok: false, status: 'rejected', detail: 'Token rejected — expired or revoked. Re-run `claude setup-token`.' };
    }

    return {
      ok: false,
      status: 'unknown',
      detail:
        `Could not confirm this token (HTTP ${res.status}${message ? `: ${message}` : ''}). ` +
        'This does not necessarily mean the subscription is broken — if tasks run fine, ignore it.',
    };
  } catch (err) {
    return { ok: false, status: 'unknown', detail: `Could not reach Anthropic to verify: ${(err as Error).message}` };
  }
}

/** Pull Anthropic's human-readable error message out of a failed response. */
async function readApiErrorMessage(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  try {
    return (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? '';
  } catch {
    return '';
  }
}
