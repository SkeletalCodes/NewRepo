'use strict';

/*
 * Timed rounds: Double and Crash. Everyone in a round sees the same betting window, the same spin or
 * rocket and the same bets. Rounds move forward when someone asks for them (serverless hosts have no
 * timers): any request that finds a round past its time finishes it and settles its bets.
 *
 *   betting   BET_MS long      players place bets (Double: several colours, Crash: one bet)
 *   playing   SPIN_MS / climb  nobody can bet; Crash players can cash out until it crashes
 *   done                       bets are settled and the next betting window opens
 */

const { db, debit, credit } = require('../db');
const { GAMES, GameError, doubleColor, DOUBLE_PAYS, CRASH_RATE, crashPoint } = require('./logic');
const { makeRng } = require('./rng');

const BET_MS = Number(process.env.ROUND_BET_MS) || 10_000;
const SPIN_MS = Number(process.env.ROUND_SPIN_MS) || 6_000;
const TIMED = ['double', 'crash'];
const parse = (json) => { try { return JSON.parse(json); } catch { return {}; } };
const floor2 = (x) => Math.floor(x * 100) / 100;

/** The result is decided when the round is opened and stays hidden until the round is done. */
function newResult(game) {
  const rng = makeRng();
  if (game === 'double') { const n = rng.int(15); return { n, color: doubleColor(n) }; }
  return { crash: crashPoint(rng) };
}

const latest = (game) => db.get('SELECT * FROM rounds WHERE game = ? ORDER BY seq DESC LIMIT 1', game);

/** Open the next betting window. Two requests racing for the same round number: one insert wins. */
async function startNext(game, prev, now) {
  await db.run(`INSERT INTO rounds (game, seq, phase, bet_end, bets_n, result) VALUES (?, ?, 'betting', ?, 0, ?)
    ON CONFLICT (game, seq) DO NOTHING`, game, prev ? prev.seq + 1 : 1, now + BET_MS, JSON.stringify(newResult(game)));
}

/** Settle a round that has reached its end. Only the request that flips playing -> done pays anyone. */
async function finish(r, now) {
  const res = parse(r.result);
  await db.tx(async (t) => {
    const up = await t.run("UPDATE rounds SET phase = 'done', settled_at = ? WHERE id = ? AND phase = 'playing'", now, r.id);
    if (up.changes !== 1) return;
    const bets = await t.all("SELECT * FROM bets WHERE round_id = ? AND status = 'active'", r.id);
    for (const b of bets) {
      const side = parse(b.state);
      let mult = 0;
      if (r.game === 'double') mult = side.side === res.color ? DOUBLE_PAYS[side.side] : 0;
      else if (side.auto && side.auto < res.crash) mult = side.auto; // the auto cash-out fired before the crash
      const payout = Math.floor(b.amount * mult + 1e-9);
      const real = b.amount ? Math.round((payout / b.amount) * 10000) / 10000 : 0;
      const won = await t.run("UPDATE bets SET status = 'settled', payout = ?, multiplier = ?, settled_at = ? WHERE id = ? AND status = 'active'", payout, real, now, b.id);
      if (won.changes === 1 && payout > 0) await credit(t, b.user_id, payout, 'win', `${GAMES[r.game].name} win (${real}×)`);
    }
  });
}

/** Move a game's latest round forward as far as the clock says. `create` also opens the next betting window. */
async function advance(game, { create }) {
  for (let i = 0; i < 5; i++) {
    const now = Date.now();
    const r = await latest(game);
    if (!r) { if (!create) return null; await startNext(game, null, now); continue; }
    if (r.phase === 'betting' && now >= r.bet_end) {
      const playAt = r.bet_end; // the clock started when betting closed, not when we noticed
      const endAt = game === 'double' ? playAt + SPIN_MS : playAt + Math.ceil(Math.log(parse(r.result).crash) / CRASH_RATE);
      await db.run("UPDATE rounds SET phase = 'playing', play_at = ?, end_at = ? WHERE id = ? AND phase = 'betting'", playAt, endAt, r.id);
      continue;
    }
    if (r.phase === 'playing' && now >= r.end_at) { await finish(r, now); continue; }
    if (r.phase === 'done' && create) { await startNext(game, r, now); continue; }
    return r;
  }
  return latest(game);
}

