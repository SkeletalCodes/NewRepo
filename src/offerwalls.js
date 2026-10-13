'use strict';

/*
 * Offerwall integrations.
 *
 * Each offerwall row holds everything needed to embed the wall and accept its postbacks:
 *   - iframe_url: the wall URL from the network dashboard, with {user_id} where the user ID goes.
 *   - postback URL: /api/postback/<slug>/<postback_token>?user_id=...&txid=...&reward=...
 *     The token is a secret only the network knows. Optionally also an IP allowlist and a
 *     signature check (hash of chosen params + secret, or HMAC of the full URL).
 *   - How to read the reward: from a reward param (cents or dollars) or as a share of the payout.
 *
 * Postbacks are idempotent per (offerwall, txid). A reversal (status in reversal_values, or a
 * negative reward) takes back a credited reward, or cancels it if it's still on hold.
 */

const crypto = require('node:crypto');
const { db } = require('./db');
const { approveCompletionInTx, rejectCompletion } = require('./rewards');

const SIG_METHODS = ['none', 'md5', 'sha1', 'sha256', 'hmac-sha1', 'hmac-sha256'];

/*
 * Starting points for popular networks. Signature schemes and macro names change, so always check
 * them against the network's current postback docs before going live. The postback log in the
 * admin panel shows exactly what each network sends and why a request was accepted or rejected.
 */
const PRESETS = {
  custom: { name: 'Custom', icon: 'fa-layer-group', color: '#eac837' },
  cpx: {
    name: 'CPX Research', icon: 'fa-clipboard-check', color: '#14f195', tagline: 'Paid surveys',
    sig_method: 'md5', sig_mode: 'template', sig_template: '{txid}-{secret}', sig_param: 'hash', reversal_values: '2',
    macros: { user: '{user_id}', txid: '{trans_id}', reward: '{amount_local}', payout: '{amount_usd}', status: '{status}', sig: '{secure_hash}' },
  },
  bitlabs: {
    name: 'BitLabs', icon: 'fa-clipboard-list', color: '#7dd3fc', tagline: 'Surveys & offers',
    sig_method: 'hmac-sha1', sig_mode: 'url', sig_param: 'hash',
  },
  adgem: {
    name: 'AdGem', icon: 'fa-gem', color: '#a78bfa', tagline: 'Games & apps',
    sig_method: 'hmac-sha256', sig_mode: 'url', sig_param: 'verifier',
  },
  torox: {
    name: 'Torox', icon: 'fa-bolt', color: '#f59e0b', tagline: 'Games, apps & surveys',
    sig_method: 'md5', sig_mode: 'template', sig_template: '{txid}-{user_id}-{secret}', sig_param: 'sig',
  },
  lootably: { name: 'Lootably', icon: 'fa-box-open', color: '#14f195', tagline: 'Offers, videos & surveys' },
  ayet: { name: 'AyeT Studios', icon: 'fa-mobile-screen-button', color: '#ff5c7a', tagline: 'Apps & games' },
  notik: { name: 'Notik', icon: 'fa-bell', color: '#eac837', tagline: 'Offers & surveys' },
  revlum: { name: 'Revlum', icon: 'fa-rotate', color: '#7dd3fc', tagline: 'Offers & surveys' },
  timewall: { name: 'TimeWall', icon: 'fa-clock', color: '#f472b6', tagline: 'Quick tasks' },
  adscend: { name: 'Adscend Media', icon: 'fa-arrow-trend-up', color: '#a3e635', tagline: 'Offers' },
};

const newToken = () => crypto.randomBytes(18).toString('base64url');

function hashWith(method, data, secret) {
  switch (method) {
    case 'md5': return crypto.createHash('md5').update(data).digest('hex');
    case 'sha1': return crypto.createHash('sha1').update(data).digest('hex');
    case 'sha256': return crypto.createHash('sha256').update(data).digest('hex');
    case 'hmac-sha1': return crypto.createHmac('sha1', secret).update(data).digest('hex');
    case 'hmac-sha256': return crypto.createHmac('sha256', secret).update(data).digest('hex');
    default: return '';
  }
}

/** Map our logical names onto the param names this wall uses. */
function paramNames(wall) {
  return {
    user_id: wall.p_user || 'user_id',
    txid: wall.p_txid || 'txid',
    reward: wall.p_reward || 'reward',
    payout: wall.p_payout || 'payout',
    status: wall.p_status || 'status',
    offer: wall.p_offer || 'offer',
    ip: wall.p_ip || 'ip',
  };
}

/** Fill {name} placeholders from the raw params. Logical names (txid, user_id...) and raw param names both work. */
function fillTemplate(template, params, wall) {
  const names = paramNames(wall);
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    if (key === 'secret') return wall.sig_secret;
    if (names[key] && params[names[key]] !== undefined) return String(params[names[key]]);
    return params[key] !== undefined ? String(params[key]) : '';
  });
}

