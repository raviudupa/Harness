/**
 * Express Server Entry Point
 * Sets up middleware, mounts routes, and serves the frontend.
 */
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth');
const harnessRoutes = require('./routes/harness');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────
app.use(cors({
  origin: true,
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'harness-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set to true in production with HTTPS
    maxAge: 4 * 60 * 60 * 1000, // 4 hours
  },
}));

// ─── Static Files (Frontend) ──────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── API Routes ───────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api', harnessRoutes);

// ─── Catch-all: serve index.html for SPA ──────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── Error Handler ────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Server] Unhandled error:', err.stack);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

// ─── Start Server ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║   ⚡ Salesforce Apex Test Harness                     ║
║   🌐 Running on http://localhost:${PORT}                ║
║                                                       ║
║   Powered by Claude LLM + Salesforce Tooling API      ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
  `);

  // Validate required env vars
  const required = ['SF_CLIENT_ID', 'SF_CLIENT_SECRET', 'ANTHROPIC_API_KEY'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.warn(`⚠️  Missing environment variables: ${missing.join(', ')}`);
    console.warn('   Copy .env.example to .env and fill in the values.');
  }
});
