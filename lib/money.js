'use strict';
/**
 * money.js — SINGLE SOURCE OF TRUTH for all money in the store.
 *
 * Past problem this fixes: ViralMode had THREE disagreeing definitions of
 * value at once ("100 tickets per signup", "1,000 tickets = $30", and a
 * separate "$30 per Golden Ticket" default), which made balances meaningless.
 * Here there is exactly one definition, used by every route, and every
 * ledger row is validated against it.
 *
 * Definition: 1 credit = 1 USD cent. All amounts are integers (cents).
 * Platform fee: 10% of every paid transaction, rounded to the nearest cent.
 * Split invariant: developer + platform === gross, always.
 */

const CENTS_PER_USD = 100;
const PLATFORM_FEE_BPS = 1000; // basis points; 1000 bps = 10%

const DEMO_BANNER = 'Cash App sales are real money — paid to $JelaniThompson2 and approved by the owner. Card payments are in test mode until Stripe verification is complete.';

function usdToCents(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n < 0) throw new Error('amount must be a non-negative number');
  return Math.round(n * CENTS_PER_USD);
}

function centsToUsd(cents) {
  return (Math.round(cents) / CENTS_PER_USD).toFixed(2);
}

function formatUsd(cents) {
  return '$' + centsToUsd(cents);
}

/**
 * Split a gross amount (integer cents) into { developer, platform }.
 * Throws on negative input — refunds are stored as negative ledger rows and
 * validated via validateLedgerRow on their absolute values.
 */
function split(grossCents) {
  const gross = Math.round(grossCents);
  if (!Number.isInteger(gross) || gross < 0) throw new Error('gross must be a non-negative integer of cents');
  const platform = Math.round((gross * PLATFORM_FEE_BPS) / 10000);
  return { developer: gross - platform, platform };
}

/**
 * Reconciliation check: does this ledger row match the single definition?
 * Returns null when OK, or a human-readable reason when NOT OK.
 * Handles refund rows (negative amounts) by checking absolute values and
 * requiring all three signs to agree.
 */
function validateLedgerRow({ gross_cents, fee_cents, net_cents }) {
  const g = Number(gross_cents), f = Number(fee_cents), n = Number(net_cents);
  if (![g, f, n].every(Number.isInteger)) return 'non-integer amount';
  const sign = Math.sign(g);
  if (sign !== Math.sign(f) || sign !== Math.sign(n)) return 'sign mismatch between gross/fee/net';
  if (g + 0 !== f + n) return `gross (${g}) !== fee (${f}) + net (${n})`;
  let expected;
  try {
    expected = split(Math.abs(g));
  } catch (e) {
    return e.message;
  }
  if (Math.abs(f) !== expected.platform || Math.abs(n) !== expected.developer) {
    return `fee/net do not match 90/10 split of ${Math.abs(g)}c (expected fee ${expected.platform}c, net ${expected.developer}c)`;
  }
  return null;
}

module.exports = {
  CENTS_PER_USD,
  PLATFORM_FEE_BPS,
  DEMO_BANNER,
  usdToCents,
  centsToUsd,
  formatUsd,
  split,
  validateLedgerRow,
};
