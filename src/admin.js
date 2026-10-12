'use strict';

const express = require('express');
const { db, credit, getSettings, setSetting } = require('./db');
const { requireAdmin, hashPassword } = require('./auth');
const { approveCompletion, rejectCompletion } = require('./rewards');

const router = express.Router();
router.use(requireAdmin);

const DAY_MS = 24 * 60 * 60 * 1000;
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const int = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' || v === 'on' ? 1 : 0);
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const isUnique = (err) => /unique|duplicate|constraint/i.test(err.message);

/* -------------------------------------------------------------- overview */

router.get('/overview', async (_req, res) => {
  const one = async (sql, ...p) => (await db.get(sql, ...p)).n;
  const now = Date.now();
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const start = new Date(now - i * DAY_MS);
    start.setHours(0, 0, 0, 0);
    days.push(start.getTime());
  }
  const signups = await Promise.all(days.map(async (d) => ({
    day: d, n: await one('SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?', d, d + DAY_MS),
  })));
  const earnings = await Promise.all(days.map(async (d) => ({
    day: d, n: await one("SELECT COALESCE(SUM(amount),0) AS n FROM transactions WHERE type = 'offer' AND created_at >= ? AND created_at < ?", d, d + DAY_MS),
  })));
  res.json({
    users: await one('SELECT COUNT(*) AS n FROM users'),
    users_today: await one('SELECT COUNT(*) AS n FROM users WHERE created_at > ?', now - DAY_MS),
    total_balance: await one('SELECT COALESCE(SUM(balance),0) AS n FROM users'),
    offers_completed: await one("SELECT COUNT(*) AS n FROM offer_completions WHERE status = 'completed'"),
    pending_completions: await one("SELECT COUNT(*) AS n FROM offer_completions WHERE status = 'pending'"),
    pending_withdrawals: await one("SELECT COUNT(*) AS n FROM withdrawals WHERE status = 'pending'"),
    pending_withdrawals_usd: await one("SELECT COALESCE(SUM(usd),0) AS n FROM withdrawals WHERE status = 'pending'"),
    paid_usd: await one("SELECT COALESCE(SUM(usd),0) AS n FROM withdrawals WHERE status IN ('approved','paid')"),
    active_offers: await one('SELECT COUNT(*) AS n FROM offers WHERE active = 1'),
    signups,
    earnings,
    recent_users: await db.all('SELECT id, username, email, balance, created_at FROM users ORDER BY id DESC LIMIT 6'),
  });
});

/* ----------------------------------------------------------------- users */

router.get('/users', async (req, res) => {
  const raw = str(req.query.q, 100);
  const q = `%${raw.toLowerCase()}%`;
  const users = await db.all(`SELECT u.id, u.username, u.email, u.balance, u.total_earned, u.role, u.banned, u.is_demo,
      u.referral_code, u.created_at, u.last_login_at, r.username AS referred_by_name,
      (SELECT COUNT(*) FROM users x WHERE x.referred_by = u.id) AS referrals
    FROM users u LEFT JOIN users r ON r.id = u.referred_by
    WHERE lower(u.username) LIKE ? OR lower(u.email) LIKE ? OR CAST(u.id AS TEXT) = ?
    ORDER BY u.id DESC LIMIT 200`, q, q, raw);
  res.json({ users });
});

router.get('/users/:id', async (req, res) => {
  const id = int(req.params.id);
  const user = await db.get('SELECT id, username, email, balance, total_earned, role, banned, referral_code, created_at, last_login_at FROM users WHERE id = ?', id);
  if (!user) return bad(res, 'User not found.', 404);
  res.json({
    user,
    transactions: await db.all('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 50', id),
    withdrawals: await db.all('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 50', id),
  });
});

router.post('/users/:id/balance', async (req, res) => {
  const id = int(req.params.id);
  const amount = int(req.body.amount);
  if (!amount) return bad(res, 'Enter a non-zero amount.');
  if (Math.abs(amount) > 100_000_000) return bad(res, 'Amount too large.');
  if (!(await db.get('SELECT 1 AS x FROM users WHERE id = ?', id))) return bad(res, 'User not found.', 404);
  await db.tx((t) => credit(t, id, amount, 'admin', str(req.body.reason, 200) || `Adjusted by ${req.user.username}`));
  res.json({ ok: true });
});

