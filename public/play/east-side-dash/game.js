/* East Side Dash — canvas endless runner.
 * Every DOM read below is null-guarded. An unguarded
 * document.getElementById('x').focus() is a crash — never do that.
 */
(function () {
  'use strict';

  var doc = (typeof document !== 'undefined') ? document : null;
  if (!doc) { return; }
  var canvas = doc.getElementById('game');
  if (!canvas) { return; }

  boot(canvas);

  function boot(cv) {
    var ctx = (cv.getContext) ? cv.getContext('2d') : null;
    if (!ctx) { return; }

    // ---- constants ----
    var W = 420, H = 740;
    var GROUND_Y = H - 110;
    var GRAV = 2100;
    var JUMP_V = -800;
    var PLAYER_W = 34, PLAYER_H = 56, PLAYER_X = 90;
    var BASE_SPEED = 265, MAX_SPEED = 660, RAMP = 9; // px/s gained per second
    var BEST_KEY = 'eastsidedash_best';
    var PACKS_KEY = 'eastsidedash_packs';
    var CASHTAG = '$JelaniThompson2';

    // ---- paid packs: unlock codes (window.DashCodes from codes.js, guarded) ----
    var Codes = (typeof window !== 'undefined' && window && window.DashCodes) ? window.DashCodes : null;

    function readPacks() {
      var arr = [];
      if (store) {
        try {
          var raw = store.getItem(PACKS_KEY);
          if (raw) {
            var p = JSON.parse(raw);
            if (p && typeof p.length === 'number') { arr = p; }
          }
        } catch (e) { arr = []; }
      }
      return arr;
    }
    function writePacks() {
      if (store) {
        try { store.setItem(PACKS_KEY, JSON.stringify(G.packs)); } catch (e) { /* private mode — fine */ }
      }
    }

    // ---- tiny guarded DOM helpers (build-time audit: never chain a query) ----
    function $(id) {
      var n = null;
      try { n = doc.getElementById(id); } catch (e) { n = null; }
      return n;
    }
    function onTap(id, fn) {
      var n = $(id);
      if (n && n.addEventListener) {
        n.addEventListener('click', function (e) {
          if (e && e.preventDefault) { e.preventDefault(); }
          fn();
        });
      }
    }
    function setText(id, t) {
      var n = $(id);
      if (n) { n.textContent = t; }
    }
    function uiShow(name) {
      G.uiShown = name;
      var root = $('dashui');
      if (!root) { return; }
      root.hidden = false;
      var ids = ['packs', 'tip', 'music'];
      for (var i = 0; i < ids.length; i++) {
        var p = $('panel-' + ids[i]);
        if (p) { p.hidden = (ids[i] !== name); }
      }
      if (name === 'packs') { refreshPackPanel(); }
    }
    function uiHide() {
      G.uiShown = null;
      var root = $('dashui');
      if (root) { root.hidden = true; }
    }
    function refreshPackPanel() {
      refreshPackStateOnly();
      var inp = $('dashcode');
      if (inp) { inp.value = ''; }
      if (!G.hasPack('nights')) { setText('packmsg', ''); }
    }
    function tryUnlock() {
      var inp = $('dashcode');
      var code = inp ? String(inp.value || '') : '';
      if (Codes && Codes.verify(code)) {
        if (G.packs.indexOf('nights') < 0) { G.packs.push('nights'); writePacks(); }
        setText('packmsg', '✓ NIGHTS UNLOCKED — close this and tap 🌙 NIGHTS.');
        try { sfx('coin'); } catch (e) { /* never crash on sfx */ }
      } else {
        setText('packmsg', '✗ That code did not check out — double-check it and try again.');
      }
      refreshPackStateOnly();
    }
    function refreshPackStateOnly() {
      var has = G.hasPack('nights');
      setText('packstate', has ? 'Status: UNLOCKED ✓ — tap 🌙 NIGHTS to run it.' : 'Status: locked');
    }
    function copyCashtag(msgId, okText) {
      var done = false;
      try {
        var nav = (typeof navigator !== 'undefined') ? navigator : null;
        if (nav && nav.clipboard && nav.clipboard.writeText) {
          nav.clipboard.writeText(CASHTAG);
          done = true;
        }
      } catch (e) { done = false; }
      if (!done) {
        var inp = $('dashcopy');
        if (inp) {
          try {
            inp.hidden = false;
            inp.value = CASHTAG;
            if (inp.select) { inp.select(); }
            if (doc.execCommand) { doc.execCommand('copy'); }
          } catch (e2) { /* best effort */ }
          inp.hidden = true;
        }
      }
      setText(msgId, okText);
    }

    // ---- themes: day (v1.0 look) vs paid "East Side Nights" pack ----
    var DAY_TH = {
      sky: '#0a0a12', moon: '#d4af37', moonCut: '#0a0a12',
      bld0: '#141419', bld1: '#1f1f28', win0: '#2b2b12', win1: '#3a3418',
      lane: '#39ff6a', ground: '#15151c', stripe: '#d4af37', hudTag: ''
    };
    var NIGHT_TH = {
      sky: '#04040c', moon: '#b44fff', moonCut: '#04040c',
      bld0: '#0b0b14', bld1: '#151524', win0: '#3d1f4d', win1: '#552a66',
      lane: '#ff4fd8', ground: '#0e0e16', stripe: '#b44fff', hudTag: '  🌙'
    };

    // ---- title-screen buttons (logical 420x740 coords) ----
    var BTNS = [
      { id: 'nights', x: 12, y: 596, w: 124, h: 48 },
      { id: 'tip', x: 148, y: 596, w: 124, h: 48 },
      { id: 'music', x: 284, y: 596, w: 124, h: 48 }
    ];
    function btnLabel(b) {
      if (b.id === 'nights') { return G.hasPack('nights') ? '🌙 NIGHTS ✓' : '🌙 NIGHTS'; }
      if (b.id === 'tip') { return '💸 TIP'; }
      return '🎵 MUSIC';
    }
    function hitButton(x, y) {
      for (var i = 0; i < BTNS.length; i++) {
        var b = BTNS[i];
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) { return b; }
      }
      return null;
    }
    function buttonAction(id) {
      if (id === 'nights') {
        if (G.hasPack('nights')) { start(true); }
        else { uiShow('packs'); }
      } else if (id === 'tip') { uiShow('tip'); }
      else if (id === 'music') { uiShow('music'); }
    }
    function toLogical(e) {
      var rect = null;
      try { rect = cv.getBoundingClientRect(); } catch (err) { rect = null; }
      if (!rect || !rect.width || !rect.height) { return null; }
      var t = (e && e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0] : e;
      var cx = t ? t.clientX : 0, cy = t ? t.clientY : 0;
      return { x: (cx - rect.left) * (W / rect.width), y: (cy - rect.top) * (H / rect.height) };
    }

    // ---- audio (WebAudio bleeps, guarded) ----
    var actx = null;
    function ensureAudio() {
      if (actx) { return actx; }
      try {
        var AC = (typeof window !== 'undefined' && window)
          ? (window.AudioContext || window.webkitAudioContext) : null;
        if (AC) { actx = new AC(); }
      } catch (e) { actx = null; }
      return actx;
    }
    function blip(f0, f1, dur, type) {
      try {
        var a = ensureAudio();
        if (!a) { return; }
        if (a.state === 'suspended') { a.resume(); }
        var o = a.createOscillator(), g = a.createGain();
        o.type = type || 'square';
        o.frequency.setValueAtTime(f0, a.currentTime);
        o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), a.currentTime + dur);
        g.gain.setValueAtTime(0.12, a.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
        o.connect(g); g.connect(a.destination);
        o.start(); o.stop(a.currentTime + dur + 0.02);
      } catch (e) { /* audio is decoration — never crash the game */ }
    }
    function sfx(name) {
      if (name === 'jump') { blip(280, 640, 0.12, 'square'); }
      else if (name === 'coin') { blip(880, 1560, 0.14, 'sine'); }
      else if (name === 'crash') { blip(220, 55, 0.35, 'sawtooth'); }
      else if (name === 'go') { blip(520, 1040, 0.12, 'triangle'); }
    }

    // ---- storage (guarded) ----
    var store = null;
    try { store = (typeof localStorage !== 'undefined') ? localStorage : null; } catch (e) { store = null; }
    function readBest() {
      var b = 0;
      if (store) {
        try { b = parseInt(store.getItem(BEST_KEY), 10) || 0; } catch (e) { b = 0; }
      }
      return b;
    }
    function writeBest(v) {
      if (store) {
        try { store.setItem(BEST_KEY, String(v)); } catch (e) { /* private mode — fine */ }
      }
    }

    // ---- game state ----
    var G = {
      state: 'ready', // ready | play | over
      score: 0, best: readBest(),
      speed: BASE_SPEED, dist: 0, time: 0,
      player: { y: GROUND_Y - PLAYER_H, vy: 0, onGround: true, legT: 0 },
      obstacles: [], records: [], buildings: [], stars: [],
      paused: false,
      night: false, // East Side Nights pack mode
      packs: readPacks(),
      uiShown: null,
      rand: Math.random
    };

    G.hasPack = function (id) { return G.packs.indexOf(id) >= 0; };
    G.unlockWithCode = function (code) {
      if (Codes && Codes.verify(code)) {
        if (G.packs.indexOf('nights') < 0) { G.packs.push('nights'); writePacks(); }
        return true;
      }
      return false;
    };

    function reset() {
      G.score = 0; G.dist = 0; G.time = 0;
      G.speed = BASE_SPEED;
      G.player.y = GROUND_Y - PLAYER_H; G.player.vy = 0; G.player.onGround = true;
      G.obstacles = []; G.records = [];
      spawnTimer = G.night ? 0.9 : 1.1; recordTimer = G.night ? 1.8 : 2.2;
    }

    function start(night) {
      G.night = !!night;
      reset(); // reset() reads G.night for the mode's pacing
      G.state = 'play';
      sfx('go');
    }

    function doJump() {
      if (G.state !== 'play') { return; }
      if (G.player.onGround) {
        G.player.vy = JUMP_V;
        G.player.onGround = false;
        sfx('jump');
      }
    }

    function onPress(pt) {
      ensureAudio();
      if (G.uiShown) { return; } // a panel is open — taps belong to it
      if (G.state === 'ready') {
        if (pt) {
          var b = hitButton(pt.x, pt.y);
          if (b) { buttonAction(b.id); return; }
        }
        start(false);
      } else if (G.state === 'over') { start(G.night); } // run it back in the same mode
      else { doJump(); }
    }

    // ---- spawners ----
    var spawnTimer = 1.1, recordTimer = 2.2;
    var OB_KINDS = ['crate', 'barrier', 'cone'];
    function spawnObstacle() {
      var k = OB_KINDS[Math.floor(G.rand() * OB_KINDS.length) % OB_KINDS.length];
      var w, h;
      if (k === 'crate') { w = 44; h = 44; }
      else if (k === 'barrier') { w = 56; h = 34; }
      else { w = 30; h = 42; } // cone
      G.obstacles.push({ kind: k, x: W + 40, y: GROUND_Y - h, w: w, h: h });
    }
    function spawnRecord() {
      var r = 14;
      var high = G.rand() < 0.45; // some records need a jump
      G.records.push({
        x: W + 30, y: high ? GROUND_Y - 150 - G.rand() * 60 : GROUND_Y - 30,
        r: r, spin: G.rand() * 6.28
      });
    }

    // ---- physics / rules: G.step(dt) is the testable core ----
    function aabb(a, b) {
      return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    }

    G.step = function (dt) {
      if (G.state !== 'play' || G.paused) { return; }
      if (dt <= 0 || dt > 0.1) { dt = 1 / 60; }
      G.time += dt;
      var ramp = G.night ? 12 : RAMP, maxs = G.night ? 740 : MAX_SPEED;
      if (G.speed < maxs) { G.speed = Math.min(maxs, G.speed + ramp * dt); }
      var dx = G.speed * dt;
      G.dist += dx;
      G.score += dx / 40;

      // player
      var p = G.player;
      p.legT += dt * (6 + G.speed / 60);
      if (!p.onGround) {
        p.vy += GRAV * dt;
        p.y += p.vy * dt;
        if (p.y >= GROUND_Y - PLAYER_H) {
          p.y = GROUND_Y - PLAYER_H; p.vy = 0; p.onGround = true;
        }
      }
      var pbox = { x: PLAYER_X, y: p.y, w: PLAYER_W, h: PLAYER_H };

      // obstacles
      spawnTimer -= dt;
      if (spawnTimer <= 0) {
        spawnObstacle();
        spawnTimer = (G.night ? 0.6 : 0.75) + G.rand() * 0.85 * (BASE_SPEED / G.speed);
      }
      for (var i = G.obstacles.length - 1; i >= 0; i--) {
        var o = G.obstacles[i];
        o.x -= dx;
        if (o.x + o.w < -20) { G.obstacles.splice(i, 1); continue; }
        if (aabb(pbox, o)) { return gameOver(); }
      }

      // records
      recordTimer -= dt;
      if (recordTimer <= 0) { spawnRecord(); recordTimer = 1.6 + G.rand() * 1.6; }
      var pcx = PLAYER_X + PLAYER_W / 2, pcy = p.y + PLAYER_H / 2;
      for (var j = G.records.length - 1; j >= 0; j--) {
        var rc = G.records[j];
        rc.x -= dx; rc.spin += dt * 4;
        if (rc.x < -30) { G.records.splice(j, 1); continue; }
        var ddx = rc.x - pcx, ddy = rc.y - pcy;
        if (ddx * ddx + ddy * ddy < (rc.r + 24) * (rc.r + 24)) {
          G.records.splice(j, 1);
          G.score += G.night ? 20 : 10; // Nights pack: records worth double
          sfx('coin');
        }
      }
    };

    function gameOver() {
      G.state = 'over';
      sfx('crash');
      var s = Math.floor(G.score);
      if (s > G.best) { G.best = s; writeBest(s); }
    }

    // ---- input (guarded) ----
    if (cv.addEventListener) {
      cv.addEventListener('touchstart', function (e) {
        if (e && e.preventDefault) { e.preventDefault(); }
        onPress(toLogical(e));
      }, { passive: false });
      cv.addEventListener('mousedown', function (e) { onPress(toLogical(e)); });
    }
    if (doc.addEventListener) {
      doc.addEventListener('keydown', function (e) {
        if (e && (e.code === 'Space' || e.code === 'ArrowUp')) {
          if (e.preventDefault) { e.preventDefault(); }
          onPress(null);
        }
      });
      doc.addEventListener('visibilitychange', function () {
        G.paused = !!(doc.hidden);
      });
    }
    if (typeof window !== 'undefined' && window && window.addEventListener) {
      window.addEventListener('blur', function () { G.paused = true; });
      window.addEventListener('focus', function () { G.paused = false; });
    }

    // ---- background scenery: East St. Louis riverfront (v1.1) ----
    // Parallax layers, slowest first: the St. Louis skyline + Gateway Arch
    // on the far bank, the Mississippi river band, a cable-stayed bridge,
    // then the East St. Louis near bank — levee, Casino Queen riverboat,
    // Gateway Geyser, ESL water tower, riverfront buildings, streetlights.
    // Gameplay code never touches this; it is pure drawing.
    var FAR_BASE = 500;   // where the far skyline meets the river
    var RIVER_BOT = 562;  // river band bottom / near-bank levee top
    var FAR_PAR = 0.15, BRIDGE_PAR = 0.30, NEAR_PAR = 0.55;

    function initScenery() {
      var i, lx;
      G.stars = [];
      for (i = 0; i < 40; i++) {
        G.stars.push({ x: Math.random() * W, y: Math.random() * (FAR_BASE - 260), s: Math.random() * 1.6 + 0.6 });
      }

      // far bank: downtown St. Louis towers, one repeating segment
      G.farSeg = 980;
      G.farBank = [];
      var fx = 30;
      while (fx < G.farSeg - 80) {
        var tw = 46 + Math.random() * 62;
        var th = 70 + Math.random() * 110;
        G.farBank.push({ x: fx, w: tw, h: th });
        fx += tw + 12 + Math.random() * 28;
      }
      G.archX = G.farSeg / 2; // Gateway Arch, centered in the segment

      // bridge segment length (cable-stayed, Stan Musial style)
      G.bridgeSeg = 800;

      // near bank: East St. Louis landmarks. Landmark x positions are fixed
      // within the segment so nothing overlaps.
      G.nearSeg = 1700;
      G.esl = {
        boat: [140],     // Casino Queen riverboat (hull ~180 wide)
        tower: [700],    // ESL water tower (~80 wide)
        geyser: [1150],  // Gateway Geyser plume (~40 wide at base)
        lights: [15, 560, 1075, 1280, 1665],
        buildings: [
          { x: 30, w: 70, h: 46 }, { x: 340, w: 90, h: 62 }, { x: 380, w: 56, h: 40 },
          { x: 800, w: 110, h: 70 }, { x: 950, w: 70, h: 44 },
          { x: 1300, w: 90, h: 56 }, { x: 1430, w: 120, h: 72 }, { x: 1590, w: 60, h: 38 }
        ]
      };
    }

    // draw fn(ix) for one repeating segment at parallax par
    function eachSeg(x, par, seg, maxW, fn) {
      var d = (G.dist * par) % seg;
      var start = x - d;
      for (var k = -1; k <= 1; k++) {
        var ix = start + k * seg;
        if (ix > -maxW && ix < W) { fn(ix); }
      }
    }

    // ---- drawing ----
    function drawFarTower(t, ix) {
      var y = FAR_BASE - t.h;
      ctx.fillStyle = '#141419';
      ctx.fillRect(ix, y, t.w, t.h);
      ctx.fillStyle = '#3a3418';
      for (var wy = y + 10; wy < FAR_BASE - 8; wy += 20) {
        for (var wx = ix + 8; wx < ix + t.w - 6; wx += 18) {
          if (((wx * 7 + wy * 13) | 0) % 4 === 0) { ctx.fillRect(wx, wy, 6, 8); }
        }
      }
    }

    function drawArch(ix) {
      // Gateway Arch — one smooth parabolic silhouette, gold-outlined.
      var legL = ix, legR = ix + 110;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#d4af37';
      ctx.lineWidth = 13;
      ctx.beginPath();
      ctx.moveTo(legL, FAR_BASE);
      ctx.quadraticCurveTo(ix + 55, 196, legR, FAR_BASE);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,233,138,0.65)';
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.fillStyle = '#d4af37';
      ctx.fillRect(legL - 8, FAR_BASE - 4, 24, 6);
      ctx.fillRect(legR - 8, FAR_BASE - 4, 24, 6);
      ctx.restore();
    }

    function drawRiver() {
      ctx.fillStyle = '#0d1622';
      ctx.fillRect(0, FAR_BASE, W, RIVER_BOT - FAR_BASE);
      // drifting shimmer streaks
      var d = (G.dist * 0.35) % 140;
      ctx.fillStyle = 'rgba(212,175,55,0.18)';
      for (var k = 0; k < 8; k++) {
        var y = FAR_BASE + 9 + k * 7;
        for (var x = -d; x < W; x += 140) {
          ctx.fillRect(x, y, 46 + ((k * 37) % 30), 2);
        }
      }
      // moonlight reflection column under the moon
      ctx.fillStyle = 'rgba(255,233,138,0.12)';
      for (var j = 0; j < 5; j++) {
        ctx.fillRect(W - 92 + (j % 2) * 8, FAR_BASE + 6 + j * 11, 34 - j * 3, 4);
      }
    }

    function drawBridge(ix) {
      var deckY = 530;
      var pylons = [ix + 200, ix + 600];
      for (var p = 0; p < pylons.length; p++) {
        var px = pylons[p];
        ctx.fillStyle = '#20202a';
        ctx.fillRect(px - 6, 402, 12, deckY - 402);
        // cable fan (Stan Musial style)
        ctx.strokeStyle = 'rgba(212,175,55,0.55)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (var c = -4; c <= 4; c++) {
          ctx.moveTo(px, 406);
          ctx.lineTo(px + c * 26, deckY);
        }
        ctx.stroke();
        ctx.fillStyle = '#39ff6a';
        ctx.fillRect(px - 2, 396, 4, 4);
      }
      ctx.fillStyle = '#181820';
      ctx.fillRect(ix, deckY, G.bridgeSeg, 9);
      ctx.fillStyle = 'rgba(212,175,55,0.4)';
      ctx.fillRect(ix, deckY, G.bridgeSeg, 2);
      for (var rx = ix + 20; rx < ix + G.bridgeSeg; rx += 60) {
        ctx.fillRect(rx, deckY - 12, 3, 12);
      }
    }

    function drawLevee() {
      // the East Side bank rising from the riverfront path
      ctx.fillStyle = '#0f0f15';
      ctx.fillRect(0, RIVER_BOT, W, GROUND_Y - RIVER_BOT);
      ctx.fillStyle = 'rgba(212,175,55,0.55)';
      ctx.fillRect(0, RIVER_BOT, W, 2);
      var d = (G.dist * NEAR_PAR) % 60;
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (var x = -d; x < W; x += 60) {
        ctx.moveTo(x, RIVER_BOT + 8);
        ctx.lineTo(x + 22, GROUND_Y - 8);
      }
      ctx.stroke();
    }

    function drawEslBuilding(b, ix) {
      var y = RIVER_BOT - b.h;
      ctx.fillStyle = '#1a1a21';
      ctx.fillRect(ix, y, b.w, b.h);
      ctx.fillStyle = '#d4af37';
      ctx.fillRect(ix, y, b.w, 2);
      ctx.fillStyle = '#3a3418';
      for (var wy = y + 10; wy < RIVER_BOT - 8; wy += 16) {
        for (var wx = ix + 7; wx < ix + b.w - 6; wx += 15) {
          if (((wx * 5 + wy * 11) | 0) % 4 === 0) { ctx.fillRect(wx, wy, 6, 7); }
        }
      }
    }

    function drawStreetlight(ix) {
      ctx.strokeStyle = '#23232c';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(ix, RIVER_BOT);
      ctx.lineTo(ix, RIVER_BOT - 62);
      ctx.lineTo(ix + 16, RIVER_BOT - 62);
      ctx.stroke();
      ctx.save();
      ctx.shadowColor = '#39ff6a'; ctx.shadowBlur = 10;
      ctx.fillStyle = '#39ff6a';
      ctx.beginPath(); ctx.arc(ix + 16, RIVER_BOT - 58, 4, 0, 6.2832); ctx.fill();
      ctx.restore();
    }

    function drawWaterTower(ix) {
      var cx = ix + 40, top = RIVER_BOT, tankY = RIVER_BOT - 92, tankW = 80, tankH = 52;
      ctx.strokeStyle = '#23232c';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(cx - 30, top); ctx.lineTo(cx - 22, tankY + tankH);
      ctx.moveTo(cx + 30, top); ctx.lineTo(cx + 22, tankY + tankH);
      ctx.moveTo(cx - 30, top - 20); ctx.lineTo(cx + 30, top - 20);
      ctx.stroke();
      ctx.fillStyle = '#1d1d25';
      ctx.fillRect(cx - tankW / 2, tankY, tankW, tankH);
      ctx.beginPath();
      ctx.moveTo(cx - tankW / 2 - 4, tankY);
      ctx.lineTo(cx, tankY - 16);
      ctx.lineTo(cx + tankW / 2 + 4, tankY);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#d4af37';
      ctx.fillRect(cx - tankW / 2, tankY + tankH - 3, tankW, 3);
      // the sign
      ctx.fillStyle = '#d4af37';
      ctx.font = 'bold 8px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('EAST ST. LOUIS', cx, tankY + 20);
      ctx.fillText('ILLINOIS', cx, tankY + 31);
    }

    function drawBoat(ix) {
      // Casino Queen — paddlewheel riverboat on the near river edge
      var hullY = RIVER_BOT - 6, bw = 180;
      ctx.fillStyle = '#15151b';
      ctx.beginPath();
      ctx.moveTo(ix, hullY - 22);
      ctx.lineTo(ix + bw - 30, hullY - 22);
      ctx.lineTo(ix + bw, hullY);
      ctx.lineTo(ix, hullY);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(212,175,55,0.6)';
      ctx.fillRect(ix, hullY - 22, bw - 30, 2);
      // deckhouse with lit windows
      ctx.fillStyle = '#1d1d25';
      ctx.fillRect(ix + 18, hullY - 54, 110, 32);
      ctx.fillStyle = '#d4af37';
      for (var wxi = ix + 26; wxi < ix + 118; wxi += 18) {
        ctx.fillRect(wxi, hullY - 46, 10, 10);
      }
      // paddlewheel housing at the stern
      ctx.fillStyle = '#15151b';
      ctx.fillRect(ix + 2, hullY - 48, 14, 42);
      // twin stacks with gold bands
      ctx.fillStyle = '#23232c';
      ctx.fillRect(ix + 44, hullY - 84, 12, 30);
      ctx.fillRect(ix + 72, hullY - 84, 12, 30);
      ctx.fillStyle = '#d4af37';
      ctx.fillRect(ix + 44, hullY - 84, 12, 4);
      ctx.fillRect(ix + 72, hullY - 84, 12, 4);
      // pilot house
      ctx.fillStyle = '#1d1d25';
      ctx.fillRect(ix + 60, hullY - 70, 34, 16);
      ctx.fillStyle = '#d4af37';
      ctx.fillRect(ix + 66, hullY - 66, 22, 8);
    }

    function drawGeyser(ix) {
      // Gateway Geyser — tall fountain plume, the East Side icon
      var base = RIVER_BOT;
      ctx.save();
      ctx.fillStyle = '#1d1d25';
      ctx.beginPath(); ctx.ellipse(ix, base - 4, 30, 8, 0, 0, 6.2832); ctx.fill();
      for (var s = -2; s <= 2; s++) {
        var hgt = 300 - Math.abs(s) * 26;
        var sx = ix + s * 7;
        var gr = null;
        try { gr = ctx.createLinearGradient(0, base, 0, base - hgt); } catch (e) { gr = null; }
        if (gr) {
          gr.addColorStop(0, 'rgba(212,175,55,0.85)');
          gr.addColorStop(1, 'rgba(255,233,138,0.15)');
          ctx.strokeStyle = gr;
        } else { ctx.strokeStyle = 'rgba(212,175,55,0.6)'; }
        ctx.lineWidth = 3 - Math.abs(s) * 0.4;
        ctx.beginPath();
        ctx.moveTo(sx, base - 8);
        ctx.quadraticCurveTo(sx + s * 3, base - hgt * 0.6, sx + s * 9, base - hgt);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,233,138,0.7)';
        for (var dd = 0.25; dd < 1; dd += 0.25) {
          ctx.fillRect(sx + s * 9 * dd - 1.5, base - 8 - hgt * dd, 3, 3);
        }
      }
      ctx.fillStyle = 'rgba(255,233,138,0.12)';
      ctx.beginPath(); ctx.ellipse(ix, base - 300, 44, 14, 0, 0, 6.2832); ctx.fill();
      ctx.restore();
    }

    function drawPlayer() {
      var p = G.player;
      var x = PLAYER_X, y = p.y;
      var run = p.onGround ? Math.sin(p.legT) : 0;
      ctx.save();
      // glow
      ctx.shadowColor = '#d4af37'; ctx.shadowBlur = 14;
      // legs
      ctx.strokeStyle = '#111'; ctx.lineWidth = 8; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x + 17, y + 30);
      ctx.lineTo(x + 17 + run * 9, GROUND_Y - 6);
      ctx.moveTo(x + 17, y + 30);
      ctx.lineTo(x + 17 - run * 9, GROUND_Y - 6);
      ctx.stroke();
      // shoes (neon)
      ctx.fillStyle = '#39ff6a';
      ctx.fillRect(x + 10 + run * 9, GROUND_Y - 12, 14, 8);
      ctx.fillRect(x + 10 - run * 9, GROUND_Y - 12, 14, 8);
      // body
      ctx.fillStyle = '#0d0d10';
      ctx.fillRect(x + 9, y + 12, 16, 22);
      // gold chain
      ctx.strokeStyle = '#d4af37'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x + 11, y + 14); ctx.lineTo(x + 23, y + 24); ctx.stroke();
      // arms
      ctx.strokeStyle = '#0d0d10'; ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(x + 17, y + 16);
      ctx.lineTo(x + 17 - run * 8, y + 30);
      ctx.moveTo(x + 17, y + 16);
      ctx.lineTo(x + 17 + run * 8, y + 30);
      ctx.stroke();
      // head
      ctx.fillStyle = '#0d0d10';
      ctx.beginPath(); ctx.arc(x + 17, y + 6, 8, 0, 6.2832); ctx.fill();
      // gold headband
      ctx.fillStyle = '#d4af37';
      ctx.fillRect(x + 9, y + 2, 16, 4);
      ctx.restore();
    }

    function drawObstacle(o) {
      if (o.kind === 'crate') {
        ctx.fillStyle = '#5a3a1e';
        ctx.fillRect(o.x, o.y, o.w, o.h);
        ctx.strokeStyle = '#2e1d0e'; ctx.lineWidth = 3;
        ctx.strokeRect(o.x + 1.5, o.y + 1.5, o.w - 3, o.h - 3);
        ctx.beginPath();
        ctx.moveTo(o.x, o.y); ctx.lineTo(o.x + o.w, o.y + o.h);
        ctx.moveTo(o.x + o.w, o.y); ctx.lineTo(o.x, o.y + o.h);
        ctx.stroke();
      } else if (o.kind === 'barrier') {
        ctx.fillStyle = '#8a1f1f';
        ctx.fillRect(o.x, o.y, o.w, o.h);
        ctx.fillStyle = '#f5f5f5';
        for (var sx = o.x + 4; sx < o.x + o.w - 8; sx += 16) {
          ctx.fillRect(sx, o.y + 4, 10, o.h - 8);
        }
        ctx.fillStyle = '#333';
        ctx.fillRect(o.x + 4, o.y + o.h, 6, GROUND_Y - (o.y + o.h));
        ctx.fillRect(o.x + o.w - 10, o.y + o.h, 6, GROUND_Y - (o.y + o.h));
      } else { // cone
        ctx.fillStyle = '#e8641e';
        ctx.beginPath();
        ctx.moveTo(o.x + o.w / 2, o.y);
        ctx.lineTo(o.x + o.w, o.y + o.h);
        ctx.lineTo(o.x, o.y + o.h);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillRect(o.x + 6, o.y + o.h * 0.55, o.w - 12, 6);
        ctx.fillStyle = '#333';
        ctx.fillRect(o.x - 3, o.y + o.h - 5, o.w + 6, 5);
      }
    }

    function drawRecord(r) {
      ctx.save();
      ctx.translate(r.x, r.y);
      ctx.rotate(r.spin * 0.15);
      // gold vinyl
      var g = null;
      try { g = ctx.createRadialGradient(0, 0, 2, 0, 0, r.r); } catch (e) { g = null; }
      if (g) {
        g.addColorStop(0, '#ffe98a'); g.addColorStop(0.55, '#d4af37'); g.addColorStop(1, '#8a6a1c');
        ctx.fillStyle = g;
      } else { ctx.fillStyle = '#d4af37'; }
      ctx.shadowColor = '#d4af37'; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(0, 0, r.r, 0, 6.2832); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, 0, r.r * 0.66, 0, 6.2832); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, r.r * 0.38, 0, 6.2832); ctx.stroke();
      ctx.fillStyle = '#111';
      ctx.beginPath(); ctx.arc(0, 0, 3.5, 0, 6.2832); ctx.fill();
      ctx.restore();
    }

    function drawScreen() {
      var TH = G.night ? NIGHT_TH : DAY_TH;
      // sky
      ctx.fillStyle = TH.sky;
      ctx.fillRect(0, 0, W, H);
      var i;
      ctx.fillStyle = '#ffffff';
      for (i = 0; i < G.stars.length; i++) {
        var s = G.stars[i];
        ctx.globalAlpha = 0.35 + 0.4 * ((s.s * 7) % 1);
        ctx.fillRect(s.x, s.y, s.s, s.s);
      }
      ctx.globalAlpha = 1;
      // moon (gold by day, neon purple by night)
      ctx.fillStyle = TH.moon;
      ctx.beginPath(); ctx.arc(W - 70, 90, 34, 0, 6.2832); ctx.fill();
      ctx.fillStyle = TH.moonCut;
      ctx.beginPath(); ctx.arc(W - 58, 80, 30, 0, 6.2832); ctx.fill();
      // --- far bank: St. Louis skyline + Gateway Arch across the Mississippi
      for (i = 0; i < G.farBank.length; i++) {
        var t = G.farBank[i];
        eachSeg(t.x, FAR_PAR, G.farSeg, t.w + 10, function (ix) { drawFarTower(t, ix); });
      }
      eachSeg(G.archX, FAR_PAR, G.farSeg, 160, drawArch);
      // --- the Mississippi ---
      drawRiver();
      // --- cable-stayed bridge crossing the river (Stan Musial style) ---
      eachSeg(0, BRIDGE_PAR, G.bridgeSeg, G.bridgeSeg, drawBridge);
      // --- Casino Queen riverboat on the near river edge ---
      for (i = 0; i < G.esl.boat.length; i++) {
        eachSeg(G.esl.boat[i], NEAR_PAR, G.nearSeg, 200, drawBoat);
      }
      // --- the East St. Louis bank: levee, buildings, lights, landmarks ---
      drawLevee();
      for (i = 0; i < G.esl.buildings.length; i++) {
        var eb = G.esl.buildings[i];
        eachSeg(eb.x, NEAR_PAR, G.nearSeg, eb.w + 10, function (ix) { drawEslBuilding(eb, ix); });
      }
      for (i = 0; i < G.esl.lights.length; i++) {
        eachSeg(G.esl.lights[i], NEAR_PAR, G.nearSeg, 40, drawStreetlight);
      }
      for (i = 0; i < G.esl.tower.length; i++) {
        eachSeg(G.esl.tower[i], NEAR_PAR, G.nearSeg, 100, drawWaterTower);
      }
      for (i = 0; i < G.esl.geyser.length; i++) {
        eachSeg(G.esl.geyser[i], NEAR_PAR, G.nearSeg, 100, drawGeyser);
      }
      if (G.night) {
        // night tint over the day-colored scenery, then a neon moon on top
        ctx.fillStyle = 'rgba(6,6,30,0.52)';
        ctx.fillRect(0, 0, W, GROUND_Y);
        ctx.save();
        ctx.shadowColor = '#b44fff'; ctx.shadowBlur = 30;
        ctx.fillStyle = '#c77dff';
        ctx.beginPath(); ctx.arc(W - 70, 90, 30, 0, 6.2832); ctx.fill();
        ctx.restore();
      }
      // ground
      ctx.fillStyle = TH.ground;
      ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
      ctx.fillStyle = TH.stripe;
      ctx.fillRect(0, GROUND_Y, W, 4);
      // neon lane dashes scroll with distance
      ctx.fillStyle = TH.lane;
      var off = -(G.dist % 90);
      for (var dx = off; dx < W; dx += 90) {
        ctx.fillRect(dx, GROUND_Y + 52, 44, 5);
      }
      // records + obstacles + player
      for (i = 0; i < G.records.length; i++) { drawRecord(G.records[i]); }
      for (i = 0; i < G.obstacles.length; i++) { drawObstacle(G.obstacles[i]); }
      drawPlayer();
      // HUD
      ctx.fillStyle = '#d4af37';
      ctx.font = 'bold 26px Arial, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(String(Math.floor(G.score)), 14, 36);
      ctx.font = '13px Arial, sans-serif';
      ctx.fillStyle = '#8f8f9a';
      ctx.fillText('BEST ' + G.best, 14, 56);
      if (G.night) {
        ctx.textAlign = 'right';
        ctx.fillStyle = '#c77dff';
        ctx.font = 'bold 15px Arial, sans-serif';
        ctx.fillText('🌙 NIGHTS', W - 14, 36);
        ctx.textAlign = 'left';
      }

      if (G.state === 'ready') { drawTitle(); }
      else if (G.state === 'over') { drawGameOver(); }
    }

    function drawTitle() {
      ctx.fillStyle = 'rgba(5,5,8,0.72)';
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#d4af37';
      ctx.font = 'bold 44px Arial, sans-serif';
      ctx.shadowColor = '#d4af37'; ctx.shadowBlur = 18;
      ctx.fillText('EAST SIDE', W / 2, 250);
      ctx.fillText('DASH', W / 2, 300);
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#f5f5f5';
      ctx.font = '16px Arial, sans-serif';
      ctx.fillText('A EAST SIDE SIT DOWN', W / 2, 332);
      ctx.fillStyle = '#d4af37';
      ctx.font = '13px Arial, sans-serif';
      ctx.fillText('EAST ST. LOUIS, ILLINOIS', W / 2, 356);
      ctx.font = 'bold 15px Arial, sans-serif';
      ctx.fillText('★ EXCLUSIVE ★', W / 2, 382);
      ctx.fillStyle = '#ffffff';
      ctx.font = '20px Arial, sans-serif';
      var pulse = 0.6 + 0.4 * Math.sin(G.time * 5);
      ctx.globalAlpha = pulse;
      ctx.fillText('TAP TO START', W / 2, 470);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#8f8f9a';
      ctx.font = '14px Arial, sans-serif';
      ctx.fillText('Tap / click / spacebar to jump.', W / 2, 510);
      ctx.fillText('Dodge crates. Grab gold records.', W / 2, 532);
      drawButtons();
    }

    function drawButtons() {
      ctx.textAlign = 'center';
      for (var i = 0; i < BTNS.length; i++) {
        var b = BTNS[i];
        ctx.fillStyle = 'rgba(10,10,16,0.88)';
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.strokeStyle = '#d4af37'; ctx.lineWidth = 2;
        ctx.strokeRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2);
        ctx.fillStyle = '#ffe98a';
        ctx.font = 'bold 15px Arial, sans-serif';
        ctx.fillText(btnLabel(b), b.x + b.w / 2, b.y + 30);
      }
      ctx.fillStyle = '#8f8f9a';
      ctx.font = '12px Arial, sans-serif';
      ctx.fillText('FREE GAME · NIGHTS PACK $0.99 · TIPS GO TO THE ARTIST', W / 2, 668);
    }

    function drawGameOver() {
      ctx.fillStyle = 'rgba(5,5,8,0.72)';
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#e04040';
      ctx.font = 'bold 40px Arial, sans-serif';
      ctx.fillText('WIPED OUT', W / 2, 280);
      ctx.fillStyle = '#d4af37';
      ctx.font = 'bold 30px Arial, sans-serif';
      ctx.fillText('SCORE ' + Math.floor(G.score), W / 2, 340);
      ctx.fillStyle = '#f5f5f5';
      ctx.font = '18px Arial, sans-serif';
      var isBest = Math.floor(G.score) >= G.best && G.score > 0;
      ctx.fillText('BEST ' + G.best + (isBest ? '  ★ NEW!' : ''), W / 2, 372);
      ctx.fillStyle = '#ffffff';
      ctx.font = '20px Arial, sans-serif';
      var pulse = 0.6 + 0.4 * Math.sin(G.time * 5);
      ctx.globalAlpha = pulse;
      ctx.fillText('TAP TO RUN IT BACK', W / 2, 470);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#8f8f9a';
      ctx.font = '13px Arial, sans-serif';
      ctx.fillText('💸 TIP + 🎵 MUSIC live on the title screen', W / 2, 520);
    }

    // ---- main loop ----
    var lastT = 0;
    function frame(t) {
      var now = (typeof t === 'number') ? t : 0;
      var dt = lastT ? Math.min((now - lastT) / 1000, 0.05) : 1 / 60;
      lastT = now;
      if (!G.paused) {
        if (G.state === 'play') { G.step(dt); }
        else { G.time += dt; }
        drawScreen();
      }
      if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(frame);
      }
    }

    // expose internals for the headless test harness (harmless in production)
    G.doJump = doJump;
    G.press = onPress;
    G.tapAt = function (x, y) { onPress({ x: x, y: y }); }; // logical 420x740 coords
    G.buttonAction = buttonAction;
    G.uiShow = uiShow; G.uiHide = uiHide;
    G.reset = reset;
    G._draw = drawScreen;
    G.GRAV = GRAV; G.JUMP_V = JUMP_V;
    G.PLAYER_X = PLAYER_X; G.PLAYER_W = PLAYER_W; G.PLAYER_H = PLAYER_H;
    G.GROUND_Y = GROUND_Y; G.BASE_SPEED = BASE_SPEED; G.W = W; G.H = H;
    if (typeof window !== 'undefined' && window) { window.EastSideDashGame = G; }

    // v1.1 overlay panel wiring — every lookup null-guarded, safe headless
    onTap('packback', uiHide);
    onTap('tipback', uiHide);
    onTap('musicback', uiHide);
    onTap('btnunlock', tryUnlock);
    onTap('btncopypack', function () { copyCashtag('packmsg', '✓ $cashtag copied — paste it in Cash App.'); });
    onTap('btncopytip', function () { copyCashtag('tipmsg', '✓ Copied — send any amount in Cash App.'); });

    initScenery();
    drawScreen();
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(function (t) { lastT = 0; frame(t); });
    }
  }
})();