/** The URL a network signs in "url" mode: the full request URL with the signature param removed. */
function urlWithoutParam(fullUrl, param) {
  const [base, query = ''] = fullUrl.split('?');
  const kept = query.split('&').filter((pair) => pair && decodeURIComponent(pair.split('=')[0]) !== param);
  return kept.length ? `${base}?${kept.join('&')}` : base;
}

function expectedSignature(wall, params, fullUrl) {
  const data = wall.sig_mode === 'url' ? urlWithoutParam(fullUrl, wall.sig_param) : fillTemplate(wall.sig_template || '', params, wall);
  return hashWith(wall.sig_method, data, wall.sig_secret);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a).toLowerCase());
  const y = Buffer.from(String(b).toLowerCase());
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function ipAllowed(wall, ip) {
  const list = String(wall.ip_whitelist || '').split(/[\s,]+/).filter(Boolean);
  if (!list.length) return true;
  const clean = String(ip || '').replace(/^::ffff:/, '');
  return list.some((entry) => {
    if (entry.endsWith('*')) return clean.startsWith(entry.slice(0, -1));
    return entry === clean;
  });
}

/** Work out the user's reward in cents from the postback params (before the wall's bonus). */
function rewardCents(wall, params) {
  const names = paramNames(wall);
  if (wall.amount_source === 'payout') {
    const payout = parseFloat(params[names.payout]);
    if (!Number.isFinite(payout)) return NaN;
    return Math.round(payout * 100 * (Number(wall.revenue_share) / 100));
  }
  const raw = parseFloat(params[names.reward]);
  if (!Number.isFinite(raw)) return NaN;
  return Math.round(wall.amount_unit === 'dollars' ? raw * 100 : raw);
}

function payoutCents(wall, params) {
  const payout = parseFloat(params[paramNames(wall).payout]);
  return Number.isFinite(payout) ? Math.round(payout * 100) : 0;
}

/** Keep only short, printable params for the log, and never log the signature secret. */
function paramsForLog(params) {
  const out = {};
  for (const [k, v] of Object.entries(params).slice(0, 40)) out[String(k).slice(0, 40)] = String(v).slice(0, 200);
  return JSON.stringify(out).slice(0, 4000);
}

