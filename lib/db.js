'use strict';
/**
 * db.js — SQLite (node:sqlite, built into Node) schema, seed data, and helpers.
 *
 * Roles are explicit in the users table ('owner' | 'developer' | 'user').
 * Past problem this fixes: ViralMode's "Owner Mode is restricted to the app
 * owner" lockout, where flags like isFounder/isOwner silently came back false
 * and blocked the real owner. Here the owner is a seeded row with role='owner'
 * and every protected route checks that role server-side.
 */

const path = require('path');
const fs = require('fs');
// node:sqlite ships with Node 22.5+/24 — zero native dependencies, no node-gyp.
// (better-sqlite3 was dropped: its node-gyp build needs to download Node
// headers, which fails in locked-down environments.)
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

// Bump this string whenever Terms/Privacy change. EVERY authenticated request
// is checked against it, including pre-existing accounts — that is the fix
// for the old build, which never forced existing accounts through the new
// legal screens.
const TERMS_VERSION = '2026-10-11.v1';

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'store.db');

function initDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('owner','developer','user')),
      birthdate TEXT,
      terms_version_accepted TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      kyc_status TEXT NOT NULL DEFAULT 'none' CHECK (kyc_status IN ('none','pending','verified')),
      kyc_note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS apps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      developer_id INTEGER NOT NULL REFERENCES users(id),
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'Tools',
      version TEXT NOT NULL DEFAULT '1.0',
      price_cents INTEGER NOT NULL DEFAULT 0,
      file_path TEXT,
      file_size INTEGER NOT NULL DEFAULT 0,
      icon_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      download_count INTEGER NOT NULL DEFAULT 0,
      copyright_attested INTEGER NOT NULL DEFAULT 0,
      rejection_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS screenshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL
    );

    -- Every paid movement of money lands here with its fee spelled out.
    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      type TEXT NOT NULL CHECK (type IN ('purchase','refund','payout')),
      app_id INTEGER REFERENCES apps(id),
      buyer_id INTEGER REFERENCES users(id),
      developer_id INTEGER REFERENCES users(id),
      gross_cents INTEGER NOT NULL,
      fee_cents INTEGER NOT NULL,
      net_cents INTEGER NOT NULL,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id INTEGER NOT NULL REFERENCES apps(id),
      buyer_id INTEGER NOT NULL REFERENCES users(id),
      ledger_id INTEGER NOT NULL REFERENCES ledger(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (app_id, buyer_id)
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (app_id, user_id)
    );

    -- Real-money checkout state. Rows are written when a Checkout Session is
    -- created; the ledger gets its 'purchase' row only when the Stripe webhook
    -- confirms checkout.session.completed, making the webhook idempotent.
    CREATE TABLE IF NOT EXISTS stripe_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      payment_intent TEXT,
      app_id INTEGER NOT NULL REFERENCES apps(id),
      buyer_id INTEGER NOT NULL REFERENCES users(id),
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','refunded')),
      ledger_id INTEGER REFERENCES ledger(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Manual Cash App orders. Buyer pays the owner's $cashtag in their own
    -- Cash App, then claims with their $cashtag; the owner approves after
    -- seeing the payment. The ledger row is written only on approval.
    CREATE TABLE IF NOT EXISTS cashapp_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id INTEGER NOT NULL REFERENCES apps(id),
      buyer_id INTEGER NOT NULL REFERENCES users(id),
      amount_cents INTEGER NOT NULL,
      buyer_cashtag TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','approved','rejected')),
      ledger_id INTEGER REFERENCES ledger(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Lightweight migrations for columns added after first deploy.
  for (const [table, column, ddl] of [['apps', 'icon_path', 'TEXT']]) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }

  seed(db);
  return db;
}

/**
 * Manual transaction helper (node:sqlite has no db.transaction()).
 * Usage: txn(db, () => { ... }) — commits on success, rolls back on throw.
 */
function txn(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

function seed(db) {
  const getUser = db.prepare('SELECT id FROM users WHERE username = ?');

  // --- Owner: Jelani Thompson ------------------------------------------------
  // Seeded with a STALE terms version on purpose: the first login must pass
  // through the retroactive Terms acceptance gate, proving the fix works.
  if (!getUser.get('jelani')) {
    const hash = bcrypt.hashSync('ChangeMe123!', 10);
    db.prepare(
      `INSERT INTO users (username, email, password_hash, role, birthdate,
        terms_version_accepted, must_change_password)
       VALUES ('jelani','jelanit448@gmail.com',?,'owner','1990-01-01','legacy-2026-09',1)`
    ).run(hash);
    console.log('[seed] owner account created: username "jelani" / password "ChangeMe123!" (must change on first login)');
  }
  const owner = db.prepare('SELECT id FROM users WHERE username = ?').get('jelani');

  // --- Legacy user: proves Terms gate applies to pre-existing accounts ------
  if (!getUser.get('legacyfan')) {
    const hash = bcrypt.hashSync('Test1234!', 10);
    db.prepare(
      `INSERT INTO users (username, email, password_hash, role, birthdate, terms_version_accepted)
       VALUES ('legacyfan','legacyfan@example.com',?,'user','1995-06-15','legacy-2026-09')`
    ).run(hash);
  }

  // --- First listing: ViralMode ---------------------------------------------
  const appExists = db.prepare('SELECT id FROM apps WHERE name = ?').get('ViralMode');
  if (!appExists) {
    const uploadsDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    const apkPath = path.join(uploadsDir, 'viralmode-1.0.0.apk');
    if (!fs.existsSync(apkPath)) {
      fs.writeFileSync(
        apkPath,
        'ViralMode 1.0.0 — placeholder package.\n' +
        'This demo file stands in for the real ViralMode APK until the production\n' +
        'build is uploaded through the developer dashboard.\n' +
        'Copyright (C) 2026 Jelani Thompson. Licensed GPL-3.0.\n'
      );
    }
    const size = fs.statSync(apkPath).size;
    db.prepare(
      `INSERT INTO apps (name, developer_id, description, category, version,
        price_cents, file_path, file_size, status, copyright_attested)
       VALUES (?,?,?,?,?,?,?,?,?,1)`
    ).run(
      'ViralMode',
      owner.id,
      'ViralMode — Promote your music, go viral, earn money, and land record deals.\n\n' +
        'Free and open-source app for independent musicians: upload music videos, get natural ' +
        'promotion, hit 100,000 views for a free viral push, land record deals in the Deal Room, ' +
        'run your own label, and collect Golden Tickets.\n\n' +
        'Features: video feed, free organic promotion, 9-perk Viral Package screen, AI audio editor ' +
        '(bass boost, EQ, vocal presence, trim, fades, tempo with WAV export), 100K-view viral rule, ' +
        'per-video dashboard, record labels with splits, money gifts, live rooms, Deal Room offers, ' +
        'song submissions, idea pitches, Owner Mode tools, Golden Tickets, Copyright Vault, 13+ legal screens, DMs, and search.\n\n' +
        'Copyright (C) 2026 Jelani Thompson. Licensed under GPL-3.0.',
      'Music & Audio',
      '1.0.0',
      0,
      apkPath,
      size,
      'approved'
    );
    console.log('[seed] ViralMode listed as the first approved app (free).');
  }
}

module.exports = { initDb, txn, TERMS_VERSION };
