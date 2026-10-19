/* Jelani Money Layer — free-demo model.
 *
 * Injected into every AppMaker store app (script tag placed BEFORE app.js).
 * Placeholders %%ML_SLUG%% %%ML_APPNAME%% %%ML_PRICE%% %%ML_HASH%% are
 * replaced at build/injection time (see moneylayer/inject.js).
 *
 * What it does:
 *  - Shows a slim gold demo bar: FREE DEMO + Unlock / Tip / More apps.
 *  - Enforces the demo cap: in demo mode, the app's largest saved
 *    collection (the biggest array found anywhere in a localStorage JSON
 *    value) may hold at most 10 entries. The write that would push it past
 *    10 is blocked and the unlock panel opens. This is a REAL enforced
 *    limit, not a label. Apps with no array collections get the bar +
 *    unlock + tip (no cap to enforce — recorded honestly per app).
 *  - Unlock panel: type the code bought in Jelani's App Store; the code is
 *    verified offline as SHA-256(code) === baked hash. Success stores
 *    ml_<slug>_full=1 and the cap lifts forever.
 *  - Tip: copies $JelaniThompson2 to the clipboard.
 *  - More apps: copies the store link (WebView-safe, no navigation).
 *
 * Honesty rules baked in: the demo genuinely works up to the cap, genuinely
 * stops there, and the full version genuinely removes it. Apps whose data
 * is not a JSON array get the bar + unlock + tip, and the wave smoke test
 * records which cap (if any) each app enforces.
 *
 * Audit note: every DOM read below is null-guarded with the patterns
 * lib/appmaker.js auditJs accepts (if (x), x &&, x ?, x !== null).
 */
