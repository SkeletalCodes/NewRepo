'use strict';

const crypto = require('node:crypto');
const { db, credit } = require('./db');
const { hashPassword } = require('./auth');

const OFFERWALLS = [
  ['Gem Surveys', 'gem-surveys', 'Share your opinion, earn fast', '#22c55e', '📋', 0],
  ['PlayQuest', 'playquest', 'Top mobile & PC games', '#7c5cff', '🎮', 10],
  ['AppVault', 'appvault', 'Install apps, get rewarded', '#06b6d4', '📱', 0],
  ['LootLab', 'lootlab', 'Hand-picked high payers', '#f59e0b', '🧪', 15],
  ['ClickStream', 'clickstream', 'Watch videos & quick tasks', '#ec4899', '🎬', 0],
  ['ShopBack+', 'shopback', 'Cashback on purchases', '#ef4444', '🛍️', 5],
];

// [title, wall slug, category, reward, icon, color, device, minutes, featured, repeatable, description, requirements]
const OFFERS = [
  ['Dragon Realms: Reach Level 25', 'playquest', 'game', 18500, '🐉', '#ef4444', 'android', 4320, 1, 0,
    'Build your kingdom, train dragons and conquer rival clans in this epic strategy RPG.',
    'Install the game as a new player and reach castle level 25 within 14 days.'],
  ['Merge Mansion: Complete Chapter 3', 'playquest', 'game', 9200, '🏰', '#f59e0b', 'ios', 2880, 1, 0,
    'Merge items, uncover family secrets and restore the grand mansion.',
    'New players only. Complete chapter 3 within 10 days of install.'],
  ['Raid Legends: Hit Level 40', 'playquest', 'game', 32000, '⚔️', '#7c5cff', 'all', 10080, 1, 0,
    'Collect 700+ champions and battle across the dark fantasy world of Teleria.',
    'Reach player level 40 within 30 days. Must be a new account.'],
  ['Coin Pusher Frenzy', 'playquest', 'game', 2400, '🪙', '#eab308', 'android', 120, 0, 0,
    'Arcade-style coin pusher with daily prizes.', 'Install and reach level 15.'],
  ['Solitaire Royale', 'lootlab', 'game', 6800, '🃏', '#22c55e', 'all', 600, 1, 0,
    'Classic solitaire with tournaments and daily challenges.', 'Win 20 games within 7 days of install.'],
  ['Farm Valley Tycoon', 'lootlab', 'game', 14500, '🌾', '#84cc16', 'ios', 5760, 0, 0,
    'Grow crops, raise animals and build the ultimate farm empire.', 'Reach farm level 30 within 21 days.'],
  ['Crypto Wallet Signup', 'lootlab', 'signup', 4500, '🔐', '#3b82f6', 'all', 10, 1, 0,
    'Create a free self-custody crypto wallet.', 'Register with a valid email and complete identity verification.'],
  ['Daily Opinion Survey', 'gem-surveys', 'survey', 350, '📝', '#22c55e', 'all', 5, 0, 1,
    'A quick 5-minute survey about everyday products.', 'Answer all questions honestly. Screen-outs are not rewarded.'],
  ['Tech Habits Study', 'gem-surveys', 'survey', 900, '💻', '#06b6d4', 'desktop', 15, 0, 1,
    'Tell researchers how you use technology at home and work.', 'Complete the full survey on desktop.'],
  ['Gaming Preferences Poll', 'gem-surveys', 'survey', 600, '🕹️', '#a855f7', 'all', 8, 0, 1,
    'Share which games you play and why.', 'Complete all sections.'],
  ['Music Stream Free Trial', 'appvault', 'app', 3200, '🎧', '#ec4899', 'all', 5, 0, 0,
    'Start a free 30-day music streaming trial.', 'New subscribers only. Must remain active for 3 days.'],
  ['Cashback Browser Extension', 'appvault', 'app', 1200, '🧩', '#06b6d4', 'desktop', 3, 0, 0,
    'Install a free browser extension that finds coupons automatically.', 'Install and keep active for 48 hours.'],
  ['Budget Tracker App', 'appvault', 'app', 1800, '📊', '#14b8a6', 'android', 10, 0, 0,
    'Track spending and set savings goals.', 'Install, open, and link a budget category.'],
  ['Watch 5 Trailers', 'clickstream', 'video', 120, '🎬', '#ec4899', 'all', 4, 0, 1,
    'Watch five short movie trailers.', 'Watch each trailer to the end.'],
  ['Sponsored Video Playlist', 'clickstream', 'video', 250, '📺', '#f43f5e', 'all', 10, 0, 1,
    'Watch a playlist of sponsored videos.', 'Keep the tab active until the playlist completes.'],
  ['Meal Kit First Box', 'shopback', 'shopping', 22000, '🥗', '#ef4444', 'all', 20, 1, 0,
    'Order your first discounted meal kit box.', 'New customers only. Order must ship and not be cancelled.'],
  ['VPN Annual Plan', 'shopback', 'shopping', 26000, '🛡️', '#3b82f6', 'all', 10, 0, 0,
    'Protect your privacy with a top-rated VPN.', 'Purchase an annual plan. No refund within 30 days.'],
  ['Stock Trading App Deposit', 'lootlab', 'signup', 40000, '📈', '#10b981', 'all', 30, 1, 0,
    'Open a brokerage account and make your first deposit.', 'Deposit $50 or more within 7 days. 18+ only.'],
];

