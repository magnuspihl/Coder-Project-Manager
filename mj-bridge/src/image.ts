import sharp from 'sharp';
import { config } from './config.js';

export interface PreviewImage {
  base64: string;
  mimeType: string;
}

/**
 * Download the full-resolution image and produce a small JPEG preview for
 * inline MCP image content. Full grids/upscales from Midjourney can be
 * several MB — embedding that directly in every tool result would bloat the
 * agent's context (and the SSH/WebSocket stream it flows back through) for
 * no benefit, since judging composition/quality doesn't need full res.
 */
export async function fetchPreview(uri: string): Promise<PreviewImage> {
  const res = await fetch(uri, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Failed to fetch image (${res.status}): ${uri}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const jpeg = await sharp(buf)
    .resize({ width: config.previewMaxEdge, height: config.previewMaxEdge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: config.previewQuality })
    .toBuffer();
  return { base64: jpeg.toString('base64'), mimeType: 'image/jpeg' };
}
