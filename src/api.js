'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { db, credit, debit, getSettings, getSetting, EPHEMERAL, IS_PG } = require('./db');
const {
  hashPassword, verifyPassword, fakeVerify, passwordProblem, createSession, destroySession, destroyOtherSessions,
  requireUser, rateLimit, sharedLimit, hit, publicUser, lockedMinutes, recordFailedLogin,
  createResetToken, findResetToken, consumeResetToken,
} = require('./auth');
const { mailConfigured, sendMail, layout } = require('./mail');
const { pageOf, pageRows } = require('./paging');

const router = express.Router();

const AVATAR_COLORS = ['#7c5cff', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#3b82f6', '#a855f7'];
const DAY_MS = 24 * 60 * 60 * 1000;

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });
const actionLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, key: (req) => `u${req.user ? req.user.id : req.ip}` });

function bad(res, msg, code = 400) {
  return res.status(code).json({ error: msg });
}

class UserError extends Error {}

const getUser = (id) => db.get('SELECT * FROM users WHERE id = ?', id);

async function newReferralCode() {
  for (;;) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    if (!(await db.get('SELECT 1 AS x FROM users WHERE referral_code = ?', code))) return code;
  }
}

function maskName(name) {
  if (name.length <= 3) return name[0] + '**';
  return name.slice(0, 2) + '*'.repeat(Math.min(4, name.length - 3)) + name.slice(-1);
}

/* ---------------------------------------------------------------- config */

router.get('/config', async (req, res) => {
  const s = await getSettings();
  const min = await db.get('SELECT MIN(min_coins) AS n FROM reward_methods WHERE active = 1');
  res.json({
    site_name: s.site_name,
    signup_bonus: Number(s.signup_bonus),
    daily_reward: Number(s.daily_reward),
    referral_percent: Number(s.referral_percent),
    min_withdraw: (min && min.n) || 500,
    announcement: s.announcement,
    maintenance: s.maintenance === '1',
    ephemeral: EPHEMERAL,
    mail_enabled: mailConfigured(),
    user: publicUser(req.user),
  });
});

/** For uptime monitors. */
router.get('/health', async (_req, res) => {
  const started = Date.now();
  await db.get('SELECT 1 AS ok');
  res.json({ ok: true, database: IS_PG ? 'postgres' : 'sqlite', persistent: !EPHEMERAL, db_ms: Date.now() - started });
});

router.get('/stats', async (_req, res) => {
  const [users, paid, offers, earnedToday] = await Promise.all([
    db.get('SELECT COUNT(*) AS n FROM users'),
    db.get("SELECT COALESCE(SUM(usd), 0) AS n FROM withdrawals WHERE status IN ('approved','paid')"),
    db.get("SELECT COUNT(*) AS n FROM offer_completions WHERE status = 'completed'"),
    db.get("SELECT COALESCE(SUM(amount), 0) AS n FROM transactions WHERE amount > 0 AND type IN ('offer','referral','daily','promo','bonus') AND created_at > ?",
      Date.now() - DAY_MS),
  ]);
  res.json({ users: users.n, paid_usd: paid.n, offers_completed: offers.n, earned_today: earnedToday.n });
});

/* ------------------------------------------------------------------ auth */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN = 60 * 1000;
const ipKey = (req) => req.ip || 'unknown';

