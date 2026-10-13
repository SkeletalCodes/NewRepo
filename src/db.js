'use strict';

/*
 * Database layer with two backends behind one async API:
 *   - Postgres when DATABASE_URL (or POSTGRES_URL) is set: use this in production / on Vercel.
 *   - SQLite (node:sqlite) otherwise: zero-config local development.
 *
 * API: get(sql, ...params), all(sql, ...params), run(sql, ...params) -> { changes },
 *      tx(async (t) => ...) where t has the same get/all/run.
 * SQL is written with `?` placeholders and portable syntax (ON CONFLICT, RETURNING, lower()).
 */

const path = require('node:path');
const fs = require('node:fs');

const PG_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const IS_PG = !!PG_URL;
const ON_VERCEL = !!process.env.VERCEL;

let backend;

if (IS_PG) {
  const pg = require('pg');
  pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // int8 (COUNT, SUM of ints, BIGINT columns)
  pg.types.setTypeParser(1700, (v) => parseFloat(v)); // numeric
  const pool = new pg.Pool({ connectionString: PG_URL, max: ON_VERCEL ? 3 : 10 });

  const toPg = (sql) => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  };
  const exec = (client) => ({
    async get(sql, ...p) { return (await client.query(toPg(sql), p)).rows[0]; },
    async all(sql, ...p) { return (await client.query(toPg(sql), p)).rows; },
    async run(sql, ...p) { return { changes: (await client.query(toPg(sql), p)).rowCount }; },
  });

  backend = {
    ...exec(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(exec(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
} else {
  const { DatabaseSync } = require('node:sqlite');
  // Vercel's filesystem is read-only except /tmp (and /tmp is wiped often): demo mode only.
  const file = process.env.DB_PATH || (ON_VERCEL ? '/tmp/gemrush.db' : path.join(__dirname, '..', 'data', 'gemrush.db'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new DatabaseSync(file);
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  const exec = {
    async get(sql, ...p) { return sqlite.prepare(sql).get(...p); },
    async all(sql, ...p) { return sqlite.prepare(sql).all(...p); },
    async run(sql, ...p) { return { changes: Number(sqlite.prepare(sql).run(...p).changes) }; },
  };
  // One connection, so serialize transactions to keep other requests' queries out of them.
  let lock = Promise.resolve();
  backend = {
    ...exec,
    exec: (sql) => sqlite.exec(sql),
    tx(fn) {
      const run = lock.then(async () => {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(exec);
          sqlite.exec('COMMIT');
          return result;
        } catch (err) {
          sqlite.exec('ROLLBACK');
          throw err;
        }
      });
      lock = run.catch(() => {});
      return run;
    },
  };
}

const ID = IS_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id ${ID},
    username TEXT NOT NULL,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0,
    total_earned INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'user',
    banned INTEGER NOT NULL DEFAULT 0,
    referral_code TEXT NOT NULL UNIQUE,
    referred_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    avatar_color TEXT NOT NULL DEFAULT '#7c5cff',
    onboarded INTEGER NOT NULL DEFAULT 0,
    is_demo INTEGER NOT NULL DEFAULT 0,
    last_daily_at BIGINT,
    last_login_at BIGINT,
    created_at BIGINT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_users_username ON users (lower(username))',
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users (lower(email))',
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS offerwalls (
    id ${ID},
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    tagline TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#eac837',
    icon TEXT NOT NULL DEFAULT 'fa-layer-group',
    bonus_percent INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS offers (
    id ${ID},
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    requirements TEXT NOT NULL DEFAULT '',
    offerwall_id INTEGER REFERENCES offerwalls(id) ON DELETE SET NULL,
    category TEXT NOT NULL DEFAULT 'game',
    reward INTEGER NOT NULL,
    icon TEXT NOT NULL DEFAULT '🎮',
    color TEXT NOT NULL DEFAULT '#7c5cff',
    device TEXT NOT NULL DEFAULT 'all',
    est_minutes INTEGER NOT NULL DEFAULT 10,
    url TEXT NOT NULL DEFAULT '',
    featured INTEGER NOT NULL DEFAULT 0,
    repeatable INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    completions INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS offer_completions (
    id ${ID},
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    offer_id INTEGER REFERENCES offers(id) ON DELETE SET NULL,
    offer_title TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'Featured',
    reward INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    txid TEXT UNIQUE,
    note TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS transactions (
    id ${ID},
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    type TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reward_methods (
    id ${ID},
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'cash',
    icon TEXT NOT NULL DEFAULT '💵',
    color TEXT NOT NULL DEFAULT '#22c55e',
    field_label TEXT NOT NULL DEFAULT 'Email',
    min_coins INTEGER NOT NULL DEFAULT 1000,
    active INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS withdrawals (
    id ${ID},
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    method_id INTEGER REFERENCES reward_methods(id) ON DELETE SET NULL,
    method_name TEXT NOT NULL,
    coins INTEGER NOT NULL,
    usd DOUBLE PRECISION NOT NULL,
    destination TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    admin_note TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL,
    processed_at BIGINT
  )`,
  `CREATE TABLE IF NOT EXISTS promo_codes (
    code TEXT PRIMARY KEY,
    reward INTEGER NOT NULL,
    max_uses INTEGER NOT NULL DEFAULT 0,
    uses INTEGER NOT NULL DEFAULT 0,
    expires_at BIGINT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS promo_redemptions (
    code TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (code, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS postback_logs (
    id ${ID},
    offerwall_id INTEGER REFERENCES offerwalls(id) ON DELETE CASCADE,
    ip TEXT NOT NULL DEFAULT '',
    method TEXT NOT NULL DEFAULT 'GET',
    params TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    user_id INTEGER,
    amount INTEGER,
    created_at BIGINT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_pb_wall ON postback_logs(offerwall_id, id)',
  `CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    used_at BIGINT,
    ip TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_pr_user ON password_resets(user_id)',
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    reset_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id ${ID},
    admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_oc_user ON offer_completions(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_oc_status ON offer_completions(status)',
  'CREATE INDEX IF NOT EXISTS idx_wd_status ON withdrawals(status)',
];

// Money settings are in US cents.
/*
 * Columns added after the first release. They're added to existing tables on startup if missing,
 * so the CREATE TABLE statements above stay as they were.
 */
const ADDED_COLUMNS = {
  users: [
    ['signup_ip', "TEXT NOT NULL DEFAULT ''"],
    ['last_ip', "TEXT NOT NULL DEFAULT ''"],
    ['failed_logins', 'INTEGER NOT NULL DEFAULT 0'],
    ['locked_until', 'BIGINT'],
    ['password_changed_at', 'BIGINT'],
  ],
  sessions: [
    ['ip', "TEXT NOT NULL DEFAULT ''"],
    ['user_agent', "TEXT NOT NULL DEFAULT ''"],
    ['last_seen_at', 'BIGINT NOT NULL DEFAULT 0'],
    ['remember', 'INTEGER NOT NULL DEFAULT 1'],
  ],
  offerwalls: [
    // Integration
    ['preset', "TEXT NOT NULL DEFAULT 'custom'"],
    ['iframe_url', "TEXT NOT NULL DEFAULT ''"], // {user_id} and {username} are substituted
    ['open_mode', "TEXT NOT NULL DEFAULT 'iframe'"], // iframe | tab
    ['postback_token', "TEXT NOT NULL DEFAULT ''"], // secret path segment in the postback URL
    ['ip_whitelist', "TEXT NOT NULL DEFAULT ''"], // comma separated, empty = any IP
    // Signature check
    ['sig_method', "TEXT NOT NULL DEFAULT 'none'"], // none | md5 | sha1 | sha256 | hmac-sha1 | hmac-sha256
    ['sig_mode', "TEXT NOT NULL DEFAULT 'template'"], // template | url
    ['sig_template', "TEXT NOT NULL DEFAULT ''"], // e.g. {txid}-{secret}
    ['sig_param', "TEXT NOT NULL DEFAULT 'hash'"],
    ['sig_secret', "TEXT NOT NULL DEFAULT ''"],
    // Postback parameter names
    ['p_user', "TEXT NOT NULL DEFAULT 'user_id'"],
    ['p_txid', "TEXT NOT NULL DEFAULT 'txid'"],
    ['p_reward', "TEXT NOT NULL DEFAULT 'reward'"],
    ['p_payout', "TEXT NOT NULL DEFAULT 'payout'"],
    ['p_status', "TEXT NOT NULL DEFAULT 'status'"],
    ['p_offer', "TEXT NOT NULL DEFAULT 'offer'"],
    ['p_ip', "TEXT NOT NULL DEFAULT 'ip'"],
    // How the user's reward is worked out
    ['amount_source', "TEXT NOT NULL DEFAULT 'reward'"], // reward | payout
    ['amount_unit', "TEXT NOT NULL DEFAULT 'cents'"], // cents | dollars (for amount_source = reward)
    ['revenue_share', 'INTEGER NOT NULL DEFAULT 70'], // % of payout given to the user (for amount_source = payout)
    ['reversal_values', "TEXT NOT NULL DEFAULT '2,reversed,chargeback,rejected'"],
    ['success_response', "TEXT NOT NULL DEFAULT '1'"],
    ['hold_hours', 'INTEGER NOT NULL DEFAULT 0'],
    ['created_at', 'BIGINT NOT NULL DEFAULT 0'],
  ],
  offer_completions: [
    ['offerwall_id', 'INTEGER'],
    ['payout_cents', 'INTEGER NOT NULL DEFAULT 0'], // revenue the network reported paying us
    ['ip', "TEXT NOT NULL DEFAULT ''"],
    ['release_at', 'BIGINT'],
  ],
};

async function hasColumn(t, table, column) {
  if (IS_PG) {
    return !!(await t.get('SELECT 1 AS x FROM information_schema.columns WHERE table_name = ? AND column_name = ?', table, column));
  }
  return !!(await t.get(`SELECT 1 AS x FROM pragma_table_info('${table}') WHERE name = ?`, column));
}

const DEFAULT_SETTINGS = {
  site_name: 'GoldRush',
  signup_bonus: '25',
  daily_reward: '5',
  referral_percent: '10',
  announcement: 'New here? Use code WELCOME for a free bonus.',
  maintenance: '0',
  max_accounts_per_ip: '0', // 0 = no limit
};

/** Create tables and default settings. Safe to run concurrently (serverless cold starts). */
async function migrate() {
  await backend.tx(async (t) => {
    if (IS_PG) await t.get('SELECT pg_advisory_xact_lock(727274)');
    for (const stmt of SCHEMA) await t.run(stmt);
    for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
      for (const [name, type] of cols) {
        if (!(await hasColumn(t, table, name))) await t.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
    }
    await t.run('CREATE INDEX IF NOT EXISTS idx_oc_release ON offer_completions(status, release_at)');
    await t.run('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
    await t.run('CREATE INDEX IF NOT EXISTS idx_users_signup_ip ON users(signup_ip)');
    const defaults = DEFAULT_SETTINGS;
    for (const [k, v] of Object.entries(defaults)) {
      await t.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', k, v);
    }
  });
}

async function getSettings(q = backend) {
  const out = {};
  for (const row of await q.all('SELECT key, value FROM settings')) out[row.key] = row.value;
  return out;
}

async function getSetting(key, q = backend) {
  const row = await q.get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : DEFAULT_SETTINGS[key];
}

async function setSetting(key, value) {
  await backend.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, String(value));
}

/** Credit (or debit, with a negative amount) a user's balance and log it in the ledger. */
async function credit(q, userId, amount, type, description, at = Date.now()) {
  const earned = amount > 0 && type !== 'refund' && type !== 'admin' ? amount : 0;
  await q.run('UPDATE users SET balance = balance + ?, total_earned = total_earned + ? WHERE id = ?', amount, earned, userId);
  await q.run('INSERT INTO transactions (user_id, amount, type, description, created_at) VALUES (?, ?, ?, ?, ?)',
    userId, amount, type, description, at);
}

/**
 * Atomically debit a user only if they have enough balance. Returns false if they don't.
 * Uses a conditional UPDATE so concurrent requests can't overdraw.
 */
async function debit(q, userId, amount, type, description) {
  const r = await q.run('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?', amount, userId, amount);
  if (r.changes !== 1) return false;
  await q.run('INSERT INTO transactions (user_id, amount, type, description, created_at) VALUES (?, ?, ?, ?, ?)',
    userId, -amount, type, description, Date.now());
  return true;
}

module.exports = {
  db: backend,
  IS_PG,
  ON_VERCEL,
  EPHEMERAL: !IS_PG && ON_VERCEL,
  migrate,
  credit,
  debit,
  getSettings,
  getSetting,
  setSetting,
};
