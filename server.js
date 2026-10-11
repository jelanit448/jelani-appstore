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

const PORT = process.env.PORT || 3000;
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
  '/api/change-password',
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
    demoMode: true,
    demoBanner: money.DEMO_BANNER,
    stripeConfigured: stripe.configured,
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

// Deterministic letter-icon so listings look alive without uploads.
app.get('/api/apps/:id/icon', (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(404).send('not found');
  const appRow = db.prepare('SELECT name FROM apps WHERE id = ?').get(id);
  if (!appRow) return res.status(404).send('not found');
  let h = 0;
  for (const c of appRow.name) h = (h * 31 + c.charCodeAt(0)) % 360;
  const letter = (appRow.name[0] || '?').toUpperCase();
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">` +
    `<rect width="128" height="128" rx="24" fill="hsl(${h},65%,42%)"/>` +
    `<text x="64" y="86" font-family="sans-serif" font-size="64" fill="white" text-anchor="middle">${letter}</text></svg>`;
  res.type('image/svg+xml').send(svg);
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
  if (!['appfile', 'screenshot'].includes(kind)) {
    return res.status(400).json({ error: "kind must be 'appfile' or 'screenshot'." });
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

// Refunds: owner or the app's developer. Writes a negative ledger row so the
// books always reconcile; never deletes the original row.
app.post('/api/refund', requireAuth, (req, res) => {
  const ledgerId = toId((req.body || {}).ledger_id);
  if (!ledgerId) return res.status(404).json({ error: 'Purchase not found.' });
  const row = db.prepare('SELECT * FROM ledger WHERE id = ? AND type = \'purchase\'').get(ledgerId);
  if (!row) return res.status(404).json({ error: 'Purchase not found.' });
  const appRow = db.prepare('SELECT developer_id FROM apps WHERE id = ?').get(row.app_id);
  const allowed = req.user.role === 'owner' || (appRow && appRow.developer_id === req.user.id);
  if (!allowed) return res.status(403).json({ error: 'Only the owner or the app developer can refund.' });

  const tx = txn(db, () => {
    const li = db.prepare(
      `INSERT INTO ledger (type, app_id, buyer_id, developer_id, gross_cents, fee_cents, net_cents, note)
       VALUES ('refund',?,?,?,?,?,?,?)`
    ).run(row.app_id, row.buyer_id, row.developer_id, -row.gross_cents, -row.fee_cents, -row.net_cents,
      `Refund of ledger #${row.id}`);
    db.prepare('DELETE FROM purchases WHERE ledger_id = ?').run(row.id);
    return li.lastInsertRowid;
  });
  res.json({ ok: true, refund_ledger_id: tx, demo: true });
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
// frontend
// ---------------------------------------------------------------------------
app.use(express.static(path.join(ROOT, 'public')));

// error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Server error.' });
});

app.listen(PORT, () => {
  console.log(`\n  Jelani's App Store running at http://localhost:${PORT}`);
  console.log(`  Owner login: jelani / ChangeMe123!  (change on first login; Terms gate applies)`);
  console.log(`  ${money.DEMO_BANNER}\n`);
});
