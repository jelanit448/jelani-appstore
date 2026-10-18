'use strict';
/**
 * server.js — Jelani's App Store backend.
 *
 * A real shared backend (Express + SQLite): every upload, download, review,
 * and money movement is stored server-side, so all users see the same data.
 * That is the fix for the "uploads and money won't sync between people"
 * problem of link-shared demo pages.
 *
 * Past ViralMode problems fixed here (see PROBLEMS_FIXED.md):
 *  - Owner lockout        -> explicit role column + requireRole('owner')
 *  - Ticket value conflict-> lib/money.js is the only definition of value
 *  - Fake money           -> DEMO labels everywhere, Stripe stub, KYC gate
 *  - No refunds/fraud     -> /api/refund + rate limits + full ledger
 *  - Legal not retroactive-> TERMS_VERSION gate on EVERY authed request
 *  - Empty copyright vault-> copyright_attested required on every upload
 *  - 54MB upload failures -> chunked/resumable uploads (2GB cap)
 */

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const { initDb, txn, TERMS_VERSION } = require('./lib/db');
const money = require('./lib/money');
const stripe = require('./lib/stripe');
const paypal = require('./lib/paypal');

const PORT = process.env.PORT || 3000;
// Owner's Cash App $cashtag for manual payments (no Stripe/ID needed).
// Override with the CASHAPP_CASHTAG env var on Render if it ever changes.
const CASHAPP_CASHTAG = process.env.CASHAPP_CASHTAG || '$JelaniThompson2';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me-in-production';
if (!process.env.SESSION_SECRET) {
  console.warn('[warn] SESSION_SECRET not set — using dev default. Set it in production.');
}

const ROOT = __dirname;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, 'uploads');
const TMP_DIR = path.join(ROOT, 'data', 'tmp');
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB suggested client chunk
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

const db = initDb();

// PayPal reads its owner-saved keys from the settings table (env vars win
// when set). The secret is never returned to any client.
paypal.bindSettingsReader((key) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : '';
});

const app = express();
app.set('trust proxy', 1);
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 },
  })
);
// Stripe webhook: needs the RAW body for signature verification, so it is
// mounted here with express.raw() BEFORE the global JSON parser (which would
// otherwise consume the raw bytes and break signature checks). It also has
// no session (Stripe calls it), so it is in TERMS_ALLOWLIST below.
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.constructEvent(req.body, sig);
  } catch (e) {
    return res.status(400).json({ error: 'Bad webhook signature.' });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const meta = session.metadata || {};
      if (meta.kind !== 'app_purchase') return res.json({ ok: true, ignored: true });
      const row = db.prepare('SELECT * FROM stripe_sessions WHERE session_id = ?').get(session.id);
      if (!row) return res.json({ ok: true, ignored: true }); // unknown session
      if (row.status === 'completed') return res.json({ ok: true, duplicate: true }); // idempotent retry

      const appRow = db.prepare('SELECT * FROM apps WHERE id = ?').get(row.app_id);
      if (!appRow || appRow.status !== 'approved' || appRow.price_cents !== row.amount_cents) {
        return res.json({ ok: true, ignored: true }); // price/app changed mid-checkout — no charge recorded
      }
      const { developer, platform } = money.split(row.amount_cents);
      const piId = typeof session.payment_intent === 'string' ? session.payment_intent : session.id;
      const note = `Stripe payment ${piId} — real money`;
      const tx = txn(db, () => {
        const li = db.prepare(
          `INSERT INTO ledger (type, app_id, buyer_id, developer_id, gross_cents, fee_cents, net_cents, note)
           VALUES ('purchase',?,?,?,?,?,?,?)`
        ).run(row.app_id, row.buyer_id, appRow.developer_id, row.amount_cents, platform, developer, note);
        db.prepare('INSERT OR IGNORE INTO purchases (app_id, buyer_id, ledger_id) VALUES (?,?,?)')
          .run(row.app_id, row.buyer_id, li.lastInsertRowid);
        db.prepare(`UPDATE stripe_sessions SET status = 'completed', payment_intent = COALESCE(payment_intent, ?), ledger_id = ? WHERE id = ?`)
          .run(typeof session.payment_intent === 'string' ? session.payment_intent : null, li.lastInsertRowid, row.id);
        return li.lastInsertRowid;
      });
      return res.json({ ok: true, ledger_id: tx });
    }

    if (event.type === 'charge.refunded') {
      const charge = event.data.object;
      const pi = charge.payment_intent;
      const row = pi && db.prepare(
        `SELECT * FROM stripe_sessions WHERE payment_intent = ? AND status = 'completed'`
      ).get(typeof pi === 'string' ? pi : pi.id);
      if (row && row.ledger_id) {
        const prow = db.prepare(`SELECT * FROM ledger WHERE id = ? AND type = 'purchase'`).get(row.ledger_id);
        if (prow) {
          txn(db, () => {
            db.prepare(
              `INSERT INTO ledger (type, app_id, buyer_id, developer_id, gross_cents, fee_cents, net_cents, note)
               VALUES ('refund',?,?,?,?,?,?,?)`
            ).run(prow.app_id, prow.buyer_id, prow.developer_id,
              -prow.gross_cents, -prow.fee_cents, -prow.net_cents,
              `Stripe refund of ledger #${prow.id}`);
            db.prepare('DELETE FROM purchases WHERE ledger_id = ?').run(prow.id);
            db.prepare(`UPDATE stripe_sessions SET status = 'refunded' WHERE id = ?`).run(row.id);
          });
        }
      }
      return res.json({ ok: true });
    }

    return res.json({ ok: true, ignored: true });
  } catch (e) {
    console.error('[stripe-webhook]', e.message);
    return res.status(500).json({ error: 'Webhook handler failed.' });
  }
});

app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const q = {
  userById: db.prepare('SELECT id, username, email, role, birthdate, terms_version_accepted, must_change_password, kyc_status FROM users WHERE id = ?'),
  userByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  appById: db.prepare('SELECT a.*, u.username AS developer_name FROM apps a JOIN users u ON u.id = a.developer_id WHERE a.id = ?'),
};

function publicUser(u) {
  return { id: u.id, username: u.username, email: u.email, role: u.role, kyc_status: u.kyc_status };
}

function ageOn(birthdate) {
  const b = new Date(birthdate + 'T00:00:00Z');
  if (Number.isNaN(b.getTime())) return -1;
  const now = new Date();
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const m = now.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

function validUsername(v) { return typeof v === 'string' && /^[a-zA-Z0-9_]{3,20}$/.test(v); }
function validEmail(v) { return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
// node:sqlite throws when binding undefined/null, so validate IDs up front.
function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Base URL for Stripe redirect URLs. Set PUBLIC_URL in production;
// falls back to the request host (works on Render out of the box).
function publicUrl(req) {
  const base = (process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '');
  return base;
}
function safeFileName(v) {
  const base = path.basename(String(v || 'file')).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.slice(0, 120) || 'file';
}

// --- tiny in-memory rate limiter (per key) ---
const buckets = new Map();
function rateLimit({ windowMs, max, key }) {
  return (req, res, next) => {
    const k = `${key}:${typeof key === 'function' ? '' : ''}` + (req.ip + ':' + (req.session.userId || '-'));
    const now = Date.now();
    let b = buckets.get(k);
    if (!b || now > b.reset) b = { count: 0, reset: now + windowMs };
    b.count++;
    buckets.set(k, b);
    if (b.count > max) return res.status(429).json({ error: 'Too many requests — slow down.' });
    next();
  };
}

// ---------------------------------------------------------------------------
// auth + terms middleware
// ---------------------------------------------------------------------------
function loadUser(req, res, next) {
  req.user = null;
  if (req.session.userId) {
    req.user = q.userById.get(req.session.userId) || null;
    if (!req.user) delete req.session.userId;
  }
  next();
}
app.use(loadUser);

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
    // Explicit server-side role check on every protected route — the fix for
    // the old "Owner Mode is restricted to the app owner" lockout, where the
    // client guessed ownership from flags that came back false.
    if (req.user.role !== role) {
      return res.status(403).json({ error: `Requires ${role} role.` });
    }
    next();
  };
}