const siteUrl = (req) => (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

router.post('/auth/register', authLimiter, sharedLimit('register', 10, 60 * MIN, ipKey), async (req, res) => {
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const referral = String(req.body.referral || '').trim().toUpperCase();

  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return bad(res, 'Username must be 3-20 letters, numbers or underscores.');
  if (!EMAIL_RE.test(email) || email.length > 254) return bad(res, 'Please enter a valid email address.');
  const pwProblem = passwordProblem(password);
  if (pwProblem) return bad(res, pwProblem);
  if (!req.body.terms) return bad(res, 'You must accept the Terms of Service.');

  if (await db.get('SELECT 1 AS x FROM users WHERE lower(username) = lower(?)', username)) return bad(res, 'That username is taken.');
  if (await db.get('SELECT 1 AS x FROM users WHERE lower(email) = ?', email)) return bad(res, 'An account with that email already exists. Try logging in, or reset your password.');

  const maxPerIp = Number(await getSetting('max_accounts_per_ip')) || 0;
  if (maxPerIp > 0 && req.ip) {
    const n = (await db.get('SELECT COUNT(*) AS n FROM users WHERE signup_ip = ?', req.ip)).n;
    if (n >= maxPerIp) return bad(res, 'Too many accounts have been created from your network. One account per person, please.');
  }

  let referrer = null;
  if (referral) {
    referrer = await db.get('SELECT id FROM users WHERE referral_code = ?', referral);
    if (!referrer) return bad(res, 'That referral code does not exist.');
  }

  const passwordHash = hashPassword(password);
  const code = await newReferralCode();
  let id;
  try {
    id = await db.tx(async (t) => {
      const hasAdmin = await t.get("SELECT 1 AS x FROM users WHERE role = 'admin'");
      const row = await t.get(`INSERT INTO users
        (username, email, password_hash, role, referral_code, referred_by, avatar_color, created_at, signup_ip, password_changed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      username, email, passwordHash, hasAdmin ? 'user' : 'admin', code,
      referrer ? referrer.id : null, AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
      Date.now(), String(req.ip || '').slice(0, 64), Date.now());
      const bonus = Number(await getSetting('signup_bonus', t)) || 0;
      if (bonus > 0) await credit(t, row.id, bonus, 'bonus', 'Welcome bonus');
      return row.id;
    });
  } catch (err) {
    if (/unique|constraint/i.test(err.message)) return bad(res, 'That username or email is already registered.');
    throw err;
  }

  await createSession(req, res, id, { remember: true });
  res.json({ user: publicUser(await getUser(id)) });
});

router.post('/auth/login', authLimiter, sharedLimit('login-ip', 30, 15 * MIN, ipKey), async (req, res) => {
  const login = String(req.body.login || '').trim().slice(0, 254);
  const password = String(req.body.password || '').slice(0, 200);
  if (!login || !password) return bad(res, 'Enter your username or email, and your password.');
  const user = await db.get('SELECT * FROM users WHERE (lower(username) = lower(?) OR lower(email) = lower(?)) AND is_demo = 0', login, login);
  if (!user) {
    fakeVerify();
    return bad(res, 'That username/email and password don\'t match. Check for typos, or reset your password.', 401);
  }
  const locked = lockedMinutes(user);
  if (locked) return bad(res, `Too many wrong passwords. This account is locked for ${locked} more minute${locked === 1 ? '' : 's'}, or you can reset your password.`, 429);
  if (!verifyPassword(password, user.password_hash)) {
    const nowLocked = await recordFailedLogin(user);
    return bad(res, nowLocked
      ? 'Too many wrong passwords. This account is locked for 15 minutes, or you can reset your password.'
      : 'That username/email and password don\'t match. Check for typos, or reset your password.', 401);
  }
  if (user.banned) return bad(res, 'This account has been suspended. Contact support if you think this is a mistake.', 403);
  await createSession(req, res, user.id, { remember: req.body.remember !== false });
  res.json({ user: publicUser(await getUser(user.id)) });
});

router.post('/auth/logout', async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

const RESET_SENT = 'If an account uses that email, a reset link is on its way. It works for 1 hour. Check your spam folder too.';

/** Request a reset link. Always answers the same way so it can't be used to find accounts. */
router.post('/auth/forgot', authLimiter, sharedLimit('forgot-ip', 10, 60 * MIN, ipKey), async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return bad(res, 'Please enter a valid email address.');
  if (!mailConfigured()) {
    return res.json({ ok: true, mail: false, message: "Email isn't set up on this site yet. Contact support and they can send you a reset link." });
  }
  if (!(await hit(`forgot-email:${email}`, 3, 60 * MIN))) return res.json({ ok: true, mail: true, message: RESET_SENT });
  const user = await db.get('SELECT id, username, email, banned FROM users WHERE lower(email) = ? AND is_demo = 0', email);
  if (user && !user.banned) {
    const token = await createResetToken(user.id, req.ip);
    const siteName = await getSetting('site_name');
    const url = `${siteUrl(req)}/#/reset/${token}`;
    const msg = layout({
      siteName,
      heading: 'Reset your password',
      body: `Hi ${user.username}, someone (hopefully you) asked to reset the password for your ${siteName} account. Click below to choose a new one.`,
      button: 'Choose a new password',
      url,
      footer: "This link works for 1 hour and only once. If you didn't ask for this, you can ignore this email; your password won't change.",
    });
    try {
      await sendMail({ to: user.email, subject: `Reset your ${siteName} password`, ...msg });
    } catch (err) {
      console.error('Password reset email failed:', err.message);
    }
  }
  res.json({ ok: true, mail: true, message: RESET_SENT });
});

router.get('/auth/reset/:token', sharedLimit('reset-check', 30, 15 * MIN, ipKey), async (req, res) => {
  const r = await findResetToken(req.params.token);
  if (!r || r.banned) return bad(res, 'This reset link is invalid or has expired. Request a new one.', 404);
  res.json({ ok: true, username: r.username });
});

router.post('/auth/reset', authLimiter, sharedLimit('reset', 10, 15 * MIN, ipKey), async (req, res) => {
  const token = String(req.body.token || '');
  const password = String(req.body.password || '');
  const pwProblem = passwordProblem(password);
  if (pwProblem) return bad(res, pwProblem);
  const r = await findResetToken(token);
  if (!r || r.banned) return bad(res, 'This reset link is invalid or has expired. Request a new one.', 404);
  if (!(await consumeResetToken(token))) return bad(res, 'This reset link has already been used. Request a new one.', 404);
  await db.run('UPDATE users SET password_hash = ?, password_changed_at = ?, failed_logins = 0, locked_until = NULL WHERE id = ?',
    hashPassword(password), Date.now(), r.user_id);
  await destroyOtherSessions(r.user_id); // sign out everywhere, then log in here
  await createSession(req, res, r.user_id, { remember: true });
  res.json({ user: publicUser(await getUser(r.user_id)) });
});

/* ---------------------------------------------------------------- account */

router.get('/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }));

router.post('/me/onboarded', requireUser, async (req, res) => {
  await db.run('UPDATE users SET onboarded = 1 WHERE id = ?', req.user.id);
  res.json({ ok: true });
});

router.post('/me/password', requireUser, authLimiter, async (req, res) => {
  const current = String(req.body.current || '');
  const next = String(req.body.next || '');
  if (!verifyPassword(current, req.user.password_hash)) return bad(res, 'Your current password is incorrect.');
  const pwProblem = passwordProblem(next);
  if (pwProblem) return bad(res, pwProblem);
  if (current === next) return bad(res, 'Pick a password different from your current one.');
  await db.run('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?', hashPassword(next), Date.now(), req.user.id);
  await destroyOtherSessions(req.user.id, req.sessionHash);
  res.json({ ok: true, message: 'Password updated. Other devices have been signed out.' });
});

router.post('/me/email', requireUser, authLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!verifyPassword(String(req.body.password || ''), req.user.password_hash)) return bad(res, 'Your password is incorrect.');
  if (!EMAIL_RE.test(email) || email.length > 254) return bad(res, 'Please enter a valid email address.');
  if (await db.get('SELECT 1 AS x FROM users WHERE lower(email) = ? AND id != ?', email, req.user.id)) return bad(res, 'Another account already uses that email.');
  await db.run('UPDATE users SET email = ? WHERE id = ?', email, req.user.id);
  res.json({ user: publicUser(await getUser(req.user.id)) });
});

const sessionId = (hash) => hash.slice(0, 16);

router.get('/me/sessions', requireUser, async (req, res) => {
  const rows = await db.all('SELECT token_hash, ip, user_agent, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC',
    req.user.id, Date.now());
  res.json({
    sessions: rows.map((r) => ({
      id: sessionId(r.token_hash), ip: r.ip, user_agent: r.user_agent, created_at: r.created_at,
      last_seen_at: r.last_seen_at || r.created_at, expires_at: r.expires_at, current: r.token_hash === req.sessionHash,
    })),
  });
});

router.delete('/me/sessions/:id', requireUser, async (req, res) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f]{16}$/.test(id)) return bad(res, 'Unknown session.', 404);
  const rows = await db.all('SELECT token_hash FROM sessions WHERE user_id = ?', req.user.id);
  const match = rows.find((r) => sessionId(r.token_hash) === id);
  if (!match) return bad(res, 'Unknown session.', 404);
  await db.run('DELETE FROM sessions WHERE token_hash = ?', match.token_hash);
  if (match.token_hash === req.sessionHash) res.clearCookie('gr_session', { path: '/' });
  res.json({ ok: true });
});

