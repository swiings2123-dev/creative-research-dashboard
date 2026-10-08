require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const logger = require('./utils/logger');

// Initialize database
require('./db/schema').getDb();

const app = express();

// Middleware
// Local dev on any port, plus deployed frontends listed in FRONTEND_URL (comma-separated)
const allowedOrigins = [
  /^http:\/\/(localhost|127\.0\.0\.1):\d+$/,
  ...(process.env.FRONTEND_URL || '').split(',').map((u) => u.trim().replace(/\/$/, '')).filter(Boolean),
];
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info(`${req.method} ${req.path}`, {
      status: res.statusCode,
      duration: `${Date.now() - start}ms`,
    });
  });
  next();
});

// Routes
app.use('/api/search', require('./routes/search'));
app.use('/api/history', require('./routes/history'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Serve the built frontend (production / Docker / Render); dev uses the Vite server instead
const FRONTEND_DIST = path.join(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(path.join(FRONTEND_DIST, 'index.html'))) {
  app.use(express.static(FRONTEND_DIST));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(FRONTEND_DIST, 'index.html')));
}

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// Hosts with ephemeral disks start with an empty DB; load the recorded demo searches so the
// dashboard has data to explore (disable with SEED_DEMO=false).
if (process.env.SEED_DEMO !== 'false') {
  try {
    const { getDb } = require('./db/schema');
    if (!getDb().prepare('SELECT 1 FROM searches LIMIT 1').get()) {
      const loaded = require('../scripts/seedRecorded').seedRecorded({ quiet: true });
      logger.info('Loaded recorded demo searches into empty database', { loaded });
    }
  } catch (error) {
    logger.warn('Could not load recorded demo searches', { error: error.message });
  }
}

// Start server
app.listen(config.port, () => {
  logger.info(`Server running on port ${config.port}`, {
    env: config.nodeEnv,
    apifyConfigured: !!config.apifyToken,
    geminiConfigured: !!config.geminiApiKey,
    tiktokEnabled: config.enableTiktok,
  });
});

module.exports = app;
