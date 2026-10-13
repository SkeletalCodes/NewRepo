'use strict';

/*
 * Games API (real USD balance, in cents). Every result is decided here on the server from the player's
 * provably-fair seed pair; the browser only animates what the server already decided.
 *
 *   GET  /api/games/config                 games list, limits
 *   GET  /api/games/fair                   your seed pair (server seed shown hashed)
 *   POST /api/games/fair/rotate            reveal the server seed, start a new pair
 *   POST /api/games/:game/bet              { amount, params }  instant games settle right away
 *   POST /api/games/bets/:id/action        { action, params }  moves in round games (mines, blackjack...)
 *   GET  /api/games/active                 your unfinished rounds (to resume after a reload)
 *   GET  /api/games/bets                   your bet history
 *   GET  /api/games/live                   recent bets by everyone (names masked)
 *   POST /api/games/verify                 recompute any bet from its seeds
 */

const express = require('express');
const { db, debit, credit, getSettings } = require('../db');
const { requireUser, rateLimit, publicUser } = require('../auth');
const { randomHex, sha256hex, rngFor } = require('./fair');
const { GAMES, GameError, card } = require('./logic');

const router = express.Router();
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const betLimiter = rateLimit({ windowMs: 60_000, max: 600, key: (req) => `g${req.user ? req.user.id : req.ip}` });
const money = (c) => `$${(c / 100).toFixed(2)}`;

async function limits() {
  const s = await getSettings();
  return {
    enabled: s.games_enabled !== '0',
    min: Math.max(1, Number(s.games_min_bet) || 10),
    max: Math.max(1, Number(s.games_max_bet) || 10000),
    maxWin: Math.max(1, Number(s.games_max_win) || 100000),
  };
}

/** Load (or create) a user's seed pair. */
async function seedsFor(q, userId) {
  let s = await q.get('SELECT * FROM fair_seeds WHERE user_id = ?', userId);
  if (!s) {
    await q.run(`INSERT INTO fair_seeds (user_id, server_seed, next_server_seed, client_seed, nonce) VALUES (?, ?, ?, ?, 0)
      ON CONFLICT (user_id) DO NOTHING`, userId, randomHex(32), randomHex(32), randomHex(8));
    s = await q.get('SELECT * FROM fair_seeds WHERE user_id = ?', userId);
  }
  return s;
}

const parse = (json) => { try { return JSON.parse(json); } catch { return {}; } };

/** What the player may see of a bet. Round games only show hidden info once the round is over. */
function betView(b, currentHash) {
  const g = GAMES[b.game];
  const state = parse(b.state);
  const done = b.status !== 'active';
  const out = {
    id: b.id, game: b.game, name: g ? g.name : b.game, amount: b.amount, payout: b.payout, multiplier: b.multiplier,
    status: b.status, params: parse(b.params), created_at: b.created_at, settled_at: b.settled_at,
    nonce: b.nonce, client_seed: b.client_seed, server_hash: b.server_hash,
    // The server seed is only revealed once the player has rotated away from it.
    server_seed: done && currentHash && b.server_hash !== currentHash ? b.server_seed : null,
  };
  if (g && g.round) {
    out.view = g.view(state, done);
    if (b.game === 'crash') { out.view.started_at = state.started; out.view.server_now = Date.now(); }
  } else {
    out.result = state.result || null;
  }
  return out;
}

/** Pay out a finished bet (inside a transaction). The payout is capped at the max-win setting. */
async function settle(t, bet, mult, maxWin, payoutCents) {
  let payout = payoutCents !== undefined ? payoutCents : Math.floor(bet.amount * mult + 1e-9);
  payout = Math.max(0, Math.min(payout, maxWin));
  const realMult = bet.amount ? Math.round((payout / bet.amount) * 10000) / 10000 : 0;
  if (payout > 0) await credit(t, bet.user_id, payout, 'win', `${GAMES[bet.game].name} win (${realMult}×)`);
  return { payout, mult: realMult };
}

router.get('/config', async (_req, res) => {
  const l = await limits();
  res.json({
    ...l,
    games: Object.entries(GAMES).map(([id, g]) => ({ id, name: g.name, rtp: g.rtp, round: !!g.round })),
    tables: {
      plinko: GAMES.plinko.PAYS, keno: GAMES.keno.PAY, diamonds: GAMES.diamonds.PAY,
      towers: GAMES.towers.LEVELS, pump: GAMES.pump.LEVELS, roulette_reds: GAMES.roulette.REDS,
      wheel: Object.fromEntries(['low', 'medium', 'high'].map((r) => [r, Object.fromEntries([10, 20, 30, 40, 50].map((n) => [n, GAMES.wheel.slices(r, n)]))])),
    },
  });
});

