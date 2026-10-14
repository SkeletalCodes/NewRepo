'use strict';

/*
 * Game rules, ported from the original site so odds and pay tables match exactly.
 * Everything here is pure: given a number stream (rng) and the player's choices, work out the result.
 *
 * Instant games:  play(rng, params) -> { mult, result }
 * Round games:    start(rng, params) -> state
 *                 act(rng, state, action, params) -> { state, done?, mult? }  (rng resumes where the last call stopped)
 *                 view(state, done) -> what the player is allowed to see (never hidden mines, traps, hole cards...)
 * Every game also has check(params) which validates and normalises the player's choices (throws GameError).
 */

class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };
const floor2 = (x) => Math.floor(x * 100) / 100;
const pickOne = (v, list, name) => (list.includes(v) ? v : fail(`Choose a valid ${name}.`));

/* ------------------------------------------------------------------ cards */

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];
/** Infinite deck: each card is an independent draw. i = rank index (0 = ace ... 12 = king). */
function card(rng) {
  const n = rng.int(52);
  const si = Math.floor(n / 13);
  return { i: n % 13, r: RANKS[n % 13], s: SUITS[si], red: si === 1 || si === 2 };
}

/* ------------------------------------------------------------- instant */

const dice = {
  name: 'Dice', rtp: 99,
  check(p) {
    const target = Math.round(Number(p.target));
    if (!(target >= 2 && target <= 98)) fail('Target must be between 2 and 98.');
    return { target, mode: pickOne(p.mode, ['under', 'over'], 'direction') };
  },
  play(rng, { target, mode }) {
    const chance = mode === 'under' ? target : 100 - target;
    const m = Math.floor((99 / chance) * 10000) / 10000;
    const roll = Math.floor(rng.float() * 10001) / 100;
    const won = mode === 'under' ? roll < target : roll > target;
    return { mult: won ? m : 0, result: { roll, won, chance, payoutMult: m } };
  },
  verify: (rng) => [['Roll', (Math.floor(rng.float() * 10001) / 100).toFixed(2)]],
};

const limbo = {
  name: 'Limbo', rtp: 99,
  check(p) {
    const target = floor2(Number(p.target));
    if (!(target >= 1.01 && target <= 1000000)) fail('Target must be between 1.01× and 1,000,000×.');
    return { target };
  },
  play(rng, { target }) {
    const result = Math.min(1000000, Math.max(1, Math.floor(99 / (1 - rng.float())) / 100));
    return { mult: result >= target ? target : 0, result: { value: result } };
  },
  verify(rng) {
    const v = Math.min(1000000, Math.max(1, Math.floor(99 / (1 - rng.float())) / 100));
    return [['Result', `${v >= 10000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2)}×`], ['You win if', 'the result is at or above your target']];
  },
};

const STREAK = { low: 1, medium: 2, high: 3, extreme: 5 };
const coinflip = {
  name: 'Coin Flip', rtp: 99,
  check(p) {
    return { side: pickOne(p.side, ['heads', 'tails'], 'side'), risk: pickOne(p.risk || 'low', Object.keys(STREAK), 'risk level') };
  },
  play(rng, { side, risk }) {
    const n = STREAK[risk];
    const flips = [];
    for (let i = 0; i < n; i++) flips.push(rng.float() < 0.5 ? 'heads' : 'tails');
    const miss = flips.findIndex((f) => f !== side);
    const won = miss < 0;
    return { mult: won ? floor2(0.99 * 2 ** n) : 0, result: { flips: won ? flips : flips.slice(0, miss + 1), need: n } };
  },
  verify(rng) {
    const flips = [];
    for (let i = 0; i < 5; i++) flips.push(rng.float() < 0.5 ? 'Skull' : 'Bones');
    return [['Flips in order', flips.join('  ·  ')], ['How to read it', 'Skull is heads, bones is tails. A streak of N uses the first N flips and stops at the first miss.']];
  },
};

const doubleColor = (n) => (n === 0 ? 'green' : n <= 7 ? 'red' : 'black');
const DOUBLE_PAYS = { red: 2, green: 14, black: 2 };
const double = {
  name: 'Double', rtp: 93.3,
  check(p) { return { pick: pickOne(p.pick, ['red', 'black', 'green'], 'colour') }; },
  play(rng, { pick }) {
    const n = rng.int(15);
    const color = doubleColor(n);
    return { mult: color === pick ? DOUBLE_PAYS[pick] : 0, result: { n, color } };
  },
  verify(rng) {
    const n = rng.int(15);
    const c = doubleColor(n);
    return [['Number drawn (0-14)', String(n)], ['Colour', `${c[0].toUpperCase()}${c.slice(1)} — pays ${DOUBLE_PAYS[c]}×`]];
  },
};

