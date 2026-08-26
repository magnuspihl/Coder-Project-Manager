import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const STORAGE_DIR = path.join(process.cwd(), 'data', 'references');

export const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

export class ReferenceStoreConfigError extends Error {}

// UUID + one of the extensions above, nothing else — this is also the
// path-traversal guard for the public GET route below: no user-controlled
// string ever reaches the filesystem unless it matches this exactly.
const REFERENCE_FILENAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|webp|gif)$/;

/**
 * Save uploaded reference bytes to local disk and return a public URL for
 * them, instead of minting a Discord CDN URL. Discord's attachment-upload
 * REST flow (reserve a slot, PUT the bytes, post a message) is a well-known
 * self-bot detection trigger under a personal user token — it got this
 * bridge's Discord account banned after three uploads. Serving files
 * ourselves removes Discord from the reference path entirely; the tradeoff
 * is this bridge must itself be reachable at a public URL (MJ_PUBLIC_BASE_URL)
 * so Midjourney's bot can fetch what we hand back.
 */
export async function saveReferenceImage(buf: Buffer, mimeType: string): Promise<string> {
  const ext = EXT_BY_MIME[mimeType];
  if (!ext) {
    throw new Error(`Unsupported content type "${mimeType}" — expected one of ${Object.keys(EXT_BY_MIME).join(', ')}`);
  }
  if (!config.publicBaseUrl) {
    throw new ReferenceStoreConfigError('MJ_PUBLIC_BASE_URL is not configured — set it to the public URL this bridge is reachable at so Midjourney can fetch uploaded references.');
  }
  await mkdir(STORAGE_DIR, { recursive: true });
  const filename = `${randomUUID()}${ext}`;
  await writeFile(path.join(STORAGE_DIR, filename), buf);
  return `${config.publicBaseUrl.replace(/\/+$/, '')}/references/${filename}`;
}

// Returns the absolute file path for a filename straight off the URL path,
// or null if it doesn't match the exact shape saveReferenceImage produces.
export function referenceFilePath(filename: string): string | null {
  if (!REFERENCE_FILENAME_RE.test(filename)) return null;
  return path.join(STORAGE_DIR, filename);
}