router.patch('/users/:id', async (req, res) => {
  const id = int(req.params.id);
  const body = req.body || {};
  if (!(await db.get('SELECT 1 AS x FROM users WHERE id = ?', id))) return bad(res, 'User not found.', 404);
  if (id === req.user.id && (body.banned || body.role === 'user')) return bad(res, "You can't ban or demote yourself.");
  if (body.password && String(body.password).length < 8) return bad(res, 'Password must be at least 8 characters.');
  if ('banned' in body) {
    await db.run('UPDATE users SET banned = ? WHERE id = ?', bool(body.banned), id);
    if (bool(body.banned)) await db.run('DELETE FROM sessions WHERE user_id = ?', id);
  }
  if (body.role === 'admin' || body.role === 'user') await db.run('UPDATE users SET role = ? WHERE id = ?', body.role, id);
  if (body.password) {
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(String(body.password)), id);
    await db.run('DELETE FROM sessions WHERE user_id = ?', id);
  }
  res.json({ ok: true });
});

router.delete('/users/:id', async (req, res) => {
  const id = int(req.params.id);
  if (id === req.user.id) return bad(res, "You can't delete yourself.");
  await db.run('DELETE FROM users WHERE id = ?', id);
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
    reward: Math.min(100_000_000, Math.max(1, int(b.reward, 100))),
    icon: str(b.icon, 200) || 'fa-gamepad',
    color: /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : '#7c5cff',
    device: ['all', 'android', 'ios', 'desktop'].includes(b.device) ? b.device : 'all',
    est_minutes: Math.min(1_000_000, Math.max(1, int(b.est_minutes, 10))),
    url: str(b.url, 500),
    featured: bool(b.featured),
    repeatable: bool(b.repeatable),
    active: 'active' in b ? bool(b.active) : 1,
  };
}

router.get('/offers', async (_req, res) => {
  res.json({
    offers: await db.all('SELECT o.*, w.name AS provider FROM offers o LEFT JOIN offerwalls w ON w.id = o.offerwall_id ORDER BY o.id DESC'),
  });
});