const DIAMOND_PAY = {
  low: { five: 25, four: 4, full: 3.5, three: 2.1, twopair: 1.6, pair: 0.55, none: 0 },
  medium: { five: 50, four: 5, full: 4, three: 3, twopair: 2, pair: 0.1, none: 0 },
  high: { five: 120, four: 10, full: 5, three: 3, twopair: 1.65, pair: 0, none: 0 },
};
const DIAMOND_SHAPE = { 5: 'five', 41: 'four', 32: 'full', 311: 'three', 221: 'twopair', 2111: 'pair', 11111: 'none' };
const diamonds = {
  name: 'Diamonds', rtp: 98.4, PAY: DIAMOND_PAY,
  check(p) { return { risk: pickOne(p.risk || 'medium', Object.keys(DIAMOND_PAY), 'risk level') }; },
  play(rng, { risk }) {
    const gems = [];
    for (let i = 0; i < 5; i++) gems.push(rng.int(7));
    const count = {};
    gems.forEach((g) => { count[g] = (count[g] || 0) + 1; });
    const hand = DIAMOND_SHAPE[Object.values(count).sort((a, b) => b - a).join('')];
    return { mult: DIAMOND_PAY[risk][hand], result: { gems, hand } };
  },
  verify(rng) {
    const { result } = diamonds.play(rng, { risk: 'medium' });
    const names = ['Red', 'Green', 'Blue', 'Amber', 'Purple', 'Cyan', 'Pink'];
    const hands = { five: 'Five of a kind', four: 'Four of a kind', full: 'Full house', three: 'Three of a kind', twopair: 'Two pairs', pair: 'One pair', none: 'No match' };
    return [['Gems drawn, left to right', result.gems.map((i) => names[i]).join(', ')], ['Hand', hands[result.hand]]];
  },
};

const WHEEL_BASE = {
  low: [1.5, 1.2, 1.2, 1.2, 0, 1.2, 1.2, 1.2, 1.2, 0],
  medium: [0, 1.9, 0, 1.5, 0, 2, 0, 1.5, 0, 3],
};
function wheelSlices(risk, n) {
  if (risk === 'high') { const a = new Array(n).fill(0); a[0] = Math.round(0.99 * n * 100) / 100; return a; }
  return Array.from({ length: n }, (_, i) => WHEEL_BASE[risk][i % 10]);
}
const wheel = {
  name: 'Wheel', rtp: 99, slices: wheelSlices,
  check(p) {
    return { risk: pickOne(p.risk || 'medium', ['low', 'medium', 'high'], 'risk level'), segments: pickOne(Number(p.segments || 30), [10, 20, 30, 40, 50], 'number of segments') };
  },
  play(rng, { risk, segments }) {
    const list = wheelSlices(risk, segments);
    const index = rng.int(segments);
    return { mult: list[index], result: { index } };
  },
  verify(rng) {
    const f = rng.float();
    return [['Winning slice (counted clockwise from the top)', [10, 20, 30, 40, 50].map((n) => `${n} slices: #${Math.floor(f * n) + 1}`).join('  ·  ')]];
  },
};

