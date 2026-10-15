'use strict';

const crypto = require('node:crypto');
const { db, credit } = require('./db');
const { hashPassword } = require('./auth');

/*
 * Seed data and one-time upgrades. All money is stored as integer US cents.
 * Icons: 'fa-name' (Font Awesome solid), 'fa-brands fa-name', or 'img:/path.svg'.
 *
 * Nothing fake is seeded: no offers, no offerwalls, no demo users. Add real offerwalls in the
 * admin panel (Admin -> Offerwalls).
 */

// [name, category, icon, color, destination label, minimum (cents), sort]
const METHODS = [
  ['Bitcoin', 'crypto', 'img:/img/crypto/btc.svg', '#f7931a', 'Bitcoin (BTC) address', 500, 1],
  ['Ethereum', 'crypto', 'img:/img/crypto/eth.svg', '#627eea', 'Ethereum (ERC-20) address', 500, 2],
  ['Litecoin', 'crypto', 'img:/img/crypto/ltc.svg', '#bfbbbb', 'Litecoin (LTC) address', 500, 3],
  ['Solana', 'crypto', 'img:/img/crypto/sol.svg', '#9945ff', 'Solana (SOL) address', 500, 4],
  ['BNB', 'crypto', 'img:/img/crypto/bnb.svg', '#f3ba2f', 'BNB Smart Chain (BEP-20) address', 500, 5],
  ['Tron', 'crypto', 'img:/img/crypto/trx.svg', '#ef0027', 'Tron (TRX) address', 500, 6],
  ['Dogecoin', 'crypto', 'img:/img/crypto/doge.svg', '#c2a633', 'Dogecoin (DOGE) address', 500, 7],
  ['Visa Prepaid', 'prepaid', 'fa-brands fa-cc-visa', '#ffffff', 'Email for delivery', 2000, 10],
  ['Mastercard Prepaid', 'prepaid', 'fa-brands fa-cc-mastercard', '#eb001b', 'Email for delivery', 2000, 11],
  ['Amazon', 'giftcard', 'fa-brands fa-amazon', '#ff9900', 'Email for delivery', 500, 20],
  ['Walmart', 'giftcard', 'img:/img/brands/walmart.svg', '#0071ce', 'Email for delivery', 500, 21],
  ['Target', 'giftcard', 'img:/img/brands/target.svg', '#cc0000', 'Email for delivery', 500, 22],
  ['Apple', 'giftcard', 'fa-brands fa-apple', '#e8edf5', 'Email for delivery', 500, 23],
  ['Google Play', 'giftcard', 'fa-brands fa-google-play', '#34a853', 'Email for delivery', 500, 24],
  ['Steam', 'giftcard', 'fa-brands fa-steam', '#66c0f4', 'Email for delivery', 500, 25],
];

async function insertMethods(t) {
  for (const [name, cat, icon, color, label, min, sort] of METHODS) {
    await t.run('INSERT INTO reward_methods (name, category, icon, color, field_label, min_coins, sort) VALUES (?, ?, ?, ?, ?, ?, ?)',
      name, cat, icon, color, label, min, sort);
  }
}

const claim = async (t, key) => (await t.run("INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT (key) DO NOTHING", key)).changes === 1;

/** First start on an empty database: payout methods and a welcome promo code. */
async function seed() {
  await db.tx(async (t) => {
    if (!(await claim(t, 'seeded'))) return;
    // A brand-new database is already in the current format, so skip the upgrades below.
    await claim(t, 'upgraded_v2');
    await claim(t, 'upgraded_v3');
    if ((await t.get('SELECT COUNT(*) AS n FROM reward_methods')).n === 0) await insertMethods(t);
    await t.run('INSERT INTO promo_codes (code, reward, max_uses, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (code) DO NOTHING', 'WELCOME', 10, 0, Date.now());
  });
}

/** v1 -> v2: Gems (1,000 per $1) to USD cents, and the crypto / prepaid / gift card payout lineup. */
async function upgradeV2(t) {
  const legacy = await t.get("SELECT value FROM settings WHERE key = 'schema_version'");
  if (legacy) return; // already converted by an earlier release
  await t.run('UPDATE users SET balance = balance / 10, total_earned = total_earned / 10');
  await t.run('UPDATE transactions SET amount = amount / 10');
  await t.run('UPDATE offer_completions SET reward = reward / 10');
  await t.run('UPDATE withdrawals SET coins = coins / 10');
  await t.run('UPDATE promo_codes SET reward = CASE WHEN reward >= 10 THEN reward / 10 ELSE 1 END');
  for (const key of ['signup_bonus', 'daily_reward']) {
    const row = await t.get('SELECT value FROM settings WHERE key = ?', key);
    if (row) await t.run('UPDATE settings SET value = ? WHERE key = ?', String(Math.floor(Number(row.value) / 10) || 0), key);
  }
  await t.run("DELETE FROM settings WHERE key IN ('currency_name', 'coins_per_usd', 'min_withdraw')");
  await t.run("UPDATE settings SET value = 'GoldRush' WHERE key = 'site_name' AND value = 'GemRush'");
  await t.run("UPDATE settings SET value = ? WHERE key = 'announcement' AND value LIKE '%WELCOME for 100 free gems%'",
    'New here? Use code WELCOME for a free bonus.');
  await t.run('DELETE FROM reward_methods');
  await insertMethods(t);
}