router.post('/offers', async (req, res) => {
  const f = offerFields(req.body);
  if (!f.title) return bad(res, 'Title is required.');
  const row = await db.get(`INSERT INTO offers (title, description, requirements, offerwall_id, category, reward, icon, color, device, est_minutes, url, featured, repeatable, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  f.title, f.description, f.requirements, f.offerwall_id, f.category, f.reward, f.icon, f.color, f.device, f.est_minutes, f.url, f.featured, f.repeatable, f.active, Date.now());
  res.json({ id: row.id });
});

router.put('/offers/:id', async (req, res) => {
  const f = offerFields(req.body);
  if (!f.title) return bad(res, 'Title is required.');
  await db.run(`UPDATE offers SET title=?, description=?, requirements=?, offerwall_id=?, category=?, reward=?, icon=?, color=?, device=?, est_minutes=?, url=?, featured=?, repeatable=?, active=? WHERE id=?`,
    f.title, f.description, f.requirements, f.offerwall_id, f.category, f.reward, f.icon, f.color, f.device, f.est_minutes, f.url, f.featured, f.repeatable, f.active, int(req.params.id));
  res.json({ ok: true });
});

router.delete('/offers/:id', async (req, res) => {
  await db.run('DELETE FROM offers WHERE id = ?', int(req.params.id));
  res.json({ ok: true });
});

function wallFields(b) {
  const name = str(b.name, 60);
  return {
    name,
    slug: (str(b.slug, 60) || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    tagline: str(b.tagline, 120),
    color: /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : '#7c5cff',
    icon: str(b.icon, 200) || 'fa-layer-group',
    bonus_percent: Math.min(1000, Math.max(0, int(b.bonus_percent))),
    active: 'active' in b ? bool(b.active) : 1,
    sort: int(b.sort),
  };
}

router.get('/offerwalls', async (_req, res) => {
  res.json({ offerwalls: await db.all('SELECT * FROM offerwalls ORDER BY sort, id') });
});

router.post('/offerwalls', async (req, res) => {
  const f = wallFields(req.body);
  if (!f.name || !f.slug) return bad(res, 'Name is required.');
  try {
    const row = await db.get('INSERT INTO offerwalls (name, slug, tagline, color, icon, bonus_percent, active, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      f.name, f.slug, f.tagline, f.color, f.icon, f.bonus_percent, f.active, f.sort);
    res.json({ id: row.id });
  } catch (err) {
    if (!isUnique(err)) throw err;
    bad(res, 'An offerwall with that slug already exists.');
  }
});

router.put('/offerwalls/:id', async (req, res) => {
  const f = wallFields(req.body);
  if (!f.name || !f.slug) return bad(res, 'Name is required.');
  try {
    await db.run('UPDATE offerwalls SET name=?, slug=?, tagline=?, color=?, icon=?, bonus_percent=?, active=?, sort=? WHERE id=?',
      f.name, f.slug, f.tagline, f.color, f.icon, f.bonus_percent, f.active, f.sort, int(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    if (!isUnique(err)) throw err;
    bad(res, 'An offerwall with that slug already exists.');
  }
});

router.delete('/offerwalls/:id', async (req, res) => {
  await db.run('DELETE FROM offerwalls WHERE id = ?', int(req.params.id));
  res.json({ ok: true });
});

/* ------------------------------------------------------------ completions */

router.get('/completions', async (req, res) => {
  const status = ['pending', 'completed', 'rejected'].includes(req.query.status) ? req.query.status : null;
  res.json({
    completions: await db.all(`SELECT c.*, u.username FROM offer_completions c JOIN users u ON u.id = c.user_id
      ${status ? 'WHERE c.status = ?' : ''} ORDER BY c.id DESC LIMIT 300`, ...(status ? [status] : [])),
  });
});

router.post('/completions/:id/approve', async (req, res) => {
  try { await approveCompletion(int(req.params.id)); res.json({ ok: true }); } catch (e) { bad(res, e.message); }
});

router.post('/completions/:id/reject', async (req, res) => {
  try { await rejectCompletion(int(req.params.id), str(req.body.note, 200)); res.json({ ok: true }); } catch (e) { bad(res, e.message); }
});

/* ------------------------------------------------------------ withdrawals */

router.get('/withdrawals', async (req, res) => {
  const status = ['pending', 'paid', 'rejected'].includes(req.query.status) ? req.query.status : null;
  res.json({
    withdrawals: await db.all(`SELECT w.*, u.username, u.email FROM withdrawals w JOIN users u ON u.id = w.user_id
      ${status ? 'WHERE w.status = ?' : ''} ORDER BY w.id DESC LIMIT 300`, ...(status ? [status] : [])),
  });
});

router.post('/withdrawals/:id/:action', async (req, res) => {
  const { action } = req.params;
  if (!['pay', 'reject'].includes(action)) return bad(res, 'Unknown action.', 404);
  const result = await db.tx(async (t) => {
    const w = await t.get('SELECT * FROM withdrawals WHERE id = ?', int(req.params.id));
    if (!w) return 'Withdrawal not found.';
    const status = action === 'pay' ? 'paid' : 'rejected';
    const r = await t.run("UPDATE withdrawals SET status = ?, admin_note = ?, processed_at = ? WHERE id = ? AND status = 'pending'",
      status, str(req.body.note, 300), Date.now(), w.id);
    if (r.changes !== 1) return 'Withdrawal already processed.';
    if (status === 'rejected') await credit(t, w.user_id, w.coins, 'refund', `Refund: ${w.method_name} cashout #${w.id}`);
    return null;
  });
  if (result) return bad(res, result);
  res.json({ ok: true });
});

/* -------------------------------------------------------- reward methods */

function methodFields(b) {
  return {
    name: str(b.name, 60),
    category: ['crypto', 'prepaid', 'giftcard'].includes(b.category) ? b.category : 'crypto',
    icon: str(b.icon, 200) || 'fa-money-bill',
    color: /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : '#22c55e',
    field_label: str(b.field_label, 60) || 'Email',
    min_coins: Math.min(100_000_000, Math.max(1, int(b.min_coins, 1000))),
    active: 'active' in b ? bool(b.active) : 1,
    sort: int(b.sort),
  };
}