// Retroactive legal gate: EVERY authenticated request (except the allowlist)
// is blocked until the account accepts the current Terms version — including
// accounts created before the Terms existed. This fixes the old build, which
// never forced existing accounts through new legal screens.
const TERMS_ALLOWLIST = new Set([
  '/api/me', '/api/accept-terms', '/api/logout', '/api/config',
  '/api/change-password', '/api/webhook/stripe',
]);
function requireTermsFresh(req, res, next) {
  if (!req.user) return next();
  if (req.path.startsWith('/api/') && !TERMS_ALLOWLIST.has(req.path)) {
    if (req.user.terms_version_accepted !== TERMS_VERSION) {
      return res.status(403).json({ error: 'TERMS_UPDATE_REQUIRED', termsVersion: TERMS_VERSION });
    }
  }
  next();
}
app.use(requireTermsFresh);

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.json({
    demoMode: !stripe.live,
    demoBanner: money.DEMO_BANNER,
    stripeConfigured: stripe.configured,
    stripeLive: stripe.live,
    paypalConfigured: paypal.configured(),
    termsVersion: TERMS_VERSION,
    platformFeeBps: money.PLATFORM_FEE_BPS,
    maxUploadBytes: MAX_FILE_BYTES,
    chunkSize: CHUNK_SIZE,
  });
});

app.get('/api/categories', (req, res) => {
  const rows = db.prepare(
    "SELECT DISTINCT category FROM apps WHERE status = 'approved' ORDER BY category"
  ).all();
  res.json({ categories: rows.map((r) => r.category) });
});

