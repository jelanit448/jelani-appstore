# 📱 Jelani's App Store

A real, self-hostable Google Play-style app store with a **shared backend**
(Node.js + Express + SQLite), so uploads, downloads, reviews, and money are
the same for every user — no per-device demo data.

- Developers upload apps (chunked, resumable — up to 2GB), apps wait in a
  moderation queue until the owner approves.
- Public storefront with search, categories, ratings, and download counters.
- Paid apps split **90% developer / 10% platform**, every cent written to a
  ledger with an automatic reconciliation check in the owner console.
- **Demo money mode:** balances are ledger records only — clearly labeled,
  never presented as withdrawable — until Stripe Connect is configured.

Copyright (C) 2026 Jelani Thompson. License: GPL-3.0-only.

## Run locally (free)

Requirements: Node.js 22.5+ (uses `node:sqlite`, built into Node — no native
build tools needed).

```sh
cd ~/workspace/appstore
npm install
npm start
# open http://localhost:3000
```

First boot seeds:
- **Owner:** username `jelani`, password `ChangeMe123!`
  (you must change it on first login, and accept the Terms — the retroactive
  legal gate applies to this account on purpose)
- **ViralMode** as the first approved, free listing
- A legacy demo account `legacyfan` / `Test1234!` (stale Terms, for testing)

Run the smoke test (needs the server running):

```sh
node scripts/smoke.js
# or: npm run smoke
```

It verifies signup/login, the 13+ gate, the retroactive Terms gate, chunked
upload, moderation, downloads, a $1 purchase splitting $0.90/$0.10, owner
finance reconciliation, refunds, and reviews.

## Deploy publicly

The app is a single Node process with a SQLite file (`data/store.db`) and an
`uploads/` directory — both must persist.

**Render (free tier):**
1. Push this folder to a GitHub repo.
2. Create a new Web Service → build `npm install`, start `npm start`.
3. Add a persistent disk mounted at `/opt/render/project/src/data` **and**
   one for `uploads/` (or set `DB_PATH`/`UPLOADS_DIR`… note: `UPLOADS_DIR`
   currently fixed to `./uploads`; mount the disk there).
4. Set env vars: `SESSION_SECRET` (long random string), `PORT` (Render sets it).

**Railway / VPS:** same idea — `npm install && npm start` behind any reverse
proxy; keep `data/` and `uploads/` on persistent storage. Use a process
manager (`pm2` / systemd) so it restarts.

**Production checklist:**
- `SESSION_SECRET` set to a long random value (never the dev default).
- Change the owner password; back up `data/store.db` regularly.
- `express-session` uses the in-memory store — fine for one process; switch
  to a persistent session store if you run multiple processes.
- Put the app behind HTTPS (Caddy/nginx) — session cookies should be
  `secure` in production.

## Connect Stripe for real money

1. Create a Stripe account, enable **Connect**.
2. `npm install stripe` and set `STRIPE_SECRET_KEY` in the environment.
3. Implement the three functions in `lib/stripe.js`:
   - `chargeBuyer()` → `stripe.paymentIntents.create()`
   - `createDeveloperAccount()` → `stripe.accounts.create({ type: 'express' })`
   - `payoutToDeveloper()` → `stripe.transfers.create()` (after KYC check)
4. Add a webhook endpoint verifying `stripe.webhooks.constructEvent`, and
   only write ledger rows after Stripe confirms the charge.
5. Developers complete KYC on the Payouts page; block payouts until
   `kyc_status = 'verified'`.

Until then, the store runs in **demo mode**: every balance is labeled
"DEMO — not withdrawable until Stripe is connected".

## Project layout

```
server.js            Express app: auth, uploads, ledger, moderation, API
lib/db.js            SQLite schema + seeds (owner, legacy user, ViralMode)
lib/money.js         SINGLE source of truth: 1 credit = 1¢, 90/10 split
lib/stripe.js        Stripe Connect hooks (stub — throws until configured)
public/              Storefront, app pages, upload, dashboards, legal
uploads/             Uploaded packages (created at runtime)
data/store.db        SQLite database (created at runtime)
scripts/smoke.js     End-to-end verification script
PROBLEMS_FIXED.md    Each past ViralMode problem → its fix here
```
