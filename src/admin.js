'use strict';

const express = require('express');
const { db, credit, getSettings, setSetting } = require('./db');
const { requireAdmin, hashPassword, passwordProblem, destroyOtherSessions, createResetToken, RESET_TTL_MS } = require('./auth');
const { approveCompletion, rejectCompletion } = require('./rewards');
const { PRESETS, SIG_METHODS, newToken, processPostback, buildTestPostback } = require('./offerwalls');
const { GAMES } = require('./games/logic');

const router = express.Router();
router.use(requireAdmin);

/* ------------------------------------------------------------ audit log */

const SECRET_FIELDS = /password|secret|token/i;
const AUDIT_LABELS = [
  [/^POST \/users\/\d+\/balance$/, 'Adjusted balance'],
  [/^POST \/users\/\d+\/reset-link$/, 'Created password reset link'],
  [/^POST \/users\/\d+\/logout$/, 'Signed user out everywhere'],
  [/^PATCH \/users\/\d+$/, 'Updated user'],
  [/^DELETE \/users\/\d+$/, 'Deleted user'],
  [/^POST \/offerwalls$/, 'Added offerwall'],
  [/^PUT \/offerwalls\/\d+$/, 'Updated offerwall'],
  [/^DELETE \/offerwalls\/\d+$/, 'Deleted offerwall'],
  [/^POST \/offerwalls\/\d+\/token$/, 'Regenerated postback URL'],
  [/^POST \/offerwalls\/\d+\/test$/, 'Sent test postback'],
  [/^POST \/completions\/\d+\/approve$/, 'Released conversion'],
  [/^POST \/completions\/\d+\/reject$/, 'Rejected conversion'],
  [/^POST \/withdrawals\/\d+\/pay$/, 'Marked cashout paid'],
  [/^POST \/withdrawals\/\d+\/reject$/, 'Rejected cashout'],
  [/^(POST|PUT|DELETE) \/reward-methods/, 'Changed payout methods'],
  [/^(POST|PATCH|DELETE) \/promos/, 'Changed promo codes'],
  [/^PUT \/settings$/, 'Changed settings'],
];

/** Every successful admin change is recorded, with secrets stripped from the details. */
router.use((req, res, next) => {
  if (req.method === 'GET') return next();
  const sig = `${req.method} ${req.path}`;
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    const label = (AUDIT_LABELS.find(([re]) => re.test(sig)) || [null, sig])[1];
    const details = {};
    for (const [k, v] of Object.entries(req.body || {})) details[k] = SECRET_FIELDS.test(k) ? '[hidden]' : String(v).slice(0, 120);
    db.run('INSERT INTO audit_log (admin_id, action, target, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      req.user.id, label, req.path.slice(0, 120), JSON.stringify(details).slice(0, 2000), String(req.ip || '').slice(0, 64), Date.now())
      .catch((err) => console.error('audit log failed', err.message));
  });
  next();
});

/* ----------------------------------------------------------------- games */

router.get('/games', async (req, res) => {
  const now = Date.now();
  const sums = async (since) => db.get(`SELECT COUNT(*) AS bets, COALESCE(SUM(amount), 0) AS wagered, COALESCE(SUM(payout), 0) AS paid
    FROM bets WHERE status = 'settled' AND settled_at > ?`, since);
  const [today, week, all] = await Promise.all([sums(now - DAY_MS), sums(now - 7 * DAY_MS), sums(0)]);
  const byGame = await db.all(`SELECT game, COUNT(*) AS bets, COALESCE(SUM(amount), 0) AS wagered, COALESCE(SUM(payout), 0) AS paid
    FROM bets WHERE status = 'settled' GROUP BY game ORDER BY wagered DESC`);
  const user = int(req.query.user);
  const bets = await db.all(`SELECT b.id, b.game, b.amount, b.payout, b.multiplier, b.status, b.nonce, b.created_at, b.settled_at, u.username
    FROM bets b JOIN users u ON u.id = b.user_id ${user ? 'WHERE b.user_id = ?' : ''} ORDER BY b.id DESC LIMIT 200`, ...(user ? [user] : []));
  const open = await db.get("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM bets WHERE status = 'active'");
  const named = (r) => ({ ...r, name: GAMES[r.game] ? GAMES[r.game].name : r.game });
  res.json({ today, week, all, byGame: byGame.map(named), bets: bets.map(named), open });
});

