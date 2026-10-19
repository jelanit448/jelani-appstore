/*
 * levels.js — Jelani's 100-LEVELS engine for WebView game apps.
 *
 * Drop this file in the app's www/ folder, load it BEFORE app.js:
 *   <script src="levels.js"></script>
 *
 * Then at the top of app.js (after DOM is ready is fine):
 *   if (window.Levels) Levels.init('<slug>');
 *
 * And call Levels.earn(xp) whenever the player does the game's core action
 * (scores a point, wins a round, answers right, finishes a session, ...).
 *
 * Everything is stored in localStorage under '<slug>_levelxp' (cumulative XP)
 * and derived from it — never pre-filled, never faked. Level is computed from
 * real earned XP only.
 *
 * LEVEL CURVE: going from level L to L+1 costs 25*L XP.
 *   level 1 -> 2 : 25 XP
 *   level 2 -> 3 : 50 XP
 *   level 9 -> 10: 225 XP
 *   cumulative XP to REACH level L = 25 * L * (L - 1) / 2
 *   level 10 comes after 1,125 XP; level 100 after 123,750 XP.
 * A typical quiz right-answer = 25 XP, so level 10 lands after ~45 right
 * answers (a good session) and level 100 is a genuine long-term grind.
 *
 * API:
 *   Levels.init(slug, opts)     — start the engine. opts.label (game name),
 *                                 opts.badge (default true: gold badge top-right)
 *   Levels.earn(xp)             — award XP (number, must be > 0)
 *   Levels.getLevel()           — current level 1..100
 *   Levels.getXp()              — cumulative XP
 *   Levels.onLevel(fn)          — fn(level) called on init + every level-up
 *   Levels.openPanel() / closePanel() — the 1–100 levels map
 *   Levels.thresholdsFor(level) — {toNext, have, need} progress info
 */
