'use strict';

const express = require('express');
const { db, tx, credit, getSettings, setSetting } = require('./db');
const { requireAdmin, hashPassword } = require('./auth');
const { approveCompletion, rejectCompletion } = require('./rewards');

const router = express.Router();
router.use(requireAdmin);

const DAY_MS = 24 * 60 * 60 * 1000;
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const int = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' || v === 'on' ? 1 : 0);
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);

/* -------------------------------------------------------------- overview */

router.get('/overview', (_req, res) => {
  const one = (sql, ...p) => db.prepare(sql).get(...p).n;
  const now = Date.now();
  const signups = [];
  const earnings = [];
  for (let i = 13; i >= 0; i--) {
    const start = new Date(now - i * DAY_MS);
    start.setHours(0, 0, 0, 0);
    const end = start.getTime() + DAY_MS;
    signups.push({ day: start.getTime(), n: one('SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?', start.getTime(), end) });
    earnings.push({ day: start.getTime(), n: one("SELECT COALESCE(SUM(amount),0) AS n FROM transactions WHERE type = 'offer' AND created_at >= ? AND created_at < ?", start.getTime(), end) });
  }
  res.json({
    users: one('SELECT COUNT(*) AS n FROM users'),
    users_today: one('SELECT COUNT(*) AS n FROM users WHERE created_at > ?', now - DAY_MS),
    total_balance: one('SELECT COALESCE(SUM(balance),0) AS n FROM users'),
    offers_completed: one("SELECT COUNT(*) AS n FROM offer_completions WHERE status = 'completed'"),
    pending_completions: one("SELECT COUNT(*) AS n FROM offer_completions WHERE status = 'pending'"),
    pending_withdrawals: one("SELECT COUNT(*) AS n FROM withdrawals WHERE status = 'pending'"),
    pending_withdrawals_usd: one("SELECT COALESCE(SUM(usd),0) AS n FROM withdrawals WHERE status = 'pending'"),
    paid_usd: one("SELECT COALESCE(SUM(usd),0) AS n FROM withdrawals WHERE status IN ('approved','paid')"),
    active_offers: one('SELECT COUNT(*) AS n FROM offers WHERE active = 1'),
    signups,
    earnings,
    recent_users: db.prepare('SELECT id, username, email, balance, created_at FROM users ORDER BY id DESC LIMIT 6').all(),
  });
});

/* ----------------------------------------------------------------- users */

router.get('/users', (req, res) => {
  const q = `%${str(req.query.q, 100)}%`;
  const users = db.prepare(`SELECT u.id, u.username, u.email, u.balance, u.total_earned, u.role, u.banned, u.is_demo,
      u.referral_code, u.created_at, u.last_login_at, r.username AS referred_by_name,
      (SELECT COUNT(*) FROM users x WHERE x.referred_by = u.id) AS referrals
    FROM users u LEFT JOIN users r ON r.id = u.referred_by
    WHERE u.username LIKE ? OR u.email LIKE ? OR CAST(u.id AS TEXT) = ?
    ORDER BY u.id DESC LIMIT 200`).all(q, q, str(req.query.q, 100));
  res.json({ users });
});

router.get('/users/:id', (req, res) => {
  const id = int(req.params.id);
  const user = db.prepare('SELECT id, username, email, balance, total_earned, role, banned, referral_code, created_at, last_login_at FROM users WHERE id = ?').get(id);
  if (!user) return bad(res, 'User not found.', 404);
  res.json({
    user,
    transactions: db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(id),
    withdrawals: db.prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(id),
  });
});

router.post('/users/:id/balance', (req, res) => {
  const id = int(req.params.id);
  const amount = int(req.body.amount);
  if (!amount) return bad(res, 'Enter a non-zero amount.');
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return bad(res, 'User not found.', 404);
  tx(() => credit(id, amount, 'admin', str(req.body.reason, 200) || `Adjusted by ${req.user.username}`));
  res.json({ ok: true });
});

