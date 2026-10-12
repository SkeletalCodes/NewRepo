'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { db, credit, debit, getSettings, getSetting, EPHEMERAL } = require('./db');
const {
  hashPassword, verifyPassword, createSession, destroySession,
  requireUser, rateLimit, publicUser,
} = require('./auth');
const { approveCompletionInTx } = require('./rewards');

const router = express.Router();

const AVATAR_COLORS = ['#7c5cff', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#3b82f6', '#a855f7'];
const DAY_MS = 24 * 60 * 60 * 1000;

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
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
    user: publicUser(req.user),
  });
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

router.post('/auth/register', authLimiter, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const referral = String(req.body.referral || '').trim().toUpperCase();

  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return bad(res, 'Username must be 3-20 letters, numbers or underscores.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) return bad(res, 'Please enter a valid email address.');
  if (password.length < 8 || password.length > 128) return bad(res, 'Password must be at least 8 characters.');
  if (!req.body.terms) return bad(res, 'You must accept the Terms of Service.');

  if (await db.get('SELECT 1 AS x FROM users WHERE lower(username) = lower(?)', username)) return bad(res, 'That username is taken.');
  if (await db.get('SELECT 1 AS x FROM users WHERE lower(email) = ?', email)) return bad(res, 'An account with that email already exists.');

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
        (username, email, password_hash, role, referral_code, referred_by, avatar_color, created_at, last_login_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      username, email, passwordHash, hasAdmin ? 'user' : 'admin', code,
      referrer ? referrer.id : null, AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
      Date.now(), Date.now());
      const bonus = Number(await getSetting('signup_bonus', t)) || 0;
      if (bonus > 0) await credit(t, row.id, bonus, 'bonus', 'Welcome bonus');
      return row.id;
    });
  } catch (err) {
    if (/unique|constraint/i.test(err.message)) return bad(res, 'That username or email is already registered.');
    throw err;
  }

  await createSession(res, id);
  res.json({ user: publicUser(await getUser(id)) });
});

router.post('/auth/login', authLimiter, async (req, res) => {
  const login = String(req.body.login || '').trim();
  const password = String(req.body.password || '');
  if (!login || !password) return bad(res, 'Enter your username/email and password.');
  const user = await db.get('SELECT * FROM users WHERE (lower(username) = lower(?) OR lower(email) = lower(?)) AND is_demo = 0', login, login);
  if (!user || !verifyPassword(password, user.password_hash)) return bad(res, 'Incorrect username/email or password.', 401);
  if (user.banned) return bad(res, 'This account has been suspended.', 403);
  await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), user.id);
  await createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

