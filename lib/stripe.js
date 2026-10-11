'use strict';
/**
 * stripe.js — Stripe Connect integration hooks (STUB — not connected).
 *
 * Past problem this fixes: ViralMode showed balances that looked like real
 * money while no payment provider was connected at all. In this store:
 *   - Every balance is labeled "DEMO — not withdrawable until Stripe is connected".
 *   - Real charges/payouts go through the functions below, which currently
 *     throw UNCONFIGURED. Connect Stripe, then implement them.
 *
 * To connect for real money:
 *   1. Create a Stripe account at https://stripe.com and enable Connect.
 *   2. `npm install stripe`, set STRIPE_SECRET_KEY in the environment.
 *   3. Implement chargeBuyer() with stripe.paymentIntents.create().
 *   4. Implement createDeveloperAccount() / payoutToDeveloper() with
 *      stripe.accounts.create() (Express) and stripe.transfers.create().
 *   5. Add a webhook endpoint (stripe.webhooks.constructEvent) that writes
 *      matching ledger rows only after Stripe confirms the charge — never
 *      credit demo balances from unconfirmed intents.
 *   6. Complete KYC: developers must verify identity in the KYC page before
 *      any payout; block payouts while kyc_status != 'verified'.
 */

const configured = Boolean(process.env.STRIPE_SECRET_KEY);

function unconfigured(what) {
  const err = new Error(
    `Stripe is not connected: cannot ${what}. ` +
    'Set STRIPE_SECRET_KEY and implement lib/stripe.js. Balances remain DEMO-only.'
  );
  err.code = 'STRIPE_UNCONFIGURED';
  throw err;
}

async function chargeBuyer({ buyerId, amountCents, description }) {
  if (!configured) unconfigured('charge a buyer');
  // TODO: const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  // const intent = await stripe.paymentIntents.create({
  //   amount: amountCents, currency: 'usd', description,
  //   metadata: { buyerId: String(buyerId) },
  // });
  // return intent;
  throw new Error('not implemented');
}

async function createDeveloperAccount({ developerId, email }) {
  if (!configured) unconfigured('create a developer payout account');
  // TODO: return await stripe.accounts.create({ type: 'express', email, metadata: { developerId } });
  throw new Error('not implemented');
}

async function payoutToDeveloper({ developerId, amountCents, stripeAccountId }) {
  if (!configured) unconfigured('send a payout');
  // TODO: enforce KYC first: SELECT kyc_status FROM users WHERE id = ?
  // if (kyc_status !== 'verified') throw new Error('KYC not verified');
  // return await stripe.transfers.create({ amount: amountCents, currency: 'usd', destination: stripeAccountId });
  throw new Error('not implemented');
}

module.exports = {
  configured,
  chargeBuyer,
  createDeveloperAccount,
  payoutToDeveloper,
  DEMO_NOTE:
    'Demo mode: no real money moves. Balances are ledger records only and are NOT withdrawable until Stripe Connect is configured and KYC is verified.',
};