const METHODS = [
  ['PayPal', 'cash', '💸', '#3b82f6', 'PayPal email', 1000, 1],
  ['Bitcoin', 'crypto', '₿', '#f59e0b', 'BTC address', 5000, 2],
  ['Litecoin', 'crypto', 'Ł', '#94a3b8', 'LTC address', 2000, 3],
  ['Amazon Gift Card', 'giftcard', '🎁', '#f97316', 'Email for delivery', 5000, 4],
  ['Visa Prepaid', 'giftcard', '💳', '#6366f1', 'Email for delivery', 10000, 5],
  ['Roblox Robux', 'gaming', '🟥', '#ef4444', 'Roblox username', 2000, 6],
  ['Steam Wallet', 'gaming', '🎮', '#1e40af', 'Email for delivery', 5000, 7],
  ['Fortnite V-Bucks', 'gaming', '⚡', '#8b5cf6', 'Epic Games email', 6000, 8],
];

const DEMO_NAMES = ['NovaKid', 'pixelhunter', 'GemQueen', 'xXshadowXx', 'lootgoblin', 'TurboTom', 'mila_k', 'CryptoCat',
  'ace_runner', 'BlueJay22', 'sk8rboi', 'FrostByte', 'luckyluna', 'Zed_main', 'questmaster'];

/** Seed demo content once. Uses a settings marker so concurrent cold starts can't double-seed. */
async function seed() {
  await db.tx(async (t) => {
    const claimed = await t.run("INSERT INTO settings (key, value) VALUES ('seeded', '1') ON CONFLICT (key) DO NOTHING");
    if (claimed.changes !== 1) return;
    if ((await t.get('SELECT COUNT(*) AS n FROM offerwalls')).n > 0) return; // pre-existing data

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
    for (const [name, cat, icon, color, label, min, sort] of METHODS) {
      await t.run('INSERT INTO reward_methods (name, category, icon, color, field_label, min_coins, sort) VALUES (?, ?, ?, ?, ?, ?, ?)',
        name, cat, icon, color, label, min, sort);
    }
    await t.run('INSERT INTO promo_codes (code, reward, max_uses, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (code) DO NOTHING', 'WELCOME', 100, 0, now);

    if (process.env.SEED_DEMO !== '0') await seedDemoActivity(t, offers);
  });
}

/** Demo accounts (cannot log in) plus some history so the feed and leaderboard aren't empty. */
async function seedDemoActivity(t, offers) {
  const colors = ['#7c5cff', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#3b82f6'];
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

module.exports = { seed, ensureEnvAdmin };
