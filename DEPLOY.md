# Putting your app store on the internet (plain steps)

Your store is built and tested. Right now it only runs on my computer, so nobody
else can reach it. These steps put it online. Only YOU can do the account parts —
I can't create accounts for you.

## What I already did
- Added a Dockerfile + render.yaml so a host can run it with one click.
- Saved everything in a git repo at ~/workspace/appstore/ (committed).

## Your steps (about 10 minutes)

1. **Make a GitHub account** at https://github.com/signup (if you don't have one).
2. **Make a new repository** on GitHub (any name, e.g. `jelani-appstore`), then upload
   the files from `~/workspace/appstore/` to it. Easiest: on the repo page click
   "uploading an existing file" and drag the folder's contents in.
   (Or ask me and I'll give you the exact commands once you're logged in.)
3. **Make a Render account** at https://render.com (free to start).
4. In Render: **New + → Web Service → connect your GitHub repo.**
   Render reads `render.yaml` automatically and sets everything up, including the
   data disk (so your apps and money survive restarts) and a random session secret.
5. Open the URL Render gives you — that's your public store, working like Google Play.

## Turning on real money (Stripe)

The store now has a real Stripe checkout built in. Until you do these steps it
stays in DEMO mode — nobody can be charged, by design.

1. **Sign up at https://stripe.com** (Individual / sole proprietor is fine).
   For "business name" put **Jelani's App Store**; the website is
   `https://jelani-appstore.onrender.com`.
2. Activate payments in Stripe (it asks for your ID and bank info for payouts).
3. In Stripe: **Developers → API keys** → copy the **Secret key**
   (starts with `sk_live_`). Send it to me — I'll add it to the store.
4. In Render: go to your web service → **Environment** → add:
   - `STRIPE_SECRET_KEY` = the secret key
   - `PUBLIC_URL` = `https://jelani-appstore.onrender.com`
5. In Stripe: **Developers → Webhooks → Add endpoint**:
   - URL: `https://jelani-appstore.onrender.com/api/webhook/stripe`
   - Events: `checkout.session.completed` and `charge.refunded`
   - Copy the **Signing secret** (starts with `whsec_`) → add as
     `STRIPE_WEBHOOK_SECRET` in Render's Environment.
6. Render redeploys automatically. The owner dashboard then shows
   "Stripe connected: yes", and buyers check out on Stripe's secure page.
   Ledger rows are only written after Stripe confirms the charge, so the
   90/10 split (developer/platform) is enforced on real money too.
   Refunds go through Stripe as well, from the dashboard.

## Costs to know about
- Render's starter plan (needed for the persistent disk) is paid. The free tier
  wipes data on restarts — don't use free for real money.
- Real payments need Stripe (free to set up; they take a cut per sale).
