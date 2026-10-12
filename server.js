'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { db, migrate, getSetting, IS_PG, EPHEMERAL } = require('./src/db');
const { loadUser } = require('./src/auth');
const { seed, upgrade, ensureEnvAdmin } = require('./src/seed');
const { approveCompletionInTx, rejectCompletion } = require('./src/rewards');

// Schema + seed run once per process (once per cold start on serverless hosts).
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await migrate();
      await seed();
      await upgrade();
      await ensureEnvAdmin();
    })().catch((err) => {
      ready = null; // retry on the next request
      throw err;
    });
  }
  return ready;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1' || !!process.env.VERCEL);

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  next();
});

app.use('/api', async (_req, _res, next) => {
  await init();
  next();
});
app.use(express.json({ limit: '50kb' }));
app.use('/api', loadUser);

// CSRF defence: state-changing API calls must come from our own origin, and any body must be JSON.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.path.startsWith('/postback')) return next();
  if (req.headers['content-type'] && !req.is('application/json')) return res.status(415).json({ error: 'Expected JSON.' });
  const origin = req.headers.origin;
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch { /* malformed */ }
    if (host !== req.headers.host) return res.status(403).json({ error: 'Bad origin.' });
  }
  next();
});

// Maintenance mode: only admins and auth/config endpoints get through.
app.use('/api', async (req, res, next) => {
  if ((await getSetting('maintenance')) !== '1') return next();
  if ((req.user && req.user.role === 'admin') || /^\/(config|auth\/|me$)/.test(req.path)) return next();
  res.status(503).json({ error: 'We are performing maintenance. Please check back soon!' });
});

/**
 * Offerwall postback (server-to-server). Configure your offerwall to call:
 *   GET /api/postback?secret=SECRET&user_id={user}&offer_id={offer}&title={name}&reward={coins}&txid={transaction}&provider=Name&status=1
 * status=1 credits the user, status=2 reverses (chargeback) a previously credited txid.
 */
app.get('/api/postback', async (req, res) => {
  const q = req.query;
  const secret = String(await getSetting('postback_secret'));
  const given = String(q.secret || '');
  if (given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return res.status(403).send('0');
  }
  const userId = Math.trunc(Number(q.user_id));
  const reward = Math.trunc(Number(q.reward));
  const txid = String(q.txid || '').slice(0, 128);
  if (!userId || !txid || !Number.isFinite(reward) || reward <= 0 || reward > 100_000_000) return res.status(400).send('0');
  if (!(await db.get('SELECT 1 AS x FROM users WHERE id = ?', userId))) return res.status(404).send('0');

  const existing = await db.get('SELECT * FROM offer_completions WHERE txid = ?', txid);
  if (String(q.status) === '2') {
    if (existing) await rejectCompletion(existing.id, 'Chargeback from provider');
    return res.send('1');
  }
  if (existing) return res.send('1'); // duplicate, already handled

  const offerId = q.offer_id && (await db.get('SELECT id FROM offers WHERE id = ?', Math.trunc(Number(q.offer_id)) || 0))
    ? Math.trunc(Number(q.offer_id)) : null;
  await db.tx(async (t) => {
    const now = Date.now();
    const completion = await t.get(`INSERT INTO offer_completions (user_id, offer_id, offer_title, provider, reward, status, txid, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT (txid) DO NOTHING RETURNING *`, userId, offerId, String(q.title || 'Offer').slice(0, 120),
    String(q.provider || 'Offerwall').slice(0, 60), reward, txid, now, now);
    if (completion) await approveCompletionInTx(t, completion);
  });
  res.send('1');
});

app.use('/api/admin', require('./src/admin'));
app.use('/api', require('./src/api'));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

// On Vercel, files in public/ are served by the CDN; locally Express serves them.
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/{*splat}', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// Housekeeping: clear expired sessions hourly (long-running hosts only).
setInterval(() => {
  db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now()).catch(() => {});
}, 3600_000).unref();

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  init().then(async () => {
    app.listen(PORT, async () => {
      console.log(`${await getSetting('site_name')} running at http://localhost:${PORT} (${IS_PG ? 'Postgres' : 'SQLite'}${EPHEMERAL ? ', temporary storage' : ''})`);
    });
  }).catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
}

module.exports = app;