(function () {
'use strict';

// ===== baked at injection time =====
var ML_SLUG = '%%ML_SLUG%%';
var ML_APPNAME = '%%ML_APPNAME%%';
var ML_PRICE = '%%ML_PRICE%%';
var ML_HASH = '%%ML_HASH%%'; // sha256 hex of the unlock code
// ===================================

var ML_STORE = 'https://jelani-appstore.onrender.com';
var ML_CASHTAG = '$JelaniThompson2';
var ML_DEMO_MAX = 10;
var ML_FULL_KEY = 'ml_' + ML_SLUG + '_full';
var ML_HIDE_KEY = 'ml_' + ML_SLUG + '_barhide';

var ML_CONFIGURED = (ML_HASH.indexOf('%%') !== 0) && (ML_HASH.length === 64);

function mlGet(k) {
  try {
    var v = window.localStorage.getItem(k);
    return v;
  } catch (e) { return null; }
}
function mlSet(k, v) {
  try { window.localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ }
}
function mlIsFull() { return mlGet(ML_FULL_KEY) === '1'; }
function mlBarHidden() { return mlGet(ML_HIDE_KEY) === '1'; }

/* ---------- compact SHA-256 (sync; ASCII/UTF-8 input) ---------- */
function mlSha256Hex(input) {
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  var bytes = unescape(encodeURIComponent(String(input)));
  var bitLen = bytes.length * 8;
  bytes += String.fromCharCode(0x80);
  while ((bytes.length % 64) !== 56) bytes += String.fromCharCode(0);
  var hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
  var tail = '';
  for (var i = 3; i >= 0; i--) tail += String.fromCharCode((hi >>> (i * 8)) & 255);
  for (var j = 3; j >= 0; j--) tail += String.fromCharCode((lo >>> (j * 8)) & 255);
  bytes += tail;
  var w = new Array(64);
  function rotr(v, a) { return (v >>> a) | (v << (32 - a)); }
  for (var b = 0; b < bytes.length; b += 64) {
    for (var t = 0; t < 16; t++) {
      w[t] = (bytes.charCodeAt(b + t * 4) << 24) | (bytes.charCodeAt(b + t * 4 + 1) << 16) |
             (bytes.charCodeAt(b + t * 4 + 2) << 8) | bytes.charCodeAt(b + t * 4 + 3);
    }
    for (var u = 16; u < 64; u++) {
      var s0 = rotr(w[u - 15], 7) ^ rotr(w[u - 15], 18) ^ (w[u - 15] >>> 3);
      var s1 = rotr(w[u - 2], 17) ^ rotr(w[u - 2], 19) ^ (w[u - 2] >>> 10);
      w[u] = (w[u - 16] + s0 + w[u - 7] + s1) | 0;
    }
    var a0 = H[0], b0 = H[1], c0 = H[2], d0 = H[3], e0 = H[4], f0 = H[5], g0 = H[6], h0 = H[7];
    for (var v2 = 0; v2 < 64; v2++) {
      var S1 = rotr(e0, 6) ^ rotr(e0, 11) ^ rotr(e0, 25);
      var ch = (e0 & f0) ^ (~e0 & g0);
      var t1 = (h0 + S1 + ch + K[v2] + w[v2]) | 0;
      var S0 = rotr(a0, 2) ^ rotr(a0, 13) ^ rotr(a0, 22);
      var mj = (a0 & b0) ^ (a0 & c0) ^ (b0 & c0);
      var t2 = (S0 + mj) | 0;
      h0 = g0; g0 = f0; f0 = e0; e0 = (d0 + t1) | 0;
      d0 = c0; c0 = b0; b0 = a0; a0 = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a0) | 0; H[1] = (H[1] + b0) | 0; H[2] = (H[2] + c0) | 0; H[3] = (H[3] + d0) | 0;
    H[4] = (H[4] + e0) | 0; H[5] = (H[5] + f0) | 0; H[6] = (H[6] + g0) | 0; H[7] = (H[7] + h0) | 0;
  }
  var out = '';
  for (var q = 0; q < 8; q++) {
    var hv = H[q] >>> 0;
    out += ('00000000' + hv.toString(16)).slice(-8);
  }
  return out;
}

/* ---------- demo cap: enforced on localStorage writes ----------
 * Rule: the largest array found anywhere in the stored JSON value (the
 * app's "main collection") may hold at most ML_DEMO_MAX entries in demo
 * mode. The write that would push it past the cap is blocked and the
 * unlock panel opens. Pre-existing data over the cap is left alone.
 */
function mlMaxArrLen(v) {
  var best = -1;
  function walk(x, depth) {
    if (depth > 6 || x === null || x === undefined || typeof x !== 'object') return;
    if (Object.prototype.toString.call(x) === '[object Array]') {
      if (x.length > best) best = x.length;
      for (var i = 0; i < x.length; i++) walk(x[i], depth + 1);
    } else {
      for (var k in x) {
        if (Object.prototype.hasOwnProperty.call(x, k)) walk(x[k], depth + 1);
      }
    }
  }
  try { walk(v, 0); } catch (e) { /* never break the app on our account */ }
  return best;
}
function mlParsedMax(raw) {
  var v = null;
  try { v = JSON.parse(raw); } catch (e) { return -1; }
  return mlMaxArrLen(v);
}
var _origSetItem = null;
try {
  _origSetItem = window.Storage.prototype.setItem;
  window.Storage.prototype.setItem = function (key, value) {
    var blocked = false;
    try {
      if (!mlIsFull() && typeof key === 'string' && key.indexOf('ml_') !== 0) {
        var newMax = mlParsedMax(value);
        if (newMax > ML_DEMO_MAX) {
          var oldRaw = null;
          try { oldRaw = window.Storage.prototype.getItem.call(this, key); } catch (e2) { oldRaw = null; }
          if (mlParsedMax(oldRaw) <= ML_DEMO_MAX) blocked = true;
        }
      }
    } catch (e4) { blocked = false; }
    if (blocked) { mlShowLimit(); return; }
    return _origSetItem.call(this, key, value);
  };
} catch (e5) { /* Storage unavailable — app runs without the cap */ }

function mlNormalizeCode(input) {
  var clean = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^FULL[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{16}$/.test(clean)) return null;
  return 'FULL-' + clean.slice(4).match(/.{1,4}/g).join('-');
}

/* ---------- UI ---------- */
var ML_CSS = '.ml-bar{position:fixed;left:0;right:0;bottom:0;z-index:99999;display:flex;align-items:center;gap:8px;padding:8px 10px;background:#111;border-top:2px solid #d4af37;color:#f5f5f5;font-family:Roboto,Arial,sans-serif;font-size:13px;box-sizing:border-box}' +
  '.ml-bar button{background:#d4af37;color:#111;border:none;border-radius:8px;padding:7px 10px;font-size:13px;font-weight:700;cursor:pointer}' +
  '.ml-bar button.ml-ghost{background:#222;color:#f5f5f5;border:1px solid #444}' +
  '.ml-full{position:fixed;left:0;right:0;bottom:0;z-index:99999;display:flex;align-items:center;justify-content:center;gap:8px;padding:6px;background:#0d2818;border-top:2px solid #00d632;color:#c9f5d6;font-family:Roboto,Arial,sans-serif;font-size:12px}' +
  '.ml-full button{background:#222;color:#f5f5f5;border:1px solid #444;border-radius:8px;padding:4px 8px;font-size:12px}' +
  '.ml-overlay{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}' +
  '.ml-panel{background:#161616;border:2px solid #d4af37;border-radius:14px;padding:18px;max-width:380px;width:100%;color:#f5f5f5;font-family:Roboto,Arial,sans-serif}' +
  '.ml-panel h3{margin:0 0 8px;color:#d4af37}' +
  '.ml-panel input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #444;background:#0d0d0d;color:#f5f5f5;font-size:16px;letter-spacing:1px;margin:8px 0}' +
  '.ml-panel .ml-row{display:flex;gap:8px;margin-top:10px}' +
  '.ml-panel .ml-row button{flex:1;background:#d4af37;color:#111;border:none;border-radius:8px;padding:10px;font-size:14px;font-weight:700;cursor:pointer}' +
  '.ml-panel .ml-row button.ml-ghost{background:#222;color:#f5f5f5;border:1px solid #444}' +
  '.ml-toast{position:fixed;left:50%;bottom:70px;transform:translateX(-50%);z-index:100001;background:#222;border:1px solid #d4af37;color:#f5f5f5;border-radius:10px;padding:10px 16px;font-family:Roboto,Arial,sans-serif;font-size:13px;max-width:90vw;box-sizing:border-box}';

function mlEl(id) { return document.getElementById(id); }

function mlToast(msg) {
  var old = mlEl('ml-toast');
  if (old && old.parentNode) { old.parentNode.removeChild(old); }
  var t = document.createElement('div');
  t.id = 'ml-toast';
  t.className = 'ml-toast';
  t.textContent = msg;
  var body = document.body;
  if (body) { body.appendChild(t); }
  setTimeout(function () {
    var cur = mlEl('ml-toast');
    if (cur && cur.parentNode) { cur.parentNode.removeChild(cur); }
  }, 2600);
}

function mlCopy(text, doneMsg) {
  function done() { mlToast(doneMsg || 'Copied ✅'); }
  var nav = window.navigator;
  if (nav && nav.clipboard && nav.clipboard.writeText) {
    nav.clipboard.writeText(text).then(done, function () { mlFallbackCopy(text); done(); });
  } else { mlFallbackCopy(text); done(); }
}
function mlFallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  var body = document.body;
  if (body) {
    body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    body.removeChild(ta);
  }
}

function mlHideBar(permanent) {
  var bar = mlEl('ml-bar');
  if (bar && bar.parentNode) { bar.parentNode.removeChild(bar); }
  var full = mlEl('ml-full');
  if (full && full.parentNode) { full.parentNode.removeChild(full); }
  if (permanent) { mlSet(ML_HIDE_KEY, '1'); }
  var body = document.body;
  if (body) { body.style.paddingBottom = '0'; }
}

function mlOpenPanel(withLimitNote) {
  mlClosePanel();
  var ov = document.createElement('div');
  ov.id = 'ml-overlay';
  ov.className = 'ml-overlay';
  var limitNote = withLimitNote
    ? '<p style="color:#ffb84d"><b>Demo limit reached</b> — the free demo holds up to ' + ML_DEMO_MAX + ' saved entries. Unlock the full version for unlimited everything, forever.</p>'
    : '';
  var configNote = ML_CONFIGURED ? '' : '<p class="muted">Unlock codes are not configured for this build yet.</p>';
  ov.innerHTML =
    '<div class="ml-panel"><h3>🔓 Unlock ' + mlEsc(ML_APPNAME) + '</h3>' + limitNote + configNote +
    '<p style="font-size:13px;color:#bbb">The download is the <b>FREE DEMO</b>. The <b style="color:#d4af37">FULL VERSION ' + mlEsc(ML_PRICE) + '</b> removes the demo limits forever.</p>' +
    '<p style="font-size:13px;color:#bbb">1. Buy the unlock code in <b>Jelani\u2019s App Store</b> (pay ' + mlEsc(ML_CASHTAG) + ' on Cash App).<br>2. Type your code here:</p>' +
    '<input id="ml-code" placeholder="FULL-XXXX-XXXX-XXXX-XXXX" maxlength="24" autocomplete="off">' +
    '<div id="ml-code-err" style="color:#ff7b7b;font-size:13px;min-height:18px"></div>' +
    '<div class="ml-row"><button id="ml-verify">Unlock</button><button id="ml-close" class="ml-ghost">Later</button></div>' +
    '<div class="ml-row"><button id="ml-tip2" class="ml-ghost">💛 Tip the maker</button></div></div>';
  var body = document.body;
  if (body) { body.appendChild(ov); }
  var verify = mlEl('ml-verify');
  if (verify) {
    verify.addEventListener('click', function () {
      var input = mlEl('ml-code');
      var err = mlEl('ml-code-err');
      var raw = input ? input.value : '';
      var canon = mlNormalizeCode(raw);
      if (!canon) {
        if (err) { err.textContent = 'That code does not look right — check it and try again.'; }
        return;
      }
      var good = ML_CONFIGURED && (mlSha256Hex(canon) === ML_HASH.toLowerCase());
      if (good) {
        mlSet(ML_FULL_KEY, '1');
        mlClosePanel();
        mlRenderBar();
        mlToast('🎉 Full version unlocked — enjoy!');
      } else {
        if (err) { err.textContent = 'That code didn\u2019t work — check it and try again.'; }
      }
    });
  }
  var close = mlEl('ml-close');
  if (close) { close.addEventListener('click', mlClosePanel); }
  var tip2 = mlEl('ml-tip2');
  if (tip2) {
    tip2.addEventListener('click', function () {
      mlCopy(ML_CASHTAG, ML_CASHTAG + ' copied — send any tip in Cash App 💛');
    });
  }
  var codeInput = mlEl('ml-code');
  if (codeInput) { codeInput.focus(); }
}

function mlClosePanel() {
  var ov = mlEl('ml-overlay');
  if (ov && ov.parentNode) { ov.parentNode.removeChild(ov); }
}

function mlShowLimit() { mlOpenPanel(true); }

function mlEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function mlRenderBar() {
  mlHideBar(false);
  if (mlBarHidden() && mlIsFull()) return;
  var body = document.body;
  if (!body) return;
  body.style.paddingBottom = '58px';
  if (mlIsFull()) {
    var full = document.createElement('div');
    full.id = 'ml-full';
    full.className = 'ml-full';
    full.innerHTML = '<span>✓ FULL VERSION — ' + mlEsc(ML_APPNAME) + '</span><button id="ml-full-hide">Hide</button>';
    body.appendChild(full);
    var fh = mlEl('ml-full-hide');
    if (fh) { fh.addEventListener('click', function () { mlHideBar(true); }); }
    return;
  }
  var bar = document.createElement('div');
  bar.id = 'ml-bar';
  bar.className = 'ml-bar';
  bar.innerHTML =
    '<span><b style="color:#d4af37">FREE DEMO</b> · Full version ' + mlEsc(ML_PRICE) + '</span>' +
    '<span style="flex:1"></span>' +
    '<button id="ml-b-unlock">Unlock</button>' +
    '<button id="ml-b-tip" class="ml-ghost">Tip</button>' +
    '<button id="ml-b-more" class="ml-ghost">More apps</button>' +
    '<button id="ml-b-hide" class="ml-ghost">✕</button>';
  body.appendChild(bar);
  var un = mlEl('ml-b-unlock');
  if (un) { un.addEventListener('click', function () { mlOpenPanel(false); }); }
  var tip = mlEl('ml-b-tip');
  if (tip) {
    tip.addEventListener('click', function () {
      mlCopy(ML_CASHTAG, ML_CASHTAG + ' copied — send any tip in Cash App 💛');
    });
  }
  var more = mlEl('ml-b-more');
  if (more) {
    more.addEventListener('click', function () {
      mlCopy(ML_STORE, 'Store link copied — paste it in your browser 🔗');
    });
  }
  var hide = mlEl('ml-b-hide');
  if (hide) {
    hide.addEventListener('click', function () {
      mlHideBar(false);
      mlToast('Demo bar hidden for this visit — it returns next launch.');
    });
  }
}

function mlBoot() {
  var style = document.createElement('style');
  style.textContent = ML_CSS;
  var head = document.head;
  if (head) { head.appendChild(style); }
  function go() { mlRenderBar(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', go);
  } else { go(); }
}

mlBoot();
})();