app.get('/api/apps', (req, res) => {
  const { search = '', category = '' } = req.query;
  let status = 'approved';
  // Owners may preview the moderation queue; everyone else sees approved only.
  if (req.user && req.user.role === 'owner' && req.query.status === 'all') status = 'all';
  let sql = `SELECT a.id, a.name, a.description, a.category, a.version, a.price_cents,
             a.status, a.download_count, a.created_at, u.username AS developer_name,
             (SELECT AVG(rating) FROM reviews r WHERE r.app_id = a.id) AS avg_rating,
             (SELECT COUNT(*) FROM reviews r WHERE r.app_id = a.id) AS review_count
             FROM apps a JOIN users u ON u.id = a.developer_id`;
  const where = [];
  const params = [];
  if (status !== 'all') { where.push("a.status = 'approved'"); }
  if (search) { where.push('(a.name LIKE ? OR a.description LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  if (category) { where.push('a.category = ?'); params.push(category); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY a.download_count DESC, a.created_at DESC LIMIT 200';
  res.json({ apps: db.prepare(sql).all(...params) });
});

app.get('/api/apps/:id', (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(404).json({ error: 'App not found.' });
  const appRow = q.appById.get(id);
  if (!appRow) return res.status(404).json({ error: 'App not found.' });
  const isOwner = req.user && req.user.role === 'owner';
  const isDev = req.user && req.user.id === appRow.developer_id;
  if (appRow.status !== 'approved' && !isOwner && !isDev) {
    return res.status(404).json({ error: 'App not found.' });
  }
  const shots = db.prepare('SELECT id, file_path FROM screenshots WHERE app_id = ?').all(appRow.id);
  const reviews = db.prepare(
    `SELECT r.rating, r.text, r.created_at, u.username FROM reviews r
     JOIN users u ON u.id = r.user_id WHERE r.app_id = ? ORDER BY r.created_at DESC LIMIT 50`
  ).all(appRow.id);
  const avg = db.prepare('SELECT AVG(rating) AS avg, COUNT(*) AS n FROM reviews WHERE app_id = ?').get(appRow.id);
  let owned = false;
  if (req.user) {
    owned = appRow.price_cents === 0 || !!db.prepare(
      'SELECT id FROM purchases WHERE app_id = ? AND buyer_id = ?'
    ).get(appRow.id, req.user.id);
  }
  const { file_path, ...safe } = appRow; // never leak server paths
  res.json({
    app: { ...safe, avg_rating: avg.avg, review_count: avg.n, owned },
    screenshots: shots.map((s) => `/api/screenshots/${s.id}`),
    reviews,
    demoBanner: money.DEMO_BANNER,
  });
});

// Serves the uploaded icon when one exists, else falls back to the
// deterministic letter-icon so listings look alive without uploads.
app.get('/api/apps/:id/icon', (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(404).send('not found');
  const appRow = db.prepare('SELECT name, icon_path FROM apps WHERE id = ?').get(id);
  if (!appRow) return res.status(404).send('not found');
  if (appRow.icon_path && fs.existsSync(appRow.icon_path)) {
    return res.sendFile(path.resolve(appRow.icon_path));
  }
  let h = 0;
  for (const c of appRow.name) h = (h * 31 + c.charCodeAt(0)) % 360;
  const letter = (appRow.name[0] || '?').toUpperCase();
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">` +
    `<rect width="128" height="128" rx="24" fill="hsl(${h},65%,42%)"/>` +
    `<text x="64" y="86" font-family="sans-serif" font-size="64" fill="white" text-anchor="middle">${letter}</text></svg>`;
  res.type('image/svg+xml').send(svg);
});

// Owner-only: set the listing icon from a completed chunked upload
// (kind 'icon'). Replaces any previous icon file.
app.post('/api/owner/apps/:id/icon', requireRole('owner'), (req, res) => {
  const { upload_id } = req.body || {};
  const meta = readMeta(upload_id);
  if (!meta || meta.user_id !== req.user.id || meta.kind !== 'icon') {
    return res.status(404).json({ error: 'Icon upload not found.' });
  }
  if (meta.received_bytes !== meta.size_bytes) {
    return res.status(400).json({ error: `Incomplete upload: ${meta.received_bytes}/${meta.size_bytes} bytes.` });
  }
  const id = toId(req.params.id);
  const appRow = id ? q.appById.get(id) : null;
  if (!appRow) return res.status(404).json({ error: 'App not found.' });
  const finalName = `icon-${appRow.id}-${Date.now()}${path.extname(meta.filename) || '.png'}`;
  const finalPath = path.join(UPLOAD_DIR, finalName);
  fs.renameSync(uploadPart(upload_id), finalPath);
  fs.unlinkSync(uploadMeta(upload_id));
  const oldIcon = appRow.icon_path;
  db.prepare('UPDATE apps SET icon_path = ? WHERE id = ?').run(finalPath, appRow.id);
  if (oldIcon && oldIcon !== finalPath) {
    try { if (fs.existsSync(oldIcon)) fs.unlinkSync(oldIcon); } catch { /* best effort */ }
  }
  res.json({ ok: true, app_id: appRow.id, icon: `/api/apps/${appRow.id}/icon` });
});

app.get('/api/screenshots/:id', (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(404).send('not found');
  const s = db.prepare(
    `SELECT s.file_path FROM screenshots s JOIN apps a ON a.id = s.app_id WHERE s.id = ?`
  ).get(id);
  if (!s || !fs.existsSync(s.file_path)) return res.status(404).send('not found');
  res.sendFile(s.file_path);
});

// Download: streams the package and bumps the shared counter.
app.get('/api/apps/:id/download', (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(404).json({ error: 'App not found.' });
  const appRow = q.appById.get(id);
  const isOwner = req.user && req.user.role === 'owner';
  if (!appRow || (appRow.status !== 'approved' && !isOwner)) {
    return res.status(404).json({ error: 'App not found.' });
  }
  if (!appRow.file_path || !fs.existsSync(appRow.file_path)) {
    return res.status(410).json({ error: 'Package file missing — developer must re-upload.' });
  }
  if (appRow.price_cents > 0) {
    const entitled = req.user && db.prepare(
      'SELECT id FROM purchases WHERE app_id = ? AND buyer_id = ?'
    ).get(appRow.id, req.user.id);
    if (!entitled && !isOwner && !(req.user && req.user.id === appRow.developer_id)) {
      return res.status(402).json({ error: 'Purchase required before download.' });
    }
  }
  db.prepare('UPDATE apps SET download_count = download_count + 1 WHERE id = ?').run(appRow.id);
  res.download(appRow.file_path, `${safeFileName(appRow.name)}-${appRow.version}.apk`);
});

// ---------------------------------------------------------------------------
// auth API
// ---------------------------------------------------------------------------
app.post('/api/signup', rateLimit({ windowMs: 60_000, max: 10 }), (req, res) => {
  const { username, email, password, birthdate, accept_terms } = req.body || {};
  if (!validUsername(username)) return res.status(400).json({ error: 'Username: 3–20 letters, numbers, underscores.' });
  if (!validEmail(email)) return res.status(400).json({ error: 'Valid email required.' });
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  const age = ageOn(birthdate);
  if (age < 0) return res.status(400).json({ error: 'Birthdate required (YYYY-MM-DD).' });
  if (age < 13) return res.status(400).json({ error: 'You must be 13 or older to sign up.' });
  if (accept_terms !== true) return res.status(400).json({ error: 'You must accept the Terms of Service and Privacy Policy.' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare(
      `INSERT INTO users (username, email, password_hash, role, birthdate, terms_version_accepted)
       VALUES (?,?,?,'user',?,?)`
    ).run(username, email, hash, birthdate, TERMS_VERSION);
    req.session.userId = info.lastInsertRowid;
    res.json({ ok: true, user: publicUser(q.userById.get(info.lastInsertRowid)) });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username or email already taken.' });
    }
    throw e;
  }
});

app.post('/api/login', rateLimit({ windowMs: 60_000, max: 15 }), (req, res) => {
  const { username, password } = req.body || {};
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!row || !bcrypt.compareSync(password || '', row.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  req.session.userId = row.id;
  const user = q.userById.get(row.id);
  res.json({
    ok: true,
    user: publicUser(user),
    must_accept_terms: user.terms_version_accepted !== TERMS_VERSION,
    must_change_password: user.must_change_password === 1,
    termsVersion: TERMS_VERSION,
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({
    user: publicUser(req.user),
    must_accept_terms: req.user.terms_version_accepted !== TERMS_VERSION,
    must_change_password: req.user.must_change_password === 1,
    termsVersion: TERMS_VERSION,
  });
});

app.post('/api/accept-terms', requireAuth, (req, res) => {
  if (req.body.accept !== true) return res.status(400).json({ error: 'You must accept to continue.' });
  db.prepare('UPDATE users SET terms_version_accepted = ? WHERE id = ?').run(TERMS_VERSION, req.user.id);
  res.json({ ok: true, termsVersion: TERMS_VERSION });
});

app.post('/api/change-password', requireAuth, (req, res) => {
  const { current, next } = req.body || {};
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current || '', row.password_hash)) {
    return res.status(401).json({ error: 'Current password is wrong.' });
  }
  if (typeof next !== 'string' || next.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(bcrypt.hashSync(next, 10), req.user.id);
  res.json({ ok: true });
});

// Developers are just users who upload; promote via owner or self-serve here.
app.post('/api/become-developer', requireAuth, (req, res) => {
  if (req.user.role === 'owner') return res.json({ ok: true, role: 'owner' });
  db.prepare("UPDATE users SET role = 'developer' WHERE id = ?").run(req.user.id);
  res.json({ ok: true, role: 'developer' });
});

// ---------------------------------------------------------------------------
// chunked / resumable uploads (fixes old 54MB single-shot failures)
// ---------------------------------------------------------------------------
const uploadMeta = (id) => path.join(TMP_DIR, id + '.json');
const uploadPart = (id) => path.join(TMP_DIR, id + '.part');

function readMeta(id) {
  const p = uploadMeta(id);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

app.post('/api/upload/init', requireAuth, (req, res) => {
  if (!['owner', 'developer'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only developers can upload. Use "Become a developer" first.' });
  }
  const { filename, size_bytes, kind } = req.body || {};
  const size = Number(size_bytes);
  if (!filename || !Number.isInteger(size) || size <= 0 || size > MAX_FILE_BYTES) {
    return res.status(400).json({ error: `size_bytes must be 1–${MAX_FILE_BYTES}.` });
  }
  if (!['appfile', 'screenshot', 'icon'].includes(kind)) {
    return res.status(400).json({ error: "kind must be 'appfile', 'screenshot', or 'icon'." });
  }
  const id = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(uploadPart(id), Buffer.alloc(0));
  fs.writeFileSync(uploadMeta(id), JSON.stringify({
    id, kind, filename: safeFileName(filename), size_bytes: size,
    received_bytes: 0, next_index: 0, user_id: req.user.id, created_at: Date.now(),
  }));
  res.json({ upload_id: id, chunk_size: CHUNK_SIZE });
});

// Raw binary chunk. Clients send chunks IN ORDER; the server enforces the
// sequence so an interrupted upload can resume from next_index.
// The type function always returns true so chunks parse even when the client
// omits the Content-Type header (some fetch implementations do).
app.post('/api/upload/chunk', requireAuth, express.raw({ type: () => true, limit: '12mb' }), (req, res) => {
  const { upload_id, index } = req.query;
  const idx = Number(index);
  const meta = readMeta(upload_id);
  if (!meta || meta.user_id !== req.user.id) return res.status(404).json({ error: 'Upload not found.' });
  if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'Bad chunk index.' });
  if (idx < meta.next_index) {
    return res.json({ ok: true, resumed: true, received_bytes: meta.received_bytes, next_index: meta.next_index });
  }
  if (idx > meta.next_index) {
    return res.status(409).json({ error: 'Out-of-order chunk.', next_index: meta.next_index });
  }
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: 'Empty chunk.' });
  if (meta.received_bytes + buf.length > meta.size_bytes) {
    return res.status(400).json({ error: 'Chunk would exceed declared size.' });
  }
  fs.appendFileSync(uploadPart(upload_id), buf);
  meta.received_bytes += buf.length;
  meta.next_index += 1;
  fs.writeFileSync(uploadMeta(upload_id), JSON.stringify(meta));
  res.json({ ok: true, received_bytes: meta.received_bytes, next_index: meta.next_index });
});

app.post('/api/upload/complete', requireAuth, (req, res) => {
  if (!['owner', 'developer'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only developers can upload.' });
  }
  const { upload_id, name, description, category, version, price_cents, copyright_attested, screenshot_upload_ids } = req.body || {};

  // Copyright/DMCA attestation is REQUIRED — fixes the old empty Copyright Vault.
  if (copyright_attested !== true) {
    return res.status(400).json({ error: 'Copyright attestation required: confirm you own the rights or have a license.' });
  }
  const meta = readMeta(upload_id);
  if (!meta || meta.user_id !== req.user.id || meta.kind !== 'appfile') {
    return res.status(404).json({ error: 'Upload not found.' });
  }
  if (meta.received_bytes !== meta.size_bytes) {
    return res.status(400).json({ error: `Incomplete upload: ${meta.received_bytes}/${meta.size_bytes} bytes.` });
  }
  if (!name || String(name).trim().length < 2) return res.status(400).json({ error: 'App name required.' });
  const price = Number(price_cents || 0);
  if (!Number.isInteger(price) || price < 0) return res.status(400).json({ error: 'price_cents must be a non-negative integer.' });

  const finalName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${meta.filename}`;
  const finalPath = path.join(UPLOAD_DIR, finalName);
  fs.renameSync(uploadPart(upload_id), finalPath);
  fs.unlinkSync(uploadMeta(upload_id));

  const info = db.prepare(
    `INSERT INTO apps (name, developer_id, description, category, version, price_cents,
      file_path, file_size, status, copyright_attested)
     VALUES (?,?,?,?,?,?,?,?,'pending',1)`
  ).run(
    String(name).trim(), req.user.id, String(description || '').slice(0, 8000),
    String(category || 'Tools').slice(0, 60), String(version || '1.0').slice(0, 20),
    price, finalPath, meta.size_bytes
  );
  const appId = info.lastInsertRowid;

  // Optional screenshots (each itself a completed chunked upload).
  for (const sid of screenshot_upload_ids || []) {
    const sm = readMeta(sid);
    if (!sm || sm.user_id !== req.user.id || sm.kind !== 'screenshot') continue;
    if (sm.received_bytes !== sm.size_bytes) continue;
    const spath = path.join(UPLOAD_DIR, `shot-${appId}-${crypto.randomBytes(4).toString('hex')}-${sm.filename}`);
    fs.renameSync(uploadPart(sid), spath);
    fs.unlinkSync(uploadMeta(sid));
    db.prepare('INSERT INTO screenshots (app_id, file_path) VALUES (?,?)').run(appId, spath);
  }

  res.json({ ok: true, app_id: appId, status: 'pending', message: 'Uploaded. Waiting for owner approval.' });
});

// Owner-only: swap the package file on an EXISTING listing (e.g. replace the
// seeded placeholder with the real production build). The file must first be
// sent through the normal chunked upload flow (/api/upload/init → chunk →
// complete-data via upload_id); this endpoint just re-points the listing.
app.post('/api/owner/apps/:id/replace-file', requireRole('owner'), (req, res) => {
  const { upload_id, version } = req.body || {};
  const meta = readMeta(upload_id);
  if (!meta || meta.user_id !== req.user.id || meta.kind !== 'appfile') {
    return res.status(404).json({ error: 'Upload not found.' });
  }
  if (meta.received_bytes !== meta.size_bytes) {
    return res.status(400).json({ error: `Incomplete upload: ${meta.received_bytes}/${meta.size_bytes} bytes.` });
  }
  const id = toId(req.params.id);
  const appRow = id ? q.appById.get(id) : null;
  if (!appRow) return res.status(404).json({ error: 'App not found.' });
  const finalName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${meta.filename}`;
  const finalPath = path.join(UPLOAD_DIR, finalName);
  fs.renameSync(uploadPart(upload_id), finalPath);
  fs.unlinkSync(uploadMeta(upload_id));
  const oldPath = appRow.file_path;
  db.prepare('UPDATE apps SET file_path = ?, file_size = ? WHERE id = ?')
    .run(finalPath, meta.size_bytes, appRow.id);
  if (version) {
    db.prepare('UPDATE apps SET version = ? WHERE id = ?').run(String(version).slice(0, 20), appRow.id);
  }
  if (oldPath && oldPath !== finalPath) {
    try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch { /* best effort */ }
  }
  res.json({ ok: true, app_id: appRow.id, file_size: meta.size_bytes });
});

// Owner-only: change an app's listing status (approve, reject/unlist, or send
// back to pending). Lets the owner pull a bad or test listing off the store.
app.post('/api/owner/apps/:id/status', requireRole('owner'), (req, res) => {
  const { status } = req.body || {};
  if (!['approved', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ error: "status must be 'approved', 'rejected', or 'pending'." });
  }
  const id = toId(req.params.id);
  const appRow = id ? db.prepare('SELECT id FROM apps WHERE id = ?').get(id) : null;
  if (!appRow) return res.status(404).json({ error: 'App not found.' });
  db.prepare('UPDATE apps SET status = ? WHERE id = ?').run(status, id);
  res.json({ ok: true, app_id: id, status });
});

// ---------------------------------------------------------------------------
// money: purchases, refunds, finance
// ---------------------------------------------------------------------------
app.post('/api/purchase', requireAuth, rateLimit({ windowMs: 3600_000, max: 20 }), (req, res) => {
  const appId = toId((req.body || {}).app_id);
  if (!appId) return res.status(404).json({ error: 'App not found.' });
  const appRow = q.appById.get(appId);
  if (!appRow || appRow.status !== 'approved') return res.status(404).json({ error: 'App not found.' });
  if (appRow.price_cents <= 0) return res.status(400).json({ error: 'This app is free — just download it.' });
  if (appRow.developer_id === req.user.id) return res.status(400).json({ error: 'You cannot buy your own app.' });
  const already = db.prepare('SELECT id FROM purchases WHERE app_id = ? AND buyer_id = ?').get(appRow.id, req.user.id);
  if (already) return res.status(409).json({ error: 'Already purchased.' });

  // Real money: demo purchases are OFF once Stripe is LIVE. The buyer must
  // go through Stripe Checkout so a real charge exists behind the ledger.
  if (stripe.live) {
    return res.status(402).json({
      error: 'Real payments are enabled — check out with Stripe to buy this app.',
      checkout: '/api/purchase/checkout',
      app_id: appRow.id,
    });
  }
  // A test key is configured but cards are NOT live: demo purchases stay OFF
  // (they would give paid apps away free). Cash App is the real-money rail.
  if (stripe.configured) {
    return res.status(402).json({
      error: 'Pay with Cash App to buy this app — card checkout is not live yet.',
      cashapp: true,
      app_id: appRow.id,
    });
  }

  // Single split definition — lib/money.js. No second "ticket value" anywhere.
  const { developer, platform } = money.split(appRow.price_cents);
  const note = `DEMO purchase — ${money.DEMO_BANNER}`;

  const tx = txn(db, () => {
    const li = db.prepare(
      `INSERT INTO ledger (type, app_id, buyer_id, developer_id, gross_cents, fee_cents, net_cents, note)
       VALUES ('purchase',?,?,?,?,?,?,?)`
    ).run(appRow.id, req.user.id, appRow.developer_id, appRow.price_cents, platform, developer, note);
    db.prepare('INSERT INTO purchases (app_id, buyer_id, ledger_id) VALUES (?,?,?)')
      .run(appRow.id, req.user.id, li.lastInsertRowid);
    return li.lastInsertRowid;
  });
  const ledgerId = tx;

  res.json({
    ok: true,
    ledger_id: ledgerId,
    gross: money.formatUsd(appRow.price_cents),
    developer_share: money.formatUsd(developer),
    platform_fee: money.formatUsd(platform),
    demo: true,
    demoBanner: money.DEMO_BANNER,
  });
});

// Real-money checkout: create a Stripe Checkout Session for one paid app.
// The ledger row is written by the webhook on checkout.session.completed,
// AFTER Stripe confirms the charge — never here.
app.post('/api/purchase/checkout', requireAuth, rateLimit({ windowMs: 3600_000, max: 20 }), async (req, res) => {
  if (!stripe.live) {
    // Refuse test-mode checkout: Stripe test cards (4242…) would otherwise
    // complete "purchases" and unlock paid apps for free. Cash App is the
    // live rail until a real sk_live_ key + Connect/KYC are in place.
    const err = new Error('Card payments are not live yet — pay with Cash App.');
    err.code = 'STRIPE_NOT_LIVE';
    return res.status(503).json({ error: err.message, code: err.code });
  }
  const appId = toId((req.body || {}).app_id);
  if (!appId) return res.status(404).json({ error: 'App not found.' });
  const appRow = q.appById.get(appId);
  if (!appRow || appRow.status !== 'approved') return res.status(404).json({ error: 'App not found.' });
  if (appRow.price_cents <= 0) return res.status(400).json({ error: 'This app is free — just download it.' });
  if (appRow.developer_id === req.user.id) return res.status(400).json({ error: 'You cannot buy your own app.' });
  const already = db.prepare('SELECT id FROM purchases WHERE app_id = ? AND buyer_id = ?').get(appRow.id, req.user.id);
  if (already) return res.status(409).json({ error: 'Already purchased.' });

  const base = publicUrl(req);
  try {
    const { id: sessionId, url } = await stripe.createCheckoutSession({
      appId: appRow.id,
      buyerId: req.user.id,
      appName: `${appRow.name} — Jelani's App Store`,
      amountCents: appRow.price_cents,
      successUrl: `${base}/purchase-success.html?session_id={CHECKOUT_SESSION_ID}&app_id=${appRow.id}`,
      cancelUrl: `${base}/app.html?id=${appRow.id}&cancelled=1`,
    });
    db.prepare(
      `INSERT INTO stripe_sessions (session_id, app_id, buyer_id, amount_cents, status)
       VALUES (?,?,?,?, 'pending')`
    ).run(sessionId, appRow.id, req.user.id, appRow.price_cents);
    res.json({ ok: true, checkout_url: url, session_id: sessionId });
  } catch (e) {
    console.error('[stripe-checkout]', e.message);
    res.status(502).json({ error: 'Could not start checkout. Please try again.' });
  }
});

// Checkout status for the success page: poll until the webhook completes it.
app.get('/api/purchase/session-status', requireAuth, (req, res) => {
  const sid = String(req.query.session_id || '').slice(0, 200);
  if (!sid) return res.status(400).json({ error: 'Missing session_id.' });
  const row = db.prepare('SELECT * FROM stripe_sessions WHERE session_id = ? AND buyer_id = ?').get(sid, req.user.id);
  if (!row) return res.status(404).json({ error: 'Checkout session not found.' });
  const owned = db.prepare('SELECT id FROM purchases WHERE app_id = ? AND buyer_id = ?').get(row.app_id, req.user.id);
  res.json({ ok: true, status: row.status, owned: Boolean(owned), app_id: row.app_id });
});

// ---- Manual Cash App payments (no Stripe, no ID verification needed) ----
// Buyer pays the owner's $cashtag inside their own Cash App, then claims the
// order with their $cashtag. The owner approves in the dashboard after seeing
// the payment; only approval writes the ledger + purchase rows.

function cashappAppCheck(appId, buyerId) {
  const appRow = q.appById.get(appId);
  if (!appRow || appRow.status !== 'approved') return { error: 'App not found.', code: 404 };
  if (appRow.price_cents <= 0) return { error: 'This app is free — just download it.', code: 400 };
  if (appRow.developer_id === buyerId) return { error: 'You cannot buy your own app.', code: 400 };
  const already = db.prepare('SELECT id FROM purchases WHERE app_id = ? AND buyer_id = ?').get(appRow.id, buyerId);
  if (already) return { error: 'Already purchased.', code: 409 };
  return { appRow };
}

const CASHTAG_RE = /^\$[A-Za-z0-9_]{1,20}$/;

// Start a Cash App order: returns what to pay and where.
app.post('/api/purchase/cashapp/init', requireAuth, rateLimit({ windowMs: 3600_000, max: 20 }), (req, res) => {
  const appId = toId((req.body || {}).app_id);
  if (!appId) return res.status(404).json({ error: 'App not found.' });
  const check = cashappAppCheck(appId, req.user.id);
  if (check.error) return res.status(check.code).json({ error: check.error });
  const existing = db.prepare(
    `SELECT * FROM cashapp_orders WHERE app_id = ? AND buyer_id = ? AND status IN ('pending','claimed','approved')`
  ).get(check.appRow.id, req.user.id);
  if (existing) {
    return res.json({
      ok: true, order_id: existing.id, status: existing.status,
      cashtag: CASHAPP_CASHTAG, amount_cents: existing.amount_cents,
      amount: money.formatUsd(existing.amount_cents), resumed: true,
    });
  }
  const info = db.prepare(
    `INSERT INTO cashapp_orders (app_id, buyer_id, amount_cents, status) VALUES (?,?,?,'pending')`
  ).run(check.appRow.id, req.user.id, check.appRow.price_cents);
  res.json({
    ok: true, order_id: Number(info.lastInsertRowid), status: 'pending',
    cashtag: CASHAPP_CASHTAG, amount_cents: check.appRow.price_cents,
    amount: money.formatUsd(check.appRow.price_cents),
  });
});

// Buyer claims they paid: records their $cashtag as proof.
app.post('/api/purchase/cashapp/claim', requireAuth, rateLimit({ windowMs: 3600_000, max: 20 }), (req, res) => {
  const orderId = toId((req.body || {}).order_id);
  const cashtag = String((req.body || {}).buyer_cashtag || '').trim();
  if (!CASHTAG_RE.test(cashtag)) {
    return res.status(400).json({ error: 'Enter your Cash App $cashtag (starts with $, letters/numbers only).' });
  }
  const order = db.prepare('SELECT * FROM cashapp_orders WHERE id = ? AND buyer_id = ?').get(orderId, req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status !== 'pending') return res.status(409).json({ error: `Order is already ${order.status}.` });
  db.prepare(`UPDATE cashapp_orders SET buyer_cashtag = ?, status = 'claimed' WHERE id = ?`).run(cashtag, order.id);
  res.json({ ok: true, order_id: order.id, status: 'claimed' });
});

// Buyer's own order status (for the "waiting for approval" screen).
app.get('/api/purchase/cashapp/status', requireAuth, (req, res) => {
  const orderId = toId(req.query.order_id);
  const order = db.prepare('SELECT * FROM cashapp_orders WHERE id = ? AND buyer_id = ?').get(orderId, req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const owned = db.prepare('SELECT id FROM purchases WHERE app_id = ? AND buyer_id = ?').get(order.app_id, req.user.id);
  res.json({ ok: true, status: order.status, owned: Boolean(owned), app_id: order.app_id });
});

// Owner: list Cash App orders awaiting review.
app.get('/api/owner/cashapp/orders', requireRole('owner'), (req, res) => {
  const rows = db.prepare(
    `SELECT o.*, a.name AS app_name, u.username AS buyer_name
     FROM cashapp_orders o
     JOIN apps a ON a.id = o.app_id
     JOIN users u ON u.id = o.buyer_id
     ORDER BY o.created_at DESC LIMIT 100`
  ).all();
  res.json({ ok: true, orders: rows, cashtag: CASHAPP_CASHTAG });
});

// Owner: approve a claimed order — writes the ledger + purchase (90/10 split).
app.post('/api/owner/cashapp/orders/:id/approve', requireRole('owner'), (req, res) => {
  const id = toId(req.params.id);
  const order = db.prepare('SELECT * FROM cashapp_orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status === 'approved') return res.status(409).json({ error: 'Already approved.' });
  if (order.status !== 'claimed') {
    return res.status(409).json({ error: 'Buyer has not claimed payment yet.' });
  }
  const appRow = q.appById.get(order.app_id);
  if (!appRow) return res.status(404).json({ error: 'App not found.' });
  const { developer, platform } = money.split(order.amount_cents);
  const note = `Cash App manual — buyer ${order.buyer_cashtag} → ${CASHAPP_CASHTAG}`;
  const ledgerId = txn(db, () => {
    const li = db.prepare(
      `INSERT INTO ledger (type, app_id, buyer_id, developer_id, gross_cents, fee_cents, net_cents, note)
       VALUES ('purchase',?,?,?,?,?,?,?)`
    ).run(order.app_id, order.buyer_id, appRow.developer_id, order.amount_cents, platform, developer, note);
    db.prepare('INSERT OR IGNORE INTO purchases (app_id, buyer_id, ledger_id) VALUES (?,?,?)')
      .run(order.app_id, order.buyer_id, li.lastInsertRowid);
    db.prepare(`UPDATE cashapp_orders SET status = 'approved', ledger_id = ? WHERE id = ?`)
      .run(li.lastInsertRowid, order.id);
    return li.lastInsertRowid;
  });
  res.json({ ok: true, order_id: order.id, ledger_id: Number(ledgerId) });
});

// Owner: reject a Cash App order.
app.post('/api/owner/cashapp/orders/:id/reject', requireRole('owner'), (req, res) => {
  const id = toId(req.params.id);
  const order = db.prepare('SELECT * FROM cashapp_orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status === 'approved') return res.status(409).json({ error: 'Already approved — issue a refund instead.' });
  db.prepare(`UPDATE cashapp_orders SET status = 'rejected' WHERE id = ?`).run(id);
  res.json({ ok: true, order_id: id, status: 'rejected' });
});

// ---------------------------------------------------------------------------
// money: PayPal checkout (buyer's choice alongside Cash App / Stripe)
// ---------------------------------------------------------------------------

// Public client ID for the PayPal JS SDK button. The Client ID is publishable
// by PayPal's design (like a Stripe publishable key) — the SECRET never
// leaves the server.
app.get('/api/paypal/client-id', (req, res) => {
  if (!paypal.configured()) return res.status(404).json({ error: 'PayPal is not connected.' });
  res.json({ client_id: paypal.creds().id, env: paypal.effectiveEnv() });
});

// Same purchase pre-checks as the Cash App flow: one definition, no drift.
function paypalAppCheck(appId, buyerId) {
  const appRow = q.appById.get(appId);
  if (!appRow || appRow.status !== 'approved') return { error: 'App not found.', code: 404 };
  if (appRow.price_cents <= 0) return { error: 'This app is free — just download it.', code: 400 };
  if (appRow.developer_id === buyerId) return { error: 'You cannot buy your own app.', code: 400 };
  const already = db.prepare('SELECT id FROM purchases WHERE app_id = ? AND buyer_id = ?').get(appRow.id, buyerId);
  if (already) return { error: 'Already purchased.', code: 409 };
  return { appRow };
}

// Create a PayPal order for one paid app. The amount always comes from the DB
// price — never from the browser.
app.post('/api/paypal/create-order', requireAuth, rateLimit({ windowMs: 3600_000, max: 20 }), async (req, res) => {
  if (!paypal.configured()) {
    return res.status(503).json({ error: 'PayPal checkout is not connected yet.', code: 'PAYPAL_UNCONFIGURED' });
  }
  const appId = toId((req.body || {}).app_id);
  if (!appId) return res.status(404).json({ error: 'App not found.' });
  const check = paypalAppCheck(appId, req.user.id);
  if (check.error) return res.status(check.code).json({ error: check.error });
  try {
    const { id: orderId } = await paypal.createOrder({
      appId: check.appRow.id,
      appName: `${check.appRow.name} — Jelani's App Store`,
      amountCents: check.appRow.price_cents,
    });
    db.prepare(
      `INSERT INTO paypal_orders (order_id, app_id, buyer_id, amount_cents, status)
       VALUES (?,?,?,?,'pending')`
    ).run(orderId, check.appRow.id, req.user.id, check.appRow.price_cents);
    res.json({ ok: true, order_id: orderId });
  } catch (e) {
    console.error('[paypal-create]', e.code || e.message);
    res.status(502).json({ error: 'Could not start PayPal checkout. Please try again.', code: e.code || 'PAYPAL_ERROR' });
  }
});

// Capture a PayPal order. On a verified COMPLETED capture it writes the same
// ledger + purchases rows the other rails write, so the download unlocks
// identically. Idempotent: capturing the same order twice records one purchase.
app.post('/api/paypal/capture', requireAuth, rateLimit({ windowMs: 3600_000, max: 20 }), async (req, res) => {
  if (!paypal.configured()) {
    return res.status(503).json({ error: 'PayPal checkout is not connected yet.', code: 'PAYPAL_UNCONFIGURED' });
  }
  const orderId = String((req.body || {}).order_id || '').slice(0, 64);
  if (!orderId) return res.status(400).json({ error: 'Missing order_id.' });
  const row = db.prepare('SELECT * FROM paypal_orders WHERE order_id = ? AND buyer_id = ?').get(orderId, req.user.id);
  if (!row) return res.status(404).json({ error: 'PayPal order not found.' });
  if (row.status === 'completed') {
    const owned = db.prepare('SELECT id FROM purchases WHERE app_id = ? AND buyer_id = ?').get(row.app_id, req.user.id);
    return res.json({ ok: true, owned: Boolean(owned), app_id: row.app_id, ledger_id: row.ledger_id, duplicate: true });
  }
  try {
    const cap = await paypal.captureOrder(orderId);
    // Verify PayPal's word against the DB price before writing anything.
    if (cap.status !== 'COMPLETED' || cap.currency !== 'USD' || cap.amountCents !== row.amount_cents) {
      return res.status(502).json({ error: 'PayPal did not confirm this payment — no purchase was recorded.' });
    }
    const appRow = q.appById.get(row.app_id);
    if (!appRow || appRow.status !== 'approved' || appRow.price_cents !== row.amount_cents) {
      return res.status(409).json({ error: 'The app or its price changed — no purchase was recorded.' });
    }
    const { developer, platform } = money.split(row.amount_cents);
    const note = `PayPal payment ${cap.captureId || orderId} — ${paypal.live() ? 'real money' : 'sandbox (test money)'}`;
    const ledgerId = txn(db, () => {
      const li = db.prepare(
        `INSERT INTO ledger (type, app_id, buyer_id, developer_id, gross_cents, fee_cents, net_cents, note)
         VALUES ('purchase',?,?,?,?,?,?,?)`
      ).run(row.app_id, row.buyer_id, appRow.developer_id, row.amount_cents, platform, developer, note);
      db.prepare('INSERT OR IGNORE INTO purchases (app_id, buyer_id, ledger_id) VALUES (?,?,?)')
        .run(row.app_id, row.buyer_id, li.lastInsertRowid);
      db.prepare(`UPDATE paypal_orders SET status = 'completed', ledger_id = ? WHERE id = ?`)
        .run(li.lastInsertRowid, row.id);
      return li.lastInsertRowid;
    });
    res.json({ ok: true, owned: true, app_id: row.app_id, ledger_id: Number(ledgerId) });
  } catch (e) {
    console.error('[paypal-capture]', e.code || e.message);
    res.status(502).json({ error: 'Could not confirm the PayPal payment. Please try again.', code: e.code || 'PAYPAL_ERROR' });
  }
});

// ---------------------------------------------------------------------------
// owner: PayPal settings (Client ID + Secret — stored server-side only)
// ---------------------------------------------------------------------------
app.get('/api/owner/paypal', requireRole('owner'), (req, res) => {
  const fromEnv = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
  let last4 = '';
  if (!fromEnv) {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'paypal_client_id'").get();
    if (row && row.value) last4 = String(row.value).slice(-4);
  }
  res.json({
    configured: paypal.configured(),
    env: paypal.effectiveEnv(),
    live: paypal.live(),
    source: fromEnv ? 'env' : 'settings',
    client_id_last4: last4 || null,
  });
});

app.post('/api/owner/paypal', requireRole('owner'), (req, res) => {
  const { client_id, secret, env } = req.body || {};
  const e = String(env || 'sandbox').toLowerCase();
  if (!['sandbox', 'live'].includes(e)) return res.status(400).json({ error: "env must be 'sandbox' or 'live'." });
  const cid = String(client_id || '').trim();
  const sec = String(secret || '').trim();
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  );
  if (!cid && !sec) {
    // Env-only update: keep the saved keys, just switch sandbox/live.
    upsert.run('paypal_env', e);
    return res.json({ ok: true, configured: paypal.configured(), env: e, source: 'settings' });
  }
  if (!cid || cid.length < 8) return res.status(400).json({ error: 'A valid PayPal Client ID is required.' });
  if (!sec || sec.length < 8) return res.status(400).json({ error: 'A valid PayPal Secret is required.' });
  upsert.run('paypal_client_id', cid);
  upsert.run('paypal_secret', sec);
  upsert.run('paypal_env', e);
  res.json({ ok: true, configured: true, env: e, source: 'settings' });
});

// Internal: read-only Cash App totals for the daily cap watcher. Gated by the
// WATCH_TOKEN env var (compared via hashes so lengths never leak); when the
// env var is unset the route 404s like it doesn't exist. Reports what buyers
// actually paid: APPROVED Cash App orders only, dated by their ledger row.
app.get('/api/internal/cashapp-summary', (req, res) => {
  const expected = process.env.WATCH_TOKEN || '';
  if (!expected) return res.status(404).json({ error: 'Not found.' });
  const given = String(req.get('x-watch-token') || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(404).json({ error: 'Not found.' });
  const last30 = db.prepare(
    `SELECT COALESCE(SUM(o.amount_cents), 0) AS total_cents, COUNT(*) AS n
     FROM cashapp_orders o JOIN ledger l ON l.id = o.ledger_id
     WHERE o.status = 'approved' AND l.created_at >= datetime('now', '-30 days')`
  ).get();
  const allTime = db.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total_cents, COUNT(*) AS n
     FROM cashapp_orders WHERE status = 'approved'`
  ).get();
  res.json({
    ok: true,
    cashtag: CASHAPP_CASHTAG,
    cap_cents: 100000,
    last_30d_cents: Number(last30.total_cents),
    last_30d_count: Number(last30.n),
    all_time_cents: Number(allTime.total_cents),
    all_time_count: Number(allTime.n),
    generated_at: new Date().toISOString(),
  });
});

// Owner: set an app's price (cents). Lets the owner price apps from the dashboard.
app.post('/api/owner/apps/:id/price', requireRole('owner'), (req, res) => {
  const id = toId(req.params.id);
  const cents = Number((req.body || {}).price_cents);
  if (!Number.isInteger(cents) || cents < 0 || cents > 1000000) {
    return res.status(400).json({ error: 'price_cents must be 0–1000000.' });
  }
  const appRow = q.appById.get(id);
  if (!appRow) return res.status(404).json({ error: 'App not found.' });
  db.prepare('UPDATE apps SET price_cents = ? WHERE id = ?').run(cents, id);
  res.json({ ok: true, app_id: id, price_cents: cents, price: money.formatUsd(cents) });
});

// Owner: fix an app's listing description (truth-in-advertising edits).
app.post('/api/owner/apps/:id/description', requireRole('owner'), (req, res) => {
  const id = toId(req.params.id);
  const appRow = id ? q.appById.get(id) : null;
  if (!appRow) return res.status(404).json({ error: 'App not found.' });
  const desc = String(((req.body || {}).description) || '').slice(0, 8000);
  db.prepare('UPDATE apps SET description = ? WHERE id = ?').run(desc, id);
  res.json({ ok: true, app_id: id });
});

// Owner: attach a screenshot (a completed 'screenshot' kind upload) to a listing.
app.post('/api/owner/apps/:id/screenshots', requireRole('owner'), (req, res) => {
  const { upload_id } = req.body || {};
  const meta = readMeta(upload_id);
  if (!meta || meta.user_id !== req.user.id || meta.kind !== 'screenshot') {
    return res.status(404).json({ error: 'Upload not found.' });
  }
  if (meta.received_bytes !== meta.size_bytes) {
    return res.status(400).json({ error: `Incomplete upload: ${meta.received_bytes}/${meta.size_bytes} bytes.` });
  }
  const id = toId(req.params.id);
  const appRow = id ? q.appById.get(id) : null;
  if (!appRow) return res.status(404).json({ error: 'App not found.' });
  const finalName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${meta.filename}`;
  const finalPath = path.join(UPLOAD_DIR, finalName);
  fs.renameSync(uploadPart(upload_id), finalPath);
  fs.unlinkSync(uploadMeta(upload_id));
  const info = db.prepare('INSERT INTO screenshots (app_id, file_path) VALUES (?,?)').run(id, finalPath);
  res.json({ ok: true, app_id: id, screenshot_id: Number(info.lastInsertRowid) });
});

// Owner: remove a stale screenshot from a listing.
app.delete('/api/owner/screenshots/:shotId', requireRole('owner'), (req, res) => {
  const sid = toId(req.params.shotId);
  const row = sid ? db.prepare('SELECT id, file_path FROM screenshots WHERE id = ?').get(sid) : null;
  if (!row) return res.status(404).json({ error: 'Screenshot not found.' });
  db.prepare('DELETE FROM screenshots WHERE id = ?').run(sid);
  try { if (row.file_path && fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path); } catch { /* best effort */ }
  res.json({ ok: true, screenshot_id: sid });
});

// Owner: list all apps (for the prices panel).
app.get('/api/owner/apps', requireRole('owner'), (req, res) => {
  const rows = db.prepare(
    `SELECT id, name, version, price_cents, status, download_count FROM apps ORDER BY id`
  ).all();
  res.json({ ok: true, apps: rows });
});

// Refunds: owner or the app's developer. Writes a negative ledger row so the
// books always reconcile; never deletes the original row.
app.post('/api/refund', requireAuth, async (req, res) => {
  const ledgerId = toId((req.body || {}).ledger_id);
  if (!ledgerId) return res.status(404).json({ error: 'Purchase not found.' });
  const row = db.prepare('SELECT * FROM ledger WHERE id = ? AND type = \'purchase\'').get(ledgerId);
  if (!row) return res.status(404).json({ error: 'Purchase not found.' });
  const appRow = db.prepare('SELECT developer_id FROM apps WHERE id = ?').get(row.app_id);
  const allowed = req.user.role === 'owner' || (appRow && appRow.developer_id === req.user.id);
  if (!allowed) return res.status(403).json({ error: 'Only the owner or the app developer can refund.' });

  // Real money? Push the refund through Stripe FIRST, then write the books.
  const sess = db.prepare(`SELECT * FROM stripe_sessions WHERE ledger_id = ? AND status = 'completed'`).get(row.id);
  let refundedVia = 'demo';
  if (sess && sess.payment_intent) {
    if (!stripe.configured) return res.status(503).json({ error: 'Stripe is not connected — cannot refund real money.' });
    try {
      await stripe.refundPayment({ paymentIntentId: sess.payment_intent, amountCents: row.gross_cents });
      refundedVia = 'stripe';
    } catch (e) {
      console.error('[stripe-refund]', e.message);
      return res.status(502).json({ error: 'Stripe refund failed — nothing was written to the ledger.' });
    }
  }

  const tx = txn(db, () => {
    const li = db.prepare(
      `INSERT INTO ledger (type, app_id, buyer_id, developer_id, gross_cents, fee_cents, net_cents, note)
       VALUES ('refund',?,?,?,?,?,?,?)`
    ).run(row.app_id, row.buyer_id, row.developer_id, -row.gross_cents, -row.fee_cents, -row.net_cents,
      `Refund of ledger #${row.id}${refundedVia === 'stripe' ? ' via Stripe' : ''}`);
    db.prepare('DELETE FROM purchases WHERE ledger_id = ?').run(row.id);
    if (sess) db.prepare(`UPDATE stripe_sessions SET status = 'refunded' WHERE id = ?`).run(sess.id);
    return li.lastInsertRowid;
  });
  res.json({ ok: true, refund_ledger_id: tx, demo: refundedVia === 'demo', refunded_via: refundedVia });
});

// Developer: my apps + earnings (net of refunds).
app.get('/api/dev/apps', requireAuth, (req, res) => {
  if (!['owner', 'developer'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Developer role required.' });
  }
  const apps = db.prepare(
    `SELECT id, name, category, version, price_cents, status, download_count, created_at
     FROM apps WHERE developer_id = ? ORDER BY created_at DESC`
  ).all(req.user.role === 'owner' && req.query.all === '1' ? -1 : req.user.id);
  res.json({ apps, demoBanner: money.DEMO_BANNER });
});

app.get('/api/dev/earnings', requireAuth, (req, res) => {
  if (!['owner', 'developer'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Developer role required.' });
  }
  const rows = db.prepare(
    `SELECT a.id AS app_id, a.name,
       COALESCE(SUM(CASE WHEN l.type='purchase' THEN l.net_cents WHEN l.type='refund' THEN l.net_cents ELSE 0 END),0) AS net_cents,
       COUNT(CASE WHEN l.type='purchase' THEN 1 END) AS sales,
       COUNT(CASE WHEN l.type='refund' THEN 1 END) AS refunds
     FROM apps a LEFT JOIN ledger l ON l.app_id = a.id AND l.type IN ('purchase','refund')
     WHERE a.developer_id = ? GROUP BY a.id ORDER BY net_cents DESC`
  ).all(req.user.id);
  res.json({ earnings: rows, demo: true, demoBanner: money.DEMO_BANNER });
});

// ---------------------------------------------------------------------------
// owner: moderation queue + finance with reconciliation
// ---------------------------------------------------------------------------
app.get('/api/owner/pending', requireRole('owner'), (req, res) => {
  const rows = db.prepare(
    `SELECT a.*, u.username AS developer_name FROM apps a
     JOIN users u ON u.id = a.developer_id
     WHERE a.status = 'pending' ORDER BY a.created_at ASC`
  ).all();
  res.json({ pending: rows.map(({ file_path, ...r }) => r) });
});

app.post('/api/owner/approve', requireRole('owner'), (req, res) => {
  const { approve, reason } = req.body || {};
  const appId = toId((req.body || {}).app_id);
  if (!appId) return res.status(404).json({ error: 'App not found.' });
  const appRow = db.prepare('SELECT id, status FROM apps WHERE id = ?').get(appId);
  if (!appRow) return res.status(404).json({ error: 'App not found.' });
  if (appRow.status !== 'pending') return res.status(409).json({ error: 'Already moderated.' });
  db.prepare('UPDATE apps SET status = ?, rejection_reason = ? WHERE id = ?')
    .run(approve ? 'approved' : 'rejected', approve ? null : String(reason || '').slice(0, 500), appId);
  res.json({ ok: true, status: approve ? 'approved' : 'rejected' });
});

app.get('/api/owner/finance', requireRole('owner'), (req, res) => {
  const totals = db.prepare(
    `SELECT type,
       COALESCE(SUM(gross_cents),0) AS gross,
       COALESCE(SUM(fee_cents),0) AS fees,
       COALESCE(SUM(net_cents),0) AS net,
       COUNT(*) AS n
     FROM ledger GROUP BY type`
  ).all();

  const perDeveloper = db.prepare(
    `SELECT u.username AS developer,
       COALESCE(SUM(CASE WHEN l.type='purchase' THEN l.net_cents WHEN l.type='refund' THEN l.net_cents ELSE 0 END),0) AS owed_cents
     FROM ledger l JOIN users u ON u.id = l.developer_id
     WHERE l.developer_id IS NOT NULL
     GROUP BY l.developer_id HAVING owed_cents != 0 ORDER BY owed_cents DESC`
  ).all();

  // Reconciliation: EVERY ledger row must satisfy the single money definition.
  const rows = db.prepare('SELECT id, type, gross_cents, fee_cents, net_cents FROM ledger').all();
  const mismatches = [];
  for (const r of rows) {
    const problem = money.validateLedgerRow(r);
    if (problem) mismatches.push({ ledger_id: r.id, type: r.type, problem });
  }

  res.json({
    demo: true,
    demoBanner: money.DEMO_BANNER,
    stripeConfigured: stripe.configured,
    totals,
    perDeveloper,
    reconciliation: {
      checked: rows.length,
      mismatches,
      ok: mismatches.length === 0,
    },
  });
});

// ---------------------------------------------------------------------------
// reviews + KYC
// ---------------------------------------------------------------------------
app.post('/api/apps/:id/reviews', requireAuth, (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(404).json({ error: 'App not found.' });
  const appRow = db.prepare('SELECT id, status FROM apps WHERE id = ?').get(id);
  if (!appRow || appRow.status !== 'approved') return res.status(404).json({ error: 'App not found.' });
  const rating = Number(req.body.rating);
  const text = String(req.body.text || '').slice(0, 2000);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be 1–5.' });
  }
  db.prepare(
    `INSERT INTO reviews (app_id, user_id, rating, text)
     VALUES (?,?,?,?)
     ON CONFLICT(app_id, user_id) DO UPDATE SET rating=excluded.rating, text=excluded.text, created_at=datetime('now')`
  ).run(appRow.id, req.user.id, rating, text);
  res.json({ ok: true });
});

app.get('/api/kyc', requireAuth, (req, res) => {
  const u = db.prepare('SELECT kyc_status FROM users WHERE id = ?').get(req.user.id);
  res.json({ kyc_status: u.kyc_status, demoNote: stripe.DEMO_NOTE, stripeConfigured: stripe.configured });
});

app.post('/api/kyc', requireAuth, (req, res) => {
  const note = String(req.body.note || '').slice(0, 1000);
  db.prepare("UPDATE users SET kyc_status = 'pending', kyc_note = ? WHERE id = ?").run(note, req.user.id);
  res.json({ ok: true, kyc_status: 'pending', demoNote: stripe.DEMO_NOTE });
});

// ---------------------------------------------------------------------------
// AppMaker — generate installable APKs from templates
// ---------------------------------------------------------------------------
const appmaker = require('./lib/appmaker');
const APPMAKER_DIR = path.join(UPLOAD_DIR, 'appmaker');
fs.mkdirSync(APPMAKER_DIR, { recursive: true });

// Developers and the owner can build. (requireRole takes one role, so the
// two-role check is inline — same server-side enforcement.)
function requireDevOrOwner(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  if (!['owner', 'developer'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Requires developer or owner role.' });
  }
  next();
}

function nextVersionCode(packageName) {
  const row = db.prepare(
    'SELECT MAX(version_code) AS v FROM appmaker_builds WHERE package_name = ?'
  ).get(packageName);
  return (row && row.v ? row.v : 0) + 1;
}

// Builds are CPU-heavy (~10s): 10 per hour per account.
app.post('/api/appmaker/build', requireDevOrOwner, rateLimit({ windowMs: 3600_000, max: 10, key: 'appmaker' }),
  (req, res) => {
    const t0 = Date.now();
    try {
      const { appName, packageName, template, url, color, icon_upload_id } = req.body || {};
      const pkg = appmaker.validatePackageName(packageName);
      const name = appmaker.validateAppName(appName);
      const tpl = template === 'website' ? 'website' : 'starter';
      if (tpl === 'website') appmaker.validateUrl(url);
      const versionCode = nextVersionCode(pkg);

      // Optional PNG icon via the chunked-upload flow (kind 'icon').
      let iconSrcPath = null;
      if (icon_upload_id) {
        const meta = readMeta(icon_upload_id);
        if (!meta || meta.user_id !== req.user.id || meta.kind !== 'icon' || meta.received_bytes !== meta.size_bytes) {
          return res.status(400).json({ error: 'Icon upload not found or incomplete.' });
        }
        iconSrcPath = uploadPart(icon_upload_id);
      }

      const result = appmaker.generateApk({
        appName: name,
        packageName: pkg,
        template: tpl,
        url: tpl === 'website' ? url : undefined,
        color,
        iconSrcPath,
        versionCode,
        versionName: '1.0',
        workRoot: path.join(TMP_DIR, 'appmaker'),
        dataDir: path.join(ROOT, 'data'),
      });

      // Persist the APK + notes under the uploads dir (survives restarts).
      // (copy+unlink, not rename: data/ and uploads/ can be different volumes.)
      const moveFile = (src, dest) => {
        fs.copyFileSync(src, dest);
        fs.unlinkSync(src);
      };
      const destApk = path.join(APPMAKER_DIR, `${result.versionCode}-${crypto.randomBytes(6).toString('hex')}.apk`);
      moveFile(result.apkPath, destApk);
      let destNotes = null;
      try {
        destNotes = destApk + '.BUILD_NOTES.txt';
        moveFile(result.notesPath, destNotes);
      } catch { /* notes are best-effort */ }
      if (icon_upload_id) { try { fs.unlinkSync(uploadMeta(icon_upload_id)); } catch { /* best effort */ } }
      // Clean the temp project dir (APK + notes already moved out).
      try { fs.rmSync(result.workDir, { recursive: true, force: true }); } catch { /* best effort */ }

      const info = db.prepare(
        `INSERT INTO appmaker_builds
           (user_id, app_name, package_name, template, version_code, version_name, apk_path, apk_size, notes_path, warnings)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(req.user.id, name, pkg, tpl, result.versionCode, '1.0',
        destApk, result.size, destNotes, JSON.stringify(result.warnings));
      res.json({
        ok: true,
        build_id: Number(info.lastInsertRowid),
        app_name: name,
        package_name: pkg,
        version_code: result.versionCode,
        apk_size: result.size,
        warnings: result.warnings,
        download_url: `/api/appmaker/builds/${info.lastInsertRowid}/download`,
        took_ms: Date.now() - t0,
      });
    } catch (e) {
      const msg = String(e.message || 'Build failed.');
      // Known validation / environment problems get a 400 with the plain message;
      // unexpected failures stay a 500 without leaking internals.
      const known = /package name|app name|URL|Color|versionCode|JS audit|assets are|SDK|JDK|Icon/i.test(msg);
      console.error('[appmaker] build failed:', msg.split('\n')[0]);
      res.status(known ? 400 : 500).json({ error: known ? msg : 'Build failed. Try again or simplify the inputs.' });
    }
  });

app.get('/api/appmaker/builds', requireDevOrOwner, (req, res) => {
  const rows = db.prepare(
    `SELECT id, app_name, package_name, template, version_code, version_name,
            apk_size, warnings, created_at
     FROM appmaker_builds WHERE user_id = ? ORDER BY id DESC LIMIT 100`
  ).all(req.user.id);
  res.json({
    builds: rows.map((r) => ({
      ...r,
      warnings: JSON.parse(r.warnings || '[]'),
      download_url: `/api/appmaker/builds/${r.id}/download`,
    })),
  });
});

app.get('/api/appmaker/builds/:id/download', requireDevOrOwner, (req, res) => {
  const id = toId(req.params.id);
  const row = id ? db.prepare('SELECT * FROM appmaker_builds WHERE id = ?').get(id) : null;
  if (!row) return res.status(404).json({ error: 'Build not found.' });
  if (row.user_id !== req.user.id && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Not your build.' });
  }
  if (!fs.existsSync(row.apk_path)) return res.status(410).json({ error: 'APK file missing — rebuild it.' });
  res.download(row.apk_path, `${row.package_name}-v${row.version_code}.apk`);
});

// Publish a build as a real store listing. The listing goes through the
// SAME moderation queue and the SAME purchase flows as any upload:
// status starts 'pending', the owner approves, and buyers pay via Cash App
// or Stripe — the 90/10 split in lib/money.js pays the builder (developer_id)
// 90% automatically. No new payment path, no new money definition.
app.post('/api/appmaker/builds/:id/publish', requireDevOrOwner, (req, res) => {
  const id = toId(req.params.id);
  const build = id ? db.prepare('SELECT * FROM appmaker_builds WHERE id = ?').get(id) : null;
  if (!build) return res.status(404).json({ error: 'Build not found.' });
  if (build.user_id !== req.user.id && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Not your build.' });
  }
  const { price_cents, description, category, copyright_attested } = req.body || {};
  // Copyright attestation is REQUIRED — same rule as the upload flow
  // (PROBLEMS_FIXED.md #6: the old empty Copyright Vault).
  if (copyright_attested !== true) {
    return res.status(400).json({ error: 'Copyright attestation required: confirm you own the rights to this app.' });
  }
  const price = Number(price_cents || 0);
  if (!Number.isInteger(price) || price < 0) {
    return res.status(400).json({ error: 'price_cents must be a non-negative integer.' });
  }
  if (!fs.existsSync(build.apk_path)) {
    return res.status(410).json({ error: 'APK file missing — rebuild it first.' });
  }
  const desc = String(description || '').slice(0, 8000);
  const cat = String(category || 'Tools').slice(0, 60);

  // Copy (not move): the build stays downloadable under My builds.
  const finalName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${build.package_name}-v${build.version_code}.apk`;
  const finalPath = path.join(UPLOAD_DIR, finalName);
  fs.copyFileSync(build.apk_path, finalPath);

  const info = db.prepare(
    `INSERT INTO apps (name, developer_id, description, category, version, price_cents,
      file_path, file_size, status, copyright_attested)
     VALUES (?,?,?,?,?,?,?,?,'pending',1)`
  ).run(
    build.app_name, build.user_id, desc, cat, build.version_name,
    price, finalPath, build.apk_size
  );
  const appId = Number(info.lastInsertRowid);
  const { developer } = money.split(price);
  res.json({
    ok: true,
    app_id: appId,
    status: 'pending',
    message: 'Submitted for owner review. It goes live after approval.',
    price: money.formatUsd(price),
    you_earn_per_sale: money.formatUsd(developer),
  });
});

// ---------------------------------------------------------------------------
// frontend
// ---------------------------------------------------------------------------
// frontend (static files)
// ---------------------------------------------------------------------------
app.use(express.static(path.join(ROOT, 'public')));

// error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Server error.' });
});

// Lightweight health probe for orchestrators (Render, Docker, etc.).
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Jelani's App Store running at http://0.0.0.0:${PORT}`);
  console.log(`  ${money.DEMO_BANNER}\n`);
});
