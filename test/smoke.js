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

  /* ---------- games (real balance, server-side provably fair) ---------- */
  {
    const g = client();
    await g('/auth/register', { username: 'gamer', email: 'gamer@example.com', password: 'gamerpass123', terms: true });
    const gid = (await g('/me')).data.user.id;
    await admin(`/admin/users/${gid}/balance`, { amount: 10000, reason: 'test funds' }); // $100
    let bal = (await g('/me')).data.user.balance;
    assert.equal(bal, 10025);

    const cfg = (await g('/games/config')).data;
    assert.equal(cfg.games.length, 20, '20 games, no slots');
    assert.ok(!cfg.games.some((x) => /slot/i.test(x.id)));

    const fair = (await g('/games/fair')).data;
    assert.ok(fair.server_hash.length === 64 && fair.nonce === 0);

    // instant game: dice
    r = await g('/games/dice/bet', { amount: 100, params: { target: 50, mode: 'under' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const d1 = r.data.bet;
    assert.equal(d1.status, 'settled');
    assert.equal(d1.nonce, 1);
    assert.equal(d1.server_seed, null, 'server seed hidden until rotation');
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
      limbo: { target: 2 }, coinflip: { side: 'heads', risk: 'medium' }, double: { pick: 'red' }, diamonds: { risk: 'low' },
      wheel: { risk: 'medium', segments: 20 }, plinko: { rows: 16, risk: 'high' }, keno: { picks: [1, 5, 9, 22, 40], risk: 'medium' },
      baccarat: { side: 'banker' }, cases: { risk: 'high' }, dragontiger: { side: 'tie' },
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
    assert.equal((await g('/games/fair/rotate', { client_seed: 'abc' })).status, 400, 'cannot rotate with an open round');
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
      const wins = (await g('/me/history')).data.transactions.filter((t) => t.type === 'win' && t.description.startsWith('Mines'));
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
    // crash: auto cash out at 1.01 resolves server-side
    r = await g('/games/crash/bet', { amount: 100, params: { auto: 1.01 } });
    const cb = r.data.bet;
    assert.ok(!('crashedAt' in cb.view), 'crash point hidden');
    await new Promise((ok) => setTimeout(ok, 250));
    r = await g(`/games/bets/${cb.id}/action`, { action: 'poll' });
    assert.equal(r.data.bet.status, 'settled');
    assert.ok([0, 101].includes(r.data.bet.payout), JSON.stringify(r.data.bet));
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
    // chicken: death lane hidden until the end
    r = await g('/games/chicken/bet', { amount: 100, params: { difficulty: 'easy' } });
    let ck = r.data.bet;
    assert.ok(!('death' in ck.view), 'the losing lane stays on the server');
    r = await g(`/games/bets/${ck.id}/action`, { action: 'step' });
    ck = r.data.bet;
    if (ck.status === 'active') {
      r = await g(`/games/bets/${ck.id}/action`, { action: 'cashout' });
      assert.equal(r.data.bet.payout, Math.floor(100 * 1.02 + 1e-9), 'one easy lane pays 1.02×');
    } else assert.equal(ck.payout, 0);
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

    // rotate, then the old server seed is revealed and the dice result verifies
    assert.equal((await g('/games/fair/rotate', { client_seed: 'my-new-seed' })).status, 200);
    const old = (await g('/games/bets?game=dice')).data.bets.find((x) => x.id === d1.id);
    assert.ok(old.server_seed && old.server_seed.length === 64, 'server seed revealed after rotation');
    const v = (await client()('/games/verify', { game: 'dice', server_seed: old.server_seed, client_seed: old.client_seed, nonce: old.nonce, params: old.params })).data;
    assert.equal(v.server_hash, old.server_hash, 'hash matches');
    assert.equal(v.result.roll, d1.result.roll, 'verifier reproduces the roll');
    assert.equal(v.rows.find((x) => x[0] === 'Roll')[1], d1.result.roll.toFixed(2), 'verifier rows show the roll');
    for (const { id } of cfg.games) {
      const vr = (await client()('/games/verify', { game: id, server_seed: old.server_seed, client_seed: 'c', nonce: 3 })).data;
      assert.ok(Array.isArray(vr.rows) && vr.rows.length >= 2, `verify rows for ${id}`);
    }
    assert.equal((await g('/games/fair')).data.client_seed, 'my-new-seed');

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
