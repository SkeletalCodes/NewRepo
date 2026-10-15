'use strict';

/*
 * Games API (real USD balance, amounts in cents). The server decides every result; the browser only
 * animates what it's told.
 *
 *   GET  /api/games/config                 games, limits, pay tables
 *   GET  /api/games/live?game=             recent settled bets by everyone (names masked)
 *   GET  /api/games/rounds/:game           a timed round (Double, Crash): phase, timers, everyone's bets
 *   POST /api/games/rounds/:game/bet       { amount, params }  bet in the betting window
 *   POST /api/games/rounds/crash/cashout   cash out of the flying rocket
 *   POST /api/games/:game/bet              { amount, params }  instant and step games
 *   POST /api/games/bets/:id/action        { action, params }  moves in step games (mines, blackjack...)
 *   GET  /api/games/active                 your unfinished step games (to resume after a reload)
 *   GET  /api/games/bets                   your bet history
 */

const express = require('express');
const { db, debit, credit, getSettings } = require('../db');
const { requireUser, rateLimit, publicUser } = require('../auth');
const { GAMES, GameError } = require('./logic');
const { makeRng } = require('./rng');
const rounds = require('./rounds');
const { pageOf, pageRows } = require('../paging');

const router = express.Router();
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const betLimiter = rateLimit({ windowMs: 60_000, max: 600, key: (req) => `g${req.user ? req.user.id : req.ip}` });
const money = (c) => `$${(c / 100).toFixed(2)}`;
const parse = (json) => { try { return JSON.parse(json); } catch { return {}; } };

async function limits() {
  const s = await getSettings();
  return {
    enabled: s.games_enabled !== '0',
    min: Math.max(1, Number(s.games_min_bet) || 10),
    max: Math.max(1, Number(s.games_max_bet) || 10000),
  };
}

/** What the player may see of one of their bets. Step games only show hidden info once the round is over. */
function betView(b) {
  const g = GAMES[b.game];
  const state = parse(b.state);
  const done = b.status !== 'active';
  const out = {
    id: b.id, game: b.game, name: g ? g.name : b.game, amount: b.amount, payout: b.payout, multiplier: b.multiplier,
    status: b.status, params: parse(b.params), created_at: b.created_at, settled_at: b.settled_at,
  };
  if (g && !g.timed) {
    if (g.round) out.view = g.view(state, done);
    else out.result = state.result || null;
  }
  return out;
}

/** Pay out a finished step-game bet (inside a transaction). */
async function settle(t, bet, mult, payoutCents) {
  const payout = payoutCents !== undefined ? payoutCents : Math.floor(bet.amount * mult + 1e-9);
  const realMult = bet.amount ? Math.round((payout / bet.amount) * 10000) / 10000 : 0;
  if (payout > 0) await credit(t, bet.user_id, payout, 'win', `${GAMES[bet.game].name} win (${realMult}×)`);
  return { payout, mult: realMult };
}

router.get('/config', async (_req, res) => {
  const l = await limits();
  res.json({
    ...l,
    games: Object.entries(GAMES).map(([id, g]) => ({ id, name: g.name, rtp: g.rtp, timed: !!g.timed, round: !!g.round })),
    tables: {
      plinko: GAMES.plinko.PAYS, keno: GAMES.keno.PAY, diamonds: GAMES.diamonds.PAY,
      towers: GAMES.towers.LEVELS, pump: GAMES.pump.LEVELS, roulette_reds: GAMES.roulette.REDS,
      videopoker: GAMES.videopoker.PAYS, cases: GAMES.cases.TABLE,
      wheel: Object.fromEntries(['low', 'medium', 'high'].map((r) => [r, Object.fromEntries([10, 20, 30, 40, 50].map((n) => [n, GAMES.wheel.slices(r, n)]))])),
    },
  });
});