async function log(wall, ctx, params, result, message, extra = {}) {
  await db.run(`INSERT INTO postback_logs (offerwall_id, ip, method, params, result, message, user_id, amount, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, wall.id, String(ctx.ip || '').slice(0, 64), ctx.method || 'GET', paramsForLog(params),
  result, String(message).slice(0, 300), extra.userId ?? null, extra.amount ?? null, Date.now());
}

/**
 * Process one postback. Returns { status, body, result, message } where status/body are the HTTP
 * response for the network. Every call is logged.
 * ctx: { ip, method, fullUrl }
 */
async function processPostback(wall, params, ctx) {
  const ok = { status: 200, body: wall.success_response || '1' };
  const fail = (status, result, message) => ({ status, body: '0', result, message });
  const done = async (res, extra) => {
    await log(wall, ctx, params, res.result, res.message, extra);
    return res;
  };

  if (!wall.active) return done(fail(403, 'rejected', 'Offerwall is disabled.'));
  if (!ipAllowed(wall, ctx.ip)) return done(fail(403, 'rejected', `IP ${ctx.ip} is not on the allowlist.`));

  if (wall.sig_method && wall.sig_method !== 'none') {
    const given = params[wall.sig_param];
    if (!given) return done(fail(403, 'rejected', `Missing signature param "${wall.sig_param}".`));
    const expected = expectedSignature(wall, params, ctx.fullUrl || '');
    if (!safeEqual(given, expected)) return done(fail(403, 'rejected', 'Signature does not match.'));
  }

  const names = paramNames(wall);
  const userId = Math.trunc(Number(params[names.user_id]));
  const txidRaw = String(params[names.txid] ?? '').trim().slice(0, 128);
  if (!txidRaw) return done(fail(400, 'rejected', `Missing transaction ID param "${names.txid}".`));
  const txid = `${wall.slug}:${txidRaw}`;
  const status = String(params[names.status] ?? '').trim().toLowerCase();
  const reversalValues = String(wall.reversal_values || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  const cents = rewardCents(wall, params);
  const isReversal = (status && reversalValues.includes(status)) || cents < 0;

  const existing = await db.get('SELECT * FROM offer_completions WHERE txid = ?', txid);

  if (isReversal) {
    if (!existing) return done({ ...ok, result: 'ignored', message: 'Reversal for an unknown transaction.' }, { userId: userId || null });
    if (existing.status === 'rejected') return done({ ...ok, result: 'duplicate', message: 'Already reversed.' }, { userId: existing.user_id });
    await rejectCompletion(existing.id, 'Reversed by the network');
    return done({ ...ok, result: 'reversed', message: existing.status === 'completed' ? 'Reward taken back.' : 'Held reward cancelled.' },
      { userId: existing.user_id, amount: -existing.reward });
  }

  if (existing) return done({ ...ok, result: 'duplicate', message: 'Transaction already processed.' }, { userId: existing.user_id });
  if (!userId || !(await db.get('SELECT 1 AS x FROM users WHERE id = ?', userId))) {
    return done(fail(400, 'rejected', `Unknown user "${params[names.user_id] ?? ''}".`));
  }
  if (!Number.isFinite(cents)) {
    return done(fail(400, 'rejected', `Missing or invalid ${wall.amount_source === 'payout' ? `payout param "${names.payout}"` : `reward param "${names.reward}"`}.`));
  }
  const amount = Math.round(cents * (1 + (Number(wall.bonus_percent) || 0) / 100));
  if (amount <= 0) return done({ ...ok, result: 'ignored', message: 'Zero reward, nothing to credit.' }, { userId, amount: 0 });
  if (amount > 1_000_000) return done(fail(400, 'rejected', 'Reward is over the $10,000 safety limit.'), { userId, amount });

  const now = Date.now();
  const holdMs = Math.max(0, Number(wall.hold_hours) || 0) * 3600_000;
  const offerName = String(params[names.offer] || 'Offer').slice(0, 120);
  const userIp = String(params[names.ip] || '').slice(0, 64);
  const inserted = await db.tx(async (t) => {
    const c = await t.get(`INSERT INTO offer_completions
      (user_id, offerwall_id, offer_title, provider, reward, payout_cents, ip, status, txid, release_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?) ON CONFLICT (txid) DO NOTHING RETURNING *`,
    userId, wall.id, offerName, wall.name, amount, payoutCents(wall, params), userIp, txid, holdMs ? now + holdMs : null, now, now);
    if (c && !holdMs) await approveCompletionInTx(t, c);
    return c;
  });
  if (!inserted) return done({ ...ok, result: 'duplicate', message: 'Transaction already processed.' }, { userId });
  return done({ ...ok, result: holdMs ? 'held' : 'credited', message: holdMs ? `On hold for ${wall.hold_hours}h.` : 'Credited.' }, { userId, amount });
}

/** Credit completions whose hold period has ended. Cheap; safe to call often. */
async function releaseHeld() {
  const due = await db.all("SELECT id FROM offer_completions WHERE status = 'pending' AND release_at IS NOT NULL AND release_at <= ? LIMIT 200", Date.now());
  for (const { id } of due) {
    await db.tx(async (t) => {
      const c = await t.get('SELECT * FROM offer_completions WHERE id = ?', id);
      if (c) await approveCompletionInTx(t, c);
    });
  }
  return due.length;
}

let lastHousekeeping = 0;
/** Release holds and clear out expired rows, at most once a minute per server instance. */
function housekeeping() {
  if (Date.now() - lastHousekeeping < 60_000) return;
  lastHousekeeping = Date.now();
  releaseHeld().catch((err) => console.error('releaseHeld failed', err));
  const now = Date.now();
  db.run('DELETE FROM postback_logs WHERE created_at < ?', now - 30 * 86400_000).catch(() => {});
  db.run('DELETE FROM sessions WHERE expires_at < ?', now).catch(() => {});
  db.run('DELETE FROM password_resets WHERE expires_at < ?', now - 86400_000).catch(() => {});
  db.run('DELETE FROM rate_limits WHERE reset_at < ?', now).catch(() => {});
}

/** Build a correctly signed test postback for a wall, the way the network would send it. */
function buildTestPostback(wall, baseUrl, { userId, txid, cents, reversal }) {
  const names = paramNames(wall);
  const params = {};
  params[names.user_id] = String(userId);
  params[names.txid] = txid;
  if (wall.amount_source === 'payout') {
    params[names.payout] = ((cents / 100) / (Number(wall.revenue_share) / 100 || 1)).toFixed(2);
  } else {
    params[names.reward] = wall.amount_unit === 'dollars' ? (cents / 100).toFixed(2) : String(cents);
    params[names.payout] = (cents / 70).toFixed(2);
  }
  params[names.status] = reversal ? (String(wall.reversal_values).split(/[\s,]+/).filter(Boolean)[0] || '2') : '1';
  params[names.offer] = 'Test postback';
  const query = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  let fullUrl = `${baseUrl}/api/postback/${wall.slug}/${wall.postback_token}?${query}`;
  if (wall.sig_method && wall.sig_method !== 'none') {
    const sig = expectedSignature(wall, params, fullUrl);
    params[wall.sig_param] = sig;
    fullUrl += `&${encodeURIComponent(wall.sig_param)}=${sig}`;
  }
  return { params, fullUrl };
}

module.exports = {
  PRESETS, SIG_METHODS, newToken, processPostback, releaseHeld, housekeeping, buildTestPostback,
  expectedSignature, urlWithoutParam, paramNames,
};
