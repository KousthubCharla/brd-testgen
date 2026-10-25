/**
 * server.js — Express entry point for AL-FS-01
 * AI-Powered Contextual Test Case Generation from BRD
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const config = require('./config/default');
const apiRoutes = require('./src/routes/api');
const { createModuleLogger } = require('./src/services/logger');

const log = createModuleLogger('Server');
const app = express();

// ── Middleware ────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Static files ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API routes ───────────────────────────────────────────
app.use('/api', apiRoutes);

// ── Output file downloads ────────────────────────────────
app.use('/output', express.static(path.resolve(config.paths.output)));

// ── Health check ─────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ── SPA fallback ─────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Error handler ────────────────────────────────────────
app.use((err, req, res, _next) => {
  log.error(`Unhandled error: ${err.message}`, { stack: err.stack });
  res.status(500).json({ success: false, error: err.message });
});

// ── Start ────────────────────────────────────────────────
const PORT = config.server.port;
app.listen(PORT, () => {
  log.info(`═══════════════════════════════════════════════════`);
  log.info(`  AL-FS-01 BRD Test Generator`);
  log.info(`  Running on http://localhost:${PORT}`);
  log.info(`  Environment: ${config.server.env}`);
  log.info(`  LLM: ${config.llm.provider} / ${config.llm.openai.model}`);
  log.info(`═══════════════════════════════════════════════════`);
});

module.exports = app;
