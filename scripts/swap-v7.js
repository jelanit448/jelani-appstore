// ONE-TIME admin script: run on the Render shell to swap ViralMode to v7,
// set the price, and reset the owner password. Delete from repo after use.
'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const https = require('https');
const path = require('path');

const DB = '/app/data/store.db';
const UPLOADS = '/app/data/uploads';
const APK_URL = 'https://raw.githubusercontent.com/jelanit448/jelani-appstore/main/public/downloads/ViralMode-v7.apk';
const APK_DEST = path.join(UPLOADS, 'viralmode-v7.apk');
const EXPECTED_SIZE = 54875;
// bcrypt hash of the temporary owner password (Jelani changes it after login)
const PW_HASH = '$2a$10$AY4fKwGcwOwbfi0G9dQTkOwSfVLUd2bYCOEReKwfYv.hqayGalJIS';

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (e) => { try { fs.unlinkSync(dest); } catch {} reject(e); });
  });
}

(async () => {
  fs.mkdirSync(UPLOADS, { recursive: true });
  console.log('downloading v7 apk...');
  await download(APK_URL, APK_DEST);
  const size = fs.statSync(APK_DEST).size;
  console.log('apk size:', size);
  if (size !== EXPECTED_SIZE) throw new Error(`size mismatch: got ${size}, want ${EXPECTED_SIZE}`);

  const db = new DatabaseSync(DB);
  // 1. owner password reset
  let r = db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE username = ?')
    .run(PW_HASH, 'jelani');
  console.log('password rows updated:', r.changes);

  // 2. swap app file + version + price, remember old file for cleanup
  const old = db.prepare('SELECT file_path FROM apps WHERE id = 1').get();
  r = db.prepare('UPDATE apps SET file_path = ?, file_size = ?, version = ?, price_cents = ? WHERE id = 1')
    .run(APK_DEST, size, '1.0.6', 199);
  console.log('app rows updated:', r.changes);
  if (old && old.file_path && old.file_path !== APK_DEST) {
    try { fs.unlinkSync(old.file_path); console.log('deleted old apk:', old.file_path); }
    catch (e) { console.log('old apk cleanup skipped:', e.message); }
  }
  const a = db.prepare('SELECT version, file_size, price_cents FROM apps WHERE id = 1').get();
  console.log('FINAL:', JSON.stringify(a));
  db.close();
  if (a.version !== '1.0.6' || a.file_size !== EXPECTED_SIZE || a.price_cents !== 199) {
    throw new Error('verification failed');
  }
  console.log('SWAP COMPLETE');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