const PLINKO_PAYS = {
  8: {
    low: [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6],
    medium: [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
    high: [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29],
  },
  12: {
    low: [10, 3, 1.6, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 1.6, 3, 10],
    medium: [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33],
    high: [170, 24, 8.1, 2, 0.7, 0.2, 0.2, 0.2, 0.7, 2, 8.1, 24, 170],
  },
  16: {
    low: [16, 9, 2, 1.4, 1.4, 1.2, 1.1, 1, 0.5, 1, 1.1, 1.2, 1.4, 1.4, 2, 9, 16],
    medium: [110, 41, 10, 5, 3, 1.5, 1, 0.5, 0.3, 0.5, 1, 1.5, 3, 5, 10, 41, 110],
    high: [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000],
  },
};
const plinko = {
  name: 'Plinko', rtp: 99, PAYS: PLINKO_PAYS,
  check(p) {
    return { rows: pickOne(Number(p.rows || 12), [8, 12, 16], 'number of rows'), risk: pickOne(p.risk || 'medium', ['low', 'medium', 'high'], 'risk level') };
  },
  play(rng, { rows, risk }) {
    const path = [];
    for (let i = 0; i < rows; i++) path.push(rng.float() < 0.5 ? 0 : 1);
    const bucket = path.reduce((a, b) => a + b, 0);
    return { mult: PLINKO_PAYS[rows][risk][bucket], result: { path, bucket } };
  },
  verify(rng) {
    const path = [];
    for (let i = 0; i < 16; i++) path.push(rng.float() < 0.5 ? 0 : 1);
    const at = (n) => path.slice(0, n).reduce((a, b) => a + b, 0) + 1;
    return [['Path (top peg first)', path.map((d) => (d ? 'R' : 'L')).join('')], ['Bucket, counted from the left', `8 rows: ${at(8)}  ·  12 rows: ${at(12)}  ·  16 rows: ${at(16)}`]];
  },
};

const KENO_PAY = {
  low: {
    1: [0.7, 1.85], 2: [0, 2, 3.8], 3: [0, 1.1, 1.38, 26], 4: [0, 0, 2.2, 7.9, 90], 5: [0, 0, 1.5, 4.2, 13, 300],
    6: [0, 0, 1.1, 2, 6.2, 100, 700], 7: [0, 0, 1.1, 1.6, 3.5, 15, 225, 700], 8: [0, 0, 1.1, 1.5, 2, 5.5, 39, 100, 800],
    9: [0, 0, 1.1, 1.3, 1.7, 2.5, 7.5, 50, 250, 1000], 10: [0, 0, 1.1, 1.2, 1.3, 1.8, 3.5, 13, 50, 250, 1000],
  },
  medium: {
    1: [0.4, 2.75], 2: [0, 1.8, 5.1], 3: [0, 0, 2.8, 50], 4: [0, 0, 1.7, 10, 100], 5: [0, 0, 1.4, 4, 14, 390],
    6: [0, 0, 0, 3, 9, 180, 710], 7: [0, 0, 0, 2, 7, 30, 400, 800], 8: [0, 0, 0, 2, 4, 11, 67, 400, 900],
    9: [0, 0, 0, 2, 2.5, 5, 15, 100, 500, 1000], 10: [0, 0, 0, 1.6, 2, 4, 7, 26, 100, 500, 1000],
  },
  high: {
    1: [0, 3.96], 2: [0, 0, 17.1], 3: [0, 0, 0, 81.5], 4: [0, 0, 0, 10, 259], 5: [0, 0, 0, 4.5, 48, 450],
    6: [0, 0, 0, 0, 11, 350, 710], 7: [0, 0, 0, 0, 7, 90, 400, 800], 8: [0, 0, 0, 0, 5, 20, 270, 600, 900],
    9: [0, 0, 0, 0, 4, 11, 56, 500, 800, 1000], 10: [0, 0, 0, 0, 3.5, 8, 13, 63, 500, 800, 1000],
  },
};
const keno = {
  name: 'Keno', rtp: 99, PAY: KENO_PAY,
  check(p) {
    const picks = [...new Set((Array.isArray(p.picks) ? p.picks : []).map(Number))];
    if (picks.length < 1 || picks.length > 10 || !picks.every((n) => Number.isInteger(n) && n >= 1 && n <= 40)) fail('Pick between 1 and 10 numbers from 1 to 40.');
    return { picks: picks.sort((a, b) => a - b), risk: pickOne(p.risk || 'medium', ['low', 'medium', 'high'], 'risk level') };
  },
  play(rng, { picks, risk }) {
    const pool = Array.from({ length: 40 }, (_, i) => i + 1);
    const drawn = [];
    for (let i = 0; i < 10; i++) drawn.push(rng.pick(pool));
    const hits = drawn.filter((n) => picks.includes(n)).length;
    return { mult: KENO_PAY[risk][picks.length][hits], result: { drawn, hits } };
  },
  verify(rng) {
    const pool = Array.from({ length: 40 }, (_, i) => i + 1);
    const drawn = [];
    for (let i = 0; i < 10; i++) drawn.push(rng.pick(pool));
    return [['Numbers drawn, in order', drawn.join(', ')]];
  },
};

const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const ROULETTE_KEYS = new Set(['red', 'black', 'even', 'odd', 'low', 'high', 'doz1', 'doz2', 'doz3', 'col1', 'col2', 'col3',
  ...Array.from({ length: 37 }, (_, n) => `n_${n}`)]);
function rouletteWins(key, n) {
  if (key.startsWith('n_')) return Number(key.slice(2)) === n;
  if (n === 0) return false;
  switch (key) {
    case 'red': return REDS.has(n);
    case 'black': return !REDS.has(n);
    case 'even': return n % 2 === 0;
    case 'odd': return n % 2 === 1;
    case 'low': return n <= 18;
    case 'high': return n >= 19;
    case 'doz1': return n <= 12;
    case 'doz2': return n > 12 && n <= 24;
    case 'doz3': return n > 24;
    case 'col1': return n % 3 === 1;
    case 'col2': return n % 3 === 2;
    case 'col3': return n % 3 === 0;
    default: return false;
  }
}
const roulettePays = (key) => (key.startsWith('n_') ? 36 : /^(doz|col)/.test(key) ? 3 : 2);
const roulette = {
  name: 'Roulette', rtp: 97.3, REDS: [...REDS],
  /** The stake is the sum of the chips, so roulette works out its own amount. */
  check(p) {
    const chips = {};
    for (const [k, v] of Object.entries(p.chips || {})) {
      const c = Math.floor(Number(v));
      if (!ROULETTE_KEYS.has(k)) fail('Unknown spot on the table.');
      if (!(c > 0)) continue;
      chips[k] = c;
    }
    if (!Object.keys(chips).length) fail('Place at least one chip on the table.');
    return { chips };
  },
  stake: (params) => Object.values(params.chips).reduce((a, b) => a + b, 0),
  play(rng, { chips }) {
    const n = rng.int(37);
    const total = Object.values(chips).reduce((a, b) => a + b, 0);
    let back = 0;
    for (const [k, c] of Object.entries(chips)) if (rouletteWins(k, n)) back += c * roulettePays(k);
    return { mult: back / total, payoutCents: back, result: { n, color: n === 0 ? 'green' : REDS.has(n) ? 'red' : 'black' } };
  },
  verify(rng) { const n = rng.int(37); return [['Winning number', `${n} (${n === 0 ? 'green' : REDS.has(n) ? 'red' : 'black'})`]]; },
};

const baccaratVal = (c) => (c.i === 0 ? 1 : c.i >= 9 ? 0 : c.i + 1);
const baccaratTotal = (cs) => cs.reduce((a, c) => a + baccaratVal(c), 0) % 10;
const BACCARAT_PAYS = { player: 2, tie: 9, banker: 1.95 };
const baccarat = {
  name: 'Baccarat', rtp: 98.9,
  check(p) { return { side: pickOne(p.side, ['player', 'banker', 'tie'], 'side') }; },
  play(rng, { side }) {
    const draw = () => card(rng);
    const p = [draw()];
    const b = [draw()];
    p.push(draw()); b.push(draw());
    if (baccaratTotal(p) < 8 && baccaratTotal(b) < 8) {
      let p3 = null;
      if (baccaratTotal(p) <= 5) { p3 = draw(); p.push(p3); }
      const bt = baccaratTotal(b);
      const v = p3 ? baccaratVal(p3) : -1;
      const bankerDraws = p3 === null ? bt <= 5
        : bt <= 2 || (bt === 3 && v !== 8) || (bt === 4 && v >= 2 && v <= 7) || (bt === 5 && v >= 4 && v <= 7) || (bt === 6 && (v === 6 || v === 7));
      if (bankerDraws) b.push(draw());
    }
    const pt = baccaratTotal(p);
    const bt = baccaratTotal(b);
    const winner = pt > bt ? 'player' : bt > pt ? 'banker' : 'tie';
    const mult = winner === side ? BACCARAT_PAYS[side] : winner === 'tie' ? 1 : 0;
    return { mult, result: { player: p, banker: b, pt, bt, winner } };
  },
  verify(rng) {
    const { result: r } = baccarat.play(rng, { side: 'player' });
    const txt = (cs) => cs.map((c) => c.r + c.s).join('  ');
    return [['Player hand', `${txt(r.player)}  = ${r.pt}`], ['Banker hand', `${txt(r.banker)}  = ${r.bt}`],
      ['Result', r.winner === 'tie' ? 'Tie' : `${r.winner === 'player' ? 'Player' : 'Banker'} wins`]];
  },
};

/* ---------------------------------------------------------------- rounds */

const MINES_N = 25;
const minesMult = (k, m) => { let x = 1; for (let i = 0; i < k; i++) x *= (MINES_N - i) / (MINES_N - m - i); return floor2(x * 0.99); };
const mines = {
  name: 'Mines', rtp: 99, round: true, mult: minesMult,
  check(p) {
    const m = Math.floor(Number(p.mines));
    if (!(m >= 1 && m <= 24)) fail('Choose between 1 and 24 mines.');
    return { mines: m };
  },
  start(rng, { mines: m }) {
    const pool = Array.from({ length: MINES_N }, (_, i) => i);
    const layout = [];
    for (let i = 0; i < m; i++) layout.push(rng.pick(pool));
    return { m, layout, revealed: [] };
  },
  act(rng, s, action, p) {
    if (action === 'cashout') {
      if (!s.revealed.length) fail('Reveal at least one tile first.');
      return { state: s, done: true, mult: minesMult(s.revealed.length, s.m) };
    }
    if (action !== 'reveal') fail('Unknown move.');
    const tile = Math.floor(Number(p.tile));
    if (!(tile >= 0 && tile < MINES_N)) fail('Pick a tile on the board.');
    if (s.revealed.includes(tile)) fail('That tile is already open.');
    if (s.layout.includes(tile)) return { state: { ...s, hit: tile }, done: true, mult: 0 };
    const next = { ...s, revealed: [...s.revealed, tile] };
    if (next.revealed.length === MINES_N - s.m) return { state: next, done: true, mult: minesMult(next.revealed.length, s.m) };
    return { state: next };
  },
  view(s, done) {
    return { mines: s.m, revealed: s.revealed, multiplier: s.revealed.length ? minesMult(s.revealed.length, s.m) : 1,
      next: minesMult(s.revealed.length + 1, s.m), ...(done ? { layout: s.layout, hit: s.hit ?? null } : {}) };
  },
  verify(rng) {
    return [['Mine order (tiles 1-25)', mines.start(rng, { mines: 24 }).layout.map((i) => i + 1).join(', ')], ['How to read it', 'An N-mine game uses the first N tiles in this list']];
  },
};

const TOWER_ROWS = 8;
const TOWER_LEVELS = { easy: { cols: 4, bombs: 1 }, medium: { cols: 3, bombs: 1 }, hard: { cols: 2, bombs: 1 }, extreme: { cols: 3, bombs: 2 } };
const towersMult = (d, k) => { const c = TOWER_LEVELS[d]; return floor2(0.98 * (c.cols / (c.cols - c.bombs)) ** k); };
const towers = {
  name: 'Towers', rtp: 98, round: true, LEVELS: TOWER_LEVELS, ROWS: TOWER_ROWS, mult: towersMult,
  check(p) { return { difficulty: pickOne(p.difficulty || 'medium', Object.keys(TOWER_LEVELS), 'difficulty') }; },
  start(rng, { difficulty }) {
    const c = TOWER_LEVELS[difficulty];
    const traps = [];
    for (let r = 0; r < TOWER_ROWS; r++) {
      const pool = Array.from({ length: c.cols }, (_, i) => i);
      const row = [];
      for (let b = 0; b < c.bombs; b++) row.push(rng.pick(pool));
      traps.push(row);
    }
    return { d: difficulty, traps, picks: [] };
  },
  act(rng, s, action, p) {
    if (action === 'cashout') {
      if (!s.picks.length) fail('Climb at least one floor first.');
      return { state: s, done: true, mult: towersMult(s.d, s.picks.length) };
    }
    if (action !== 'pick') fail('Unknown move.');
    const col = Math.floor(Number(p.col));
    if (!(col >= 0 && col < TOWER_LEVELS[s.d].cols)) fail('Pick a tile on this floor.');
    const floor = s.picks.length;
    const next = { ...s, picks: [...s.picks, col] };
    if (s.traps[floor].includes(col)) return { state: { ...next, lost: true }, done: true, mult: 0 };
    if (next.picks.length === TOWER_ROWS) return { state: next, done: true, mult: towersMult(s.d, TOWER_ROWS) };
    return { state: next };
  },
  view(s, done) {
    const safe = s.lost ? s.picks.length - 1 : s.picks.length;
    return { difficulty: s.d, picks: s.picks, floor: s.picks.length, multiplier: safe ? towersMult(s.d, safe) : 1,
      next: towersMult(s.d, safe + 1), ...(done ? { traps: s.traps } : { traps: s.traps.slice(0, s.picks.length) }) };
  },
  verify(rng, fresh) {
    const label = { easy: 'Easy', medium: 'Medium', hard: 'Hard', extreme: 'Extreme' };
    return Object.keys(TOWER_LEVELS).map((k) => [`${label[k]} — trap column per floor (1 to 8)`,
      towers.start(fresh(), { difficulty: k }).traps.map((row) => row.map((x) => x + 1).sort().join('+')).join('  ')]);
  },
};

const PUMP_N = 25;
const PUMP_LEVELS = { easy: 1, medium: 3, hard: 5, expert: 10 };
const pumpMult = (k, m) => { let x = 1; for (let i = 0; i < k; i++) x *= (PUMP_N - i) / (PUMP_N - m - i); return floor2(x * 0.98); };
const pump = {
  name: 'Pump', rtp: 98, round: true, LEVELS: PUMP_LEVELS, mult: pumpMult,
  check(p) { return { difficulty: pickOne(p.difficulty || 'medium', Object.keys(PUMP_LEVELS), 'difficulty') }; },
  start(rng, { difficulty }) {
    const m = PUMP_LEVELS[difficulty];
    const pool = Array.from({ length: PUMP_N }, (_, i) => i);
    let first = PUMP_N;
    for (let i = 0; i < m; i++) first = Math.min(first, rng.pick(pool));
    return { d: difficulty, m, safe: first, pumps: 0 };
  },
  act(rng, s, action) {
    if (action === 'cashout') {
      if (!s.pumps) fail('Pump at least once first.');
      return { state: s, done: true, mult: pumpMult(s.pumps, s.m) };
    }
    if (action !== 'pump') fail('Unknown move.');
    if (s.pumps >= s.safe) return { state: { ...s, popped: true }, done: true, mult: 0 };
    const next = { ...s, pumps: s.pumps + 1 };
    if (next.pumps === PUMP_N - s.m) return { state: next, done: true, mult: pumpMult(next.pumps, s.m) };
    return { state: next };
  },
  view(s, done) {
    return { difficulty: s.d, pumps: s.pumps, max: PUMP_N - s.m, popped: !!s.popped, multiplier: s.pumps ? pumpMult(s.pumps, s.m) : 1,
      next: pumpMult(s.pumps + 1, s.m), ...(done ? { safe: s.safe } : {}) };
  },
  verify(rng, fresh) {
    const label = { easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert' };
    return Object.keys(PUMP_LEVELS).map((k) => {
      const s = pump.start(fresh(), { difficulty: k });
      const max = PUMP_N - s.m;
      return [`${label[k]} (${s.m} in 25)`, s.safe >= max ? `Never pops — all ${max} pumps are safe` : `Pops on pump ${s.safe + 1} (${s.safe} safe)`];
    });
  },
};

function hiloCalls(i) {
  return {
    hi: i === 12 ? { label: 'Same', p: 1 / 13, wins: (n) => n === i }
      : i === 0 ? { label: 'Higher', p: 12 / 13, wins: (n) => n > i }
        : { label: 'Higher or same', p: (13 - i) / 13, wins: (n) => n >= i },
    lo: i === 0 ? { label: 'Same', p: 1 / 13, wins: (n) => n === i }
      : i === 12 ? { label: 'Lower', p: 12 / 13, wins: (n) => n < i }
        : { label: 'Lower or same', p: (i + 1) / 13, wins: (n) => n <= i },
  };
}
const hiloTotal = (odds) => floor2(0.99 * odds);
const hilo = {
  name: 'Hi-Lo', rtp: 99, round: true, calls: hiloCalls,
  check: () => ({}),
  start(rng) { const c = card(rng); return { cur: c, odds: 1, steps: 0, trail: [{ c, how: 'start' }] }; },
  act(rng, s, action) {
    if (action === 'cashout') {
      if (!s.steps) fail('Make at least one call first.');
      return { state: s, done: true, mult: hiloTotal(s.odds) };
    }
    if (action === 'skip') {
      const next = card(rng);
      return { state: { ...s, cur: next, trail: [...s.trail, { c: next, how: 'skip' }].slice(-40) } };
    }
    if (action !== 'hi' && action !== 'lo') fail('Unknown move.');
    const call = hiloCalls(s.cur.i)[action];
    const next = card(rng);
    const ok = call.wins(next.i);
    const odds = ok ? s.odds / call.p : s.odds;
    const st = { ...s, cur: next, odds, steps: s.steps + (ok ? 1 : 0), trail: [...s.trail, { c: next, how: action, ok, label: call.label, m: hiloTotal(odds) }].slice(-40) };
    if (!ok) return { state: { ...st, lost: true }, done: true, mult: 0 };
    return { state: st };
  },
  view(s) {
    const calls = hiloCalls(s.cur.i);
    return { card: s.cur, steps: s.steps, trail: s.trail, lost: !!s.lost, multiplier: s.lost ? 0 : s.steps ? hiloTotal(s.odds) : 1,
      options: { hi: { label: calls.hi.label, mult: hiloTotal(s.odds / calls.hi.p), chance: calls.hi.p }, lo: { label: calls.lo.label, mult: hiloTotal(s.odds / calls.lo.p), chance: calls.lo.p } } };
  },
  verify(rng) {
    const out = [];
    for (let i = 0; i < 12; i++) { const c = card(rng); out.push(c.r + c.s); }
    return [['Cards in order', out.join('  ')], ['How to read it', 'The first card is the starting card; every call or skip takes the next one. Ace is low, King is high.']];
  },
};

function bjTotal(cards) {
  let t = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.r === 'A') { aces++; t += 11; } else if (['K', 'Q', 'J', '10'].includes(c.r)) t += 10; else t += Number(c.r);
  }
  while (t > 21 && aces) { t -= 10; aces--; }
  return t;
}
function bjDealer(rng, s) {
  const dealer = [...s.dealer];
  while (bjTotal(dealer) < 17) dealer.push(card(rng));
  const p = bjTotal(s.player);
  const d = bjTotal(dealer);
  const outcome = d > 21 ? 'dealer_bust' : p > d ? 'win' : p === d ? 'push' : 'lose';
  return { state: { ...s, dealer, outcome }, done: true, mult: outcome === 'push' ? 1 : outcome === 'lose' ? 0 : 2 };
}
const blackjack = {
  name: 'Blackjack', rtp: 99.5, round: true,
  check: () => ({}),
  start(rng) {
    const player = [card(rng)];
    const dealer = [card(rng)];
    player.push(card(rng));
    dealer.push(card(rng)); // hole card, hidden until the end
    return { player, dealer, doubled: false };
  },
  /** Natural blackjacks settle immediately. */
  instant(s) {
    const pBJ = bjTotal(s.player) === 21;
    const dBJ = bjTotal(s.dealer) === 21;
    if (pBJ) return { state: { ...s, outcome: dBJ ? 'push' : 'blackjack' }, done: true, mult: dBJ ? 1 : 2.5 };
    if (dBJ) return { state: { ...s, outcome: 'dealer_blackjack' }, done: true, mult: 0 };
    return null;
  },
  act(rng, s, action) {
    if (action === 'hit') {
      const st = { ...s, player: [...s.player, card(rng)] };
      const t = bjTotal(st.player);
      if (t > 21) return { state: { ...st, outcome: 'bust' }, done: true, mult: 0 };
      if (t === 21) return bjDealer(rng, st);
      return { state: st };
    }
    if (action === 'stand') return bjDealer(rng, s);
    if (action === 'double') {
      if (s.player.length !== 2) fail('You can only double on your first two cards.');
      const st = { ...s, doubled: true, player: [...s.player, card(rng)] };
      if (bjTotal(st.player) > 21) return { state: { ...st, outcome: 'bust' }, done: true, mult: 0 };
      return bjDealer(rng, st);
    }
    fail('Unknown move.');
  },
  view(s, done) {
    return { player: s.player, playerTotal: bjTotal(s.player), doubled: s.doubled, outcome: s.outcome || null,
      dealer: done ? s.dealer : [s.dealer[0]], dealerTotal: done ? bjTotal(s.dealer) : bjTotal([s.dealer[0]]), hidden: !done };
  },
  total: bjTotal,
  verify(rng) {
    const out = [];
    for (let i = 0; i < 10; i++) { const c = card(rng); out.push(c.r + c.s); }
    return [['Cards in draw order', out.join('  ')], ['Deal order', 'you, dealer, you, dealer (face down), then each hit']];
  },
};

