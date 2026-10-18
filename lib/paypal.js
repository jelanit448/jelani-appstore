'use strict';
/**
 * paypal.js — PayPal integration for real money (buyer's choice alongside
 * Cash App and Stripe). Zero new dependencies: Node's built-in fetch only.
 *
 * Config resolution (first hit wins):
 *   1. PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET env vars (deployment override)
 *      + PAYPAL_ENV env var ('live' or 'sandbox').
 *   2. The owner-saved values in the store's `settings` table (set through
 *      /paypal.html — never exposed to clients after save).
 *
 * Two environments:
 *   sandbox — api-m.sandbox.paypal.com. Money is play money: purchases are
 *             recorded in the ledger but labeled sandbox so they are never
 *             confused with real payouts.
 *   live    — api-m.paypal.com. Real buyer money; the ledger row is written
 *             only after PayPal confirms the capture — never from the browser.
 *
 * Unlike the Stripe flow there is no demo-purchase hole here: a purchase
 * only lands in the ledger after PayPal itself says the capture COMPLETED
 * for the exact app price (verified server-side in server.js).
 *
 * The Client ID is publishable by PayPal's design (it ships in every PayPal
 * checkout page on the internet, like a Stripe publishable key) — server.js
 * exposes it through GET /api/paypal/client-id so the JS SDK button can
 * render. The SECRET never leaves the server.
 */

const BASES = {
  live: 'https://api-m.paypal.com',
  sandbox: 'https://api-m.sandbox.paypal.com',
};

// Lazy-bound settings accessor — server.js sets this after initDb() so the
// module never touches the database directly.
let _settingsReader = null;
function bindSettingsReader(fn) { _settingsReader = fn; }

function envCreds() {
  const id = process.env.PAYPAL_CLIENT_ID || '';
  const secret = process.env.PAYPAL_CLIENT_SECRET || '';
  return id && secret ? { id, secret, source: 'env' } : null;
}

function dbCreds() {
  if (!_settingsReader) return null;
  try {
    const id = _settingsReader('paypal_client_id') || '';
    const secret = _settingsReader('paypal_secret') || '';
    return id && secret ? { id, secret, source: 'db' } : null;
  } catch { return null; }
}

function creds() { return envCreds() || dbCreds(); }

function effectiveEnv() {
  const e = (process.env.PAYPAL_ENV || '').toLowerCase();
  if (e === 'live' || e === 'sandbox') return e;
  if (_settingsReader) {
    try {
      const s = String(_settingsReader('paypal_env') || '').toLowerCase();
      if (s === 'live' || s === 'sandbox') return s;
    } catch { /* fall through */ }
  }
  return 'sandbox'; // safe default: never real money unless the owner says live
}

function baseUrl() { return BASES[effectiveEnv()] || BASES.sandbox; }

const configured = () => Boolean(creds());
const live = () => configured() && effectiveEnv() === 'live';

function notConfiguredError() {
  const err = new Error('PayPal is not connected — the owner has not set it up yet.');
  err.code = 'PAYPAL_UNCONFIGURED';
  return err;
}

// OAuth2 client-credentials token, cached in memory until it expires.
let _token = null;
let _tokenExp = 0;
// 15s cap: never let a slow PayPal hang a buyer request.
const PP_TIMEOUT = 15000;
function ppFetch(url, opts) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(PP_TIMEOUT) });
}

async function accessToken() {
  const c = creds();
  if (!c) throw notConfiguredError();
  if (_token && Date.now() < _tokenExp - 30_000) return _token;
  const res = await ppFetch(baseUrl() + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(c.id + ':' + c.secret).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const err = new Error('Could not reach PayPal — check the Client ID/Secret and try again.');
    err.code = 'PAYPAL_AUTH_FAILED';
    throw err;
  }
  _token = data.access_token;
  _tokenExp = Date.now() + (Number(data.expires_in) || 300) * 1000;
  return _token;
}

function cleanHttpError(res, fallbackCode) {
  const err = new Error('PayPal request failed — please try again.');
  err.code = fallbackCode;
  err.status = res.status;
  return err;
}

/**
 * Create an order for one app purchase. The amount comes from the caller
 * (server.js passes the DB price) — it is never taken from the browser.
 * Returns { id } (the PayPal order id).
 */
async function createOrder({ appId, appName, amountCents }) {
  if (!creds()) throw notConfiguredError();
  const token = await accessToken();
  const res = await ppFetch(baseUrl() + '/v2/checkout/orders', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        custom_id: String(appId),
        description: String(appName || 'App').slice(0, 127),
        amount: {
          currency_code: 'USD',
          value: (Math.round(amountCents) / 100).toFixed(2),
        },
      }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) throw cleanHttpError(res, 'PAYPAL_CREATE_FAILED');
  return { id: data.id };
}

/**
 * Capture an order. Returns { id, status, amountCents, currency, captureId }.
 * Server-side callers must still verify status/currency/amount against the
 * expected app price before writing any ledger row.
 */
async function captureOrder(orderId) {
  if (!creds()) throw notConfiguredError();
  const token = await accessToken();
  const res = await ppFetch(baseUrl() + '/v2/checkout/orders/' + encodeURIComponent(orderId) + '/capture', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw cleanHttpError(res, 'PAYPAL_CAPTURE_FAILED');
  const units = (data.purchase_units || [])[0] || {};
  const cap = ((units.payments || {}).captures || [])[0] || {};
  const amt = cap.amount || {};
  return {
    id: data.id || orderId,
    status: String(cap.status || '').toUpperCase(),
    amountCents: amt.value != null ? Math.round(Number(amt.value) * 100) : NaN,
    currency: String(amt.currency_code || '').toUpperCase(),
    captureId: cap.id || null,
  };
}

module.exports = {
  bindSettingsReader,
  configured,
  live,
  effectiveEnv,
  baseUrl,
  creds,
  createOrder,
  captureOrder,
  notConfiguredError,
};
