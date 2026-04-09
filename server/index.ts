import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import compression from 'compression';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

import authRoutes from './routes/auth.js';
import workspaceRoutes from './routes/workspaces.js';
import taskRoutes from './routes/tasks.js';
import discussionRoutes from './routes/discussions.js';

// Initialize database on import
import './db/index.js';
import { reconnectWorkingTasks } from './services/claude.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
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

// Serve static files in production
const clientDist = join(__dirname, '../dist/client');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist, { maxAge: '1d', immutable: true }));
  app.get('*', (_req, res) => {
    res.sendFile(join(clientDist, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Coder Project Manager running on http://localhost:${PORT}`);
  reconnectWorkingTasks();
});