/** Crash: the multiplier is e^(RATE * ms) from the moment the round starts, timed on the server. */
const CRASH_RATE = 0.00009;
const crashMultAt = (ms) => Math.floor(Math.exp(CRASH_RATE * Math.max(0, ms)) * 100) / 100;
const crashTimeOf = (m) => Math.log(m) / CRASH_RATE;
const crash = {
  name: 'Crash', rtp: 99, round: true, RATE: CRASH_RATE,
  check(p) {
    const auto = p.auto === undefined || p.auto === null || p.auto === '' ? 0 : floor2(Number(p.auto));
    if (auto && !(auto >= 1.01 && auto <= 1000000)) fail('Auto cash out must be between 1.01× and 1,000,000×.');
    return { auto };
  },
  start(rng, { auto }) {
    return { at: Math.max(1, Math.floor(99 / (1 - rng.float())) / 100), auto };
  },
  /** Called with the ms since the round started (server clock). `cashout` = the player pressed the button. */
  resolve(s, elapsed, cashout) {
    const now = crashMultAt(elapsed);
    if (s.auto && s.auto <= s.at && now >= s.auto) return { done: true, mult: s.auto, state: { ...s, out: s.auto } };
    if (now >= s.at) return { done: true, mult: 0, state: { ...s, out: 0 } };
    if (cashout) return { done: true, mult: now, state: { ...s, out: now } };
    return null;
  },
  view(s, done) { return { auto: s.auto, rate: CRASH_RATE, ...(done ? { crashedAt: s.at, cashedAt: s.out || 0 } : {}) }; },
  verify: (rng) => [['Crash point', `${crash.start(rng, { auto: 0 }).at.toFixed(2)}×`]],
  multAt: crashMultAt,
  timeOf: crashTimeOf,
};