router.post('/me/sessions/revoke-others', requireUser, async (req, res) => {
  await destroyOtherSessions(req.user.id, req.sessionHash);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- offers */

router.get('/offerwalls', async (_req, res) => {
  const walls = await db.all(`SELECT id, name, slug, tagline, color, icon, bonus_percent, open_mode, hold_hours
    FROM offerwalls WHERE active = 1 AND iframe_url != '' ORDER BY sort, id`);
  res.json({ offerwalls: walls });
});

/** The wall URL for the logged-in user, with their ID filled in. */
router.get('/offerwalls/:slug/launch', requireUser, async (req, res) => {
  const wall = await db.get("SELECT * FROM offerwalls WHERE slug = ? AND active = 1 AND iframe_url != ''", String(req.params.slug));
  if (!wall) return bad(res, 'Offerwall not found.', 404);
  const url = wall.iframe_url
    .replace(/\{user_id\}/g, encodeURIComponent(String(req.user.id)))
    .replace(/\{username\}/g, encodeURIComponent(req.user.username));
  res.json({ url, open_mode: wall.open_mode });
});

/* --------------------------------------------------------------- rewards */

router.post('/daily', requireUser, async (req, res) => {
  const last = Number(req.user.last_daily_at) || 0;
  if (Date.now() - last < DAY_MS) return bad(res, 'Daily reward already claimed. Come back later!');
  const amount = Number(await getSetting('daily_reward')) || 0;
  const ok = await db.tx(async (t) => {
    const updated = await t.run('UPDATE users SET last_daily_at = ? WHERE id = ? AND COALESCE(last_daily_at, 0) = ?',
      Date.now(), req.user.id, last);
    if (updated.changes !== 1) return false;
    await credit(t, req.user.id, amount, 'daily', 'Daily reward');
    return true;
  });
  if (!ok) return bad(res, 'Daily reward already claimed. Come back later!');
  res.json({ amount, user: publicUser(await getUser(req.user.id)) });
});

router.post('/promo', requireUser, actionLimiter, async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!code) return bad(res, 'Enter a promo code.');
  try {
    const amount = await db.tx(async (t) => {
      const promo = await t.get('SELECT * FROM promo_codes WHERE code = ? AND active = 1', code);
      if (!promo) throw new UserError('Invalid promo code.');
      if (promo.expires_at && promo.expires_at < Date.now()) throw new UserError('This promo code has expired.');
      const ins = await t.run('INSERT INTO promo_redemptions (code, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        promo.code, req.user.id, Date.now());
      if (ins.changes !== 1) throw new UserError('You already redeemed this code.');
      const used = await t.run('UPDATE promo_codes SET uses = uses + 1 WHERE code = ? AND (max_uses = 0 OR uses < max_uses)', promo.code);
      if (used.changes !== 1) throw new UserError('This promo code has been fully redeemed.');
      await credit(t, req.user.id, promo.reward, 'promo', `Promo code ${promo.code}`);
      return promo.reward;
    });
    res.json({ amount, user: publicUser(await getUser(req.user.id)) });
  } catch (err) {
    if (err instanceof UserError) return bad(res, err.message);
    throw err;
  }
});

/* --------------------------------------------------------------- cashout */

router.get('/reward-methods', async (_req, res) => {
  res.json({ methods: await db.all('SELECT * FROM reward_methods WHERE active = 1 ORDER BY sort, id') });
});

router.post('/withdraw', requireUser, actionLimiter, async (req, res) => {
  const method = await db.get('SELECT * FROM reward_methods WHERE id = ? AND active = 1', Number(req.body.method_id) || 0);
  if (!method) return bad(res, 'Choose a valid reward method.');
  const coins = Math.floor(Number(req.body.coins));
  const destination = String(req.body.destination || '').trim();
  const min = method.min_coins;
  if (!Number.isFinite(coins) || coins < min) return bad(res, `Minimum cashout for ${method.name} is $${(min / 100).toFixed(2)}.`);
  if (coins > 1_000_000) return bad(res, 'Amount too large.');
  if (!destination || destination.length > 200) return bad(res, `Enter your ${method.field_label}.`);

  const ok = await db.tx(async (t) => {
    if (!(await debit(t, req.user.id, coins, 'withdraw', `Cashout via ${method.name}`))) return false;
    await t.run(`INSERT INTO withdrawals (user_id, method_id, method_name, coins, usd, destination, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, req.user.id, method.id, method.name, coins, coins / 100, destination, Date.now());
    return true;
  });
  if (!ok) return bad(res, 'Insufficient balance.');
  res.json({ ok: true, user: publicUser(await getUser(req.user.id)) });
});

/* ---------------------------------------------------------------- history */

/* One section of the activity list, a page at a time: ?section=transactions|completions|withdrawals&page=1 */
router.get('/me/history', requireUser, async (req, res) => {
  const section = ['transactions', 'completions', 'withdrawals'].includes(req.query.section) ? req.query.section : 'transactions';
  const table = { transactions: 'transactions', completions: 'offer_completions', withdrawals: 'withdrawals' }[section];
  const p = pageOf(req.query);
  const rows = await db.all(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`, req.user.id, p.limit + 1, p.offset);
  res.json({ section, ...pageRows(rows, p) });
});

router.get('/me/referrals', requireUser, async (req, res) => {
  const p = pageOf(req.query);
  const rows = await db.all(`SELECT u.username, u.created_at,
      COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.user_id = u.id AND t.type = 'offer'), 0) AS earned
    FROM users u WHERE u.referred_by = ? ORDER BY u.id DESC LIMIT ? OFFSET ?`, req.user.id, p.limit + 1, p.offset);
  const count = Number((await db.get('SELECT COUNT(*) AS n FROM users WHERE referred_by = ?', req.user.id)).n);
  const commission = (await db.get("SELECT COALESCE(SUM(amount), 0) AS n FROM transactions WHERE user_id = ? AND type = 'referral'", req.user.id)).n;
  res.json({ ...pageRows(rows, p, 'referrals'), count, commission, code: req.user.referral_code });
});

/* ---------------------------------------------------------- social proof */

router.get('/feed', async (_req, res) => {
  const rows = await db.all(`SELECT c.id, c.offer_title, c.provider, c.reward, c.updated_at AS at, u.username, u.avatar_color
    FROM offer_completions c JOIN users u ON u.id = c.user_id
    WHERE c.status = 'completed' ORDER BY c.updated_at DESC LIMIT 25`);
  res.json({ feed: rows.map((r) => ({ ...r, username: maskName(r.username) })) });
});

router.get('/leaderboard', async (req, res) => {
  const period = req.query.period === 'monthly' ? 30 : req.query.period === 'all' ? 36500 : 7;
  const rows = await db.all(`SELECT u.username, u.avatar_color, SUM(t.amount) AS earned
    FROM transactions t JOIN users u ON u.id = t.user_id
    WHERE t.amount > 0 AND t.type IN ('offer','referral') AND t.created_at > ? AND u.banned = 0
    GROUP BY u.id, u.username, u.avatar_color ORDER BY earned DESC LIMIT 10`, Date.now() - period * DAY_MS);
  res.json({ leaderboard: rows });
});

module.exports = router;
