import express, { Request, Response, NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { config } from './config.js';
import { imagine, upscale, variation, reroll, type MjResult } from './mjClient.js';
import { fetchPreview } from './image.js';
import { saveReferenceImage, referenceFilePath, ReferenceStoreConfigError } from './referenceStore.js';

const IndexSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

function jobMeta(r: MjResult, note: string) {
  return {
    id: r.id,
    hash: r.hash,
    flags: r.flags,
    prompt: r.prompt,
    full_resolution_url: r.uri,
    note,
  };
}

async function toolResult(r: MjResult, note: string) {
  const preview = await fetchPreview(r.uri);
  return {
    content: [
      { type: 'image' as const, data: preview.base64, mimeType: preview.mimeType },
      { type: 'text' as const, text: JSON.stringify(jobMeta(r, note), null, 2) },
    ],
  };
}

function errorResult(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: 'midjourney', version: '0.1.0' }, { capabilities: {} });

  server.registerTool(
    'mj_imagine',
    {
      description:
        'Generate a new Midjourney image from a text prompt. Returns a 2x2 grid as an inline preview image, ' +
        'plus job metadata (id/hash/flags) needed for mj_upscale, mj_variation, or mj_reroll on this job. ' +
        'Judge the grid yourself using the preview image before deciding whether to upscale a quadrant, ' +
        'request a variation, reroll, or refine the prompt and try again. ' +
        'To use an image as a reference (style, composition, character, etc.), pass its URL(s) via ' +
        'reference_image_urls — Midjourney only accepts image input as a URL prepended to the prompt, not a file. ' +
        'For a local file (no public URL yet), first POST its raw bytes to this bridge\'s /upload-reference ' +
        'endpoint to mint a URL, then pass that URL here.',
      inputSchema: {
        prompt: z.string().min(1).describe('The Midjourney prompt, including any parameters like --ar or --v'),
        reference_image_urls: z.array(z.string().url()).max(5).optional().describe('Public image URLs to use as image references, prepended to the prompt exactly as Midjourney expects.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ prompt, reference_image_urls }) => {
      try {
        const fullPrompt = reference_image_urls?.length ? `${reference_image_urls.join(' ')} ${prompt}` : prompt;
        const r = await imagine(fullPrompt);
        return await toolResult(r, 'This is a 2x2 grid. Use mj_upscale(index 1-4) for a single full-size image, mj_variation(index 1-4) for variants of one quadrant, or mj_reroll for a fresh grid with the same prompt.');
      } catch (err) {
        return errorResult(`mj_imagine failed: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'mj_upscale',
    {
      description: 'Upscale one quadrant (1-4) of a previous mj_imagine/mj_variation/mj_reroll grid to a single full-resolution image.',
      inputSchema: {
        prompt: z.string().min(1).describe('The same prompt text used to create the job being upscaled'),
        id: z.string().describe('job id from the prior result'),
        hash: z.string().describe('job hash from the prior result'),
        flags: z.number().describe('job flags from the prior result'),
        index: IndexSchema.describe('which quadrant to upscale (1-4)'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ prompt, id, hash, flags, index }) => {
      try {
        const r = await upscale(prompt, id, hash, flags, index);
        return await toolResult(r, 'Full-resolution single image. Download it (curl the full_resolution_url) if you want to keep or deliver it.');
      } catch (err) {
        return errorResult(`mj_upscale failed: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'mj_variation',
    {
      description: 'Generate a new 2x2 grid of variations based on one quadrant (1-4) of a previous grid.',
      inputSchema: {
        prompt: z.string().min(1).describe('The same prompt text used to create the job being varied'),
        id: z.string().describe('job id from the prior result'),
        hash: z.string().describe('job hash from the prior result'),
        flags: z.number().describe('job flags from the prior result'),
        index: IndexSchema.describe('which quadrant to base variations on (1-4)'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ prompt, id, hash, flags, index }) => {
      try {
        const r = await variation(prompt, id, hash, flags, index);
        return await toolResult(r, 'This is a new 2x2 grid. Use mj_upscale(index 1-4) on it once you find a quadrant worth keeping.');
      } catch (err) {
        return errorResult(`mj_variation failed: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'mj_reroll',
    {
      description: 'Regenerate a fresh 2x2 grid using the same prompt as a previous job (a "redo" with new randomness).',
      inputSchema: {
        prompt: z.string().min(1).describe('The same prompt text used to create the job being rerolled'),
        id: z.string().describe('job id from the prior result'),
        hash: z.string().describe('job hash from the prior result'),
        flags: z.number().describe('job flags from the prior result'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ prompt, id, hash, flags }) => {
      try {
        const r = await reroll(prompt, id, hash, flags);
        return await toolResult(r, 'This is a new 2x2 grid from the same prompt.');
      } catch (err) {
        return errorResult(`mj_reroll failed: ${(err as Error).message}`);
      }
    },
  );

  return server;
}

function requireToken(req: Request, res: Response, next: NextFunction): void {
  if (!config.bridgeToken) return next();
  const header = req.header('authorization');
  if (header === `Bearer ${config.bridgeToken}`) return next();
  res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Plain HTTP upload — deliberately NOT an MCP tool. A base64 image passed
  // as an MCP tool argument would flow through the calling agent's context
  // (a few-MB photo becomes hundreds of thousands of tokens as base64); this
  // lets an agent `curl --data-binary` the raw bytes straight to the bridge
  // and get back only a small URL string to use in mj_imagine.
  //
  // Saved to local disk and served back via /references/* below, rather than
  // uploaded to Discord — the Discord attachment-upload flow under a
  // personal user token is a self-bot detection trigger and got this
  // bridge's account banned after three uploads.
  app.post('/upload-reference', requireToken, express.raw({ type: '*/*', limit: '15mb' }), async (req, res) => {
    try {
      const buf = req.body as Buffer;
      if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
        res.status(400).json({ error: 'Empty body — send the raw image bytes with an image Content-Type.' });
        return;
      }
      const mimeType = req.header('content-type') || 'image/png';
      const url = await saveReferenceImage(buf, mimeType);
      res.json({ url });
    } catch (err) {
      const status = err instanceof ReferenceStoreConfigError ? 500 : 400;
      res.status(status).json({ error: `upload-reference failed: ${(err as Error).message}` });
    }
  });

  // Deliberately unauthenticated, unlike every other route here — Midjourney's
  // bot fetches this as a plain GET and has no way to send a bearer token. The
  // filename is the only gate: it must be an exact, unguessable UUID minted by
  // /upload-reference, so this is no more exposed than a Discord CDN link was.
  app.get('/references/:filename', (req, res) => {
    const filePath = referenceFilePath(req.params.filename);
    if (!filePath) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Not found' });
    });
  });

  app.post('/mcp', requireToken, async (req, res) => {
    const server = buildServer();
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mj-bridge] request error:', (err as Error).message);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  app.all('/mcp', requireToken, (_req, res) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  });

  return app;
}
