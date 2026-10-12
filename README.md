# GoldRush: a get-paid-to (GPT) rewards site

A complete GPT / offerwall rewards site (similar to Gemsloot, Freecash, etc.): users earn **US dollars** by completing offers and cash out in **crypto** (BTC, ETH, LTC, SOL, BNB, TRX, DOGE, from $5), **prepaid cards** (Visa, Mastercard, from $20) or **gift cards** (Amazon, Walmart, Target, Apple, Google Play, Steam, from $5). Minimums can be changed per method in the admin panel. It ships with a full admin panel and a production-ready offerwall postback backend.

Built with **Node.js + Express**. It uses **Postgres** when `DATABASE_URL` is set (production, Vercel) and falls back to **SQLite** (Node's built-in `node:sqlite`) for zero-config local development. The front end is a single-page app in vanilla JS and CSS, with no build step.

## Quick start

```bash
npm install
npm start            # http://localhost:3000
```

Requires **Node.js 22.5+**.

**The first account you register becomes the admin.** You can also create or reset an admin from env vars:

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD='a-strong-password' ADMIN_EMAIL=you@example.com npm start
```

Run the end-to-end API tests with `npm test` (SQLite), or `DATABASE_URL=postgres://... npm test` to test against Postgres.

## Deploying to Vercel

1. Import the GitHub repo in Vercel. No build settings are needed: it's detected as an Express app, and `public/` is served from the CDN.
2. **Add a database** (required to keep data). In your Vercel project, open **Storage → Create Database → Neon (Postgres)** and connect it to the project. This sets `DATABASE_URL` automatically. The free plan is enough to start.
3. **Redeploy**: Deployments → ⋯ → Redeploy. Tables and payout methods are created automatically on the first request.
4. Open the site and **sign up immediately**. The first account becomes the admin.

Without a database the site still runs on Vercel, but it uses temporary storage that Vercel wipes regularly, and each server instance has its own copy. Admins see a yellow warning banner while it's in this mode.

Any other Postgres works too (Supabase, Railway, Render): set `DATABASE_URL` to its connection string.

## Design

Black and gold, with Fredoka One headings and offset "press" cards that flatten on hover. Icons are Font Awesome 6 (free), and the crypto logos come from `cryptocurrency-icons`. Both are bundled in `public/` so nothing loads from an icon CDN. The animations are plain CSS and the Web Animations API: a 3D spinning coin, coins that fly into your balance when you earn, count-up numbers, scroll reveals, a live earnings feed and a drifting cloud header. They're turned off for visitors with reduced motion enabled.

All money is stored as integer **US cents**. A database from the earlier Gems version is converted automatically on first start (1,000 Gems = $1).

## Features

**Users**
- Landing page with hero, live stats, how-it-works, payout methods, FAQ and CTA
- Sign-up / log-in modal: username, email, password strength meter, referral code, terms checkbox
- A three-step welcome screen with the sign-up bonus, how earning works, and cashout progress
- Earn page: daily bonus, promo codes, and your live offerwalls
- Each offerwall embedded on its own page (or opened in a new tab), personalised with the user's ID
- Live earnings ticker of real conversions (usernames are masked)
- Cashout page with methods grouped by type, amount presets, destination field and cashout history
- Weekly, monthly and all-time leaderboard with a podium
- Referral page with a share link (`/?ref=CODE`) and lifetime commission
- Profile page with activity, earnings (including rewards on hold) and cashout history, and password change
- Responsive layout: on mobile the sidebar becomes a drawer

**Admin panel** (`/#/admin`)
- Overview: users, conversions, rewards on hold, revenue reported vs paid to users, postback health, 14-day charts
- Offerwalls: connect networks (see below), copy postback URLs, send signed test postbacks
- Postback log: every postback with its params, source IP, result and the reason it was accepted or rejected (kept 30 days)
- Conversions: release held rewards early, reject them, or reverse paid ones (reversing takes the money back)
- Users: search, adjust balance, ban/unban, promote/demote, reset password, delete
- Cashouts: mark as paid with a note, or reject, which refunds the user automatically
- Payout methods, promo codes (max uses and expiry) and a full transaction log
- Settings: site name, sign-up bonus, daily bonus, referral %, announcement bar, maintenance mode

There are no fake offers, walls or users. A database from an earlier version is cleaned up automatically on first start: demo users, demo offers and demo offerwalls are deleted, and any balance users got from the simulated offers is taken back, with an "adjustment" entry in their history.

## Offerwall integration

Every offerwall you add gets:

- **A wall URL**: the link from the network's publisher dashboard, with `{user_id}` where the user ID goes (`{username}` also works). Shown embedded on the site, or in a new tab if the network blocks embedding.
- **Its own postback URL**: `/api/postback/<slug>/<secret-token>?...`. The token is random and only the network knows it. You can regenerate it at any time. GET and POST both work.
- **Optional IP allowlist**: the network's server IPs. A trailing `*` matches a prefix.
- **Optional signature check**: MD5, SHA1, SHA256, HMAC-SHA1 or HMAC-SHA256, over either
  - a **template** of params, such as `{txid}-{secret}` or `{txid}-{user_id}-{secret}`, or
  - the **full postback URL** minus the signature param (how HMAC-signing networks usually do it).
- **Reward rules**: read the reward from a param in cents or dollars (set the network's currency to 100 per $1 for cents), or pay the user a % of the payout the network reports. You can add a per-wall bonus %.
- **Hold period**: optionally keep rewards pending for N hours so chargebacks arrive before users can cash out. Rewards release on their own after that, and you can release or reject them early under Conversions.
- **Reversals**: a status listed in the wall's reversal values (default `2,reversed,chargeback,rejected`), or a negative reward, takes back a paid reward or cancels a held one.

Postbacks are idempotent per (offerwall, transaction ID). Duplicates are acknowledged and never paid twice. Referral commission is paid automatically. Every request is written to the postback log.

Default param names (each can be renamed per wall under *Advanced*):

| Param | Meaning |
|---|---|
| `user_id` | Our user ID (whatever you put at `{user_id}` in the wall URL) |
| `txid` | The network's unique transaction/conversion ID |
| `reward` | The user's reward, in cents or dollars |
| `payout` | What the network paid you, in USD (for revenue stats, or for % share mode) |
| `status` | Matched against the wall's reversal values |
| `offer` | Offer name, shown in the user's history |
| `ip` | The user's IP (stored for fraud review) |

The success reply defaults to `1`. Change it per wall if a network expects something else, such as `OK`. Rejected postbacks get a 4xx response with `0`.

**Presets** for CPX Research, BitLabs, AdGem, Torox, Lootably, AyeT Studios, Notik, Revlum, TimeWall and Adscend Media fill in a name, icon and a typical signature setup. Networks change their schemes, so check each one against the network's current postback docs. Then use **Send test** (a signed credit plus reversal for your own account, net $0) and a test conversion from the network's dashboard, and watch the postback log.

### Connecting a network, step by step

1. Sign up as a publisher with the network and add your site/app there.
2. In **Admin → Offerwalls**, click **Add offerwall**, pick the network, and paste the wall URL with `{user_id}`.
3. Copy the postback URL into the network's dashboard. Replace the `{CAPS}` placeholders with the network's own macros.
4. Copy the network's secret key into the signature settings, and its server IPs into the allowlist if it publishes them.
5. Set how rewards are calculated (network currency in cents, dollars, or % of payout), and a hold period if you want one.
6. Click **Send test**, then send a test conversion from the network's dashboard and check **Postback log**.

## Configuration

| Env var | Default | |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | — | Postgres connection string (also reads `POSTGRES_URL`). Use this in production. |
| `DB_PATH` | `data/gemrush.db` | SQLite file, used only when no Postgres URL is set |
| `NODE_ENV` | — | `production` marks cookies `Secure` (needs HTTPS) |
| `TRUST_PROXY` | — | `1` when behind a reverse proxy (for correct IPs and rate limits). Automatic on Vercel. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_EMAIL` | — | create or reset an admin on boot |

## Security notes

- Passwords are hashed with scrypt. Sessions use random tokens stored hashed, in `httpOnly` `SameSite=Lax` cookies.
- Login and registration are rate-limited. State-changing API calls must be JSON from the same origin (CSRF defense).
- A strict Content-Security-Policy is set, and all user content is HTML-escaped on render.
- Balance changes run in SQL transactions, debits use conditional updates so concurrent requests can't overdraw, and every change is written to a ledger (`transactions`).
- Rate limits are kept in memory, so on serverless hosts they apply per instance and are weaker than on a single server.

## Project layout

```
server.js          Express app, security headers, postback route
src/db.js          Postgres/SQLite adapter, schema, settings, ledger helpers
src/auth.js        Password hashing, sessions, rate limiting
src/api.js         Public/user API (auth, offers, daily, promo, cashout, feed, leaderboard)
src/admin.js       Admin API
src/rewards.js     Approve/reject completions + referral commission
src/offerwalls.js  Offerwall presets, signature checks, postback processing, holds
src/seed.js        Payout methods, welcome promo, one-time upgrades
public/            SPA (index.html, css/style.css, js/app.js)
test/smoke.js      End-to-end API test
```
