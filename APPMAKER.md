# App Maker

Turn an idea into a real installable Android app (.apk) from a form on your
phone. No coding, no computer needed.

## What it makes

Two templates (v1):

1. **Starter** — a clean single-screen app with your name in the toolbar, a
   welcome card, and a tap counter. A starting point you can build on.
2. **Website wrapper** — your website as an app. Enter an `https://` address
   and the app opens it in a fast native view, with working back-button
   history.

Every generated app is a **pure native WebView shell** — one small Java file,
no Capacitor, no frameworks. That is the exact recipe that fixed the old
1-second crash: the Capacitor native bridge was the problem, and removing it
was the fix. Generated apps can't reintroduce it — the builder has no
framework code to include.

## The guarantees (the problems we did, baked in)

- **No unguarded JavaScript.** Every template's JS is audited at build time.
  The old killer — `document.getElementById('sq').focus()` on an element that
  doesn't exist — fails the build instead of shipping to your phone.
- **No surprise 54MB downloads.** Web assets are capped at 10MB (build fails
  above it) and you get a loud warning over 5MB.
- **Package names that install.** Bad package names are rejected up front
  with a plain-English message instead of a cryptic install failure.
- **Updates that actually update.** Every build gets the next versionCode
  automatically — Android refuses updates that reuse one.
- **Honest notes.** Every download comes with a BUILD_NOTES.txt saying what
  was and wasn't done.

## The limits (read this)

- **Debug-signed.** Generated APKs are signed with a shared debug key — fine
  for testing and sideloading. Do **not** publish to Google Play with this
  signature. A Play release needs your own release keystore and a re-sign.
- **Generated apps are not listed in the store automatically.** If you want
  to sell one, upload the APK through the normal upload flow (it goes through
  moderation like everything else).
- **Website wrapper needs your site to be live.** If the site goes down, the
  app shows the site's error page. Only `https://` addresses are accepted.
- **10 builds per hour** per account, to keep the build server healthy.
- Only **PNG** icons are supported for now.

## How to use it

1. Sign in as a developer (or the owner) → **App Maker** in the nav.
2. Fill the form: app name, package name (like `com.yourname.myapp`),
   template, theme color, optional PNG icon.
3. Hit **Build my app** — about 10 seconds.
4. Download the APK, install it on your phone (allow "install unknown apps"
   once), done.

Your builds are saved under **My builds** so you can re-download them anytime.
