'use strict';

const crypto = require('node:crypto');
const { db, credit } = require('./db');
const { hashPassword } = require('./auth');

/*
 * All money is stored as integer US cents.
 * Icons: 'fa-name' (Font Awesome solid), 'fa-brands fa-name', or 'img:/path.svg'.
 */

const SCHEMA_VERSION = '2';

const OFFERWALLS = [
  ['Opinion Hub', 'opinion-hub', 'Paid surveys, matched to you', '#14F195', 'fa-clipboard-check', 0],
  ['PlayQuest', 'playquest', 'Mobile & PC game milestones', '#eac837', 'fa-gamepad', 10],
  ['AppVault', 'appvault', 'Install apps, get paid', '#7dd3fc', 'fa-mobile-screen-button', 0],
  ['LootLab', 'lootlab', 'High payers, hand-picked', '#f59e0b', 'fa-flask', 15],
  ['ClickStream', 'clickstream', 'Videos & quick tasks', '#f472b6', 'fa-circle-play', 0],
  ['ShopBack+', 'shopback', 'Cashback on purchases', '#ff5c7a', 'fa-bag-shopping', 5],
];
const OLD_WALL_SLUGS = { 'gem-surveys': ['Opinion Hub', 'opinion-hub'] };

// [title, wall slug, category, reward (cents), icon, color, device, minutes, featured, repeatable, description, requirements]
const OFFERS = [
  ['Dragon Realms: Reach Level 25', 'playquest', 'game', 1850, 'fa-dragon', '#ff5c7a', 'android', 4320, 1, 0,
    'Build your kingdom, train dragons and take on rival clans in this strategy RPG.',
    'Install the game as a new player and reach castle level 25 within 14 days.'],
  ['Merge Mansion: Complete Chapter 3', 'playquest', 'game', 920, 'fa-chess-rook', '#f59e0b', 'ios', 2880, 1, 0,
    'Merge items, uncover family secrets and restore the old mansion.',
    'New players only. Complete chapter 3 within 10 days of install.'],
  ['Raid Legends: Hit Level 40', 'playquest', 'game', 3200, 'fa-hat-wizard', '#a78bfa', 'all', 10080, 1, 0,
    'Collect champions and battle across a dark fantasy world.',
    'Reach player level 40 within 30 days. Must be a new account.'],
  ['Coin Pusher Frenzy', 'playquest', 'game', 240, 'fa-coins', '#eac837', 'android', 120, 0, 0,
    'Arcade-style coin pusher with daily prizes.', 'Install and reach level 15.'],
  ['Solitaire Royale', 'lootlab', 'game', 680, 'fa-heart', '#14F195', 'all', 600, 1, 0,
    'Classic solitaire with tournaments and daily challenges.', 'Win 20 games within 7 days of install.'],
  ['Farm Valley Tycoon', 'lootlab', 'game', 1450, 'fa-wheat-awn', '#a3e635', 'ios', 5760, 0, 0,
    'Grow crops, raise animals and build a farming empire.', 'Reach farm level 30 within 21 days.'],
  ['Crypto Wallet Signup', 'lootlab', 'signup', 450, 'fa-wallet', '#7dd3fc', 'all', 10, 1, 0,
    'Create a free self-custody crypto wallet.', 'Register with a valid email and complete identity verification.'],
  ['Daily Opinion Survey', 'opinion-hub', 'survey', 35, 'fa-clipboard-list', '#14F195', 'all', 5, 0, 1,
    'A quick 5-minute survey about everyday products.', 'Answer all questions honestly. Screen-outs are not rewarded.'],
  ['Tech Habits Study', 'opinion-hub', 'survey', 90, 'fa-laptop', '#7dd3fc', 'desktop', 15, 0, 1,
    'Tell researchers how you use technology at home and work.', 'Complete the full survey on desktop.'],
  ['Gaming Preferences Poll', 'opinion-hub', 'survey', 60, 'fa-gamepad', '#a78bfa', 'all', 8, 0, 1,
    'Share which games you play and why.', 'Complete all sections.'],
  ['Music Stream Free Trial', 'appvault', 'app', 320, 'fa-headphones', '#f472b6', 'all', 5, 0, 0,
    'Start a free 30-day music streaming trial.', 'New subscribers only. Must remain active for 3 days.'],
  ['Cashback Browser Extension', 'appvault', 'app', 120, 'fa-puzzle-piece', '#7dd3fc', 'desktop', 3, 0, 0,
    'Install a free browser extension that finds coupons automatically.', 'Install and keep active for 48 hours.'],
  ['Budget Tracker App', 'appvault', 'app', 180, 'fa-chart-pie', '#2dd4bf', 'android', 10, 0, 0,
    'Track spending and set savings goals.', 'Install, open, and link a budget category.'],
  ['Watch 5 Trailers', 'clickstream', 'video', 12, 'fa-film', '#f472b6', 'all', 4, 0, 1,
    'Watch five short movie trailers.', 'Watch each trailer to the end.'],
  ['Sponsored Video Playlist', 'clickstream', 'video', 25, 'fa-tv', '#ff5c7a', 'all', 10, 0, 1,
    'Watch a playlist of sponsored videos.', 'Keep the tab active until the playlist completes.'],
  ['Meal Kit First Box', 'shopback', 'shopping', 2200, 'fa-bowl-food', '#ff5c7a', 'all', 20, 1, 0,
    'Order your first discounted meal kit box.', 'New customers only. Order must ship and not be cancelled.'],
  ['VPN Annual Plan', 'shopback', 'shopping', 2600, 'fa-user-shield', '#7dd3fc', 'all', 10, 0, 0,
    'Protect your privacy with a top-rated VPN.', 'Purchase an annual plan. No refund within 30 days.'],
  ['Stock Trading App Deposit', 'lootlab', 'signup', 4000, 'fa-chart-line', '#14F195', 'all', 30, 1, 0,
    'Open a brokerage account and make your first deposit.', 'Deposit $50 or more within 7 days. 18+ only.'],
];

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