/** What the client may see. The crash point and the colour stay hidden until the round is done. */
async function view(game, userId) {
  const r = await advance(game, { create: true });
  const now = Date.now();
  const bets = r ? await db.all(`SELECT b.id, b.user_id, b.amount, b.status, b.payout, b.multiplier, b.state, u.username, u.avatar_color
    FROM bets b JOIN users u ON u.id = b.user_id WHERE b.round_id = ? ORDER BY b.id DESC LIMIT 200`, r.id) : [];
  const history = await db.all("SELECT seq, result FROM rounds WHERE game = ? AND phase = 'done' ORDER BY seq DESC LIMIT 30", game);
  return {
    now,
    round: r && {
      id: r.id, seq: r.seq, phase: r.phase, betEnd: r.bet_end, playAt: r.play_at, endAt: r.end_at,
      // the climb is public: the multiplier is only the time since launch, never the crash point
      mult: game === 'crash' && r.phase === 'playing' ? floor2(Math.exp(CRASH_RATE * (now - r.play_at))) : undefined,
      rate: game === 'crash' ? CRASH_RATE : undefined,
      result: r.phase === 'done' ? parse(r.result) : undefined,
    },
    history: history.map((h) => ({ seq: h.seq, result: parse(h.result) })),
    bets: bets.map((b) => {
      const s = parse(b.state);
      return {
        id: b.id, userId: b.user_id, username: b.username, avatar: b.avatar_color, amount: b.amount,
        status: b.status, payout: b.payout, multiplier: b.multiplier, side: s.side || null, auto: s.auto || null,
        mine: b.user_id === userId,
      };
    }),
  };
}

/** Put a bet into the betting window. Amount is in cents and has already been checked against the limits. */
async function placeBet(userId, game, amount, params) {
  const r = await advance(game, { create: true });
  if (!r || r.phase !== 'betting' || Date.now() >= r.bet_end) throw new GameError('Betting is closed. The next round opens in a moment.');
  let side = null;
  let auto = 0;
  if (game === 'double') {
    side = ['red', 'black', 'green'].includes(params.side) ? params.side : null;
    if (!side) throw new GameError('Pick red, black or green.');
  } else {
    const a = params.auto === undefined || params.auto === null || params.auto === '' ? 0 : floor2(Number(params.auto));
    if (a && !(a >= 1.01 && a <= 1000)) throw new GameError('Auto cash out must be between 1.01× and 1,000×.');
    auto = a;
  }
  return db.tx(async (t) => {
    // the counter update doubles as a lock: once the round has moved on, this matches nothing
    const lock = await t.run("UPDATE rounds SET bets_n = bets_n + 1 WHERE id = ? AND phase = 'betting'", r.id);
    if (lock.changes !== 1) throw new GameError('Betting just closed for this round.');
    if (game === 'crash' && (await t.get('SELECT 1 AS x FROM bets WHERE round_id = ? AND user_id = ?', r.id, userId))) {
      throw new GameError("You're already in this round.");
    }
    if (!(await debit(t, userId, amount, 'bet', `${GAMES[game].name} bet`))) throw new GameError('Not enough balance for that bet.');
    return t.get(`INSERT INTO bets (user_id, game, amount, status, params, state, server_seed, server_hash, client_seed, nonce, created_at, round_id)
      VALUES (?, ?, ?, 'active', ?, ?, '', '', '', 0, ?, ?) RETURNING *`,
    userId, game, amount, JSON.stringify(params), JSON.stringify({ side, auto }), Date.now(), r.id);
  });
}

/** Cash out of the rocket. The multiplier is the server's clock, and it must still be climbing. */
async function cashout(userId) {
  const r = await advance('crash', { create: false });
  const now = Date.now();
  if (!r || r.phase !== 'playing') throw new GameError('The rocket is not flying right now.');
  const raw = Math.exp(CRASH_RATE * (now - r.play_at));
  if (now >= r.end_at || raw >= parse(r.result).crash) throw new GameError('Too late: it has already crashed.');
  const m = floor2(raw);
  return db.tx(async (t) => {
    const b = await t.get("SELECT * FROM bets WHERE round_id = ? AND user_id = ? AND status = 'active'", r.id, userId);
    if (!b) throw new GameError('You have no bet in this round.');
    const payout = Math.floor(b.amount * m + 1e-9);
    const up = await t.run("UPDATE bets SET status = 'settled', payout = ?, multiplier = ?, settled_at = ? WHERE id = ? AND status = 'active'", payout, m, now, b.id);
    if (up.changes !== 1) throw new GameError('That bet is already settled.');
    await credit(t, userId, payout, 'win', `Crash win (${m}×)`);
    return m;
  });
}

/** Called from the server's housekeeping: finishes rounds whose time is up, even if nobody is watching. */
async function sweep() {
  for (const game of TIMED) await advance(game, { create: false });
}

module.exports = { BET_MS, SPIN_MS, TIMED, view, placeBet, cashout, sweep };
