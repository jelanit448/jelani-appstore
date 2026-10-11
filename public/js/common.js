'use strict';
/* shared frontend helpers */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* non-json */ }
  if (res.status === 403 && data.error === 'TERMS_UPDATE_REQUIRED') {
    location.href = '/terms.html?must=1&next=' + encodeURIComponent(location.pathname + location.search);
    throw new Error('terms');
  }
  if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
  return data;
}

let _me = null;
async function me() {
  if (_me !== null) return _me;
  const d = await api('/api/me');
  _me = d.user;
  _meMustTerms = d.must_accept_terms;
  _meMustPw = d.must_change_password;
  return _me;
}
let _meMustTerms = false, _meMustPw = false;

async function renderHeader(active) {
  const u = await me().catch(() => null);
  const nav = document.getElementById('nav');
  let links = `<a href="/">Store</a>`;
  if (u) {
    if (u.role === 'owner' || u.role === 'developer') links += `<a href="/upload.html">Upload app</a><a href="/dashboard.html">Dashboard</a>`;
    else links += `<a href="/dashboard.html">Become a developer</a>`;
    if (u.role === 'owner') links += `<a href="/owner.html">Owner</a>`;
    links += `<a href="/kyc.html">Payouts</a>`;
    links += `<span class="who">${esc(u.username)} (${esc(u.role)})</span><a href="#" id="logout">Sign out</a>`;
  } else {
    links += `<a href="/login.html">Sign in</a><a href="/signup.html">Sign up</a>`;
  }
  nav.innerHTML = links;
  const lo = document.getElementById('logout');
  if (lo) lo.onclick = async (e) => { e.preventDefault(); await api('/api/logout', { method: 'POST' }); location.href = '/'; };
  if (u && _meMustTerms && !location.pathname.endsWith('terms.html')) {
    location.href = '/terms.html?must=1&next=' + encodeURIComponent(location.pathname);
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function stars(avg, n) {
  if (!avg) return '<span class="muted">No ratings yet</span>';
  const full = Math.round(avg);
  return `<span class="stars">${'★'.repeat(full)}${'☆'.repeat(5 - full)}</span> <span class="muted">${Number(avg).toFixed(1)} (${n})</span>`;
}

function demoBanner() {
  return `<div class="demo-banner">⚠️ <b>Demo money mode.</b> Balances shown here are ledger records only — <b>not withdrawable</b> until Stripe Connect is configured and KYC is verified. <a href="/kyc.html">Payout settings</a></div>`;
}

function showErr(el, msg) { el.innerHTML = `<div class="err">${esc(msg)}</div>`; }
function showOk(el, msg) { el.innerHTML = `<div class="okmsg">${esc(msg)}</div>`; }
