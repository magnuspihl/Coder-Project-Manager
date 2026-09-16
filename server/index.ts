import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import compression from 'compression';

import authRoutes from './routes/auth.js';
import workspaceRoutes from './routes/workspaces.js';
import taskRoutes from './routes/tasks.js';
import uploadRoutes from './routes/uploads.js';
import ttsRoutes from './routes/tts.js';
import sttRoutes from './routes/stt.js';
import claudeAccountRoutes from './routes/claude-accounts.js';
import { requireAuth } from './middleware/auth.js';
import { securityHeaders, allowedOrigins, corsOriginCheck } from './middleware/security.js';
import { handleMcpRequest, handleMcpMethodNotAllowed } from './mcp/index.js';

// Initialize database on import
import './db/index.js';
import { reconnectWorkingTasks, startRateLimitRetryPoller, startWakePoller } from './services/claude.js';
import { startWorktreeReconciler } from './services/git.js';
import { startPortJanitor } from './services/port-janitor.js';

// Prevent unhandled promise rejections from crashing the server
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection:', reason instanceof Error ? reason.message.slice(0, 200) : String(reason).slice(0, 200));
});

const PORT = parseInt(process.env.PORT || '3000', 10);

const app = express();

// CPM is reached through Coder's workspace-app proxy, which appends the real
// client IP to X-Forwarded-For. Trusting exactly that many hops (1 by default)
// makes `req.ip` the actual client rather than the proxy — which the rate
// limiters key on — without trusting a client-supplied leftmost XFF entry.
app.set('trust proxy', Number(process.env.CPM_TRUST_PROXY ?? 1));

const CORS_ALLOWED = allowedOrigins();
if (CORS_ALLOWED.size === 0) {
  console.warn('[server] No APP_URL or CPM_ALLOWED_ORIGINS set — all cross-origin browser calls will be blocked.');
}

app.use(compression());
app.use(securityHeaders);
app.use(cors({ origin: corsOriginCheck(CORS_ALLOWED), credentials: true }));
app.use(express.json());
app.use(cookieParser());

// API routes
app.use('/auth', authRoutes);
app.use('/api/workspaces', workspaceRoutes);
app.use('/api', taskRoutes);
app.use('/api', uploadRoutes);
app.use('/api', ttsRoutes);
app.use('/api', sttRoutes);
app.use('/api', claudeAccountRoutes);

// MCP endpoint — Bearer-token or cookie-authed, one stateless server per request.
app.post('/mcp', requireAuth, handleMcpRequest);
app.get('/mcp', requireAuth, handleMcpMethodNotAllowed);
app.delete('/mcp', requireAuth, handleMcpMethodNotAllowed);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Coder Project Manager running on http://localhost:${PORT}`);
  reconnectWorkingTasks().catch(err => {
    console.error('[recovery] Unhandled error during task reconnect:', (err as Error).message?.slice(0, 200));
  });
  // Sweep worktrees left behind by deleted tasks — once now, then periodically.
  // Delete-time cleanup runs in the background after the HTTP response, so this
  // is the recovery path when that cleanup fails or is cut short by a restart.
  startWorktreeReconciler();
  // Periodically re-queue tasks that failed on a usage/token limit once their
  // reset window has passed, so the user doesn't have to retry them by hand.
  startRateLimitRetryPoller();
  // Resume tasks whose agent scheduled its own wake-up ([WAKE]) — either when
  // the sentinel file it was waiting on appears, or when its timer elapses.
  // Survives restarts: the schedule lives in the tasks table, not in a timer.
  startWakePoller();
  // Periodically reap orphaned dev servers and attribute drifted ports to their
  // owning task (see services/port-janitor.ts).
  startPortJanitor();
});