(function () {
  'use strict';

  var MAX_LEVEL = 100;

  function xpToReach(level) { // cumulative XP needed to be AT `level`
    return 25 * level * (level - 1) / 2;
  }
  function levelFromXp(xp) {
    var lvl = 1;
    while (lvl < MAX_LEVEL && xp >= xpToReach(lvl + 1)) lvl++;
    return lvl;
  }

  var L = {
    slug: null,
    label: 'Game',
    xp: 0,
    level: 1,
    _listeners: [],
    _panel: null,
    _overlay: null,
    _badge: null,

    init: function (slug, opts) {
      if (L.slug) return; // already running
      opts = opts || {};
      L.slug = slug;
      L.label = opts.label || slug;
      try {
        var stored = parseInt(localStorage.getItem(slug + '_levelxp'), 10);
        L.xp = isNaN(stored) || stored < 0 ? 0 : stored;
      } catch (e) { L.xp = 0; }
      L.level = levelFromXp(L.xp);
      if (opts.badge !== false) L._mountBadge();
      L._fire(L.level);
      return L;
    },

    earn: function (xp) {
      if (!L.slug) return;
      xp = Number(xp);
      if (!isFinite(xp) || xp <= 0) return;
      var before = L.level;
      L.xp = Math.floor(L.xp + xp);
      try { localStorage.setItem(L.slug + '_levelxp', String(L.xp)); } catch (e) {}
      L.level = levelFromXp(L.xp);
      L._refreshBadge();
      if (L.level > before) {
        L._celebrate(L.level);
        L._fire(L.level);
      }
      return L.level;
    },

    getLevel: function () { return L.level; },
    getXp: function () { return L.xp; },
    getMax: function () { return MAX_LEVEL; },

    onLevel: function (fn) {
      if (typeof fn === 'function') {
        L._listeners.push(fn);
        try { fn(L.level); } catch (e) {}
      }
    },

    thresholdsFor: function (level) {
      level = Math.max(1, Math.min(MAX_LEVEL, level || L.level));
      var base = xpToReach(level);
      var next = level < MAX_LEVEL ? xpToReach(level + 1) : base;
      return { level: level, have: Math.max(0, L.xp - base), need: Math.max(1, next - base) };
    },

    openPanel: function () { L._buildPanel(); if (L._panel) L._panel.style.display = 'flex'; },
    closePanel: function () { if (L._panel) L._panel.style.display = 'none'; },

    // ---- internals ----
    _fire: function (lvl) {
      for (var i = 0; i < L._listeners.length; i++) {
        try { L._listeners[i](lvl); } catch (e) {}
      }
    },

    _css: function () {
      var id = 'jl-levels-style';
      if (document.getElementById(id)) return;
      var s = document.createElement('style');
      s.id = id;
      s.textContent =
        '.jl-badge{position:fixed;top:10px;right:10px;z-index:2147483000;' +
        'background:linear-gradient(135deg,#d4af37,#8a6d1f);color:#111;font-weight:800;' +
        'font-size:14px;padding:7px 12px;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.45);' +
        'border:1px solid #ffe08a;cursor:pointer;font-family:inherit}' +
        '.jl-panel{position:fixed;inset:0;z-index:2147483001;display:none;align-items:center;' +
        'justify-content:center;background:rgba(0,0,0,.82);font-family:inherit}' +
        '.jl-card{width:min(92vw,560px);max-height:86vh;overflow:auto;background:#111;border:2px solid #d4af37;' +
        'border-radius:14px;padding:18px;color:#f5f5f5}' +
        '.jl-card h2{margin:0 0 4px;color:#d4af37;font-size:20px}' +
        '.jl-card .sub{color:#bbb;font-size:13px;margin-bottom:10px}' +
        '.jl-grid{display:grid;grid-template-columns:repeat(10,1fr);gap:6px}' +
        '.jl-cell{aspect-ratio:1;display:flex;align-items:center;justify-content:center;' +
        'border-radius:8px;font-size:12px;font-weight:700;background:#1e1e1e;color:#666;border:1px solid #2c2c2c}' +
        '.jl-cell.hit{background:#2a230c;color:#d4af37;border-color:#8a6d1f}' +
        '.jl-cell.cur{background:linear-gradient(135deg,#d4af37,#8a6d1f);color:#111;border-color:#ffe08a;' +
        'box-shadow:0 0 10px rgba(212,175,55,.7);animation:jlpulse 1.4s infinite}' +
        '@keyframes jlpulse{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}' +
        '.jl-close{margin-top:12px;background:#d4af37;color:#111;border:none;font-weight:800;' +
        'padding:10px 18px;border-radius:10px;font-size:15px;cursor:pointer;font-family:inherit}' +
        '.jl-lvlup{position:fixed;inset:0;z-index:2147483002;display:flex;align-items:center;' +
        'justify-content:center;background:rgba(0,0,0,.55);font-family:inherit;pointer-events:none}' +
        '.jl-lvlup .box{text-align:center;animation:jlpop .55s ease-out}' +
        '.jl-lvlup .big{font-size:52px;font-weight:900;color:#d4af37;' +
        'text-shadow:0 0 24px rgba(212,175,55,.9);margin-bottom:6px}' +
        '.jl-lvlup .sm{font-size:16px;color:#fff;font-weight:700}' +
        '@keyframes jlpop{0%{transform:scale(.4);opacity:0}70%{transform:scale(1.12)}100%{transform:scale(1);opacity:1}}';
      document.head.appendChild(s);
    },

    _mountBadge: function () {
      L._css();
      if (L._badge) return;
      var b = document.createElement('button');
      b.className = 'jl-badge';
      b.type = 'button';
      b.addEventListener('click', function () { L.openPanel(); });
      document.body.appendChild(b);
      L._badge = b;
      L._refreshBadge();
    },

    _refreshBadge: function () {
      if (L._badge) L._badge.textContent = 'Lv ' + L.level;
    },

    _buildPanel: function () {
      L._css();
      if (L._panel) { L._renderGrid(); return; }
      var wrap = document.createElement('div');
      wrap.className = 'jl-panel';
      var card = document.createElement('div');
      card.className = 'jl-card';
      var t = L.thresholdsFor(L.level);
      var pct = L.level >= MAX_LEVEL ? 100 : Math.floor(t.have / t.need * 100);
      var prog = L.level >= MAX_LEVEL
        ? '<div class="sub">MAX LEVEL — 100. Legend status. 👑</div>'
        : '<div class="sub">Level ' + L.level + ' — ' + t.have + ' / ' + t.need + ' XP to level ' + (L.level + 1) + ' (' + pct + '%)</div>';
      card.innerHTML = '<h2>🏆 ' + L._esc(L.label) + ' — Levels</h2>' + prog +
        '<div class="sub">Every level is earned by playing — nothing is given. Reach level 100 to max out.</div>' +
        '<div class="jl-grid" id="jl-grid"></div>' +
        '<button class="jl-close" id="jl-close">Close</button>';
      wrap.appendChild(card);
      wrap.addEventListener('click', function (e) { if (e.target === wrap) L.closePanel(); });
      document.body.appendChild(wrap);
      var cb = card.querySelector('#jl-close');
      if (cb) cb.addEventListener('click', function () { L.closePanel(); });
      L._panel = wrap;
      L._renderGrid();
    },

    _renderGrid: function () {
      var g = document.getElementById('jl-grid');
      if (g) {
        var html = '';
        for (var i = 1; i <= MAX_LEVEL; i++) {
          var cls = 'jl-cell';
          if (i < L.level) cls += ' hit';
          else if (i === L.level) cls += ' cur';
          html += '<div class="' + cls + '">' + i + '</div>';
        }
        g.innerHTML = html;
      }
    },

    _celebrate: function (lvl) {
      L._css();
      if (L._overlay) { try { L._overlay.remove(); } catch (e) {} }
      var o = document.createElement('div');
      o.className = 'jl-lvlup';
      var inner = document.createElement('div');
      inner.className = 'box';
      var big = document.createElement('div');
      big.className = 'big';
      big.textContent = lvl >= MAX_LEVEL ? 'LEVEL 100! 👑' : 'LEVEL ' + lvl + '!';
      var sm = document.createElement('div');
      sm.className = 'sm';
      sm.textContent = L.label;
      inner.appendChild(big); inner.appendChild(sm);
      o.appendChild(inner);
      document.body.appendChild(o);
      L._overlay = o;
      setTimeout(function () { try { o.remove(); } catch (e) {} if (L._overlay === o) L._overlay = null; }, 2400);
    },

    _esc: function (s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  };

  window.Levels = L;
})();
