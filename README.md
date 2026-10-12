# 💎 GemRush — a get-paid-to (GPT) rewards site

A complete GPT / offerwall rewards site (similar to Gemsloot, Freecash, etc.): users earn **Gems** by completing offers and cash them out for PayPal, crypto, gift cards and gaming currencies. It ships with an admin panel and demo offers.

Built with **Node.js + Express + SQLite** (Node's built-in `node:sqlite`, so there are no native modules to compile). The front end is a single-page app in vanilla JS and CSS, with no build step.

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

Run the end-to-end API tests with `npm test`.

## Features

**Users**
- Landing page with hero, live stats, how-it-works, reward methods, FAQ and CTA
- Sign-up / log-in modal: username, email, password strength meter, referral code, terms checkbox
- A three-step welcome screen with the sign-up bonus, an earning guide, cashout progress and confetti
- Earn dashboard: daily reward, promo codes, featured offers, offerwalls and quick tasks
- All-offers page with category filters, search and sorting; a branded page for each offerwall
- Offer detail modal with reward, value, time and requirements, plus a simulated "tracking" step before it credits
- Live earnings ticker (usernames are masked)
- Cashout page with methods grouped by type, amount presets, destination field and cashout history
- Weekly, monthly and all-time leaderboard with a podium
- Referral page with a share link (`/?ref=CODE`) and lifetime commission
- Profile page with activity, offers and cashouts history, and password change
- Responsive layout: on mobile the sidebar becomes a drawer

**Admin panel** (`/#/admin`)
- Overview: key stats plus 14-day signup and earnings charts
- Users: search, adjust balance, ban/unban, promote/demote, reset password, delete
- Offers and offerwalls: full CRUD for the demo offers (icon, color, reward, device, featured, repeatable, bonus %)
- Completions: approve, reject, or reverse a completion (reversing claws back the payout)
- Withdrawals: mark as paid with a note, or reject, which refunds the user automatically
- Reward methods, promo codes (max uses and expiry) and a full transaction log
- Settings: site name, currency name, exchange rate, sign-up bonus, daily reward, referral %, minimum cashout, auto-approve, announcement bar, maintenance mode and postback secret

## About the demo ("fake") offers

The seeded offers and offerwalls are **placeholders**. Clicking "Start offer" simulates tracking and then credits the user immediately (or queues the completion for admin approval if you turn off *Auto-approve demo offers*). On first run the seed also creates 15 demo accounts, which cannot log in, with some history so the feed and leaderboard aren't empty. Set `SEED_DEMO=0` on first run to skip them.

Before going live, delete or hide the demo offers and connect real offerwalls (see below).

## Connecting real offerwalls (postback)

Admin → Settings shows your postback URL:

```
/api/postback?secret=SECRET&user_id={USER_ID}&offer_id={OFFER_ID}&title={OFFER_NAME}&reward={REWARD}&txid={TRANSACTION_ID}&provider=NetworkName&status={STATUS}
```

- `status=1` (or no status) credits the user. A `txid` that was already credited is ignored.
- `status=2` reverses a previously credited `txid` (chargeback).
- Referral commission is paid automatically.

## Configuration

| Env var | Default | |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `data/gemrush.db` | SQLite file |
| `NODE_ENV` | — | `production` marks cookies `Secure` (needs HTTPS) |
| `TRUST_PROXY` | — | `1` when behind a reverse proxy (for correct IPs and rate limits) |
| `SEED_DEMO` | `1` | `0` to skip demo users on first run |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_EMAIL` | — | create or reset an admin on boot |

## Security notes

- Passwords are hashed with scrypt. Sessions use random tokens stored hashed, in `httpOnly` `SameSite=Lax` cookies.
- Login and registration are rate-limited. State-changing API calls must be JSON from the same origin (CSRF defense).
- A strict Content-Security-Policy is set, and all user content is HTML-escaped on render.
- Balance changes run in SQL transactions and every change is written to a ledger (`transactions`).

## Project layout

```
server.js          Express app, security headers, postback endpoint
src/db.js          Schema, settings, ledger helper
src/auth.js        Password hashing, sessions, rate limiting
src/api.js         Public/user API (auth, offers, daily, promo, cashout, feed, leaderboard)
src/admin.js       Admin API
src/rewards.js     Approve/reject completions + referral commission
src/seed.js        Demo offerwalls, offers, reward methods, demo users
public/            SPA (index.html, css/style.css, js/app.js)
test/smoke.js      End-to-end API test
```
