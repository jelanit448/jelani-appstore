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

## After it's live
- Log in as owner with the seeded owner account and change the password
  immediately (it forces this on first login).
- Swap the placeholder ViralMode file for the real APK (normal developer upload
  in your dashboard) once the APK build finishes.
- Money stays in DEMO mode until you add your Stripe key + complete KYC —
  see README.md. Nobody can be charged or paid out before that, by design.

## Costs to know about
- Render's starter plan (needed for the persistent disk) is paid. The free tier
  wipes data on restarts — don't use free for real money.
- Real payments need Stripe (free to set up; they take a cut per sale).