router.get('/audit', async (_req, res) => {
  res.json({
    entries: await db.all(`SELECT a.*, u.username AS admin_name FROM audit_log a LEFT JOIN users u ON u.id = a.admin_id
      ORDER BY a.id DESC LIMIT 300`),
  });
});

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
    active_walls: await one('SELECT COUNT(*) AS n FROM offerwalls WHERE active = 1'),
    revenue_cents: await one("SELECT COALESCE(SUM(payout_cents),0) AS n FROM offer_completions WHERE status = 'completed'"),
    paid_to_users_cents: await one("SELECT COALESCE(SUM(reward),0) AS n FROM offer_completions WHERE status = 'completed'"),
    held_cents: await one("SELECT COALESCE(SUM(reward),0) AS n FROM offer_completions WHERE status = 'pending'"),
    postbacks_today: await one('SELECT COUNT(*) AS n FROM postback_logs WHERE created_at > ?', now - DAY_MS),
    rejected_today: await one("SELECT COUNT(*) AS n FROM postback_logs WHERE result = 'rejected' AND created_at > ?", now - DAY_MS),
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
  const user = await db.get(`SELECT id, username, email, balance, total_earned, role, banned, referral_code, created_at, last_login_at,
      signup_ip, last_ip, locked_until, password_changed_at FROM users WHERE id = ?`, id);
  if (!user) return bad(res, 'User not found.', 404);
  const ips = [...new Set([user.signup_ip, user.last_ip].filter(Boolean))];
  const sameIp = ips.length ? await db.all(`SELECT id, username, banned FROM users
    WHERE id != ? AND (signup_ip IN (${ips.map(() => '?').join(',')}) OR last_ip IN (${ips.map(() => '?').join(',')})) LIMIT 20`, id, ...ips, ...ips) : [];
  res.json({
    user,
    same_ip: sameIp,
    sessions: (await db.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?', id, Date.now())).n,
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

/** A one-hour reset link the admin can send the user themselves (handy when email isn't set up). */
router.post('/users/:id/reset-link', async (req, res) => {
  const user = await db.get('SELECT id FROM users WHERE id = ?', int(req.params.id));
  if (!user) return bad(res, 'User not found.', 404);
  const token = await createResetToken(user.id, req.ip);
  const base = (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  res.json({ url: `${base}/#/reset/${token}`, expires_in_minutes: RESET_TTL_MS / 60000 });
});

router.post('/users/:id/logout', async (req, res) => {
  await destroyOtherSessions(int(req.params.id));
  res.json({ ok: true });
});

router.patch('/users/:id', async (req, res) => {
  const id = int(req.params.id);
  const body = req.body || {};
  if (!(await db.get('SELECT 1 AS x FROM users WHERE id = ?', id))) return bad(res, 'User not found.', 404);
  if (id === req.user.id && (body.banned || body.role === 'user')) return bad(res, "You can't ban or demote yourself.");
  if (body.password && passwordProblem(String(body.password))) return bad(res, passwordProblem(String(body.password)));
  if ('banned' in body) {
    await db.run('UPDATE users SET banned = ? WHERE id = ?', bool(body.banned), id);
    if (bool(body.banned)) await db.run('DELETE FROM sessions WHERE user_id = ?', id);
  }
  if (body.role === 'admin' || body.role === 'user') await db.run('UPDATE users SET role = ? WHERE id = ?', body.role, id);
  if (body.password) {
    await db.run('UPDATE users SET password_hash = ?, password_changed_at = ?, failed_logins = 0, locked_until = NULL WHERE id = ?',
      hashPassword(String(body.password)), Date.now(), id);
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

/* ------------------------------------------------------------ offerwalls */

const COLOR = /^#[0-9a-fA-F]{6}$/;
const PARAM = (v, d) => (/^[A-Za-z0-9_.\-[\]]{1,40}$/.test(String(v || '')) ? String(v) : d);

function wallFields(b) {
  const name = str(b.name, 60);
  return {
    name,
    slug: (str(b.slug, 60) || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    tagline: str(b.tagline, 120),
    color: COLOR.test(b.color) ? b.color : '#eac837',
    icon: str(b.icon, 200) || 'fa-layer-group',
    bonus_percent: Math.min(1000, Math.max(0, int(b.bonus_percent))),
    active: 'active' in b ? bool(b.active) : 1,
    sort: int(b.sort),
    preset: PRESETS[b.preset] ? b.preset : 'custom',
    iframe_url: str(b.iframe_url, 1000),
    open_mode: b.open_mode === 'tab' ? 'tab' : 'iframe',
    ip_whitelist: str(b.ip_whitelist, 1000),
    sig_method: SIG_METHODS.includes(b.sig_method) ? b.sig_method : 'none',
    sig_mode: b.sig_mode === 'url' ? 'url' : 'template',
    sig_template: str(b.sig_template, 300),
    sig_param: PARAM(b.sig_param, 'hash'),
    sig_secret: str(b.sig_secret, 300),
    p_user: PARAM(b.p_user, 'user_id'),
    p_txid: PARAM(b.p_txid, 'txid'),
    p_reward: PARAM(b.p_reward, 'reward'),
    p_payout: PARAM(b.p_payout, 'payout'),
    p_status: PARAM(b.p_status, 'status'),
    p_offer: PARAM(b.p_offer, 'offer'),
    p_ip: PARAM(b.p_ip, 'ip'),
    amount_source: b.amount_source === 'payout' ? 'payout' : 'reward',
    amount_unit: b.amount_unit === 'dollars' ? 'dollars' : 'cents',
    revenue_share: Math.min(100, Math.max(0, int(b.revenue_share, 70))),
    reversal_values: str(b.reversal_values, 200) || '2,reversed,chargeback,rejected',
    success_response: str(b.success_response, 60) || '1',
    hold_hours: Math.min(24 * 60, Math.max(0, int(b.hold_hours))),
  };
}

function validateWall(f) {
  if (!f.name || !f.slug) return 'Name is required.';
  if (f.iframe_url && !/^https:\/\//i.test(f.iframe_url)) return 'The wall URL must start with https://';
  if (f.sig_method !== 'none') {
    if (f.sig_method.startsWith('hmac') && !f.sig_secret) return 'HMAC signatures need a secret key.';
    if (f.sig_mode === 'template' && !f.sig_template) return 'Enter what gets hashed, e.g. {txid}-{secret}.';
  }
  return null;
}

const WALL_COLS = ['name', 'slug', 'tagline', 'color', 'icon', 'bonus_percent', 'active', 'sort', 'preset', 'iframe_url', 'open_mode',
  'ip_whitelist', 'sig_method', 'sig_mode', 'sig_template', 'sig_param', 'sig_secret', 'p_user', 'p_txid', 'p_reward', 'p_payout',
  'p_status', 'p_offer', 'p_ip', 'amount_source', 'amount_unit', 'revenue_share', 'reversal_values', 'success_response', 'hold_hours'];

router.get('/offerwall-presets', (_req, res) => res.json({ presets: PRESETS, sig_methods: SIG_METHODS }));

router.get('/offerwalls', async (_req, res) => {
  const walls = await db.all(`SELECT w.*,
      (SELECT COUNT(*) FROM offer_completions c WHERE c.offerwall_id = w.id AND c.status = 'completed') AS completed,
      (SELECT COALESCE(SUM(c.reward), 0) FROM offer_completions c WHERE c.offerwall_id = w.id AND c.status = 'completed') AS paid_cents,
      (SELECT COALESCE(SUM(c.payout_cents), 0) FROM offer_completions c WHERE c.offerwall_id = w.id AND c.status = 'completed') AS revenue_cents,
      (SELECT MAX(l.created_at) FROM postback_logs l WHERE l.offerwall_id = w.id) AS last_postback
    FROM offerwalls w ORDER BY w.sort, w.id`);
  res.json({ offerwalls: walls });
});

router.post('/offerwalls', async (req, res) => {
  const f = wallFields(req.body);
  const err = validateWall(f);
  if (err) return bad(res, err);
  try {
    const row = await db.get(`INSERT INTO offerwalls (${WALL_COLS.join(', ')}, postback_token, created_at)
      VALUES (${WALL_COLS.map(() => '?').join(', ')}, ?, ?) RETURNING id`, ...WALL_COLS.map((c) => f[c]), newToken(), Date.now());
    res.json({ id: row.id });
  } catch (e) {
    if (!isUnique(e)) throw e;
    bad(res, 'An offerwall with that slug already exists.');
  }
});

router.put('/offerwalls/:id', async (req, res) => {
  const f = wallFields(req.body);
  const err = validateWall(f);
  if (err) return bad(res, err);
  try {
    await db.run(`UPDATE offerwalls SET ${WALL_COLS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...WALL_COLS.map((c) => f[c]), int(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    if (!isUnique(e)) throw e;
    bad(res, 'An offerwall with that slug already exists.');
  }
});

router.post('/offerwalls/:id/token', async (req, res) => {
  await db.run('UPDATE offerwalls SET postback_token = ? WHERE id = ?', newToken(), int(req.params.id));
  res.json({ ok: true });
});

router.delete('/offerwalls/:id', async (req, res) => {
  await db.run('DELETE FROM offerwalls WHERE id = ?', int(req.params.id));
  res.json({ ok: true });
});

/** Send a correctly signed test postback to this wall, crediting the admin, then reverse it. */
router.post('/offerwalls/:id/test', async (req, res) => {
  const wall = await db.get('SELECT * FROM offerwalls WHERE id = ?', int(req.params.id));
  if (!wall) return bad(res, 'Offerwall not found.', 404);
  const base = `${req.protocol}://${req.get('host')}`;
  const allowed = String(wall.ip_whitelist || '').split(/[\s,]+/).find((ip) => ip && !ip.endsWith('*'));
  const ctx = { ip: allowed || req.ip, method: 'TEST' };
  const txid = `test-${Date.now().toString(36)}`;
  const cents = 100;
  const credit1 = buildTestPostback(wall, base, { userId: req.user.id, txid, cents });
  const first = await processPostback(wall, credit1.params, { ...ctx, fullUrl: credit1.fullUrl });
  const rev = buildTestPostback(wall, base, { userId: req.user.id, txid, cents, reversal: true });
  const second = await processPostback(wall, rev.params, { ...ctx, fullUrl: rev.fullUrl });
  res.json({ url: credit1.fullUrl, credit: first, reversal: second });
});

router.get('/postback-logs', async (req, res) => {
  const wallId = int(req.query.wall);
  const result = ['credited', 'held', 'duplicate', 'reversed', 'ignored', 'rejected'].includes(req.query.result) ? req.query.result : null;
  const where = [];
  const params = [];
  if (wallId) { where.push('l.offerwall_id = ?'); params.push(wallId); }
  if (result) { where.push('l.result = ?'); params.push(result); }
  res.json({
    logs: await db.all(`SELECT l.*, w.name AS wall_name, u.username FROM postback_logs l
      LEFT JOIN offerwalls w ON w.id = l.offerwall_id LEFT JOIN users u ON u.id = l.user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.id DESC LIMIT 300`, ...params),
  });
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

const EDITABLE = ['site_name', 'signup_bonus', 'daily_reward', 'referral_percent', 'announcement', 'maintenance', 'max_accounts_per_ip',
  'games_enabled', 'games_min_bet', 'games_max_bet', 'games_max_win'];
const NUMERIC = ['signup_bonus', 'daily_reward', 'referral_percent', 'max_accounts_per_ip', 'games_min_bet', 'games_max_bet', 'games_max_win'];

router.get('/settings', async (_req, res) => res.json({ settings: await getSettings() }));

router.put('/settings', async (req, res) => {
  const updates = [];
  for (const key of EDITABLE) {
    if (!(key in req.body)) continue;
    let value = req.body[key];
    if (NUMERIC.includes(key)) {
      value = Math.min(key === 'referral_percent' ? 100 : 100_000_000, Math.max(0, int(value)));
      if (key.startsWith('games_') && value < 1) return bad(res, 'Bet limits must be at least $0.01.');
    } else if (key === 'maintenance' || key === 'games_enabled') {
      value = bool(value);
    } else {
      value = str(value, 500);
    }
    updates.push([key, value]);
  }
  for (const [k, v] of updates) await setSetting(k, v);
  res.json({ settings: await getSettings() });
});

module.exports = router;