/* ------------------------------------------------------------- new games */

/** Video Poker, Jacks or Better (9/6 pay table, about 99.5% with good play). One 52-card deck:
 *  ten cards are drawn up front, the first five are dealt and the rest replace discards in order. */
const VP_PAYS = { royal: 800, straight_flush: 50, four: 25, full: 9, flush: 6, straight: 4, three: 3, two_pair: 2, jacks: 1, none: 0 };
const VP_NAMES = { royal: 'Royal flush', straight_flush: 'Straight flush', four: 'Four of a kind', full: 'Full house', flush: 'Flush', straight: 'Straight', three: 'Three of a kind', two_pair: 'Two pair', jacks: 'Jacks or better', none: 'No win' };
const deckCard = (n) => { const si = Math.floor(n / 13); return { i: n % 13, r: RANKS[n % 13], s: SUITS[si], red: si === 1 || si === 2 }; };
function vpHand(cards) {
  const counts = {};
  cards.forEach((c) => { counts[c.i] = (counts[c.i] || 0) + 1; });
  const groups = Object.values(counts).sort((a, b) => b - a);
  const flush = cards.every((c) => c.s === cards[0].s);
  const vals = [...new Set(cards.map((c) => c.i))].sort((a, b) => a - b);
  const wheelHigh = vals.join() === '0,9,10,11,12'; // 10 J Q K A
  const straight = vals.length === 5 && (vals[4] - vals[0] === 4 || wheelHigh);
  if (straight && flush) return wheelHigh ? 'royal' : 'straight_flush';
  if (groups[0] === 4) return 'four';
  if (groups[0] === 3 && groups[1] === 2) return 'full';
  if (flush) return 'flush';
  if (straight) return 'straight';
  if (groups[0] === 3) return 'three';
  if (groups[0] === 2 && groups[1] === 2) return 'two_pair';
  if (groups[0] === 2) {
    const pair = Number(Object.keys(counts).find((k) => counts[k] === 2));
    if (pair === 0 || pair >= 10) return 'jacks'; // aces, jacks, queens, kings
  }
  return 'none';
}
const videopoker = {
  name: 'Video Poker', rtp: 99.5, round: true, PAYS: VP_PAYS, NAMES: VP_NAMES, hand: vpHand,
  check: () => ({}),
  start(rng) {
    const pool = Array.from({ length: 52 }, (_, i) => i);
    const cards = [];
    for (let i = 0; i < 10; i++) cards.push(rng.pick(pool));
    return { cards };
  },
  act(rng, s, action, p) {
    if (action !== 'draw') fail('Unknown move.');
    const hold = new Set((Array.isArray(p.hold) ? p.hold : []).map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < 5));
    let next = 5;
    const final = s.cards.slice(0, 5).map((n, i) => (hold.has(i) ? n : s.cards[next++]));
    const hand = vpHand(final.map(deckCard));
    return { state: { ...s, hold: [...hold].sort(), final, hand }, done: true, mult: VP_PAYS[hand] };
  },
  view(s, done) {
    const dealt = s.cards.slice(0, 5).map(deckCard);
    const out = { dealt, dealtHand: vpHand(dealt) };
    if (done && s.final) Object.assign(out, { hold: s.hold, hand: s.final.map(deckCard), result: s.hand });
    return out;
  },
  verify(rng) {
    const s = videopoker.start(rng);
    const txt = (ns) => ns.map((n) => { const c = deckCard(n); return c.r + c.s; }).join('  ');
    return [['Dealt', txt(s.cards.slice(0, 5))], ['Replacements, in order', txt(s.cards.slice(5))],
      ['How to read it', 'Each card you discard is replaced by the next card in the replacement list, left to right.']];
  },
};

