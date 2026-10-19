'use strict';
/**
 * replace.js template — per-batch copies live in batchN/replace.js.
 *
 * Swaps rebuilt APKs onto EXISTING store listings via the owner replace-file
 * flow: /api/upload/init (kind appfile) -> chunk uploads -> 
 * POST /api/owner/apps/:id/replace-file {upload_id, version}.
 *
 * Usage: STORE_OWNER_PASS='...' node batch1/replace.js [slug...]
 * Reads listing IDs from the batch manifest.json. NEVER commit a password —
 * it comes only from the env var.
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.STORE_BASE || 'https://jelani-appstore.onrender.com';
const BATCH_DIR = __dirname; // copied into each batch dir
const VERSION = '1.1';

async function main() {
  const pass = process.env.STORE_OWNER_PASS;
  if (!pass) { console.error('STORE_OWNER_PASS env required'); process.exit(1); }
  const manifest = JSON.parse(fs.readFileSync(path.join(BATCH_DIR, 'manifest.json'), 'utf8'));
  const only = new Set(process.argv.slice(2));
  const apps = (manifest.apps || []).filter((a) => !only.size || only.has(a.slug));

  const login = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'jelani', password: pass }),
  });
  if (!login.ok) { console.error('login failed:', login.status); process.exit(1); }
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const H = { Cookie: cookie };

  let ok = 0, fail = 0;
  for (const a of apps) {
    const label = `${a.slug} (#${a.listing_id})`;
    try {
      if (!a.listing_id) throw new Error('no listing_id in manifest');
      const apkPath = path.join(BATCH_DIR, 'apks', `${a.slug}.apk`);
      if (!fs.existsSync(apkPath)) throw new Error('APK missing: ' + apkPath);
      const size = fs.statSync(apkPath).size;
      const initR = await fetch(BASE + '/api/upload/init', {
        method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: `${a.slug}-1.1.apk`, size_bytes: size, kind: 'appfile' }),
      });
      const init = await initR.json();
      if (!initR.ok) throw new Error('init: ' + (init.error || initR.status));
      const CH = 5 * 1024 * 1024;
      const buf = fs.readFileSync(apkPath);
      let idx = 0;
      for (let off = 0; off < buf.length; off += CH, idx++) {
        const chunk = buf.subarray(off, Math.min(off + CH, buf.length));
        const cr = await fetch(`${BASE}/api/upload/chunk?upload_id=${init.upload_id}&index=${idx}`, {
          method: 'POST', headers: H, body: chunk,
        });
        if (!cr.ok) throw new Error('chunk ' + idx + ': ' + cr.status);
      }
      const rr = await fetch(`${BASE}/api/owner/apps/${a.listing_id}/replace-file`, {
        method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ upload_id: init.upload_id, version: VERSION }),
      });
      const rd = await rr.json();
      if (!rr.ok) throw new Error('replace-file: ' + (rd.error || rr.status));
      ok++;
      console.log(`OK ${label} (${(size / 1024).toFixed(0)} KB)`);
    } catch (e) {
      fail++;
      console.error(`FAIL ${label}: ${e.message}`);
    }
  }
  console.log(`replace done: ${ok} ok, ${fail} failed`);
  const report = { at: new Date().toISOString(), ok, fail };
  fs.writeFileSync(path.join(BATCH_DIR, 'replace-report.json'), JSON.stringify(report, null, 2));
  if (fail) process.exitCode = 2;
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
