# PROBLEMS_FIXED.md

Every painful lesson from the ViralMode builds, and the concrete fix for each
one in this codebase. If you're reading this before deploying: these are the
guarantees the store makes.

## 1. Owner lockout — "Owner Mode is restricted to the app owner"

**What went wrong:** ViralMode guessed ownership on the client from flags
(`isFounder`, `isOwner`) that silently came back `false`, so the real owner
(Jelani) was locked out of minting Golden Tickets and other owner tools, and
the assistant couldn't fix it from the outside.

**Fix here:**
- `users.role` is an explicit column: `'owner' | 'developer' | 'user'`
  (`lib/db.js`).
- The owner account (`jelani`) is **seeded** at first boot — no flag-guessing.
- Every protected route uses `requireRole('owner')`, a **server-side** check
  (`server.js`). The client never decides who the owner is.
- Smoke test logs in as the owner and exercises the owner-only routes.

## 2. Ticket-value conflict — three disagreeing definitions of money

**What went wrong:** Three definitions existed at once — "100 tickets per
signup", "1,000 tickets = $30", and a separate "$30 per Golden Ticket"
default — so nobody could say what a balance was actually worth.

**Fix here:**
- `lib/money.js` is the **single source of truth**: 1 credit = 1 USD cent,
  integer cents everywhere, one `split()` function (90% developer / 10%
  platform), one `validateLedgerRow()` used by the reconciliation check.
- No route, page, or test defines its own conversion. There is nothing else
  called a "ticket" in this codebase.

## 3. Fake money presented as real

**What went wrong:** ViralMode showed balances that looked withdrawable while
no payment provider was connected at all.

**Fix here:**
- Every money surface carries the banner: **"DEMO — not withdrawable until
  Stripe is connected"** (`money.DEMO_BANNER`, rendered in the UI, the API,
  and purchase responses).
- `lib/stripe.js` is an explicit **stub**: its functions throw
  `STRIPE_UNCONFIGURED` until `STRIPE_SECRET_KEY` is set and the TODOs are
  implemented. README documents the exact steps to connect real money.
- Payouts additionally require `kyc_status = 'verified'` (see `kyc.html`).

## 4. Missing refunds, chargebacks, and fraud controls

**What went wrong:** No refund flow, no dispute log, no rate limiting — money
only ever moved one direction.

**Fix here:**
- `POST /api/refund` (owner or the app's developer) writes a **negative
  ledger row** referencing the original; the original row is never deleted,
  so the books always reconcile.
- Rate limits on login, signup, and purchases (`server.js`).
- Full `ledger` table with `type` (`purchase`/`refund`/`payout`), `note`, and
  timestamps — an audit trail, not a single balance number.

## 5. Legal screens skipped for existing accounts

**What went wrong:** The 13+ gate and Terms/Privacy acceptance were added late
and never applied to accounts created before them.

**Fix here:**
- `TERMS_VERSION` (`lib/db.js`). **Every** authenticated API request is
  checked against it (`requireTermsFresh` middleware) — including the seeded
  owner and legacy accounts, which are deliberately seeded with a stale
  version so the gate is proven, not assumed.
- `terms.html?must=1` forces acceptance before any other page works.
- Signup enforces 13+ (birthdate check) and requires the Terms checkbox.

## 6. Empty Copyright Vault

**What went wrong:** The Vault existed but had zero records; uploads never
captured any rights statement.

**Fix here:**
- `copyright_attested` is a **required** field on every upload — the server
  rejects `POST /api/upload/complete` with 400 unless the attestation
  checkbox was checked. The value is stored per app and shown in the
  moderation queue.
- Terms include a DMCA/reporting section with a takedown contact path.

## 7. Large uploads failing (the 54MB problem)

**What went wrong:** Single-shot uploads choked on real-world files (54MB
video uploads failed with no resume).

**Fix here:**
- Chunked, **resumable** uploads: `POST /api/upload/init` →
  `POST /api/upload/chunk?upload_id=&index=` (5MB chunks, server-enforced
  ordering, idempotent retries) → `POST /api/upload/complete`.
- 2GB cap, declared-size verification before an app row is created, temp
  files cleaned up on completion.

## 8. No moderation / anything-goes listings

**What went wrong:** (Implied by the rush to publish.) No review step meant
broken or infringing uploads could go live instantly.

**Fix here:** Every upload starts as `status='pending'`. Only the owner can
approve/reject (`/api/owner/approve`), and only `approved` apps appear in
public listings, search, and downloads.