/** Chicken: cross lanes of traffic. Each lane has the same chance of getting hit; the lane where
 *  that happens is decided when the round starts. Multiplier after k lanes = 0.98 / P(surviving k). */
const CHICKEN_LEVELS = { easy: { p: 0.04, lanes: 24 }, medium: { p: 0.12, lanes: 20 }, hard: { p: 0.2, lanes: 16 }, daredevil: { p: 0.4, lanes: 10 } };
const chickenMult = (d, k) => floor2(0.98 / (1 - CHICKEN_LEVELS[d].p) ** k);
const chicken = {
  name: 'Chicken', rtp: 98, round: true, LEVELS: CHICKEN_LEVELS, mult: chickenMult,
  check(p) { return { difficulty: pickOne(p.difficulty || 'medium', Object.keys(CHICKEN_LEVELS), 'difficulty') }; },
  start(rng, { difficulty }) {
    const c = CHICKEN_LEVELS[difficulty];
    let death = c.lanes;
    for (let k = 0; k < c.lanes; k++) if (rng.float() < c.p) { death = k; break; }
    return { d: difficulty, death, lane: 0 };
  },
  act(rng, s, action) {
    if (action === 'cashout') {
      if (!s.lane) fail('Cross at least one lane first.');
      return { state: s, done: true, mult: chickenMult(s.d, s.lane) };
    }
    if (action !== 'step') fail('Unknown move.');
    if (s.lane === s.death) return { state: { ...s, dead: true }, done: true, mult: 0 };
    const next = { ...s, lane: s.lane + 1 };
    if (next.lane === CHICKEN_LEVELS[s.d].lanes) return { state: next, done: true, mult: chickenMult(s.d, next.lane) };
    return { state: next };
  },
  view(s, done) {
    const c = CHICKEN_LEVELS[s.d];
    return { difficulty: s.d, lane: s.lane, lanes: c.lanes, dead: !!s.dead, multiplier: s.lane ? chickenMult(s.d, s.lane) : 1,
      next: s.lane < c.lanes ? chickenMult(s.d, s.lane + 1) : null, ...(done ? { death: s.death } : {}) };
  },
  verify(rng, fresh) {
    const label = { easy: 'Easy', medium: 'Medium', hard: 'Hard', daredevil: 'Daredevil' };
    return Object.keys(CHICKEN_LEVELS).map((k) => {
      const s = chicken.start(fresh(), { difficulty: k });
      return [`${label[k]} (${Math.round(CHICKEN_LEVELS[k].p * 100)}% per lane)`, s.death >= CHICKEN_LEVELS[k].lanes ? `Crosses all ${s.death} lanes safely` : `Hit in lane ${s.death + 1}`];
    });
  },
};

