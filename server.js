'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { db, tx, getSetting } = require('./src/db');
const { loadUser } = require('./src/auth');
const { seed, ensureEnvAdmin } = require('./src/seed');
const { approveCompletionInTx, rejectCompletion } = require('./src/rewards');

seed();
ensureEnvAdmin();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1');

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: '50kb' }));
app.use(loadUser);

// Basic CSRF defence: state-changing API calls must be JSON from our own origin.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.path.startsWith('/postback')) return next();
  if (!req.is('application/json')) return res.status(415).json({ error: 'Expected JSON.' });
  const origin = req.headers.origin;
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch { /* malformed */ }
    if (host !== req.headers.host) return res.status(403).json({ error: 'Bad origin.' });
  }
  next();
});

// Maintenance mode: only admins and auth/config endpoints get through.
app.use('/api', (req, res, next) => {
  if (getSetting('maintenance') !== '1') return next();
  if ((req.user && req.user.role === 'admin') || /^\/(config|auth\/|me$)/.test(req.path)) return next();
  res.status(503).json({ error: 'We are performing maintenance. Please check back soon!' });
});

/**
 * Offerwall postback (server-to-server). Configure your offerwall to call:
 *   GET /api/postback?secret=SECRET&user_id={user}&offer_id={offer}&title={name}&reward={coins}&txid={transaction}&provider=Name&status=1
 * status=1 credits the user, status=2 reverses (chargeback) a previously credited txid.
 */
app.get('/api/postback', (req, res) => {
  const q = req.query;
  const secret = String(getSetting('postback_secret'));
  const given = String(q.secret || '');
  if (given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return res.status(403).send('0');
  }
  const userId = Number(q.user_id);
  const reward = Math.trunc(Number(q.reward));
  const txid = String(q.txid || '').slice(0, 128);
  if (!userId || !txid || !Number.isFinite(reward) || reward <= 0) return res.status(400).send('0');
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return res.status(404).send('0');

  const existing = db.prepare('SELECT * FROM offer_completions WHERE txid = ?').get(txid);
  if (String(q.status) === '2') {
    if (existing) rejectCompletion(existing.id, 'Chargeback from provider');
    return res.send('1');
  }
  if (existing) return res.send('1'); // duplicate, already handled

  const offerId = q.offer_id && db.prepare('SELECT id FROM offers WHERE id = ?').get(Number(q.offer_id)) ? Number(q.offer_id) : null;
  tx(() => {
    const now = Date.now();
    const info = db.prepare(`INSERT INTO offer_completions (user_id, offer_id, offer_title, provider, reward, status, txid, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(userId, offerId, String(q.title || 'Offer').slice(0, 120),
      String(q.provider || 'Offerwall').slice(0, 60), reward, txid, now, now);
    approveCompletionInTx(db.prepare('SELECT * FROM offer_completions WHERE id = ?').get(Number(info.lastInsertRowid)));
  });
  res.send('1');
});

app.use('/api/admin', require('./src/admin'));
app.use('/api', require('./src/api'));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// Housekeeping: clear expired sessions hourly.
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600_000).unref();

const PORT = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`${getSetting('site_name')} running at http://localhost:${PORT}`));
}

module.exports = { app };
