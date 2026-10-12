'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { db, migrate, getSetting, IS_PG, EPHEMERAL } = require('./src/db');
const { loadUser, rateLimit } = require('./src/auth');
const { seed, upgrade, ensureEnvAdmin } = require('./src/seed');
const { processPostback, housekeeping } = require('./src/offerwalls');

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
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; script-src 'self'; connect-src 'self'; frame-src https:; frame-ancestors 'none'");
  next();
});

app.use('/api', async (_req, _res, next) => {
  await init();
  housekeeping(); // release held rewards, trim old logs (throttled)
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
  if ((req.user && req.user.role === 'admin') || /^\/(config|auth\/|me$|postback\/)/.test(req.path)) return next();
  res.status(503).json({ error: 'We are performing maintenance. Please check back soon!' });
});

/**
 * Offerwall postbacks (server-to-server), one URL per offerwall:
 *   GET or POST /api/postback/<slug>/<token>?user_id=..&txid=..&reward=..&payout=..&status=..
 * The admin panel shows each wall's exact URL. See src/offerwalls.js.
 */
const postbackLimiter = rateLimit({ windowMs: 60_000, max: 600, key: (req) => `pb${req.ip}` });
app.all('/api/postback/:slug/:token', postbackLimiter, express.urlencoded({ extended: false, limit: '20kb' }), async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).send('0');
  const wall = await db.get('SELECT * FROM offerwalls WHERE slug = ?', String(req.params.slug));
  const token = String(req.params.token);
  if (!wall || !wall.postback_token || token.length !== wall.postback_token.length
    || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(wall.postback_token))) {
    return res.status(404).send('0');
  }
  const params = { ...req.query, ...(req.method === 'POST' && req.body && typeof req.body === 'object' ? req.body : {}) };
  for (const k of Object.keys(params)) if (typeof params[k] !== 'string') params[k] = String(params[k]);
  const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const result = await processPostback(wall, params, { ip: req.ip, method: req.method, fullUrl });
  res.status(result.status).type('text/plain').send(result.body);
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