/** Cases: open a case for one prize. Chances are out of 10,000; every risk level returns 98%. */
const CASES = {
  low: [[0.4, 3887], [0.9, 2621], [1.2, 1780], [1.5, 937], [2, 562], [4, 169], [10, 37], [25, 7]],
  medium: [[0.2, 5605], [0.5, 1488], [1.1, 1339], [2, 788], [3, 438], [6, 262], [20, 70], [60, 10]],
  high: [[0, 5551], [0.3, 2485], [1.2, 1098], [3, 549], [8, 230], [25, 70], [100, 15], [500, 2]],
};
function casePrize(rng, risk) {
  let roll = Math.floor(rng.float() * 10000);
  const t = CASES[risk];
  for (let i = 0; i < t.length; i++) { if (roll < t[i][1]) return i; roll -= t[i][1]; }
  return t.length - 1;
}
const cases = {
  name: 'Cases', rtp: 98, TABLE: CASES,
  check(p) { return { risk: pickOne(p.risk || 'medium', Object.keys(CASES), 'risk level') }; },
  play(rng, { risk }) {
    const tier = casePrize(rng, risk);
    return { mult: CASES[risk][tier][0], result: { tier, mult: CASES[risk][tier][0] } };
  },
  verify(rng) {
    const f = rng.float();
    const roll = Math.floor(f * 10000);
    return [['Roll (0-9,999)', String(roll)], ['Prize', Object.keys(CASES).map((k) => `${k}: ${CASES[k][casePrize({ float: () => f }, k)][0]}×`).join('  ·  ')]];
  },
};

