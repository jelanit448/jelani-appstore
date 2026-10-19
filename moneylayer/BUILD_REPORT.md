# Demo + Paid Full-Unlock System — Build Report

**Date:** Sun Oct 18, 2026 (~23:00–24:00 CT)
**Model:** Free demos, pay for the full app (Jelani's newest word — supersedes $1.99-full-price and all-free)
**Scope:** the 1,000 AppMaker store apps ONLY. ESIDE exclusive line untouched ($8,000/piece, no demo). All store listings already live at $0 — those free downloads ARE the demos.

---

## 1. Design

**Unlock code scheme** (server-side, `lib/unlock.js`):
- `code = 'FULL-' + 4 groups of 4 chars` from a 31-symbol no-confusion alphabet (no I/L/O/0/1), derived as HMAC-SHA256(`UNLOCK_CODE_SECRET`, `'jelani-unlock-v1:' + packageName)` with rejection sampling.
- The server stores ONLY the SHA-256 hash (`unlock_code_hash`). Plaintext codes are never stored anywhere except `moneylayer/wave1_codes.json` (gitignored, mode 600).
- The app verifies offline: SHA-256(entered code) vs the hash **baked into the app at build time**. No network needed after install.
- **Known limitation (honest):** client-side checks are forgeable by a determined person — same accepted weakness as East Side Dash's unlock pack. Fine at the $1.99 price point; if unlock revenue ever becomes meaningful, move verification server-side.

**Money flow:** buyer pays $JelaniThompson2 on Cash App → claims with their $cashtag → Jelani approves in the owner console → 90/10 ledger rows via `lib/money.js` (199¢ → fee 20¢ / net 179¢, source `'store'`, note "Unlock code — Cash App manual") → the buyer's code appears on the app page. Same manual-claim trust model as the existing purchase flow.

**Demo cap (in-app, `moneylayer/moneylayer.js`):** wraps `Storage.prototype.setItem`. In demo mode, the app's largest saved collection (the biggest array anywhere in the stored JSON value) may hold at most **10 entries** — the write that would push it past 10 is blocked and the unlock panel opens. Pre-existing data over the cap is never touched. Unlocking lifts the cap permanently (`ml_<slug>_full=1` in localStorage, survives reloads). Apps with no array collections (20/100 wave-1 apps) get the demo bar + unlock + tip + cross-promo but no enforced cap — recorded honestly per app in the smoke test.

**Real bugs found and fixed during the build:**
1. `acc >>> bits & 31` parses as `acc >>> (bits & 31)` (precedence) — parenthesized.
2. The no-confusion alphabet is 31 chars, not 32 — the bit-reader was rewritten with rejection sampling.

---

## 2. Files

### Part A — store server (staged in working tree, NOT deployed)

| File | Change |
|---|---|
| `lib/unlock.js` | NEW. `deriveCode`, `codeHash`, `normalizeCode` (tolerant: case/spaces/dashes), `verifyCode` (timing-safe), `packageNameFromApk` (aapt2). Secret from `UNLOCK_CODE_SECRET`, dev fallback clearly labeled |
| `lib/db.js` | `apps`: `unlock_price_cents` (default 199) + `unlock_code_hash` (nullable) in CREATE TABLE + migration loop. NEW `unlock_orders` table (id, app_id, buyer_id, buyer_cashtag, amount_cents, status claimed/approved/rejected, ledger_id, created_at) + indexes — mirrors `cashapp_orders` |
| `server.js` | Unlock routes (after Cash App routes, before Marketplace): `POST /api/apps/:id/unlock-order {buyer_cashtag}` (auth + rate limit, single-step claim → 'claimed'), `GET /api/apps/:id/unlock-code` (auth; 403 unless APPROVED order; code re-derived from the listing's APK package name), `GET /api/owner/unlock/orders`, `POST /api/owner/unlock/orders/:id/approve` (claimed only; 90/10 ledger; 409 on double-approve; does NOT touch `purchases`), `.../reject` (no ledger), `POST /api/owner/apps/:id/unlock-price {unlock_price_cents}` (0–1000000; derives hash from APK; 0 = unlock off). Detail API strips `unlock_code_hash` and adds `unlock_owned`. `/api/upload/complete` auto-derives the hash for NEW apps (try/catch — can never break uploads) |
| `public/app.html` | Gold unlock block when `unlock_price_cents > 0`: "FREE DEMO — FULL VERSION $1.99", Cash App claim flow w/ $cashtag prompt + polling; approved buyers see their code with copy button; signed-out users get a sign-in prompt |
| `public/owner.html` | "Unlock orders — full-version codes" panel with Approve/Reject, wired into boot |
| `lib/appmaker.js` | Template: FUTURE apps ship `www/moneylayer.js` + script tag automatically; `generateApk()` bakes placeholders with the real package-derived hash at build time (auditJs-checked; failures degrade to a build warning, never fatal). Website-template apps can't carry it (remote URL) — documented limitation |

### Part B — in-app demo layer

| File | Purpose |
|---|---|
| `moneylayer/moneylayer.js` | The snippet (15KB). Slim gold demo bar (dismissible per session; returns next launch) with Unlock / Tip ($JelaniThompson2 → clipboard) / More apps (store link → clipboard, WebView-safe). Unlock panel with offline SHA-256 verify (embedded implementation — no WebCrypto dependency). Placeholders `%%ML_SLUG%% %%ML_APPNAME%% %%ML_PRICE%% %%ML_HASH%%` replaced at injection. Passes the repo's real `auditJs` |
| `moneylayer/inject.js` | Batch injection: per app derives code+hash via `lib/unlock.js`, writes `www/moneylayer.js`, inserts the script tag idempotently, writes `wave1_codes.json`. Usage: `node moneylayer/inject.js --all-wave1` (re-runnable) |
| `moneylayer/replace_template.js` | Per-batch replace script pattern (login → chunked upload/init kind appfile → `POST /api/owner/apps/:id/replace-file`). Copied to `batch1…batch10/replace.js`. **The main agent runs these with `STORE_OWNER_PASS` — do not commit the password; the script takes it from env only** |
| `moneylayer/unlock_prices.js` | Sets unlock_price_cents=199 for wave-1 listings and **0 for all others** (their APKs have no unlock panel yet — selling a code nobody can redeem would be dishonest; each later wave sets 199 when its rebuilt APKs land). Also (re)derives+stores every app's `unlock_code_hash`. Usage: `STORE_OWNER_PASS='…' node moneylayer/unlock_prices.js` |
| `moneylayer/smoke.py` | CDP end-to-end smoke test (headed Chromium under Xvfb, self-contained websocket client). 31 checks across 3 app shapes |
| `moneylayer/wave1_codes.json` | **PLAINTEXT codes, gitignored, mode 600 — never commit.** slug → {code, code_hash, package, listing_id, batch} for all 100 wave-1 apps |
| `moneylayer/.secret` | **The production unlock secret (64 hex), gitignored, mode 600 — never commit.** |
| `moneylayer/wave1_manifest.json` | Listing IDs #5–#104 per batch (from manifests) |
| `.gitignore` | Extended: `moneylayer/.secret`, `moneylayer/*_codes.json`, `moneylayer/wave*.json` |

---

## 3. Test results

### Part A (DB copy, throwaway server :4124, then killed — real DB untouched): 29/29 pass
- Claim → 403 before approval → bad-cashtag 400 → owner approve → ledger row `gross 199 / fee 20 / net 179 / source 'store'` validated CLEAN by `money.validateLedgerRow` → buyer reads code (format valid, `verifyCode` vs stored hash = true) → non-buyer 403 → double-approve 409 → reject writes no ledger → owner order list works.
- Regressions: `/api/apps` 200, anonymous free download still open (206), finance reconciliation `ok:true, mismatches:[]`, existing purchase flows untouched.
- Two initial "failures" were test-harness assumptions, verified product-correct: the finance endpoint shape guess (ledger row verified directly instead); app #1 accepting an unlock claim (migration defaults all apps to 199 — intended; see §5 for the wave-1 pricing plan).

### Part B smoke (real Chromium, 3 app shapes): 31/31 pass
- **dontletitdie** (object state `{water, plants}` under `dlid` — the canonical cap case): bar visible → 10 plants via real UI → 11th blocked + unlock panel opens → blocked save provably did NOT persist (reload → still 10) → wrong code rejected → correct code (from wave1_codes.json) unlocks → bar "FULL VERSION ✓" → 15 saves allowed → unlock + data persist after reload.
- **themove** (top-level array under `themove_saved`): same 14/14.
- **grilltime** (no localStorage at all): bar visible, unlock works — honestly recorded as no-cap.

### Wave-1 build — COMPLETE
- Injection: 100/100 apps, zero placeholders left (re-injected once after the cap-rule improvement below).
- Rebuild: **100/100 APKs built, 10/10 per batch, all versionCode 2 / versionName 1.1, apksigner verified.** (One interruption: a runtime service restart killed the first build loop after batch 5; batches 6–10 were rebuilt in a second loop. All build-report.json files confirm 10/10 ok.)
- APK spot-check: 9/9 APKs across batches 1, 2, 6, 8, 10 (dontletitdie, themove, talktoy + 6 late-batch) — baked `ML_HASH` matches wave map, no placeholders.
- Staged for replace: `batch1…batch10/replace.js` (each reads its manifest's listing IDs #5–#104; run by the main agent with `STORE_OWNER_PASS`).

### Cap-rule improvement (during smoke work)
Surveyed all 100 wave-1 apps: 80 use localStorage, mostly as `setItem(KEY, JSON.stringify(state))` where state is an OBJECT containing arrays (e.g. `{water:{}, plants:[]}`). The first cap design only watched top-level arrays — it would have missed the dominant app shape. Rewrote the rule to cap the **largest array anywhere in the stored value** (recursive max-array-length). The 11th entry's write is blocked; pre-existing data over the cap is never touched; unlocking lifts the cap. Re-injected all 100 apps after the change; smoke suite re-run green.

---

## 4. Deploy steps (for the main agent — in this order)

**0. Read the secret.** `cat ~/workspace/appstore/moneylayer/.secret` → copy the 64-hex value. It is gitignored and must NEVER be committed or pasted anywhere except the Render env var below.

**1. Set `UNLOCK_CODE_SECRET` on Render** (dashboard → jelani-appstore → Environment) to the exact value from step 0, then continue. ⚠️ If this differs from `moneylayer/.secret`, every baked hash in the wave-1 APKs will reject the server-derived codes — this is the #1 deploy gotcha.

**2. Commit + push the staged tree:** `git add -A` (the three secret files — `moneylayer/.secret`, `moneylayer/wave1_codes.json`, `moneylayer/wave*.json` — are gitignored and stay local), commit, `git push origin master:main`. Render auto-deploys from `main`. Staged files: `lib/unlock.js`, `lib/db.js`, `lib/appmaker.js`, `server.js`, `public/app.html`, `public/owner.html`, `.gitignore`, `moneylayer/` (snippet, inject, smoke, replace template, unlock_prices, this report), `batch1…batch10/build.js` (version-env patch), `batch1…batch10/apps/*/www/{moneylayer.js,index.html}`, `batch1…batch10/apks/*.apk` (100 rebuilt v1.1), `batch1…batch10/replace.js`. (Note: `public/play/east-side-dash/` shows as modified in the working tree — that was NOT this task; leave it alone.)

**3. Swap the 100 APKs onto their listings** (after deploy is live):
```
for n in 1 2 3 4 5 6 7 8 9 10; do STORE_OWNER_PASS='…' node batch$n/replace.js || break; done
```
Each script logs in as `jelani`, reads listing IDs from its `manifest.json` (#5–#104), uploads the v1.1 APK via the chunked flow and calls `POST /api/owner/apps/:id/replace-file {upload_id, version:'1.1'}`. Password from env only — never committed. Expect 10 OK lines per batch.

**4. Set unlock prices + store hashes** (immediately after step 3, either order works — the hash is package-name-derived so it matches both old and new APKs):
```
STORE_OWNER_PASS='…' node moneylayer/unlock_prices.js
```
Sets `unlock_price_cents=199` for wave-1 listings (#5–#104) and **0 for every other listing** (their APKs have no unlock panel yet — selling a code nobody can redeem would be dishonest; each later wave flips its own batch to 199 when its rebuilt APKs land). The endpoint also (re)derives + stores each app's `unlock_code_hash` from its APK package name. ~1,000 API calls; the script reports failures at the end.

**5. Verify live:**
- `GET /api/apps/8` → `unlock_price_cents: 199`, no `unlock_code_hash` leaked, `unlock_owned: false` for anon.
- Download listing #8's APK, unzip `www/moneylayer.js` → `ML_HASH` equals the `code_hash` for `dontletitdie` in `moneylayer/wave1_codes.json`.
- Owner console → Unlock orders panel renders; app page shows the gold demo/unlock block.

## 5. Wave-1 staging inventory

| Item | Location | Status |
|---|---|---|
| 100 injected app sources | `batch1…batch10/apps/*/www/` (`moneylayer.js` + script tag) | staged — 200/200 `node --check` pass |
| 100 rebuilt APKs (v1.1, versionCode 2) | `batch1…batch10/apks/*.apk` | staged — 100/100 built, apksigner-verified |
| Per-batch replace scripts | `batch1…batch10/replace.js` | staged — main agent runs with `STORE_OWNER_PASS` |
| Plaintext code map (100 codes) | `moneylayer/wave1_codes.json` | LOCAL ONLY — gitignored, mode 600 |
| Production unlock secret | `moneylayer/.secret` | LOCAL ONLY — gitignored, mode 600 |
| Unlock-price setter | `moneylayer/unlock_prices.js` | staged — main agent runs with `STORE_OWNER_PASS` |
| Smoke suite | `moneylayer/smoke.py` | 31/31 pass, kept for future waves |
| Injector | `moneylayer/inject.js` | re-runnable (`--all-wave1`) for future waves |

## 6. Known limitations (honest)

1. **Client-side codes are forgeable by a determined person** — same accepted weakness as East Side Dash's unlock pack. The hash is baked in the APK; anyone who extracts it still can't derive the code (SHA-256 is one-way), but they can patch the check out of the app. Fine at $1.99; if unlock revenue ever matters, move verification server-side.
2. **~20/100 wave-1 apps have no array collections** (no localStorage or counters only, e.g. grilltime) — they get the demo bar + unlock + tip + cross-promo, but no enforced cap. Recorded honestly; the smoke test names the shape per app.
3. **Non-wave-1 apps (listings #1, #3–4, #105–#1001) ship unlock_price_cents=199 from the migration but have no in-app unlock panel** until their wave lands — hence step 4 of the deploy sets them to 0. Never sell a code for an app that can't redeem it.
4. **Website-template AppMaker apps can't carry the money layer** (remote URL) — documented in `lib/appmaker.js`; the build logs a warning, never fails.
5. **Secret rotation invalidates every baked hash** — rotating `UNLOCK_CODE_SECRET` requires re-injecting + rebuilding all shipped apps. Don't rotate casually.
6. **The demo bar is per-session dismissible, not permanently removable in demo** — by design (it's the demo label). The full version removes it entirely.
7. Owner viewing his own app page sees the buy flow (no self-reveal of the code) — cosmetic follow-up, not a blocker.
8. Batch `build.js` log lines carry stale `[batch3]` labels (copies of one driver) — cosmetic only; build-report.json files are authoritative.
...[truncated 4081 chars]