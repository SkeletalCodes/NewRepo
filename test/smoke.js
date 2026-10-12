'use strict';
// End-to-end API test against a throwaway database (SQLite, or Postgres when DATABASE_URL is set).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goldrush-'));
if (!process.env.DATABASE_URL) process.env.DB_PATH = path.join(dir, 'test.db');
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

  /* ---------- misc ---------- */
  assert.equal((await user('/admin/overview')).status, 403, 'non-admin blocked');
  const o = (await admin('/admin/overview')).data;
  assert.ok(o.revenue_cents > 0 && o.active_walls === 3, JSON.stringify(o));
  assert.ok((await user('/leaderboard?period=weekly')).data.leaderboard.length > 0);
  assert.ok((await user('/feed')).data.feed.length > 0, 'feed shows real conversions');
  r = await admin(`/admin/offerwalls/${share.id}`, undefined, 'DELETE');
  assert.equal(r.status, 200, 'bodiless DELETE works');
  await user('/auth/logout', {});
  assert.equal((await user('/me')).status, 401);
  assert.equal((await user('/auth/login', { login: 'p1@example.com', password: 'password123' })).status, 200);

  console.log(`All smoke tests passed ✔ (${process.env.DATABASE_URL ? 'Postgres' : 'SQLite'})`);
  server.close();
  if (process.env.DATABASE_URL) process.exit(0); // close the pg pool
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