/** Dragon Tiger: one card each, the higher card wins (ace low, king high). A tie hands back half of a
 *  Dragon or Tiger bet; the Tie bet pays 11 to 1. */
const DT_PAYS = { dragon: 2, tiger: 2, tie: 12 };
const dragontiger = {
  name: 'Dragon Tiger', rtp: 96.2,
  check(p) { return { side: pickOne(p.side, ['dragon', 'tiger', 'tie'], 'side') }; },
  play(rng, { side }) {
    const dragon = card(rng);
    const tiger = card(rng);
    const winner = dragon.i > tiger.i ? 'dragon' : tiger.i > dragon.i ? 'tiger' : 'tie';
    const mult = winner === side ? DT_PAYS[side] : winner === 'tie' ? 0.5 : 0;
    return { mult, result: { dragon, tiger, winner } };
  },
  verify(rng) {
    const { result: r } = dragontiger.play(rng, { side: 'dragon' });
    return [['Dragon', r.dragon.r + r.dragon.s], ['Tiger', r.tiger.r + r.tiger.s], ['Result', r.winner === 'tie' ? 'Tie' : `${r.winner === 'dragon' ? 'Dragon' : 'Tiger'} wins`]];
  },
};

const GAMES = {
  blackjack, baccarat, roulette, hilo, keno, dice, limbo, plinko, wheel, diamonds, double, coinflip, crash, mines, towers, pump,
  videopoker, chicken, cases, dragontiger,
};

module.exports = { GAMES, GameError, card, floor2 };