router.get('/live', async (_req, res) => {
  const rows = await db.all(`SELECT b.game, b.amount, b.payout, b.multiplier, b.settled_at, u.username, u.avatar_color
    FROM bets b JOIN users u ON u.id = b.user_id WHERE b.status = 'settled' ORDER BY b.settled_at DESC LIMIT 25`);
  const mask = (n) => (n.length <= 3 ? `${n[0]}**` : n.slice(0, 2) + '*'.repeat(Math.min(4, n.length - 3)) + n.slice(-1));
  res.json({ bets: rows.map((r) => ({ ...r, name: GAMES[r.game] ? GAMES[r.game].name : r.game, username: mask(r.username) })) });
});

router.post('/verify', (req, res) => {
  const b = req.body || {};
  const g = GAMES[b.game];
  if (!g) return bad(res, 'Pick a game.');
  const server = String(b.server_seed || '').trim();
  const client = String(b.client_seed || '').trim();
  const nonce = Math.floor(Number(b.nonce));
  if (!server || !client || !(nonce >= 0)) return bad(res, 'Enter the server seed, client seed and nonce.');
  let params;
  try { params = g.check(b.params || {}); } catch (err) { return bad(res, err.message); }
  const rng = rngFor(server, client, nonce);
  const out = { server_hash: sha256hex(server) };
  if (!g.round) Object.assign(out, g.play(rng, params));
  else if (b.game === 'crash') out.crash_point = g.start(rng, params).at;
  else if (b.game === 'mines') out.mine_order = g.start(rngFor(server, client, nonce), { mines: 24 }).layout;
  else if (b.game === 'blackjack' || b.game === 'hilo') { out.cards = []; for (let i = 0; i < 12; i++) out.cards.push(card(rng)); }
  else out.state = g.start(rng, params);
  res.json(out);
});

/* Everything below needs an account. */
router.use(requireUser);

router.get('/fair', async (req, res) => {
  const s = await seedsFor(db, req.user.id);
  res.json({
    client_seed: s.client_seed, server_hash: sha256hex(s.server_seed), nonce: s.nonce, next_hash: sha256hex(s.next_server_seed),
    previous: s.prev_server_seed ? { server_seed: s.prev_server_seed, server_hash: sha256hex(s.prev_server_seed), client_seed: s.prev_client_seed, nonce: s.prev_nonce } : null,
  });
});

router.post('/fair/rotate', betLimiter, async (req, res) => {
  const client = String(req.body.client_seed || '').trim().slice(0, 64) || randomHex(8);
  if (!/^[\w.-]+$/.test(client)) return bad(res, 'Client seed can only use letters, numbers, dots, dashes and underscores.');
  if (await db.get("SELECT 1 AS x FROM bets WHERE user_id = ? AND status = 'active'", req.user.id)) {
    return bad(res, 'Finish your open rounds first. Rotating would reveal the seed they use.');
  }
  await seedsFor(db, req.user.id);
  await db.run(`UPDATE fair_seeds SET prev_server_seed = server_seed, prev_client_seed = client_seed, prev_nonce = nonce,
    server_seed = next_server_seed, next_server_seed = ?, client_seed = ?, nonce = 0, rotated_at = ? WHERE user_id = ?`,
  randomHex(32), client, Date.now(), req.user.id);
  res.json({ ok: true });
});

async function currentHash(userId) {
  const s = await db.get('SELECT server_seed FROM fair_seeds WHERE user_id = ?', userId);
  return s ? sha256hex(s.server_seed) : null;
}

router.get('/active', async (req, res) => {
  await settleExpiredCrash(req.user.id);
  const rows = await db.all("SELECT * FROM bets WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 20", req.user.id);
  const hash = await currentHash(req.user.id);
  res.json({ bets: rows.map((b) => betView(b, hash)) });
});

router.get('/bets', async (req, res) => {
  const game = GAMES[req.query.game] ? req.query.game : null;
  const rows = await db.all(`SELECT * FROM bets WHERE user_id = ? ${game ? 'AND game = ?' : ''} ORDER BY id DESC LIMIT 50`,
    req.user.id, ...(game ? [game] : []));
  const hash = await currentHash(req.user.id);
  res.json({ bets: rows.map((b) => betView(b, hash)) });
});

