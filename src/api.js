'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { db, tx, credit, getSettings, getSetting } = require('./db');
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

function newReferralCode() {
  for (;;) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    if (!db.prepare('SELECT 1 FROM users WHERE referral_code = ?').get(code)) return code;
  }
}

function maskName(name) {
  if (name.length <= 3) return name[0] + '**';
  return name.slice(0, 2) + '*'.repeat(Math.min(4, name.length - 3)) + name.slice(-1);
}

/* ---------------------------------------------------------------- config */

router.get('/config', (req, res) => {
  const s = getSettings();
  res.json({
    site_name: s.site_name,
    currency_name: s.currency_name,
    coins_per_usd: Number(s.coins_per_usd),
    signup_bonus: Number(s.signup_bonus),
    daily_reward: Number(s.daily_reward),
    referral_percent: Number(s.referral_percent),
    min_withdraw: Number(s.min_withdraw),
    announcement: s.announcement,
    maintenance: s.maintenance === '1',
    user: publicUser(req.user),
  });
});

router.get('/stats', (_req, res) => {
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const paid = db.prepare("SELECT COALESCE(SUM(usd), 0) AS n FROM withdrawals WHERE status IN ('approved','paid')").get().n;
  const offers = db.prepare("SELECT COUNT(*) AS n FROM offer_completions WHERE status = 'completed'").get().n;
  const earnedToday = db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM transactions WHERE amount > 0 AND type IN ('offer','referral','daily','promo','bonus') AND created_at > ?")
    .get(Date.now() - DAY_MS).n;
  res.json({ users, paid_usd: paid, offers_completed: offers, earned_today: earnedToday });
});

/* ------------------------------------------------------------------ auth */