/* Settled bets from everyone, newest first. ?view=big lists this week's biggest wins instead. */
router.get('/live', async (req, res) => {
  const game = GAMES[req.query.game] ? req.query.game : null;
  const big = req.query.view === 'big';
  const p = pageOf(req.query, 15);
  const where = ["b.status = 'settled'"];
  const params = [];
  if (game) { where.push('b.game = ?'); params.push(game); }
  if (big) { where.push('b.payout > b.amount', 'b.settled_at > ?'); params.push(Date.now() - 7 * 24 * 60 * 60 * 1000); }
  const rows = await db.all(`SELECT b.game, b.amount, b.payout, b.multiplier, b.settled_at, u.username, u.avatar_color
    FROM bets b JOIN users u ON u.id = b.user_id WHERE ${where.join(' AND ')}
    ORDER BY ${big ? '(b.payout - b.amount) DESC, b.settled_at DESC' : 'b.settled_at DESC'} LIMIT ? OFFSET ?`, ...params, p.limit + 1, p.offset);
  const mask = (n) => (n.length <= 3 ? `${n[0]}**` : n.slice(0, 2) + '*'.repeat(Math.min(4, n.length - 3)) + n.slice(-1));
  res.json(pageRows(rows.map((r) => ({ ...r, name: GAMES[r.game] ? GAMES[r.game].name : r.game, username: mask(r.username) })), p, 'bets'));
});

router.get('/rounds/:game', async (req, res) => {
  if (!rounds.TIMED.includes(req.params.game)) return bad(res, 'Unknown game.', 404);
  res.json(await rounds.view(req.params.game, req.user ? req.user.id : null));
});

/* Everything below needs an account. */
router.use(requireUser);

async function userJSON(id) {
  return publicUser(await db.get('SELECT * FROM users WHERE id = ?', id));
}

router.post('/rounds/:game/bet', betLimiter, async (req, res) => {
  const game = req.params.game;
  if (!rounds.TIMED.includes(game)) return bad(res, 'Unknown game.', 404);
  const l = await limits();
  if (!l.enabled && req.user.role !== 'admin') return bad(res, 'Games are switched off right now.', 503);
  const amount = Math.floor(Number(req.body.amount));
  if (!Number.isFinite(amount) || amount < l.min) return bad(res, `The minimum bet is ${money(l.min)}.`);
  if (amount > l.max) return bad(res, `The maximum bet is ${money(l.max)}.`);
  try {
    await rounds.placeBet(req.user.id, game, amount, req.body.params || {});
  } catch (err) {
    if (err instanceof GameError) return bad(res, err.message);
    throw err;
  }
  res.json({ ...(await rounds.view(game, req.user.id)), user: await userJSON(req.user.id) });
});

router.post('/rounds/crash/cashout', betLimiter, async (req, res) => {
  try {
    await rounds.cashout(req.user.id);
  } catch (err) {
    if (err instanceof GameError) return bad(res, err.message);
    throw err;
  }
  res.json({ ...(await rounds.view('crash', req.user.id)), user: await userJSON(req.user.id) });
});

router.get('/active', async (req, res) => {
  const rows = await db.all("SELECT * FROM bets WHERE user_id = ? AND status = 'active' AND round_id IS NULL ORDER BY id DESC LIMIT 20", req.user.id);
  res.json({ bets: rows.map(betView) });
});

router.get('/bets', async (req, res) => {
  const game = GAMES[req.query.game] ? req.query.game : null;
  const p = pageOf(req.query, 15);
  const rows = await db.all(`SELECT * FROM bets WHERE user_id = ? ${game ? 'AND game = ?' : ''} ORDER BY id DESC LIMIT ? OFFSET ?`,
    req.user.id, ...(game ? [game] : []), p.limit + 1, p.offset);
  res.json(pageRows(rows.map(betView), p, 'bets'));
});

