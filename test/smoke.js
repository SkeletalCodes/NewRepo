'use strict';
// End-to-end smoke test against a throwaway database.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemrush-'));
if (!process.env.DATABASE_URL) process.env.DB_PATH = path.join(dir, 'test.db');
const app = require('../server');

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;

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

(async () => {
  const admin = client();
  const user = client();

  let r = await admin('/auth/register', { username: 'boss', email: 'boss@example.com', password: 'password123', terms: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.user.role, 'admin', 'first real user becomes admin');
  assert.equal(r.data.user.balance, 250);
  const refCode = r.data.user.referral_code;

  r = await user('/auth/register', { username: 'player1', email: 'p1@example.com', password: 'password123', terms: true, referral: refCode });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'user');

  r = await user('/auth/register', { username: 'player1', email: 'x@example.com', password: 'password123', terms: true });
  assert.equal(r.status, 400, 'duplicate username rejected');

  r = await user('/offers');
  assert.ok(r.data.offers.length > 5);
  const offer = r.data.offers.find((o) => !o.repeatable);

  r = await user(`/offers/${offer.id}/complete`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'completed');
  assert.equal(r.data.user.balance, 250 + offer.payout);

  r = await user(`/offers/${offer.id}/complete`, {});
  assert.equal(r.status, 400, 'non-repeatable offer cannot be completed twice');

  r = await admin('/me');
  assert.equal(r.data.user.balance, 250 + Math.floor(offer.payout * 0.1), 'referrer got 10% commission');

  r = await user('/daily', {});
  assert.equal(r.status, 200);
  r = await user('/daily', {});
  assert.equal(r.status, 400, 'daily only once');

  r = await user('/promo', { code: 'welcome' });
  assert.equal(r.status, 200);
  r = await user('/promo', { code: 'WELCOME' });
  assert.equal(r.status, 400, 'promo only once');

  r = await user('/me');
  const before = r.data.user.balance;
  const { data: { methods } } = await user('/reward-methods');
  const paypal = methods.find((m) => m.name === 'PayPal');
  r = await user('/withdraw', { method_id: paypal.id, coins: 1000, destination: 'p1@example.com' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.user.balance, before - 1000);
  r = await user('/withdraw', { method_id: paypal.id, coins: 99999999, destination: 'p1@example.com' });
  assert.equal(r.status, 400);

  r = await user('/admin/overview');
  assert.equal(r.status, 403, 'non-admin blocked from admin API');

  r = await admin('/admin/withdrawals?status=pending');
  assert.equal(r.data.withdrawals.length, 1);
  r = await admin(`/admin/withdrawals/${r.data.withdrawals[0].id}/reject`, { note: 'test' });
  assert.equal(r.status, 200);
  r = await user('/me');
  assert.equal(r.data.user.balance, before, 'rejected withdrawal refunded');

  r = await admin('/admin/settings', { auto_approve_offers: 0 }, 'PUT');
  assert.equal(r.data.settings.auto_approve_offers, '0');
  const offer2 = (await user('/offers')).data.offers.find((o) => o.id !== offer.id && !o.repeatable);
  r = await user(`/offers/${offer2.id}/complete`, {});
  assert.equal(r.data.status, 'pending');
  const pending = (await admin('/admin/completions?status=pending')).data.completions[0];
  r = await admin(`/admin/completions/${pending.id}/approve`, {});
  assert.equal(r.status, 200);
  r = await user('/me');
  assert.equal(r.data.user.balance, before + offer2.payout);

  const secret = (await admin('/admin/settings')).data.settings.postback_secret;
  const uid = (await user('/me')).data.user.id;
  let pb = await fetch(`${base}/postback?secret=${secret}&user_id=${uid}&reward=500&txid=abc1&title=Real%20Offer&provider=TestNet`);
  assert.equal(await pb.text(), '1');
  pb = await fetch(`${base}/postback?secret=${secret}&user_id=${uid}&reward=500&txid=abc1`);
  assert.equal(await pb.text(), '1', 'duplicate postback ignored');
  r = await user('/me');
  assert.equal(r.data.user.balance, before + offer2.payout + 500);
  pb = await fetch(`${base}/postback?secret=${secret}&user_id=${uid}&reward=500&txid=abc1&status=2`);
  r = await user('/me');
  assert.equal(r.data.user.balance, before + offer2.payout, 'chargeback reverses');
  pb = await fetch(`${base}/postback?secret=wrongwrongwrong&user_id=${uid}&reward=500&txid=abc2`);
  assert.equal(pb.status, 403);

  r = await user('/auth/logout', {});
  r = await user('/me');
  assert.equal(r.status, 401);
  r = await user('/auth/login', { login: 'p1@example.com', password: 'password123' });
  assert.equal(r.status, 200);
  r = await user('/auth/login', { login: 'player1', password: 'wrong-password' });
  assert.equal(r.status, 401);

  r = await user('/leaderboard?period=weekly');
  assert.ok(r.data.leaderboard.length > 0);
  r = await user('/feed');
  assert.ok(r.data.feed.length > 0);

  // Bodiless DELETE from the admin UI must work.
  const offers = (await admin('/admin/offers')).data.offers;
  r = await admin(`/admin/offers/${offers[0].id}`, undefined, 'DELETE');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await admin('/admin/offers')).data.offers.length, offers.length - 1);

  // Case-insensitive usernames.
  r = await client()('/auth/register', { username: 'PLAYER1', email: 'p1b@example.com', password: 'password123', terms: true });
  assert.equal(r.status, 400);

  console.log(`All smoke tests passed ✔ (${process.env.DATABASE_URL ? 'Postgres' : 'SQLite'})`);
  server.close();
  if (process.env.DATABASE_URL) process.exit(0); // close the pg pool
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