const lowerEarned = (t, userId, cents) => t.run(
  'UPDATE users SET total_earned = CASE WHEN total_earned > ? THEN total_earned - ? ELSE 0 END WHERE id = ?', cents, cents, userId);

const DEMO_WALL_SLUGS = ['gem-surveys', 'opinion-hub', 'playquest', 'appvault', 'lootlab', 'clickstream', 'shopback'];

/**
 * v2 -> v3: remove everything fake. Demo users and their history, the demo offers and offerwalls,
 * and any balance users got from the simulated "Start offer" button (those completions have no txid).
 */
async function upgradeV3(t) {
  await t.run('DELETE FROM users WHERE is_demo = 1');

  const fake = await t.all("SELECT user_id, SUM(reward) AS total FROM offer_completions WHERE txid IS NULL AND status = 'completed' GROUP BY user_id");
  for (const { user_id: userId, total } of fake) {
    if (!total) continue;
    await lowerEarned(t, userId, total);
    await credit(t, userId, -total, 'adjustment', 'Removed earnings from demo offers');
  }
  // Referral commissions paid on demo offers.
  const realEarners = new Set((await t.all("SELECT DISTINCT user_id FROM offer_completions WHERE txid IS NOT NULL AND status = 'completed'")).map((r) => r.user_id));
  const commissions = await t.all("SELECT t.user_id, t.amount, t.description FROM transactions t WHERE t.type = 'referral'");
  for (const c of commissions) {
    const m = /commission from (.+)$/.exec(c.description);
    const source = m && (await t.get('SELECT id FROM users WHERE username = ?', m[1]));
    if (source && realEarners.has(source.id)) continue;
    await lowerEarned(t, c.user_id, c.amount);
    await credit(t, c.user_id, -c.amount, 'adjustment', `Removed referral commission from demo offers (${m ? m[1] : 'unknown'})`);
  }

  await t.run('DELETE FROM offer_completions WHERE txid IS NULL');
  await t.run('DELETE FROM offers');
  for (const slug of DEMO_WALL_SLUGS) await t.run("DELETE FROM offerwalls WHERE slug = ? AND postback_token = ''", slug);
  await t.run("DELETE FROM settings WHERE key IN ('auto_approve_offers', 'postback_secret')");
}

/** Run pending one-time upgrades, each exactly once even with concurrent cold starts. */
/*
 * One-time fresh start after the testing phase: every balance, every bet, every earning and withdrawal
 * is cleared. Accounts (usernames, emails, passwords, sessions), admins, offerwall setup, payout methods
 * and site settings are kept.
 */
async function resetActivity(t) {
  for (const table of ['transactions', 'offer_completions', 'withdrawals', 'promo_redemptions', 'postback_logs',
    'bets', 'rounds', 'fair_seeds', 'password_resets', 'rate_limits']) {
    await t.run(`DELETE FROM ${table}`);
  }
  await t.run('UPDATE promo_codes SET uses = 0');
  await t.run('UPDATE users SET balance = 0, total_earned = 0, last_daily_at = NULL, failed_logins = 0, locked_until = NULL');
}

async function upgrade() {
  await db.tx(async (t) => {
    if (await claim(t, 'upgraded_v2')) await upgradeV2(t);
  });
  await db.tx(async (t) => {
    if (await claim(t, 'upgraded_v3')) await upgradeV3(t);
  });
  await db.tx(async (t) => {
    if (await claim(t, 'reset_v5')) await resetActivity(t);
  });
}

/** Create or promote an admin from ADMIN_USERNAME / ADMIN_EMAIL / ADMIN_PASSWORD env vars. */
async function ensureEnvAdmin() {
  const { ADMIN_USERNAME, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) return;
  const existing = await db.get('SELECT id FROM users WHERE lower(username) = lower(?)', ADMIN_USERNAME);
  if (existing) {
    await db.run("UPDATE users SET role = 'admin', password_hash = ?, banned = 0 WHERE id = ?", hashPassword(ADMIN_PASSWORD), existing.id);
  } else {
    await db.run(`INSERT INTO users (username, email, password_hash, role, referral_code, onboarded, created_at)
      VALUES (?, ?, ?, 'admin', ?, 1, ?) ON CONFLICT DO NOTHING`, ADMIN_USERNAME, (ADMIN_EMAIL || `${ADMIN_USERNAME}@localhost`).toLowerCase(),
    hashPassword(ADMIN_PASSWORD), crypto.randomBytes(4).toString('hex').toUpperCase(), Date.now());
  }
}

module.exports = { seed, upgrade, ensureEnvAdmin };