router.patch('/users/:id', (req, res) => {
  const id = int(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return bad(res, 'User not found.', 404);
  if (id === req.user.id && (req.body.banned || req.body.role === 'user')) return bad(res, "You can't ban or demote yourself.");
  if ('banned' in req.body) {
    db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(bool(req.body.banned), id);
    if (bool(req.body.banned)) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  if (req.body.role === 'admin' || req.body.role === 'user') db.prepare('UPDATE users SET role = ? WHERE id = ?').run(req.body.role, id);
  if (req.body.password) {
    if (String(req.body.password).length < 8) return bad(res, 'Password must be at least 8 characters.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(req.body.password)), id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  res.json({ ok: true });
});

router.delete('/users/:id', (req, res) => {
  const id = int(req.params.id);
  if (id === req.user.id) return bad(res, "You can't delete yourself.");
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

/* ---------------------------------------------------- offers & offerwalls */

function offerFields(b) {
  return {
    title: str(b.title, 120),
    description: str(b.description, 1000),
    requirements: str(b.requirements, 1000),
    offerwall_id: b.offerwall_id ? int(b.offerwall_id) : null,
    category: ['game', 'app', 'survey', 'signup', 'shopping', 'video'].includes(b.category) ? b.category : 'game',
    reward: Math.max(1, int(b.reward, 100)),
    icon: str(b.icon, 8) || '🎮',
    color: /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : '#7c5cff',
    device: ['all', 'android', 'ios', 'desktop'].includes(b.device) ? b.device : 'all',
    est_minutes: Math.max(1, int(b.est_minutes, 10)),
    url: str(b.url, 500),
    featured: bool(b.featured),
    repeatable: bool(b.repeatable),
    active: 'active' in b ? bool(b.active) : 1,
  };
}

router.get('/offers', (_req, res) => {
  res.json({
    offers: db.prepare('SELECT o.*, w.name AS provider FROM offers o LEFT JOIN offerwalls w ON w.id = o.offerwall_id ORDER BY o.id DESC').all(),
  });
});

router.post('/offers', (req, res) => {
  const f = offerFields(req.body);
  if (!f.title) return bad(res, 'Title is required.');
  const info = db.prepare(`INSERT INTO offers (title, description, requirements, offerwall_id, category, reward, icon, color, device, est_minutes, url, featured, repeatable, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    f.title, f.description, f.requirements, f.offerwall_id, f.category, f.reward, f.icon, f.color, f.device, f.est_minutes, f.url, f.featured, f.repeatable, f.active, Date.now());
  res.json({ id: Number(info.lastInsertRowid) });
});

router.put('/offers/:id', (req, res) => {
  const f = offerFields(req.body);
  if (!f.title) return bad(res, 'Title is required.');
  db.prepare(`UPDATE offers SET title=?, description=?, requirements=?, offerwall_id=?, category=?, reward=?, icon=?, color=?, device=?, est_minutes=?, url=?, featured=?, repeatable=?, active=? WHERE id=?`)
    .run(f.title, f.description, f.requirements, f.offerwall_id, f.category, f.reward, f.icon, f.color, f.device, f.est_minutes, f.url, f.featured, f.repeatable, f.active, int(req.params.id));
  res.json({ ok: true });
});

router.delete('/offers/:id', (req, res) => {
  db.prepare('DELETE FROM offers WHERE id = ?').run(int(req.params.id));
  res.json({ ok: true });
});

function wallFields(b) {
  const name = str(b.name, 60);
  return {
    name,
    slug: (str(b.slug, 60) || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    tagline: str(b.tagline, 120),
    color: /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : '#7c5cff',
    icon: str(b.icon, 8) || '💎',
    bonus_percent: Math.max(0, int(b.bonus_percent)),
    active: 'active' in b ? bool(b.active) : 1,
    sort: int(b.sort),
  };
}

router.get('/offerwalls', (_req, res) => {
  res.json({ offerwalls: db.prepare('SELECT * FROM offerwalls ORDER BY sort, id').all() });
});

router.post('/offerwalls', (req, res) => {
  const f = wallFields(req.body);
  if (!f.name || !f.slug) return bad(res, 'Name is required.');
  try {
    const info = db.prepare('INSERT INTO offerwalls (name, slug, tagline, color, icon, bonus_percent, active, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(f.name, f.slug, f.tagline, f.color, f.icon, f.bonus_percent, f.active, f.sort);
    res.json({ id: Number(info.lastInsertRowid) });
  } catch {
    bad(res, 'An offerwall with that slug already exists.');
  }
});

router.put('/offerwalls/:id', (req, res) => {
  const f = wallFields(req.body);
  if (!f.name || !f.slug) return bad(res, 'Name is required.');
  try {
    db.prepare('UPDATE offerwalls SET name=?, slug=?, tagline=?, color=?, icon=?, bonus_percent=?, active=?, sort=? WHERE id=?')
      .run(f.name, f.slug, f.tagline, f.color, f.icon, f.bonus_percent, f.active, f.sort, int(req.params.id));
    res.json({ ok: true });
  } catch {
    bad(res, 'An offerwall with that slug already exists.');
  }
});

router.delete('/offerwalls/:id', (req, res) => {
  db.prepare('DELETE FROM offerwalls WHERE id = ?').run(int(req.params.id));
  res.json({ ok: true });
});

/* ------------------------------------------------------------ completions */

router.get('/completions', (req, res) => {
  const status = ['pending', 'completed', 'rejected'].includes(req.query.status) ? req.query.status : null;
  res.json({
    completions: db.prepare(`SELECT c.*, u.username FROM offer_completions c JOIN users u ON u.id = c.user_id
      ${status ? 'WHERE c.status = ?' : ''} ORDER BY c.id DESC LIMIT 300`).all(...(status ? [status] : [])),
  });
});

router.post('/completions/:id/approve', (req, res) => {
  try { approveCompletion(int(req.params.id)); res.json({ ok: true }); } catch (e) { bad(res, e.message); }
});

router.post('/completions/:id/reject', (req, res) => {
  try { rejectCompletion(int(req.params.id), str(req.body.note, 200)); res.json({ ok: true }); } catch (e) { bad(res, e.message); }
});

/* ------------------------------------------------------------ withdrawals */

router.get('/withdrawals', (req, res) => {
  const status = ['pending', 'paid', 'rejected'].includes(req.query.status) ? req.query.status : null;
  res.json({
    withdrawals: db.prepare(`SELECT w.*, u.username, u.email FROM withdrawals w JOIN users u ON u.id = w.user_id
      ${status ? 'WHERE w.status = ?' : ''} ORDER BY w.id DESC LIMIT 300`).all(...(status ? [status] : [])),
  });
});

router.post('/withdrawals/:id/:action', (req, res) => {
  const { action } = req.params;
  if (!['pay', 'reject'].includes(action)) return bad(res, 'Unknown action.', 404);
  try {
    tx(() => {
      const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(int(req.params.id));
      if (!w) throw new Error('Withdrawal not found.');
      if (w.status !== 'pending') throw new Error('Withdrawal already processed.');
      const status = action === 'pay' ? 'paid' : 'rejected';
      db.prepare('UPDATE withdrawals SET status = ?, admin_note = ?, processed_at = ? WHERE id = ?')
        .run(status, str(req.body.note, 300), Date.now(), w.id);
      if (status === 'rejected') credit(w.user_id, w.coins, 'refund', `Refund: ${w.method_name} cashout #${w.id}`);
    });
    res.json({ ok: true });
  } catch (e) {
    bad(res, e.message);
  }
});

/* -------------------------------------------------------- reward methods */

function methodFields(b) {
  return {
    name: str(b.name, 60),
    category: ['cash', 'crypto', 'giftcard', 'gaming'].includes(b.category) ? b.category : 'cash',
    icon: str(b.icon, 8) || '💵',
    color: /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : '#22c55e',
    field_label: str(b.field_label, 60) || 'Email',
    min_coins: Math.max(1, int(b.min_coins, 1000)),
    active: 'active' in b ? bool(b.active) : 1,
    sort: int(b.sort),
  };
}

router.get('/reward-methods', (_req, res) => {
  res.json({ methods: db.prepare('SELECT * FROM reward_methods ORDER BY sort, id').all() });
});

router.post('/reward-methods', (req, res) => {
  const f = methodFields(req.body);
  if (!f.name) return bad(res, 'Name is required.');
  const info = db.prepare('INSERT INTO reward_methods (name, category, icon, color, field_label, min_coins, active, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(f.name, f.category, f.icon, f.color, f.field_label, f.min_coins, f.active, f.sort);
  res.json({ id: Number(info.lastInsertRowid) });
});

router.put('/reward-methods/:id', (req, res) => {
  const f = methodFields(req.body);
  if (!f.name) return bad(res, 'Name is required.');
  db.prepare('UPDATE reward_methods SET name=?, category=?, icon=?, color=?, field_label=?, min_coins=?, active=?, sort=? WHERE id=?')
    .run(f.name, f.category, f.icon, f.color, f.field_label, f.min_coins, f.active, f.sort, int(req.params.id));
  res.json({ ok: true });
});

router.delete('/reward-methods/:id', (req, res) => {
  db.prepare('DELETE FROM reward_methods WHERE id = ?').run(int(req.params.id));
  res.json({ ok: true });
});

/* ----------------------------------------------------------- promo codes */

router.get('/promos', (_req, res) => {
  res.json({ promos: db.prepare('SELECT * FROM promo_codes ORDER BY created_at DESC').all() });
});

router.post('/promos', (req, res) => {
  const code = str(req.body.code, 32).toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return bad(res, 'Code must be 3-32 letters, numbers, - or _.');
  const reward = int(req.body.reward);
  if (reward < 1) return bad(res, 'Reward must be at least 1.');
  const days = int(req.body.expires_days);
  try {
    db.prepare('INSERT INTO promo_codes (code, reward, max_uses, expires_at, active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
      .run(code, reward, Math.max(0, int(req.body.max_uses)), days > 0 ? Date.now() + days * DAY_MS : null, Date.now());
    res.json({ ok: true });
  } catch {
    bad(res, 'That code already exists.');
  }
});

router.patch('/promos/:code', (req, res) => {
  db.prepare('UPDATE promo_codes SET active = ? WHERE code = ?').run(bool(req.body.active), req.params.code);
  res.json({ ok: true });
});

router.delete('/promos/:code', (req, res) => {
  db.prepare('DELETE FROM promo_codes WHERE code = ?').run(req.params.code);
  res.json({ ok: true });
});

/* ---------------------------------------------------------- transactions */

router.get('/transactions', (_req, res) => {
  res.json({
    transactions: db.prepare(`SELECT t.*, u.username FROM transactions t JOIN users u ON u.id = t.user_id
      ORDER BY t.id DESC LIMIT 300`).all(),
  });
});

/* -------------------------------------------------------------- settings */

const EDITABLE = ['site_name', 'currency_name', 'coins_per_usd', 'signup_bonus', 'daily_reward', 'referral_percent',
  'min_withdraw', 'auto_approve_offers', 'announcement', 'maintenance', 'postback_secret'];
const NUMERIC = ['coins_per_usd', 'signup_bonus', 'daily_reward', 'referral_percent', 'min_withdraw'];

router.get('/settings', (_req, res) => res.json({ settings: getSettings() }));

router.put('/settings', (req, res) => {
  for (const key of EDITABLE) {
    if (!(key in req.body)) continue;
    let value = req.body[key];
    if (NUMERIC.includes(key)) {
      value = Math.max(0, int(value));
      if (key === 'coins_per_usd' && value < 1) return bad(res, 'Gems per $1 must be at least 1.');
    } else if (key === 'auto_approve_offers' || key === 'maintenance') {
      value = bool(value);
    } else {
      value = str(value, 500);
      if (key === 'postback_secret' && value.length < 12) return bad(res, 'Postback secret must be at least 12 characters.');
    }
    setSetting(key, value);
  }
  res.json({ settings: getSettings() });
});

module.exports = router;