router.post('/auth/logout', async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

router.get('/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }));

router.post('/me/onboarded', requireUser, async (req, res) => {
  await db.run('UPDATE users SET onboarded = 1 WHERE id = ?', req.user.id);
  res.json({ ok: true });
});

router.post('/me/password', requireUser, authLimiter, async (req, res) => {
  const current = String(req.body.current || '');
  const next = String(req.body.next || '');
  if (!verifyPassword(current, req.user.password_hash)) return bad(res, 'Current password is incorrect.');
  if (next.length < 8 || next.length > 128) return bad(res, 'New password must be at least 8 characters.');
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(next), req.user.id);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- offers */

router.get('/offerwalls', async (_req, res) => {
  const walls = await db.all(`SELECT w.*, (SELECT COUNT(*) FROM offers o WHERE o.offerwall_id = w.id AND o.active = 1) AS offer_count
    FROM offerwalls w WHERE w.active = 1 ORDER BY w.sort, w.id`);
  res.json({ offerwalls: walls });
});

router.get('/offers', async (req, res) => {
  const where = ['o.active = 1'];
  const params = [];
  if (req.query.wall) { where.push('w.slug = ?'); params.push(String(req.query.wall)); }
  if (req.query.category && req.query.category !== 'all') { where.push('o.category = ?'); params.push(String(req.query.category)); }
  if (req.query.featured) where.push('o.featured = 1');
  const offers = await db.all(`SELECT o.id, o.title, o.description, o.requirements, o.category, o.reward, o.icon, o.color,
      o.device, o.est_minutes, o.featured, o.repeatable, o.completions, w.name AS provider, w.slug AS provider_slug,
      COALESCE(w.bonus_percent, 0) AS bonus_percent
    FROM offers o LEFT JOIN offerwalls w ON w.id = o.offerwall_id
    WHERE ${where.join(' AND ')} AND (w.id IS NULL OR w.active = 1)
    ORDER BY o.featured DESC, o.reward DESC`, ...params);

  const done = new Map();
  if (req.user) {
    for (const r of await db.all("SELECT offer_id, status FROM offer_completions WHERE user_id = ? AND status != 'rejected'", req.user.id)) {
      done.set(r.offer_id, r.status);
    }
  }
  res.json({
    offers: offers.map((o) => ({
      ...o,
      payout: Math.round(o.reward * (1 + o.bonus_percent / 100)),
      user_status: done.get(o.id) || null,
    })),
  });
});

router.post('/offers/:id/complete', requireUser, actionLimiter, async (req, res) => {
  const offer = await db.get(`SELECT o.*, w.name AS provider, COALESCE(w.bonus_percent, 0) AS bonus_percent
    FROM offers o LEFT JOIN offerwalls w ON w.id = o.offerwall_id WHERE o.id = ? AND o.active = 1`, Number(req.params.id) || 0);
  if (!offer) return bad(res, 'Offer not found.', 404);

  const payout = Math.round(offer.reward * (1 + offer.bonus_percent / 100));
  const auto = (await getSetting('auto_approve_offers')) === '1';
  try {
    const result = await db.tx(async (t) => {
      const existing = await t.get("SELECT status FROM offer_completions WHERE user_id = ? AND offer_id = ? AND status != 'rejected' ORDER BY id DESC LIMIT 1",
        req.user.id, offer.id);
      if (existing && (!offer.repeatable || existing.status === 'pending')) {
        throw new UserError(existing.status === 'pending' ? 'This offer is already pending review.' : 'You have already completed this offer.');
      }
      const now = Date.now();
      const completion = await t.get(`INSERT INTO offer_completions (user_id, offer_id, offer_title, provider, reward, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?) RETURNING *`, req.user.id, offer.id, offer.title, offer.provider || 'Featured', payout, now, now);
      if (auto) await approveCompletionInTx(t, completion);
      return { status: auto ? 'completed' : 'pending', reward: payout };
    });
    res.json({ ...result, user: publicUser(await getUser(req.user.id)) });
  } catch (err) {
    if (err instanceof UserError) return bad(res, err.message);
    throw err;
  }
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

router.get('/me/history', requireUser, async (req, res) => {
  const id = req.user.id;
  const [transactions, completions, withdrawals] = await Promise.all([
    db.all('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100', id),
    db.all('SELECT * FROM offer_completions WHERE user_id = ? ORDER BY id DESC LIMIT 100', id),
    db.all('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 100', id),
  ]);
  res.json({ transactions, completions, withdrawals });
});

router.get('/me/referrals', requireUser, async (req, res) => {
  const referrals = await db.all(`SELECT u.username, u.created_at,
      COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.user_id = u.id AND t.type = 'offer'), 0) AS earned
    FROM users u WHERE u.referred_by = ? ORDER BY u.id DESC LIMIT 200`, req.user.id);
  const commission = (await db.get("SELECT COALESCE(SUM(amount), 0) AS n FROM transactions WHERE user_id = ? AND type = 'referral'", req.user.id)).n;
  res.json({ referrals, commission, code: req.user.referral_code });
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
    GROUP BY u.id, u.username, u.avatar_color ORDER BY earned DESC LIMIT 25`, Date.now() - period * DAY_MS);
  res.json({ leaderboard: rows });
});

module.exports = router;