const DEMO_NAMES = ['NovaKid', 'pixelhunter', 'GoldQueen', 'xXshadowXx', 'lootgoblin', 'TurboTom', 'mila_k', 'CryptoCat',
  'ace_runner', 'BlueJay22', 'sk8rboi', 'FrostByte', 'luckyluna', 'Zed_main', 'questmaster'];

async function insertMethods(t) {
  for (const [name, cat, icon, color, label, min, sort] of METHODS) {
    await t.run('INSERT INTO reward_methods (name, category, icon, color, field_label, min_coins, sort) VALUES (?, ?, ?, ?, ?, ?, ?)',
      name, cat, icon, color, label, min, sort);
  }
}

/** Seed demo content once. Uses a settings marker so concurrent cold starts can't double-seed. */
async function seed() {
  await db.tx(async (t) => {
    const claimed = await t.run("INSERT INTO settings (key, value) VALUES ('seeded', '1') ON CONFLICT (key) DO NOTHING");
    if (claimed.changes !== 1) return;
    if ((await t.get('SELECT COUNT(*) AS n FROM offerwalls')).n > 0) return; // pre-existing data
    await t.run("INSERT INTO settings (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO NOTHING", SCHEMA_VERSION);

    const now = Date.now();
    const wallId = {};
    for (const [i, [name, slug, tagline, color, icon, bonus]] of OFFERWALLS.entries()) {
      const row = await t.get('INSERT INTO offerwalls (name, slug, tagline, color, icon, bonus_percent, sort) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
        name, slug, tagline, color, icon, bonus, i);
      wallId[slug] = row.id;
    }
    const offers = [];
    for (const [title, wall, cat, reward, icon, color, device, mins, featured, repeatable, desc, reqs] of OFFERS) {
      const row = await t.get(`INSERT INTO offers (title, description, requirements, offerwall_id, category, reward, icon, color, device, est_minutes, featured, repeatable, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, title, desc, reqs, wallId[wall], cat, reward, icon, color, device, mins, featured, repeatable, now);
      const w = OFFERWALLS.find((x) => x[1] === wall);
      offers.push({ id: row.id, title, reward, provider: w[0] });
    }
    await insertMethods(t);
    await t.run('INSERT INTO promo_codes (code, reward, max_uses, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (code) DO NOTHING', 'WELCOME', 10, 0, now);

    if (process.env.SEED_DEMO !== '0') await seedDemoActivity(t, offers);
  });
}

/** Demo accounts (cannot log in) plus some history so the feed and leaderboard aren't empty. */
async function seedDemoActivity(t, offers) {
  const colors = ['#eac837', '#14F195', '#7dd3fc', '#ff5c7a', '#a78bfa', '#f59e0b', '#f472b6'];
  const unusable = hashPassword(crypto.randomBytes(24).toString('hex'));
  const now = Date.now();
  for (const [i, name] of DEMO_NAMES.entries()) {
    const row = await t.get(`INSERT INTO users (username, email, password_hash, referral_code, avatar_color, onboarded, is_demo, created_at)
      VALUES (?, ?, ?, ?, ?, 1, 1, ?) RETURNING id`, name, `${name.toLowerCase()}@demo.invalid`, unusable,
    crypto.randomBytes(4).toString('hex').toUpperCase(), colors[i % colors.length], now - (20 - i) * 86400000);
    const count = 2 + (i % 4);
    for (let k = 0; k < count; k++) {
      const o = offers[(i * 3 + k * 5) % offers.length];
      const at = now - Math.floor(Math.random() * 6 * 86400000);
      await t.run(`INSERT INTO offer_completions (user_id, offer_id, offer_title, provider, reward, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`, row.id, o.id, o.title, o.provider, o.reward, at, at);
      await credit(t, row.id, o.reward, 'offer', `${o.provider}: ${o.title}`, at);
      await t.run('UPDATE offers SET completions = completions + 1 WHERE id = ?', o.id);
    }
  }
}

/**
 * Upgrade databases created by v1 (Gems, 1,000 per $1) to v2 (USD cents, crypto/prepaid/gift-card cashouts).
 * Runs once, guarded by the schema_version setting.
 */
async function upgrade() {
  await db.tx(async (t) => {
    const claimed = await t.run("INSERT INTO settings (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO NOTHING", SCHEMA_VERSION);
    if (claimed.changes !== 1) return;

    // 1,000 gems = $1 = 100 cents
    await t.run('UPDATE users SET balance = balance / 10, total_earned = total_earned / 10');
    await t.run('UPDATE transactions SET amount = amount / 10');
    await t.run('UPDATE offers SET reward = CASE WHEN reward >= 10 THEN reward / 10 ELSE 1 END');
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

    // New cashout lineup: crypto, prepaid cards, gift cards.
    await t.run('DELETE FROM reward_methods');
    await insertMethods(t);

    // Swap emoji icons on the demo offerwalls/offers for real icons.
    for (const [oldSlug, [name, slug]] of Object.entries(OLD_WALL_SLUGS)) {
      await t.run('UPDATE offerwalls SET name = ?, slug = ? WHERE slug = ?', name, slug, oldSlug);
    }
    for (const [name, slug, tagline, color, icon] of OFFERWALLS) {
      await t.run('UPDATE offerwalls SET name = ?, tagline = ?, color = ?, icon = ? WHERE slug = ?', name, tagline, color, icon, slug);
    }
    for (const [title, , , , icon, color] of OFFERS) {
      await t.run('UPDATE offers SET icon = ?, color = ? WHERE title = ?', icon, color, title);
    }
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
