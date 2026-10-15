'use strict';
// End-to-end API test against a throwaway database (SQLite, or Postgres when DATABASE_URL is set).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goldrush-'));
if (!process.env.DATABASE_URL) process.env.DB_PATH = path.join(dir, 'test.db');
process.env.RATE_LIMIT_SCALE = '20'; // every test request comes from one IP
process.env.ROUND_BET_MS = '1200'; // timed rounds: short betting window and spin for the tests
process.env.ROUND_SPIN_MS = '700';
const app = require('../server');

const server = app.listen(0);
const origin = `http://127.0.0.1:${server.address().port}`;
const base = `${origin}/api`;
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function client() {
  let cookie = '';
  return async (p, body, method) => {
    const res = await fetch(base + p, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = {};
    try { data = await res.json(); } catch { /* text */ }
    return { status: res.status, data };
  };
}

async function postback(url, opts) {
  const res = await fetch(url, opts);
  return { status: res.status, body: await res.text() };
}

(async () => {
  const admin = client();
  const user = client();

  /* ---------- accounts ---------- */
  let r = await admin('/auth/register', { username: 'boss', email: 'boss@example.com', password: 'password123', terms: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.user.role, 'admin', 'first user becomes admin');
  assert.equal(r.data.user.balance, 25, 'signup bonus is $0.25');
  const refCode = r.data.user.referral_code;

  r = await user('/auth/register', { username: 'player1', email: 'p1@example.com', password: 'password123', terms: true, referral: refCode });
  assert.equal(r.status, 200);
  const uid = r.data.user.id;
  r = await client()('/auth/register', { username: 'PLAYER1', email: 'p1b@example.com', password: 'password123', terms: true });
  assert.equal(r.status, 400, 'usernames are case-insensitive');

  /* ---------- nothing fake is seeded ---------- */
  r = await user('/offerwalls');
  assert.equal(r.data.offerwalls.length, 0, 'no demo offerwalls');
  r = await user('/feed');
  assert.equal(r.data.feed.length, 0, 'no fake feed');
  r = await user('/offers');
  assert.equal(r.status, 404, 'fake offers endpoint is gone');

  /* ---------- create an offerwall (CPX-style md5 signature) ---------- */
  r = await admin('/admin/offerwalls', {
    preset: 'cpx', name: 'CPX Research', iframe_url: 'https://offers.example.com/?app_id=1&ext_user_id={user_id}',
    sig_method: 'md5', sig_mode: 'template', sig_template: '{txid}-{secret}', sig_param: 'hash', sig_secret: 'cpxsecret',
    amount_source: 'reward', amount_unit: 'cents', reversal_values: '2', hold_hours: 0, active: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let walls = (await admin('/admin/offerwalls')).data.offerwalls;
  let cpx = walls.find((w) => w.slug === 'cpx-research');
  assert.ok(cpx.postback_token.length >= 20, 'postback token generated');

  r = await user('/offerwalls');
  assert.equal(r.data.offerwalls.length, 1);
  assert.ok(!('sig_secret' in r.data.offerwalls[0]) && !('postback_token' in r.data.offerwalls[0]), 'secrets not exposed to users');
  r = await user('/offerwalls/cpx-research/launch');
  assert.equal(r.data.url, `https://offers.example.com/?app_id=1&ext_user_id=${uid}`, 'user id filled into wall URL');

  const pb = (w, q) => `${base}/postback/${w.slug}/${w.postback_token}?${new URLSearchParams(q)}`;
  const cpxQ = (txid, reward, extra = {}) => ({ user_id: uid, txid, reward, payout: '1.50', status: '1', offer: 'Survey 123', hash: md5(`${txid}-cpxsecret`), ...extra });

  let res = await postback(pb(cpx, cpxQ('tx1', 100)));
  assert.equal(res.status, 200); assert.equal(res.body, '1');
  r = await user('/me');
  assert.equal(r.data.user.balance, 25 + 100, 'credited $1.00');
  r = await admin('/me');
  assert.equal(r.data.user.balance, 25 + 10, 'referrer got 10%');

  res = await postback(pb(cpx, cpxQ('tx1', 100)));
  assert.equal(res.body, '1', 'duplicate acknowledged');
  assert.equal((await user('/me')).data.user.balance, 125, 'duplicate not credited twice');

  res = await postback(pb(cpx, { ...cpxQ('tx2', 500), hash: 'forged' }));
  assert.equal(res.status, 403, 'bad signature rejected');
  res = await postback(`${base}/postback/cpx-research/wrongtoken?${new URLSearchParams(cpxQ('tx3', 500))}`);
  assert.equal(res.status, 404, 'wrong token rejected');
  res = await postback(pb(cpx, { ...cpxQ('tx4', 500), user_id: 999999 }));
  assert.equal(res.status, 400, 'unknown user rejected');
  assert.equal((await user('/me')).data.user.balance, 125);

  res = await postback(pb(cpx, cpxQ('tx1', 100, { status: '2' })));
  assert.equal(res.status, 200, 'reversal acknowledged');
  assert.equal((await user('/me')).data.user.balance, 25, 'reversal took the reward back');

  /* ---------- hold period + release ---------- */
  cpx = { ...cpx, hold_hours: 24 };
  r = await admin(`/admin/offerwalls/${cpx.id}`, { ...cpx, active: true }, 'PUT');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  res = await postback(pb(cpx, cpxQ('tx5', 300)));
  assert.equal(res.body, '1');
  assert.equal((await user('/me')).data.user.balance, 25, 'held reward not spendable yet');
  const held = (await admin('/admin/completions?status=pending')).data.completions.find((c) => c.txid === 'cpx-research:tx5');
  assert.ok(held && held.release_at > Date.now(), 'held with release time');
  r = await admin(`/admin/completions/${held.id}/approve`, {});
  assert.equal(r.status, 200);
  assert.equal((await user('/me')).data.user.balance, 325, 'released early by admin');

  res = await postback(pb(cpx, cpxQ('tx6', 300)));
  res = await postback(pb(cpx, cpxQ('tx6', 300, { status: '2' })));
  assert.equal((await user('/me')).data.user.balance, 325, 'reversal during hold cancels without debit');

  /* ---------- payout share, dollars, IP allowlist, POST ---------- */
  r = await admin('/admin/offerwalls', {
    name: 'Share Wall', iframe_url: 'https://share.example.com/{user_id}', amount_source: 'payout', revenue_share: 50,
    ip_whitelist: '127.0.0.1, ::1', bonus_percent: 10, active: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  walls = (await admin('/admin/offerwalls')).data.offerwalls;
  const share = walls.find((w) => w.slug === 'share-wall');
  res = await postback(`${base}/postback/${share.slug}/${share.postback_token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_id: uid, txid: 'p1', payout: '2.00', status: '1' }),
  });
  assert.equal(res.status, 200, res.body);
  assert.equal((await user('/me')).data.user.balance, 325 + 110, '50% of $2.00 = $1.00, +10% wall bonus = $1.10');

  r = await admin(`/admin/offerwalls/${share.id}`, { ...share, ip_whitelist: '203.0.113.7', active: true }, 'PUT');
  res = await postback(`${base}/postback/${share.slug}/${share.postback_token}?user_id=${uid}&txid=p2&payout=2&status=1`);
  assert.equal(res.status, 403, 'IP not on allowlist rejected');

  /* ---------- HMAC of the full URL (AdGem/BitLabs style) ---------- */
  r = await admin('/admin/offerwalls', {
    name: 'Hmac Wall', iframe_url: 'https://h.example.com/{user_id}', sig_method: 'hmac-sha256', sig_mode: 'url', sig_param: 'verifier',
    sig_secret: 'k3y', amount_unit: 'dollars', active: true,
  });
  walls = (await admin('/admin/offerwalls')).data.offerwalls;
  const hm = walls.find((w) => w.slug === 'hmac-wall');
  const unsigned = `${base}/postback/${hm.slug}/${hm.postback_token}?user_id=${uid}&txid=h1&reward=0.75&status=1`;
  const sig = crypto.createHmac('sha256', 'k3y').update(unsigned).digest('hex');
  res = await postback(`${unsigned}&verifier=${sig}`);
  assert.equal(res.status, 200, res.body);
  assert.equal((await user('/me')).data.user.balance, 435 + 75, '$0.75 sent in dollars');
  res = await postback(`${unsigned.replace('0.75', '9.75')}&verifier=${sig}`);
  assert.equal(res.status, 403, 'tampered URL rejected');

  /* ---------- admin test button + logs ---------- */
  r = await admin(`/admin/offerwalls/${hm.id}/test`, {});
  assert.equal(r.data.credit.result, 'credited', JSON.stringify(r.data));
  assert.equal(r.data.reversal.result, 'reversed');
  const logs = (await admin('/admin/postback-logs')).data.logs;
  assert.ok(logs.some((l) => l.result === 'rejected' && /Signature/.test(l.message)), 'rejections are logged with a reason');
  assert.ok(!logs.some((l) => l.params.includes('cpxsecret') || l.params.includes('k3y')), 'secrets never logged');
  r = await user('/admin/postback-logs');
  assert.equal(r.status, 403, 'non-admins cannot read logs');

  /* ---------- daily, promo, cashouts ---------- */
  assert.equal((await user('/daily', {})).status, 200);
  assert.equal((await user('/daily', {})).status, 400, 'daily only once');
  assert.equal((await user('/promo', { code: 'welcome' })).status, 200);
  assert.equal((await user('/promo', { code: 'WELCOME' })).status, 400, 'promo only once');

  const before = (await user('/me')).data.user.balance;
  const { methods } = (await user('/reward-methods')).data;
  assert.deepEqual([...new Set(methods.map((m) => m.category))].sort(), ['crypto', 'giftcard', 'prepaid']);
  assert.equal(methods.find((m) => m.name === 'Visa Prepaid').min_coins, 2000);
  const btc = methods.find((m) => m.name === 'Bitcoin');
  assert.equal((await user('/withdraw', { method_id: btc.id, coins: 499, destination: 'bc1q' })).status, 400, 'below minimum');
  r = await user('/withdraw', { method_id: btc.id, coins: 500, destination: 'bc1qexample' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.user.balance, before - 500);
  assert.equal((await user('/withdraw', { method_id: btc.id, coins: 900000, destination: 'bc1q' })).status, 400, 'insufficient balance');
  const wd = (await admin('/admin/withdrawals?status=pending')).data.withdrawals[0];
  assert.equal(wd.usd, 5);
  await admin(`/admin/withdrawals/${wd.id}/reject`, { note: 'test' });
  assert.equal((await user('/me')).data.user.balance, before, 'rejected cashout refunded');

  /* ---------- password reset, lockout, sessions ---------- */
  r = await client()('/auth/forgot', { email: 'p1@example.com' });
  assert.equal(r.status, 200);
  assert.equal(r.data.mail, false, 'no mail provider configured in tests');

  r = await admin(`/admin/users/${uid}/reset-link`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const token = r.data.url.split('/#/reset/')[1];
  assert.ok(token && token.length > 30, 'reset link has a token');
  r = await client()(`/auth/reset/${token}`);
  assert.equal(r.data.username, 'player1', 'token resolves to the user');
  const other = client(); // a second device that should be signed out by the reset
  assert.equal((await other('/auth/login', { login: 'player1', password: 'password123' })).status, 200);
  assert.equal((await client()('/auth/reset', { token, password: 'short' })).status, 400, 'weak password rejected');
  const resetter = client();
  r = await resetter('/auth/reset', { token, password: 'brand-new-pass-1' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.user.id, uid, 'logged in after reset');
  assert.equal((await resetter('/me')).status, 200);
  assert.equal((await other('/me')).status, 401, 'reset signs out other devices');
  assert.equal((await client()('/auth/reset', { token, password: 'another-pass-2' })).status, 404, 'reset link works once');
  assert.equal((await client()('/auth/login', { login: 'player1', password: 'password123' })).status, 401, 'old password no longer works');
  const relog = client();
  assert.equal((await relog('/auth/login', { login: 'P1@EXAMPLE.COM', password: 'brand-new-pass-1', remember: false })).status, 200, 'log back in with new password, email any case');

  // lockout after repeated wrong passwords
  await client()('/auth/register', { username: 'locky', email: 'locky@example.com', password: 'lockypass123', terms: true });
  let last;
  for (let i = 0; i < 8; i++) last = await client()('/auth/login', { login: 'locky', password: `wrong-${i}` });
  assert.equal(last.status, 401);
  assert.match(last.data.error, /locked/, 'locked after 8 wrong passwords');
  r = await client()('/auth/login', { login: 'locky', password: 'lockypass123' });
  assert.equal(r.status, 429, 'even the right password waits out the lock');

  // sessions list / revoke, password change signs out other devices
  const devA = client();
  const devB = client();
  await devA('/auth/login', { login: 'player1', password: 'brand-new-pass-1' });
  await devB('/auth/login', { login: 'player1', password: 'brand-new-pass-1' });
  r = await devA('/me/sessions');
  assert.ok(r.data.sessions.length >= 3 && r.data.sessions.filter((x) => x.current).length === 1, 'sessions listed, one current');
  const bId = (await devB('/me/sessions')).data.sessions.find((x) => x.current).id;
  assert.equal((await devA(`/me/sessions/${bId}`, undefined, 'DELETE')).status, 200);
  assert.equal((await devB('/me')).status, 401, 'revoked device is signed out');
  r = await devA('/me/password', { current: 'brand-new-pass-1', next: 'third-pass-333' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await relog('/me')).status, 401, 'password change signs out other devices');
  assert.equal((await devA('/me')).status, 200, '...but keeps this one');
  r = await devA('/me/email', { email: 'new-p1@example.com', password: 'third-pass-333' });
  assert.equal(r.data.user.email, 'new-p1@example.com');
  assert.equal((await devA('/me/email', { email: 'boss@example.com', password: 'third-pass-333' })).status, 400, 'email in use');

  // admin actions are audited, secrets hidden
  const audit = (await admin('/admin/audit')).data.entries;
  assert.ok(audit.some((e) => e.action === 'Created password reset link'));
  assert.ok(audit.some((e) => e.action === 'Added offerwall' && e.details.includes('[hidden]')), 'secrets hidden in audit details');

  r = await user('/health');
  assert.equal(r.data.ok, true);

  /* ---------- games (real balance, server-decided results) ---------- */
  {
    const g = client();
    await g('/auth/register', { username: 'gamer', email: 'gamer@example.com', password: 'gamerpass123', terms: true });
    const gid = (await g('/me')).data.user.id;
    await admin(`/admin/users/${gid}/balance`, { amount: 10000, reason: 'test funds' }); // $100
    let bal = (await g('/me')).data.user.balance;
    assert.equal(bal, 10025);

    const cfg = (await g('/games/config')).data;
    assert.equal(cfg.games.length, 19, '19 games, no slots, no chicken');
    assert.ok(!cfg.games.some((x) => x.id === 'chicken'));
    assert.ok(!cfg.games.some((x) => /slot/i.test(x.id)));

    assert.equal((await g('/games/fair')).status, 404, 'seed endpoints are gone');
    assert.equal((await g('/games/verify', { game: 'dice' })).status, 404, 'verifier is gone');

    // instant game: dice
    r = await g('/games/dice/bet', { amount: 100, params: { target: 50, mode: 'under' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const d1 = r.data.bet;
    assert.equal(d1.status, 'settled');
    const won = d1.result.roll < 50;
    assert.equal(d1.payout, won ? 198 : 0, 'dice pays 1.98× under 50');
    bal = bal - 100 + d1.payout;
    assert.equal(r.data.user.balance, bal, 'balance debited and credited');

    // limits and validation
    assert.equal((await g('/games/dice/bet', { amount: 5, params: { target: 50, mode: 'under' } })).status, 400, 'below min bet');
    assert.equal((await g('/games/dice/bet', { amount: 10001, params: { target: 50, mode: 'under' } })).status, 400, 'above max bet');
    assert.equal((await g('/games/dice/bet', { amount: 100, params: { target: 99, mode: 'under' } })).status, 400, 'bad target');
    assert.equal((await g('/games/slots/bet', { amount: 100, params: {} })).status, 404, 'no slots');
    assert.equal((await user('/games/dice/bet', { amount: 100, params: { target: 50, mode: 'under' } })).status, 401, 'login required');

    // every instant game runs
    const instant = {
      limbo: { target: 2 }, coinflip: { side: 'heads', risk: 'medium' }, diamonds: { risk: 'low' },
      wheel: { risk: 'medium', segments: 20 }, plinko: { rows: 16, risk: 'high' }, keno: { picks: [1, 5, 9, 22, 40], risk: 'medium' },
      baccarat: { chips: { banker: 50 } }, cases: { risk: 'high' }, dragontiger: { side: 'tie' },
    };
    for (const [game, params] of Object.entries(instant)) {
      r = await g(`/games/${game}/bet`, { amount: 50, params });
      assert.equal(r.status, 200, `${game}: ${JSON.stringify(r.data)}`);
      assert.equal(r.data.bet.status, 'settled');
    }
    r = await g('/games/roulette/bet', { params: { chips: { red: 100, n_17: 20 } } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.bet.amount, 120, 'roulette stake = sum of chips');

    // mines: hidden layout, reveal, cash out
    r = await g('/games/mines/bet', { amount: 200, params: { mines: 1 } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    let mb = r.data.bet;
    assert.equal(mb.status, 'active');
    assert.ok(!('layout' in mb.view), 'mine positions hidden while playing');
    assert.equal((await g('/games/mines/bet', { amount: 200, params: { mines: 1 } })).status, 400, 'one open mines round at a time');
    // reveal tiles until we either hit the mine or have two gems, then cash out
    let tile = 0;
    while (mb.status === 'active' && mb.view.revealed.length < 2) {
      r = await g(`/games/bets/${mb.id}/action`, { action: 'reveal', params: { tile: tile++ } });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      mb = r.data.bet;
    }
    if (mb.status === 'active') {
      // double-submit the cash out: only one may pay
      const [c1, c2] = await Promise.all([g(`/games/bets/${mb.id}/action`, { action: 'cashout' }), g(`/games/bets/${mb.id}/action`, { action: 'cashout' })]);
      const paidOnce = (await g('/games/bets?game=mines')).data.bets.find((x) => x.id === mb.id);
      assert.equal(paidOnce.status, 'settled');
      assert.equal(paidOnce.payout, Math.floor(200 * paidOnce.multiplier + 1e-9));
      const wins = (await g('/me/history?section=transactions')).data.items.filter((t) => t.type === 'win' && t.description.startsWith('Mines'));
      assert.equal(wins.length, 1, 'double cash out only pays once');
      assert.ok(c1.status === 200 && c2.status === 200);
    }
    // blackjack round
    r = await g('/games/blackjack/bet', { amount: 100, params: {} });
    let bj = r.data.bet;
    if (bj.status === 'active') {
      assert.equal(bj.view.dealer.length, 1, 'dealer hole card hidden');
      r = await g(`/games/bets/${bj.id}/action`, { action: 'stand' });
      bj = r.data.bet;
    }
    assert.equal(bj.status, 'settled');
    assert.ok(bj.view.dealer.length >= 2);

    // blackjack side bets: Perfect Pairs (pp) and 21+3 (t3), in cents, taken with the main bet in one debit
    {
      const sdb = require('../src/db').db;
      const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
      const PP = { perfect: 25, coloured: 12, mixed: 5 };
      const T3 = { suited_trips: 100, straight_flush: 40, trips: 30, straight: 10, flush: 5 };
      const ppHand = (a, b) => (a.r !== b.r ? null : a.s === b.s ? 'perfect' : a.red === b.red ? 'coloured' : 'mixed');
      const t3Hand = (cs) => {
        const v = cs.map((c) => RANKS.indexOf(c.r)).sort((x, y) => x - y);
        const suited = new Set(cs.map((c) => c.s)).size === 1;
        if (new Set(v).size === 1) return suited ? 'suited_trips' : 'trips';
        const run = new Set(v).size === 3 && (v[2] - v[0] === 2 || String(v) === '0,11,12');
        return run ? (suited ? 'straight_flush' : 'straight') : suited ? 'flush' : null;
      };
      const sideOf = (bet, hand, pays) => ({ bet, hand, pays: hand ? pays[hand] : 0, win: hand ? bet * (pays[hand] + 1) : 0 });

      // limits: each side bet is 0 or between the minimum bet and the main bet; the maximum covers the total
      const before = (await g('/me')).data.user.balance;
      r = await g('/games/blackjack/bet', { amount: 100, params: { pp: 101 } });
      assert.equal(r.status, 400, 'a side bet larger than the main bet is rejected');
      assert.match(r.data.error, /more than your main bet/);
      assert.equal((await g('/games/blackjack/bet', { amount: 100, params: { t3: 101 } })).status, 400, '21+3 above the main bet');
      assert.equal((await g('/games/blackjack/bet', { amount: 100, params: { t3: 5 } })).status, 400, 'side bet below the minimum');
      assert.equal((await g('/games/blackjack/bet', { amount: 100, params: { pp: -10 } })).status, 400, 'negative side bet');
      assert.equal((await g('/games/blackjack/bet', { amount: 100, params: { pp: 'lots' } })).status, 400, 'side bet must be a number');
      assert.equal((await g('/games/blackjack/bet', { amount: 10000, params: { pp: 10 } })).status, 400, 'max bet covers main + side bets');
      assert.equal((await g('/games/blackjack/bet', { amount: 5, params: {} })).status, 400, 'main bet below the minimum');
      assert.equal((await g('/me')).data.user.balance, before, 'rejected hands take nothing');

      // play hands until a side bet has paid and a hand has been doubled; check every stake, result and payout
      const count = async () => (await sdb.get(`SELECT
          (SELECT COUNT(*) FROM bets WHERE user_id = ? AND game = 'blackjack') AS rows,
          (SELECT COUNT(*) FROM transactions WHERE user_id = ? AND description = 'Blackjack bet') AS debits,
          (SELECT COUNT(*) FROM transactions WHERE user_id = ? AND description = 'Blackjack double') AS doubles,
          (SELECT COUNT(*) FROM transactions WHERE user_id = ? AND type = 'win' AND description LIKE 'Blackjack%') AS credits`, gid, gid, gid, gid));
      const led0 = await count();
      const mainMult = { blackjack: 2.5, win: 2, dealer_bust: 2, push: 1 };
      let balNow = before, hands = 0, paidSides = 0, doubles = 0, credits = 0;
      while ((paidSides < 1 || doubles < 1) && hands < 250) {
        hands++;
        r = await g('/games/blackjack/bet', { amount: 20, params: { pp: 10, t3: 20 } });
        assert.equal(r.status, 200, JSON.stringify(r.data));
        let hb = r.data.bet;
        const v0 = hb.view;
        assert.equal(hb.amount, 50, 'stake = main + both side bets');
        assert.deepEqual(hb.params, { bet: 20, pp: 10, t3: 20 });
        assert.deepEqual(v0.side.pp, sideOf(10, ppHand(v0.player[0], v0.player[1]), PP), 'Perfect Pairs decided from the first two cards');
        assert.deepEqual(v0.side.t3, sideOf(20, t3Hand([v0.player[0], v0.player[1], v0.dealer[0]]), T3), '21+3 decided from those and the up card');
        if (hb.status === 'active') {
          assert.equal(r.data.user.balance, balNow - 50, 'one debit for main + side bets');
          assert.equal(v0.dealer.length, 1, 'hole card still hidden with side bets');
          const action = doubles ? 'stand' : 'double';
          r = await g(`/games/bets/${hb.id}/action`, { action });
          assert.equal(r.status, 200, JSON.stringify(r.data));
          hb = r.data.bet;
          if (action === 'double') { doubles++; assert.equal(hb.amount, 70, 'doubling adds the main bet only'); }
        }
        assert.equal(hb.status, 'settled');
        assert.deepEqual(hb.view.side, v0.side, 'side results do not change after the deal');
        const main = 20 * (hb.view.doubled ? 2 : 1);
        const sides = v0.side.pp.win + v0.side.t3.win;
        assert.equal(hb.payout, Math.floor(main * (mainMult[hb.view.outcome] || 0) + 1e-9) + sides, `payout = main hand + side bets (${hb.view.outcome})`);
        balNow = balNow - hb.amount + hb.payout;
        assert.equal(r.data.user.balance, balNow, 'balance moves by the stake and one payout');
        if (sides) paidSides++;
        if (hb.payout > 0) credits++;
      }
      assert.ok(paidSides >= 1 && doubles >= 1, `saw a side bet pay and a double in ${hands} hands`);
      const led1 = await count();
      assert.equal(led1.rows - led0.rows, hands, 'one bet row per hand');
      assert.equal(led1.debits - led0.debits, hands, 'one debit per hand for main + side bets');
      assert.equal(led1.doubles - led0.doubles, doubles);
      assert.equal(led1.credits - led0.credits, credits, 'one credit per paying hand, side bets included');

      // forced cards straight through the rules (they take any number source)
      const bjl = require('../src/games/logic').GAMES.blackjack;
      const SUITS = ['♠', '♥', '♦', '♣'];
      const deal = (...cards) => ({ int: () => { const [r0, s0] = cards.shift(); return 13 * SUITS.indexOf(s0) + RANKS.indexOf(r0); }, float: () => 0 });
      // order: player, dealer up, player, dealer hole, then draws
      let st = bjl.start(deal(['8', '♠'], ['8', '♠'], ['8', '♠'], ['9', '♥']), { bet: 100, pp: 10, t3: 10 });
      assert.deepEqual(st.side, { pp: sideOf(10, 'perfect', PP), t3: sideOf(10, 'suited_trips', T3) });
      assert.equal(bjl.instant(st), null);
      assert.ok(!JSON.stringify(bjl.view(st, false)).includes('♥'), 'the view at the deal never carries the hole card');
      let res = bjl.act(deal(), st, 'stand');
      assert.equal(res.state.outcome, 'lose');
      assert.equal(res.payoutCents, 260 + 1010, 'a lost hand still pays its side bets');
      st = bjl.start(deal(['A', '♥'], ['Q', '♥'], ['K', '♥'], ['5', '♠']), { bet: 100, pp: 0, t3: 20 });
      assert.deepEqual(st.side, { t3: sideOf(20, 'straight_flush', T3) }, 'Q-K-A suited is a straight flush; no Perfect Pairs bet, no result');
      res = bjl.instant(st);
      assert.equal(res.state.outcome, 'blackjack');
      assert.equal(res.payoutCents, 250 + 820, 'a natural that settles at once pays the side bets too');
      st = bjl.start(deal(['8', '♥'], ['A', '♣'], ['8', '♦'], ['K', '♠']), { bet: 100, pp: 10, t3: 10 });
      assert.equal(st.side.pp.hand, 'coloured');
      assert.equal(st.side.t3.hand, null);
      assert.equal(bjl.instant(st).payoutCents, 130, 'dealer blackjack: main lost, coloured pair paid');
      st = bjl.start(deal(['5', '♠'], ['9', '♣'], ['6', '♠'], ['7', '♦']), { bet: 100, pp: 10, t3: 10 });
      res = bjl.act(deal(['10', '♠'], ['10', '♣']), st, 'double');
      assert.equal(res.state.outcome, 'dealer_bust');
      assert.equal(res.payoutCents, 400, 'a doubled win pays on the doubled main bet only');
      const c = (r0, s0) => ({ i: RANKS.indexOf(r0), r: r0, s: s0, red: s0 === '♥' || s0 === '♦' });
      assert.equal(bjl.perfectPairs(c('8', '♥'), c('8', '♣')), 'mixed');
      assert.equal(bjl.twentyOne3([c('A', '♠'), c('2', '♥'), c('3', '♦')]), 'straight', 'ace low');
      assert.equal(bjl.twentyOne3([c('K', '♠'), c('A', '♥'), c('2', '♦')]), null, 'no wrap-around');
      assert.equal(bjl.twentyOne3([c('2', '♣'), c('7', '♣'), c('J', '♣')]), 'flush');
      assert.equal(bjl.twentyOne3([c('7', '♠'), c('7', '♥'), c('7', '♦')]), 'trips');
      res = bjl.act(deal(), bjl.start(deal(['10', '♠'], ['9', '♣'], ['7', '♠'], ['8', '♦'])), 'stand');
      assert.equal(res.payoutCents, undefined, 'hands without a stored stake fall back to stake × multiplier');
    }
    // timed rounds: a Double round takes several bets; the colour is hidden until the spin ends
    const waitFor = async (game, pred, ms = 9000) => {
      const end = Date.now() + ms;
      for (;;) {
        const v = (await g(`/games/rounds/${game}`)).data;
        if (pred(v)) return v;
        if (Date.now() > end) throw new Error(`timed out waiting on ${game}`);
        await new Promise((ok) => setTimeout(ok, 120));
      }
    };
    let dv = await waitFor('double', (v) => v.round.phase === 'betting');
    assert.equal(dv.round.result, undefined, 'colour hidden while betting');
    const dseq = dv.round.seq;
    r = await g('/games/rounds/double/bet', { amount: 100, params: { side: 'red' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await g('/games/rounds/double/bet', { amount: 200, params: { side: 'green' } })).status, 200, 'several bets on one round');
    assert.equal((await g('/games/rounds/double/bet', { amount: 50, params: { side: 'purple' } })).status, 400, 'unknown colour');
    dv = await waitFor('double', (v) => v.round.phase === 'playing' && v.round.seq === dseq);
    assert.equal((await g('/games/rounds/double/bet', { amount: 100, params: { side: 'black' } })).status, 400, 'no bets while the wheel spins');
    assert.ok(dv.round.result && Number.isInteger(dv.round.result.n), 'the number is shown once betting has closed');
    assert.ok(dv.stats && 'red' in dv.stats, 'last-100 colour counts');
    dv = await waitFor('double', (v) => v.history.some((h) => h.seq === dseq));
    const color = dv.history.find((h) => h.seq === dseq).result.color;
    const mine2 = (await g('/games/bets?game=double')).data.bets.slice(0, 2); // newest first: green 200, red 100
    for (const b of mine2) {
      assert.equal(b.status, 'settled');
      const pays = { red: 2, black: 2, green: 14 }[b.params.side];
      assert.equal(b.payout, b.params.side === color ? b.amount * pays : 0, `double pays ${b.params.side} vs ${color}`);
    }

    // crash: one bet per round, a cash out while the rocket climbs, and auto cash out settling itself
    let cv = await waitFor('crash', (v) => v.round.phase === 'betting');
    const cseq = cv.round.seq;
    r = await g('/games/rounds/crash/bet', { amount: 100, params: { auto: 1.5 } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await g('/games/rounds/crash/bet', { amount: 100, params: {} })).status, 400, 'one bet per crash round');
    cv = await waitFor('crash', (v) => v.round.phase === 'playing' && v.round.seq === cseq);
    assert.ok(cv.round.mult >= 1 && cv.round.result === undefined, 'the crash point stays hidden while climbing');
    r = await g('/games/rounds/crash/cashout', {});
    const cashed = r.status === 200;
    if (cashed) {
      const mine3 = r.data.bets.find((b) => b.mine);
      assert.equal(mine3.status, 'settled');
      assert.equal(mine3.payout, Math.floor(100 * mine3.multiplier + 1e-9), 'cash out pays the climb it was taken at');
    } else assert.match(r.data.error, /crashed|already/i, 'too late means it crashed first');
    // force the round to its end and let the sweep settle it
    await require('../src/db').db.run("UPDATE rounds SET end_at = 0 WHERE game = 'crash' AND phase = 'playing'");
    await require('../src/games/rounds').sweep();
    cv = (await g('/games/rounds/crash')).data;
    const done = cv.history.find((h) => h.seq === cseq);
    assert.ok(done && done.result.crash >= 1, 'round is done and reveals its crash point');
    const cbet = (await g('/games/bets?game=crash')).data.bets[0];
    assert.equal(cbet.status, 'settled');
    if (!cashed) assert.equal(cbet.payout, done.result.crash > 1.5 ? 150 : 0, 'auto cash out at 1.5 pays only if the crash came later');

    // video poker: dealt hand only, then the draw replaces exactly the cards not held
    r = await g('/games/videopoker/bet', { amount: 100, params: {} });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const vp = r.data.bet;
    assert.equal(vp.status, 'active');
    assert.equal(vp.view.dealt.length, 5);
    assert.ok(!('hand' in vp.view) && !('cards' in vp.view), 'replacement cards stay on the server');
    r = await g(`/games/bets/${vp.id}/action`, { action: 'draw', params: { hold: [0, 2] } });
    const vpd = r.data.bet;
    assert.equal(vpd.status, 'settled');
    assert.deepEqual(vpd.view.hand[0], vp.view.dealt[0]);
    assert.deepEqual(vpd.view.hand[2], vp.view.dealt[2]);
    assert.equal(vpd.payout, 100 * { royal: 800, straight_flush: 50, four: 25, full: 9, flush: 6, straight: 4, three: 3, two_pair: 2, jacks: 1, none: 0 }[vpd.view.result]);
    // towers, pump, hilo start and move
    for (const [game, params, move] of [['towers', { difficulty: 'easy' }, { action: 'pick', params: { col: 0 } }], ['pump', { difficulty: 'easy' }, { action: 'pump' }], ['hilo', {}, { action: 'hi' }]]) {
      r = await g(`/games/${game}/bet`, { amount: 50, params });
      assert.equal(r.status, 200, `${game} ${JSON.stringify(r.data)}`);
      r = await g(`/games/bets/${r.data.bet.id}/action`, move);
      assert.equal(r.status, 200, `${game} move ${JSON.stringify(r.data)}`);
      if (r.data.bet.status === 'active') {
        r = await g(`/games/bets/${r.data.bet.id}/action`, { action: 'cashout' });
        assert.equal(r.data.bet.status, 'settled', `${game} cash out`);
      }
    }

    // ledger = balance
    const me = (await g('/me')).data.user;
    const settledBets = (await g('/games/bets')).data.bets;
    assert.ok(settledBets.length >= 10);
    /* ---------- paging: lists answer one page at a time ---------- */
    const p1 = (await g('/games/bets?limit=2')).data;
    assert.ok(p1.bets.length <= 2 && p1.page === 1 && typeof p1.hasMore === 'boolean', 'bet history: page 1 holds at most 2');
    const p2 = (await g('/games/bets?limit=2&page=2')).data;
    assert.equal(p2.page, 2);
    assert.ok(p2.bets.every((b) => !p1.bets.some((x) => x.id === b.id)), 'bet history: page 2 does not repeat page 1');
    assert.ok((await admin('/admin/transactions?limit=3')).data.transactions.length <= 3, 'admin transactions are paged');
    assert.ok(Array.isArray((await admin('/admin/games?page=1')).data.bets), 'admin games are paged');
    assert.ok(Array.isArray((await g('/me/history?section=withdrawals')).data.items), 'history sections are paged');
    assert.ok((await g('/me/referrals?limit=1')).data.referrals.length <= 1, 'referrals are paged');
    assert.ok((await user('/leaderboard?period=all')).data.leaderboard.length <= 10, 'leaderboard is top 10');

    assert.equal(me.total_earned, 25 + 0, 'game winnings are not "earned"');

    // no max win: a 37× on $100 pays $3,700 (the house would need the balance for that, so give it some)
    await admin(`/admin/users/${gid}/balance`, { amount: 1_000_000 });
    await admin('/admin/settings', { games_max_bet: 1_000_000 }, 'PUT');
    for (let i = 0; i < 80; i++) {
      r = await g('/games/limbo/bet', { amount: 10000, params: { target: 37 } });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      if (r.data.bet.payout) { assert.equal(r.data.bet.payout, 370000, '37× on $100 pays $3,700 in full'); break; }
    }
    await admin('/admin/settings', { games_max_bet: 10000 }, 'PUT');

    assert.equal((await g('/games/fair/rotate', { client_seed: 'x' })).status, 404, 'rotate is gone');

    // admin stats
    const st = (await admin('/admin/games')).data;
    assert.ok(st.all.bets >= 10 && st.byGame.length >= 10);
    // games off
    await admin('/admin/settings', { games_enabled: 0 }, 'PUT');
    assert.equal((await g('/games/dice/bet', { amount: 100, params: { target: 50, mode: 'under' } })).status, 503);
    await admin('/admin/settings', { games_enabled: 1 }, 'PUT');
  }

  /* ---------- misc ---------- */
  assert.equal((await devA('/admin/overview')).status, 403, 'non-admin blocked');
  const o = (await admin('/admin/overview')).data;
  assert.ok(o.revenue_cents > 0 && o.active_walls === 3, JSON.stringify(o));
  assert.ok((await user('/leaderboard?period=weekly')).data.leaderboard.length > 0);
  assert.ok((await user('/feed')).data.feed.length > 0, 'feed shows real conversions');
  r = await admin(`/admin/offerwalls/${share.id}`, undefined, 'DELETE');
  assert.equal(r.status, 200, 'bodiless DELETE works');
  await devA('/auth/logout', {});
  assert.equal((await devA('/me')).status, 401);
  assert.equal((await devA('/auth/login', { login: 'new-p1@example.com', password: 'third-pass-333' })).status, 200, 'can log back in after logging out');

  console.log(`All smoke tests passed ✔ (${process.env.DATABASE_URL ? 'Postgres' : 'SQLite'})`);
  server.close();
  if (process.env.DATABASE_URL) process.exit(0); // close the pg pool
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
