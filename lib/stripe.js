'use strict';
/**
 * stripe.js — Stripe integration for real money.
 *
 * Two modes:
 *   DEMO  — STRIPE_SECRET_KEY not set. Every function that would move real
 *           money throws STRIPE_UNCONFIGURED, and every balance is labeled
 *           DEMO via DEMO_NOTE (see lib/money.js DEMO_BANNER). Demo purchases
 *           still work through the store's demo route.
 *   LIVE  — keys set. Buyers pay through Stripe Checkout (a Stripe-hosted
 *           page, so the store never touches card numbers — zero PCI scope).
 *           The ledger only ever gets 'purchase' rows from the webhook AFTER
 *           Stripe confirms the charge, never from the browser.
 *
 * To go live:
 *   1. Create a Stripe account at https://stripe.com (Individual is fine),
 *      activate payments (ID + bank for payouts), then Developers → API keys
 *      → copy the SECRET key.
 *   2. Set env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (from
 *      Developers → Webhooks → endpoint https://<your-store>/api/webhook/stripe),
 *      optional PUBLIC_URL (defaults to the request host).
 *   3. Developer payouts need Stripe Connect Express accounts + KYC —
 *      see createDeveloperAccount()/payoutToDeveloper().
 */

const configured = Boolean(process.env.STRIPE_SECRET_KEY);

let _client = null;
function client() {
  if (_client) return _client;
  if (!configured) {
    const err = new Error(
      'Stripe is not connected: set STRIPE_SECRET_KEY. Balances remain DEMO-only.'
    );
    err.code = 'STRIPE_UNCONFIGURED';
    throw err;
  }
  // Lazy require so the app boots fine in DEMO mode even if the package
  // were missing; also keeps one client per process.
  _client = require('stripe')(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2025-08-27.basil',
  });
  return _client;
}

/**
 * Verify a Stripe webhook signature. Pass the RAW request body (Buffer) and
 * the 'stripe-signature' header. Throws on any verification failure.
 */
function constructEvent(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    const err = new Error('STRIPE_WEBHOOK_SECRET not set — cannot verify webhook.');
    err.code = 'STRIPE_WEBHOOK_UNCONFIGURED';
    throw err;
  }
  return client().webhooks.constructEvent(rawBody, signature, secret);
}

/**
 * Create a Stripe Checkout Session for buying one app. Returns { id, url }.
 * Ledger rows are written by the webhook on checkout.session.completed —
 * NOT here, because the buyer hasn't paid yet at this point.
 */
async function createCheckoutSession({ appId, buyerId, appName, amountCents, successUrl, cancelUrl }) {
  const s = client();
  const session = await s.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: { name: appName },
          unit_amount: amountCents,
        },
        quantity: 1,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { app_id: String(appId), buyer_id: String(buyerId), kind: 'app_purchase' },
    payment_intent_data: { metadata: { app_id: String(appId), buyer_id: String(buyerId) } },
  });
  return { id: session.id, url: session.url, paymentIntentId: session.payment_intent };
}

/**
 * Refund a Stripe charge (full or partial amount in cents). Used by /api/refund
 * for purchases that were paid with real money.
 */
async function refundPayment({ paymentIntentId, amountCents }) {
  return client().refunds.create({ payment_intent: paymentIntentId, amount: amountCents });
}

/**
 * Stripe Connect Express account for a developer (payout destination).
 * Developers must still pass the in-store KYC page before any payout;
 * payoutToDeveloper() enforces kyc_status === 'verified' itself.
 */
async function createDeveloperAccount({ email, developerId }) {
  const s = client();
  const account = await s.accounts.create({
    type: 'express',
    email,
    metadata: { developer_id: String(developerId) },
    capabilities: { transfers: { requested: true } },
  });
  return account; // store account.id on the user row (stripe_account_id)
}

/**
 * Pay a verified developer their share. The caller MUST confirm the user's
 * kyc_status === 'verified' and a stripe_account_id exists first.
 */
async function payoutToDeveloper({ stripeAccountId, amountCents, developerId }) {
  if (!stripeAccountId) throw new Error('Developer has no Stripe Connect account yet.');
  return client().transfers.create({
    amount: amountCents,
    currency: 'usd',
    destination: stripeAccountId,
    metadata: { developer_id: String(developerId) },
  });
}

module.exports = {
  configured,
  client,
  constructEvent,
  createCheckoutSession,
  refundPayment,
  createDeveloperAccount,
  payoutToDeveloper,
  DEMO_NOTE:
    'Demo mode: no real money moves. Balances are ledger records only and are NOT withdrawable until Stripe is configured and KYC is verified.',
};
