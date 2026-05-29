import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import compression from 'compression';

import authRoutes from './routes/auth.js';
import workspaceRoutes from './routes/workspaces.js';
import taskRoutes from './routes/tasks.js';
import discussionRoutes from './routes/discussions.js';
import uploadRoutes from './routes/uploads.js';
import ttsRoutes from './routes/tts.js';
import sttRoutes from './routes/stt.js';
import { requireAuth } from './middleware/auth.js';
import { handleMcpRequest, handleMcpMethodNotAllowed } from './mcp/index.js';

// Initialize database on import
import './db/index.js';
import { reconnectWorkingTasks } from './services/claude.js';

// Prevent unhandled promise rejections from crashing the server
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection:', reason instanceof Error ? reason.message.slice(0, 200) : String(reason).slice(0, 200));
});

const PORT = parseInt(process.env.PORT || '3000', 10);

const app = express();

app.use(compression());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// API routes
app.use('/auth', authRoutes);
app.use('/api/workspaces', workspaceRoutes);
app.use('/api', taskRoutes);
app.use('/api', discussionRoutes);
app.use('/api', uploadRoutes);
app.use('/api', ttsRoutes);
app.use('/api', sttRoutes);

// MCP endpoint — Bearer-token or cookie-authed, one stateless server per request.
app.post('/mcp', requireAuth, handleMcpRequest);
app.get('/mcp', requireAuth, handleMcpMethodNotAllowed);
app.delete('/mcp', requireAuth, handleMcpMethodNotAllowed);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Coder Project Manager running on http://localhost:${PORT}`);
  reconnectWorkingTasks().catch(err => {
    console.error('[recovery] Unhandled error during task reconnect:', (err as Error).message?.slice(0, 200));
  });
});
