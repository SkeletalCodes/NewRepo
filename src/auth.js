'use strict';

const crypto = require('node:crypto');
const { db } = require('./db');

const SESSION_COOKIE = 'gr_session';
const LONG_SESSION_MS = 30 * 24 * 60 * 60 * 1000; // "remember me"
const SHORT_SESSION_MS = 24 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 10 * 60 * 1000; // how often a session's last-seen / expiry is refreshed
const RESET_TTL_MS = 60 * 60 * 1000;
const LOCK_AFTER_FAILS = 8;
const LOCK_FOR_MS = 15 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
// Multiplies every rate limit. Leave at 1 in production; the test suite raises it.
const LIMIT_SCALE = Math.max(1, Number(process.env.RATE_LIMIT_SCALE) || 1);

/* -------------------------------------------------------------- passwords */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// Burn the same CPU as a real check so "no such user" and "wrong password" take the same time.
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));
const fakeVerify = () => { verifyPassword('x', DUMMY_HASH); return false; };

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 128) return 'Password must be 128 characters or less.';
  if (/^(.)\1+$/.test(password) || ['password', 'password1', '12345678', '123456789', 'qwertyui', 'iloveyou'].includes(password.toLowerCase())) {
    return 'That password is too easy to guess.';
  }
  return null;
}

/* --------------------------------------------------------------- sessions */

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

function setCookie(res, token, maxAge) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge,
    path: '/',
  });
}

async function createSession(req, res, userId, { remember = true } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const ttl = remember ? LONG_SESSION_MS : SHORT_SESSION_MS;
  await db.run(`INSERT INTO sessions (token_hash, user_id, expires_at, created_at, ip, user_agent, last_seen_at, remember)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, sha256(token), userId, now + ttl, now, String(req.ip || '').slice(0, 64),
  String(req.headers['user-agent'] || '').slice(0, 300), now, remember ? 1 : 0);
  await db.run('UPDATE users SET last_login_at = ?, last_ip = ?, failed_logins = 0, locked_until = NULL WHERE id = ?',
    now, String(req.ip || '').slice(0, 64), userId);
  setCookie(res, token, ttl);
}

async function destroySession(req, res) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Log a user out everywhere, optionally keeping the current session. */
async function destroyOtherSessions(userId, keepHash = null) {
  if (keepHash) await db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', userId, keepHash);
  else await db.run('DELETE FROM sessions WHERE user_id = ?', userId);
}

/**
 * Attaches req.user (and req.sessionHash) when a valid session cookie is present.
 * Active sessions slide forward: every ~10 minutes their expiry is pushed out again.
 */
async function loadUser(req, res, next) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) {
    const hash = sha256(token);
    const row = await db.get(`
      SELECT u.*, s.last_seen_at AS s_seen, s.remember AS s_remember
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`, hash, Date.now());
    if (row && !row.banned) {
      req.user = row;
      req.sessionHash = hash;
      const now = Date.now();
      if (now - Number(row.s_seen || 0) > TOUCH_EVERY_MS) {
        const ttl = row.s_remember ? LONG_SESSION_MS : SHORT_SESSION_MS;
        await db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ?, ip = ? WHERE token_hash = ?',
          now, now + ttl, String(req.ip || '').slice(0, 64), hash);
        setCookie(res, token, ttl);
      }
    } else if (!row) {
      res.clearCookie(SESSION_COOKIE, { path: '/' });
    }
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
  next();
}

/* ---------------------------------------------------------- login lockout */

/** Returns minutes left if the account is locked, else 0. */
function lockedMinutes(user) {
  const until = Number(user.locked_until || 0);
  return until > Date.now() ? Math.ceil((until - Date.now()) / 60000) : 0;
}

async function recordFailedLogin(user) {
  const fails = Number(user.failed_logins || 0) + 1;
  const lock = fails >= LOCK_AFTER_FAILS ? Date.now() + LOCK_FOR_MS : null;
  await db.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', lock ? 0 : fails, lock, user.id);
  return !!lock;
}

/* ---------------------------------------------------------- password reset */

async function createResetToken(userId, ip = '') {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  // Only the newest link works.
  await db.run('DELETE FROM password_resets WHERE user_id = ?', userId);
  await db.run('INSERT INTO password_resets (token_hash, user_id, expires_at, ip, created_at) VALUES (?, ?, ?, ?, ?)',
    sha256(token), userId, now + RESET_TTL_MS, String(ip).slice(0, 64), now);
  return token;
}

async function findResetToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  return db.get(`SELECT r.*, u.username, u.email, u.banned FROM password_resets r JOIN users u ON u.id = r.user_id
    WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ?`, sha256(token), Date.now());
}

/** Mark a reset token used. Returns false if someone else used it first. */
async function consumeResetToken(token) {
  const r = await db.run('UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
    Date.now(), sha256(token), Date.now());
  return r.changes === 1;
}

/* ------------------------------------------------------------ rate limits */

/** Very small in-memory fixed-window limiter, for cheap per-instance protection. */
function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    if (entry.count > max * LIMIT_SCALE) {
      return res.status(429).json({ error: 'Too many attempts. Please slow down and try again shortly.' });
    }
    next();
  };
}

/**
 * Database-backed fixed-window counter, shared by every server instance (needed on serverless hosts).
 * Returns true if the action is allowed.
 */
async function hit(key, max, windowMs) {
  const now = Date.now();
  const row = await db.get(`INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limits.reset_at < ? THEN 1 ELSE rate_limits.count + 1 END,
      reset_at = CASE WHEN rate_limits.reset_at < ? THEN ? ELSE rate_limits.reset_at END
    RETURNING count`, key, now + windowMs, now, now, now + windowMs);
  return row.count <= max * LIMIT_SCALE;
}

/** Express middleware wrapper around hit(). */
function sharedLimit(name, max, windowMs, key = (req) => req.ip) {
  return async (req, res, next) => {
    if (!(await hit(`${name}:${key(req)}`, max, windowMs))) {
      return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    }
    next();
  };
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    balance: u.balance,
    total_earned: u.total_earned,
    role: u.role,
    referral_code: u.referral_code,
    avatar_color: u.avatar_color,
    onboarded: !!u.onboarded,
    last_daily_at: u.last_daily_at,
    created_at: u.created_at,
  };
}

module.exports = {
  sha256, hashPassword, verifyPassword, fakeVerify, passwordProblem,
  createSession, destroySession, destroyOtherSessions, loadUser, requireUser, requireAdmin,
  lockedMinutes, recordFailedLogin, createResetToken, findResetToken, consumeResetToken,
  rateLimit, hit, sharedLimit, publicUser, RESET_TTL_MS,
};