router.post('/:game/bet', betLimiter, async (req, res) => {
  const g = GAMES[req.params.game];
  if (!g) return bad(res, 'Unknown game.', 404);
  if (g.timed) return bad(res, 'This game runs on a timer: bet through /rounds.', 400);
  const l = await limits();
  if (!l.enabled && req.user.role !== 'admin') return bad(res, 'Games are switched off right now.', 503);
  let params;
  try { params = g.check(req.body.params || {}, { amount: Math.floor(Number(req.body.amount)), min: l.min }); } catch (err) { return bad(res, err instanceof GameError ? err.message : 'Invalid bet.'); }
  const amount = g.stake ? g.stake(params) : Math.floor(Number(req.body.amount));
  if (!Number.isFinite(amount) || amount < l.min) return bad(res, `The minimum bet is ${money(l.min)}.`);
  if (amount > l.max) return bad(res, `The maximum bet is ${money(l.max)}.`);
  if (g.round && await db.get("SELECT 1 AS x FROM bets WHERE user_id = ? AND game = ? AND status = 'active' AND round_id IS NULL", req.user.id, req.params.game)) {
    return bad(res, `Finish your current ${g.name} round first.`);
  }

  let bet;
  try {
    bet = await db.tx(async (t) => {
      if (!(await debit(t, req.user.id, amount, 'bet', `${g.name} bet`))) throw new GameError('Not enough balance for that bet.');
      const rng = makeRng();
      const now = Date.now();
      let state;
      let finished = null;
      if (g.round) {
        state = g.start(rng, params);
        finished = g.instant ? g.instant(state) : null;
        if (finished) state = finished.state;
      } else {
        const r = g.play(rng, params);
        state = { result: r.result };
        finished = { mult: r.mult, payoutCents: r.payoutCents };
      }
      const row = await t.get(`INSERT INTO bets (user_id, game, amount, status, params, state, server_seed, server_hash, client_seed, nonce, created_at)
        VALUES (?, ?, ?, 'active', ?, ?, '', '', '', 0, ?) RETURNING *`, req.user.id, req.params.game, amount, JSON.stringify(params), JSON.stringify(state), now);
      if (!finished) return row;
      const paid = await settle(t, row, finished.mult, finished.payoutCents);
      return t.get("UPDATE bets SET status = 'settled', payout = ?, multiplier = ?, settled_at = ? WHERE id = ? RETURNING *", paid.payout, paid.mult, now, row.id);
    });
  } catch (err) {
    if (err instanceof GameError) return bad(res, err.message);
    throw err;
  }
  res.json({ bet: betView(bet), user: await userJSON(req.user.id) });
});

router.post('/bets/:id/action', betLimiter, async (req, res) => {
  const id = Math.floor(Number(req.params.id));
  const action = String(req.body.action || '');
  const result = await runAction(req.user.id, id, action, req.body.params || {});
  if (result.error) return bad(res, result.error, result.code || 400);
  res.json({ bet: betView(result.bet), user: await userJSON(req.user.id) });
});

class Retry extends Error {}

/** Apply one move to a step game. Uses the row's version number so two clicks can't both count. */
async function runAction(userId, id, action, params) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const b = await db.get('SELECT * FROM bets WHERE id = ? AND user_id = ?', id, userId);
    if (!b || b.round_id) return { error: 'Round not found.', code: 404 };
    if (b.status !== 'active') return { bet: b }; // already over: just show it
    const g = GAMES[b.game];
    const state = parse(b.state);
    try {
      return await db.tx(async (t) => {
        let amount = b.amount;
        if (b.game === 'blackjack' && action === 'double') {
          const main = state.main || b.amount; // only the main bet doubles, never the side bets
          if (!(await debit(t, userId, main, 'bet', 'Blackjack double'))) throw new GameError('Not enough balance to double.');
          amount = b.amount + main;
        }
        const res = g.act(makeRng(), state, action, params);
        const upd = await t.run('UPDATE bets SET state = ?, amount = ?, version = version + 1 WHERE id = ? AND version = ? AND status = ?',
          JSON.stringify(res.state), amount, b.id, b.version, 'active');
        if (upd.changes !== 1) throw new Retry();
        if (!res.done) return { bet: await t.get('SELECT * FROM bets WHERE id = ?', b.id) };
        const paid = await settle(t, { ...b, amount }, res.mult, res.payoutCents);
        return { bet: await t.get("UPDATE bets SET status = 'settled', payout = ?, multiplier = ?, settled_at = ? WHERE id = ? RETURNING *", paid.payout, paid.mult, Date.now(), b.id) };
      });
    } catch (err) {
      if (err instanceof Retry) continue;
      if (err instanceof GameError) return { error: err.message };
      throw err;
    }
  }
  return { error: 'That move clashed with another one. Try again.', code: 409 };
}

/** Timed rounds finish on their own, even if nobody is watching them. */
async function sweepRounds() {
  await rounds.sweep();
}

module.exports = { router, sweepRounds, GAMES };
