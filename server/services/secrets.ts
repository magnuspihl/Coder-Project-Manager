import crypto from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { DB_PATH } from '../db/index.js';

/**
 * Symmetric encryption for secrets that must live in the database.
 *
 * Both Coder OAuth tokens (`sessions.coder_access_token`/`coder_refresh_token`)
 * and Claude subscription tokens (`claude_accounts.token_enc`) are long-lived
 * bearer credentials, so both are encrypted at rest with AES-256-GCM. Rows
 * written before encryption was added are read transparently as legacy
 * plaintext (see `sessions.ts`'s `decryptToken`) and re-encrypted on their
 * next write.
 *
 * The key comes from CPM_SECRET_KEY (64 hex chars) when set; otherwise a random
 * key is generated once and persisted as `secret.key` in the same directory as the
 * database, with 0600 permissions. Losing the key only invalidates stored tokens —
 * they can be re-pasted from `claude setup-token`.
 *
 * The location is DERIVED from DB_PATH rather than computed from __dirname. A
 * separate __dirname-based default would resolve to dist/data/ in a compiled run
 * (start-stable.sh runs `node dist/server/index.js` while pinning DATABASE_PATH to
 * the repo's data/), so dev and prod would use different keys and wiping the
 * gitignored dist/ would silently destroy every stored token.
 *
 * Scope of protection: the generated-key path keeps tokens out of casual database
 * dumps, backups, and `.db` file copies. It does NOT protect against an attacker
 * who can read the whole data directory, since key and ciphertext live side by
 * side there. For that, set CPM_SECRET_KEY from the deployment's own secret store
 * so the key never touches disk next to the database.
 */

const KEY_PATH = process.env.CPM_SECRET_KEY_PATH || join(dirname(DB_PATH), 'secret.key');

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.CPM_SECRET_KEY;
  if (fromEnv) {
    const buf = Buffer.from(fromEnv.trim(), 'hex');
    if (buf.length !== 32) {
      throw new Error('CPM_SECRET_KEY must be 64 hex characters (32 bytes)');
    }
    cachedKey = buf;
    return cachedKey;
  }

  if (existsSync(KEY_PATH)) {
    const buf = Buffer.from(readFileSync(KEY_PATH, 'utf8').trim(), 'hex');
    if (buf.length === 32) {
      cachedKey = buf;
      return cachedKey;
    }
    // Refuse rather than regenerate. A malformed key usually means a truncated
    // write or a half-restored backup; overwriting it would permanently destroy
    // every stored token, so let an operator decide whether to restore or delete.
    throw new Error(
      `${KEY_PATH} exists but is not a 32-byte hex key. Restore the original file, ` +
      'or delete it to start over (all stored Claude tokens will need re-pasting).',
    );
  }

  const generated = crypto.randomBytes(32);
  mkdirSync(dirname(KEY_PATH), { recursive: true });
  writeFileSync(KEY_PATH, generated.toString('hex'), { mode: 0o600 });
  console.log(`[secrets] Generated encryption key at ${KEY_PATH}`);
  cachedKey = generated;
  return cachedKey;
}

/** Encrypt a UTF-8 string. Returns `v1:<iv>:<tag>:<ciphertext>` in base64url parts. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':');
}

/** Decrypt a value produced by encryptSecret. Throws if the key changed or the value is corrupt. */
export function decryptSecret(stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Unrecognized encrypted value format');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
}