router.post('/auth/register', authLimiter, (req, res) => {
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const referral = String(req.body.referral || '').trim().toUpperCase();

  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return bad(res, 'Username must be 3-20 letters, numbers or underscores.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) return bad(res, 'Please enter a valid email address.');
  if (password.length < 8 || password.length > 128) return bad(res, 'Password must be at least 8 characters.');
  if (!req.body.terms) return bad(res, 'You must accept the Terms of Service.');

  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return bad(res, 'That username is taken.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return bad(res, 'An account with that email already exists.');

  let referrer = null;
  if (referral) {
    referrer = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(referral);
    if (!referrer) return bad(res, 'That referral code does not exist.');
  }

  const user = tx(() => {
    const isFirstUser = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_demo = 0').get().n === 0
      && !db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get();
    const info = db.prepare(`INSERT INTO users
      (username, email, password_hash, role, referral_code, referred_by, avatar_color, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      username, email, hashPassword(password), isFirstUser ? 'admin' : 'user', newReferralCode(),
      referrer ? referrer.id : null, AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
      Date.now(), Date.now());
    const id = Number(info.lastInsertRowid);
    const bonus = Number(getSetting('signup_bonus')) || 0;
    if (bonus > 0) credit(id, bonus, 'bonus', 'Welcome bonus');
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  });

  createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

router.post('/auth/login', authLimiter, (req, res) => {
  const login = String(req.body.login || '').trim();
  const password = String(req.body.password || '');
  if (!login || !password) return bad(res, 'Enter your username/email and password.');
  const user = db.prepare('SELECT * FROM users WHERE (username = ? OR email = ?) AND is_demo = 0').get(login, login.toLowerCase());
  if (!user || !verifyPassword(password, user.password_hash)) return bad(res, 'Incorrect username/email or password.', 401);
  if (user.banned) return bad(res, 'This account has been suspended.', 403);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id);
  createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

router.post('/auth/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

router.get('/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }));

router.post('/me/onboarded', requireUser, (req, res) => {
  db.prepare('UPDATE users SET onboarded = 1 WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

router.post('/me/password', requireUser, authLimiter, (req, res) => {
  const current = String(req.body.current || '');
  const next = String(req.body.next || '');
  if (!verifyPassword(current, req.user.password_hash)) return bad(res, 'Current password is incorrect.');
  if (next.length < 8 || next.length > 128) return bad(res, 'New password must be at least 8 characters.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- offers */

router.get('/offerwalls', (_req, res) => {
  const walls = db.prepare(`SELECT w.*, (SELECT COUNT(*) FROM offers o WHERE o.offerwall_id = w.id AND o.active = 1) AS offer_count
    FROM offerwalls w WHERE w.active = 1 ORDER BY w.sort, w.id`).all();
  res.json({ offerwalls: walls });
});

router.get('/offers', (req, res) => {
  const where = ['o.active = 1'];
  const params = [];
  if (req.query.wall) { where.push('w.slug = ?'); params.push(String(req.query.wall)); }
  if (req.query.category && req.query.category !== 'all') { where.push('o.category = ?'); params.push(String(req.query.category)); }
  if (req.query.featured) where.push('o.featured = 1');
  const offers = db.prepare(`SELECT o.id, o.title, o.description, o.requirements, o.category, o.reward, o.icon, o.color,
      o.device, o.est_minutes, o.featured, o.repeatable, o.completions, w.name AS provider, w.slug AS provider_slug,
      COALESCE(w.bonus_percent, 0) AS bonus_percent
    FROM offers o LEFT JOIN offerwalls w ON w.id = o.offerwall_id
    WHERE ${where.join(' AND ')} AND (w.id IS NULL OR w.active = 1)
    ORDER BY o.featured DESC, o.reward DESC`).all(...params);

  let done = new Map();
  if (req.user) {
    for (const r of db.prepare('SELECT offer_id, status FROM offer_completions WHERE user_id = ? AND status != ?').all(req.user.id, 'rejected')) {
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

router.post('/offers/:id/complete', requireUser, actionLimiter, (req, res) => {
  const offer = db.prepare(`SELECT o.*, w.name AS provider, COALESCE(w.bonus_percent, 0) AS bonus_percent
    FROM offers o LEFT JOIN offerwalls w ON w.id = o.offerwall_id WHERE o.id = ? AND o.active = 1`).get(Number(req.params.id));
  if (!offer) return bad(res, 'Offer not found.', 404);

  const existing = db.prepare("SELECT status FROM offer_completions WHERE user_id = ? AND offer_id = ? AND status != 'rejected' ORDER BY id DESC LIMIT 1")
    .get(req.user.id, offer.id);
  if (existing && (!offer.repeatable || existing.status === 'pending')) {
    return bad(res, existing.status === 'pending' ? 'This offer is already pending review.' : 'You have already completed this offer.');
  }

  const payout = Math.round(offer.reward * (1 + offer.bonus_percent / 100));
  const auto = getSetting('auto_approve_offers') === '1';
  const result = tx(() => {
    const now = Date.now();
    const info = db.prepare(`INSERT INTO offer_completions (user_id, offer_id, offer_title, provider, reward, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`).run(req.user.id, offer.id, offer.title, offer.provider || 'GemRush', payout, now, now);
    const completion = db.prepare('SELECT * FROM offer_completions WHERE id = ?').get(Number(info.lastInsertRowid));
    if (auto) approveCompletionInTx(completion);
    return { status: auto ? 'completed' : 'pending', reward: payout };
  });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ ...result, user: publicUser(user) });
});

/* --------------------------------------------------------------- rewards */

router.post('/daily', requireUser, (req, res) => {
  const last = req.user.last_daily_at || 0;
  if (Date.now() - last < DAY_MS) {
    return bad(res, 'Daily reward already claimed. Come back later!');
  }
  const amount = Number(getSetting('daily_reward')) || 0;
  tx(() => {
    const updated = db.prepare('UPDATE users SET last_daily_at = ? WHERE id = ? AND COALESCE(last_daily_at, 0) = ?')
      .run(Date.now(), req.user.id, last);
    if (updated.changes !== 1) throw new Error('race');
    credit(req.user.id, amount, 'daily', 'Daily reward');
  });
  res.json({ amount, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

router.post('/promo', requireUser, actionLimiter, (req, res) => {
  const code = String(req.body.code || '').trim();
  if (!code) return bad(res, 'Enter a promo code.');
  try {
    const amount = tx(() => {
      const promo = db.prepare('SELECT * FROM promo_codes WHERE code = ? AND active = 1').get(code);
      if (!promo) throw new Error('Invalid promo code.');
      if (promo.expires_at && promo.expires_at < Date.now()) throw new Error('This promo code has expired.');
      if (promo.max_uses > 0 && promo.uses >= promo.max_uses) throw new Error('This promo code has been fully redeemed.');
      if (db.prepare('SELECT 1 FROM promo_redemptions WHERE code = ? AND user_id = ?').get(promo.code, req.user.id)) {
        throw new Error('You already redeemed this code.');
      }
      db.prepare('INSERT INTO promo_redemptions (code, user_id, created_at) VALUES (?, ?, ?)').run(promo.code, req.user.id, Date.now());
      db.prepare('UPDATE promo_codes SET uses = uses + 1 WHERE code = ?').run(promo.code);
      credit(req.user.id, promo.reward, 'promo', `Promo code ${promo.code.toUpperCase()}`);
      return promo.reward;
    });
    res.json({ amount, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  } catch (err) {
    bad(res, err.message);
  }
});

/* --------------------------------------------------------------- cashout */

router.get('/reward-methods', (_req, res) => {
  res.json({ methods: db.prepare('SELECT * FROM reward_methods WHERE active = 1 ORDER BY sort, id').all() });
});

router.post('/withdraw', requireUser, actionLimiter, (req, res) => {
  const method = db.prepare('SELECT * FROM reward_methods WHERE id = ? AND active = 1').get(Number(req.body.method_id));
  if (!method) return bad(res, 'Choose a valid reward method.');
  const coins = Math.floor(Number(req.body.coins));
  const destination = String(req.body.destination || '').trim();
  const globalMin = Number(getSetting('min_withdraw')) || 0;
  const min = Math.max(globalMin, method.min_coins);
  if (!Number.isFinite(coins) || coins < min) return bad(res, `Minimum cashout for ${method.name} is ${min.toLocaleString()} gems.`);
  if (coins > 10_000_000) return bad(res, 'Amount too large.');
  if (!destination || destination.length > 200) return bad(res, `Enter your ${method.field_label}.`);
  const perUsd = Number(getSetting('coins_per_usd')) || 1000;

  try {
    tx(() => {
      const fresh = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id);
      if (fresh.balance < coins) throw new Error('Insufficient balance.');
      credit(req.user.id, -coins, 'withdraw', `Cashout via ${method.name}`);
      db.prepare(`INSERT INTO withdrawals (user_id, method_id, method_name, coins, usd, destination, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.user.id, method.id, method.name, coins, Math.round((coins / perUsd) * 100) / 100, destination, Date.now());
    });
  } catch (err) {
    return bad(res, err.message);
  }
  res.json({ ok: true, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

/* ---------------------------------------------------------------- history */

router.get('/me/history', requireUser, (req, res) => {
  const id = req.user.id;
  res.json({
    transactions: db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(id),
    completions: db.prepare('SELECT * FROM offer_completions WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(id),
    withdrawals: db.prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(id),
  });
});

router.get('/me/referrals', requireUser, (req, res) => {
  const referrals = db.prepare(`SELECT u.username, u.created_at,
      COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.user_id = u.id AND t.type = 'offer'), 0) AS earned
    FROM users u WHERE u.referred_by = ? ORDER BY u.id DESC LIMIT 200`).all(req.user.id);
  const commission = db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM transactions WHERE user_id = ? AND type = 'referral'").get(req.user.id).n;
  res.json({ referrals, commission, code: req.user.referral_code });
});

/* ---------------------------------------------------------- social proof */

router.get('/feed', (_req, res) => {
  const rows = db.prepare(`SELECT c.id, c.offer_title, c.provider, c.reward, c.updated_at AS at, u.username, u.avatar_color
    FROM offer_completions c JOIN users u ON u.id = c.user_id
    WHERE c.status = 'completed' ORDER BY c.updated_at DESC LIMIT 25`).all();
  res.json({ feed: rows.map((r) => ({ ...r, username: maskName(r.username) })) });
});

router.get('/leaderboard', (req, res) => {
  const period = req.query.period === 'monthly' ? 30 : req.query.period === 'all' ? 36500 : 7;
  const rows = db.prepare(`SELECT u.username, u.avatar_color, SUM(t.amount) AS earned
    FROM transactions t JOIN users u ON u.id = t.user_id
    WHERE t.amount > 0 AND t.type IN ('offer','referral') AND t.created_at > ? AND u.banned = 0
    GROUP BY u.id ORDER BY earned DESC LIMIT 25`).all(Date.now() - period * DAY_MS);
  res.json({ leaderboard: rows });
});

module.exports = router;