router.get('/reward-methods', async (_req, res) => {
  res.json({ methods: await db.all('SELECT * FROM reward_methods ORDER BY sort, id') });
});

router.post('/reward-methods', async (req, res) => {
  const f = methodFields(req.body);
  if (!f.name) return bad(res, 'Name is required.');
  const row = await db.get('INSERT INTO reward_methods (name, category, icon, color, field_label, min_coins, active, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
    f.name, f.category, f.icon, f.color, f.field_label, f.min_coins, f.active, f.sort);
  res.json({ id: row.id });
});

router.put('/reward-methods/:id', async (req, res) => {
  const f = methodFields(req.body);
  if (!f.name) return bad(res, 'Name is required.');
  await db.run('UPDATE reward_methods SET name=?, category=?, icon=?, color=?, field_label=?, min_coins=?, active=?, sort=? WHERE id=?',
    f.name, f.category, f.icon, f.color, f.field_label, f.min_coins, f.active, f.sort, int(req.params.id));
  res.json({ ok: true });
});

router.delete('/reward-methods/:id', async (req, res) => {
  await db.run('DELETE FROM reward_methods WHERE id = ?', int(req.params.id));
  res.json({ ok: true });
});

/* ----------------------------------------------------------- promo codes */

router.get('/promos', async (_req, res) => {
  res.json({ promos: await db.all('SELECT * FROM promo_codes ORDER BY created_at DESC') });
});

router.post('/promos', async (req, res) => {
  const code = str(req.body.code, 32).toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return bad(res, 'Code must be 3-32 letters, numbers, - or _.');
  const reward = int(req.body.reward);
  if (reward < 1 || reward > 1_000_000) return bad(res, 'Reward must be between $0.01 and $10,000.');
  const days = int(req.body.expires_days);
  const r = await db.run('INSERT INTO promo_codes (code, reward, max_uses, expires_at, active, created_at) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT (code) DO NOTHING',
    code, reward, Math.max(0, int(req.body.max_uses)), days > 0 ? Date.now() + days * DAY_MS : null, Date.now());
  if (r.changes !== 1) return bad(res, 'That code already exists.');
  res.json({ ok: true });
});

router.patch('/promos/:code', async (req, res) => {
  await db.run('UPDATE promo_codes SET active = ? WHERE code = ?', bool(req.body.active), req.params.code.toUpperCase());
  res.json({ ok: true });
});

router.delete('/promos/:code', async (req, res) => {
  await db.run('DELETE FROM promo_codes WHERE code = ?', req.params.code.toUpperCase());
  res.json({ ok: true });
});

/* ---------------------------------------------------------- transactions */

router.get('/transactions', async (_req, res) => {
  res.json({
    transactions: await db.all(`SELECT t.*, u.username FROM transactions t JOIN users u ON u.id = t.user_id
      ORDER BY t.id DESC LIMIT 300`),
  });
});

/* -------------------------------------------------------------- settings */

const EDITABLE = ['site_name', 'signup_bonus', 'daily_reward', 'referral_percent',
  'auto_approve_offers', 'announcement', 'maintenance', 'postback_secret'];
const NUMERIC = ['signup_bonus', 'daily_reward', 'referral_percent'];

router.get('/settings', async (_req, res) => res.json({ settings: await getSettings() }));

router.put('/settings', async (req, res) => {
  const updates = [];
  for (const key of EDITABLE) {
    if (!(key in req.body)) continue;
    let value = req.body[key];
    if (NUMERIC.includes(key)) {
      value = Math.min(key === 'referral_percent' ? 100 : 1_000_000, Math.max(0, int(value)));
    } else if (key === 'auto_approve_offers' || key === 'maintenance') {
      value = bool(value);
    } else {
      value = str(value, 500);
      if (key === 'postback_secret' && value.length < 12) return bad(res, 'Postback secret must be at least 12 characters.');
    }
    updates.push([key, value]);
  }
  for (const [k, v] of updates) await setSetting(k, v);
  res.json({ settings: await getSettings() });
});

module.exports = router;