router.post('/:game/bet', betLimiter, async (req, res) => {
  const g = GAMES[req.params.game];
  if (!g) return bad(res, 'Unknown game.', 404);
  const l = await limits();
  if (!l.enabled && req.user.role !== 'admin') return bad(res, 'Games are switched off right now.', 503);
  let params;
  try { params = g.check(req.body.params || {}); } catch (err) { return bad(res, err instanceof GameError ? err.message : 'Invalid bet.'); }
  const amount = g.stake ? g.stake(params) : Math.floor(Number(req.body.amount));
  if (!Number.isFinite(amount) || amount < l.min) return bad(res, `The minimum bet is ${money(l.min)}.`);
  if (amount > l.max) return bad(res, `The maximum bet is ${money(l.max)}.`);
  if (g.round && await db.get("SELECT 1 AS x FROM bets WHERE user_id = ? AND game = ? AND status = 'active'", req.user.id, req.params.game)) {
    return bad(res, `Finish your current ${g.name} round first.`);
  }

  let bet;
  try {
    bet = await db.tx(async (t) => {
      await seedsFor(t, req.user.id);
      const seed = await t.get('UPDATE fair_seeds SET nonce = nonce + 1 WHERE user_id = ? RETURNING server_seed, client_seed, nonce', req.user.id);
      if (!(await debit(t, req.user.id, amount, 'bet', `${g.name} bet`))) throw new GameError('Not enough balance for that bet.');
      const rng = rngFor(seed.server_seed, seed.client_seed, seed.nonce);
      const now = Date.now();
      let state;
      let finished = null;
      if (g.round) {
        state = g.start(rng, params);
        if (req.params.game === 'crash') state.started = now;
        if (g.instant) finished = g.instant(state);
        if (finished) state = finished.state;
      } else {
        const r = g.play(rng, params);
        state = { result: r.result };
        finished = { mult: r.mult, payoutCents: r.payoutCents };
      }
      state.used = rng.used;
      const row = await t.get(`INSERT INTO bets (user_id, game, amount, status, params, state, server_seed, server_hash, client_seed, nonce, created_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?) RETURNING *`, req.user.id, req.params.game, amount, JSON.stringify(params),
      JSON.stringify(state), seed.server_seed, sha256hex(seed.server_seed), seed.client_seed, seed.nonce, now);
      if (!finished) return row;
      const paid = await settle(t, row, finished.mult, l.maxWin, finished.payoutCents);
      return t.get("UPDATE bets SET status = 'settled', payout = ?, multiplier = ?, settled_at = ? WHERE id = ? RETURNING *", paid.payout, paid.mult, now, row.id);
    });
  } catch (err) {
    if (err instanceof GameError) return bad(res, err.message);
    throw err;
  }
  const user = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);
  res.json({ bet: betView(bet, bet.server_hash), user: publicUser(user) });
});

router.post('/bets/:id/action', betLimiter, async (req, res) => {
  const id = Math.floor(Number(req.params.id));
  const action = String(req.body.action || '');
  const l = await limits();
  const result = await runAction(req.user.id, id, action, req.body.params || {}, l);
  if (result.error) return bad(res, result.error, result.code || 400);
  const user = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);
  res.json({ bet: betView(result.bet, result.bet.server_hash), user: publicUser(user) });
});

/** Apply one move to a round. Uses the row's version number so two clicks can't both count. */
async function runAction(userId, id, action, params, l) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const b = await db.get('SELECT * FROM bets WHERE id = ? AND user_id = ?', id, userId);
    if (!b) return { error: 'Round not found.', code: 404 };
    if (b.status !== 'active') return { bet: b }; // already over: just show it
    const g = GAMES[b.game];
    const state = parse(b.state);
    try {
      const out = await db.tx(async (t) => {
        let res;
        let amount = b.amount;
        if (b.game === 'crash') {
          if (action !== 'cashout' && action !== 'poll') throw new GameError('Unknown move.');
          res = g.resolve(state, Date.now() - state.started, action === 'cashout');
          if (!res) return { bet: b }; // still flying
        } else {
          if (b.game === 'blackjack' && action === 'double') {
            if (!(await debit(t, userId, b.amount, 'bet', 'Blackjack double'))) throw new GameError('Not enough balance to double.');
            amount = b.amount * 2;
          }
          const rng = rngFor(b.server_seed, b.client_seed, b.nonce).skip(state.used || 0);
          res = g.act(rng, state, action, params);
          res.state.used = rng.used;
        }
        const upd = await t.run('UPDATE bets SET state = ?, amount = ?, version = version + 1 WHERE id = ? AND version = ? AND status = ?',
          JSON.stringify(res.state), amount, b.id, b.version, 'active');
        if (upd.changes !== 1) throw new Retry();
        if (!res.done) return { bet: await t.get('SELECT * FROM bets WHERE id = ?', b.id) };
        const paid = await settle(t, { ...b, amount }, res.mult, l.maxWin);
        return { bet: await t.get("UPDATE bets SET status = 'settled', payout = ?, multiplier = ?, settled_at = ? WHERE id = ? RETURNING *", paid.payout, paid.mult, Date.now(), b.id) };
      });
      return out;
    } catch (err) {
      if (err instanceof Retry) continue;
      if (err instanceof GameError) return { error: err.message };
      throw err;
    }
  }
  return { error: 'That move clashed with another one. Try again.', code: 409 };
}
class Retry extends Error {}

/** Crash rounds settle themselves once the rocket has crashed (or hit the auto cash out), even if nobody asks. */
async function settleExpiredCrash(userId = null) {
  const rows = await db.all(`SELECT id, user_id, state FROM bets WHERE status = 'active' AND game = 'crash' ${userId ? 'AND user_id = ?' : ''} LIMIT 200`,
    ...(userId ? [userId] : []));
  if (!rows.length) return;
  const l = await limits();
  for (const r of rows) {
    const s = parse(r.state);
    if (g2().resolve(s, Date.now() - s.started, false)) await runAction(r.user_id, r.id, 'poll', {}, l);
  }
}
const g2 = () => GAMES.crash;

module.exports = { router, settleExpiredCrash, GAMES };
