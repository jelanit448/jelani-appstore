'use strict';
/**
 * inject.js — injects the money layer into a batch's app sources.
 *
 * Usage: node moneylayer/inject.js batch1 [batch2 ...]
 *   or:  node moneylayer/inject.js --all-wave1   (batches 1..10)
 *
 * For each app in batchN/apps/<slug>/:
 *  - reads meta.json (needs .package and .name)
 *  - derives the unlock code + hash via lib/unlock.js (same secret the
 *    server uses: UNLOCK_CODE_SECRET env, else moneylayer/.secret)
 *  - writes www/moneylayer.js with %%ML_*%% placeholders replaced
 *  - inserts <script src="moneylayer.js"></script> into www/index.html
 *    right before the app.js script tag (idempotent — skips if present)
 *  - records {slug, package, listing_id, code, code_hash} for the wave map
 *
 * The wave map is written to moneylayer/wave1_codes.json (gitignored —
 * it holds PLAINTEXT codes). The main agent loads unlock_code_hash values
 * into the DB at deploy via POST /api/owner/apps/:id/unlock-price.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const unlock = require(path.join(ROOT, 'lib', 'unlock'));

function getSecret() {
  if (process.env.UNLOCK_CODE_SECRET && process.env.UNLOCK_CODE_SECRET.length >= 16) {
    return process.env.UNLOCK_CODE_SECRET;
  }
  const p = path.join(__dirname, '.secret');
  if (fs.existsSync(p)) {
    const s = fs.readFileSync(p, 'utf8').trim();
    if (s.length >= 16) return s;
  }
  throw new Error('No unlock secret: set UNLOCK_CODE_SECRET or create moneylayer/.secret');
}

function injectBatch(batchDir, secret, waveMap) {
  const batchPath = path.join(ROOT, batchDir);
  const appsDir = path.join(batchPath, 'apps');
  const manifestPath = path.join(batchPath, 'manifest.json');
  if (!fs.existsSync(appsDir)) throw new Error(`no apps dir: ${appsDir}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const listingBySlug = {};
  for (const a of manifest.apps || []) listingBySlug[a.slug] = a.listing_id;

  const template = fs.readFileSync(path.join(__dirname, 'moneylayer.js'), 'utf8');
  if (template.indexOf('%%ML_HASH%%') < 0) throw new Error('moneylayer.js template missing placeholders');

  const slugs = fs.readdirSync(appsDir).filter((s) =>
    fs.statSync(path.join(appsDir, s)).isDirectory()).sort();
  let n = 0;
  for (const slug of slugs) {
    const appDir = path.join(appsDir, slug);
    const metaPath = path.join(appDir, 'meta.json');
    const wwwDir = path.join(appDir, 'www');
    const indexPath = path.join(wwwDir, 'index.html');
    if (!fs.existsSync(metaPath) || !fs.existsSync(indexPath)) {
      console.log(`[${batchDir}] SKIP ${slug}: missing meta.json or www/index.html`);
      continue;
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const pkg = String(meta.package || '').trim();
    if (!pkg) { console.log(`[${batchDir}] SKIP ${slug}: no package in meta.json`); continue; }
    const name = String(meta.name || slug);
    const code = unlock.deriveCode(pkg);
    const hash = unlock.codeHash(code);
    const price = '$1.99';

    const filled = template
      .split('%%ML_SLUG%%').join(slug)
      .split('%%ML_APPNAME%%').join(name.replace(/'/g, "\\'"))
      .split('%%ML_PRICE%%').join(price)
      .split('%%ML_HASH%%').join(hash);
    if (filled.indexOf('%%ML_') >= 0) throw new Error(`unreplaced placeholder in ${slug}`);
    fs.writeFileSync(path.join(wwwDir, 'moneylayer.js'), filled);

    let html = fs.readFileSync(indexPath, 'utf8');
    if (html.indexOf('moneylayer.js') < 0) {
      const tag = '<script src="moneylayer.js"></script>';
      if (html.indexOf('<script src="app.js"') >= 0) {
        html = html.replace('<script src="app.js"', tag + '\n<script src="app.js"');
      } else if (html.indexOf('</body>') >= 0) {
        html = html.replace('</body>', tag + '\n</body>');
      } else {
        html += '\n' + tag + '\n';
      }
      fs.writeFileSync(indexPath, html);
    }
    waveMap.push({
      batch: batchDir, slug, package: pkg,
      listing_id: listingBySlug[slug] == null ? null : listingBySlug[slug],
      code, code_hash: hash,
    });
    n++;
  }
  console.log(`[${batchDir}] injected ${n}/${slugs.length} apps`);
  return n;
}

function main() {
  const args = process.argv.slice(2);
  let batches = args;
  if (args.includes('--all-wave1')) batches = Array.from({ length: 10 }, (_, i) => `batch${i + 1}`);
  if (!batches.length) {
    console.error('usage: node moneylayer/inject.js batch1 [batch2 ...] | --all-wave1');
    process.exit(1);
  }
  const secret = getSecret();
  process.env.UNLOCK_CODE_SECRET = secret;
  const waveMapPath = path.join(__dirname, 'wave1_codes.json');
  let waveMap = [];
  if (fs.existsSync(waveMapPath)) {
    try { waveMap = JSON.parse(fs.readFileSync(waveMapPath, 'utf8')).apps || []; } catch { waveMap = []; }
  }
  const seen = new Set(waveMap.map((e) => e.batch + '/' + e.slug));
  waveMap = waveMap.filter((e) => !batches.includes(e.batch)); // re-inject cleanly
  let total = 0;
  for (const b of batches) total += injectBatch(b, secret, waveMap);
  fs.writeFileSync(waveMapPath, JSON.stringify({ generated_at: new Date().toISOString(), apps: waveMap }, null, 2));
  fs.chmodSync(waveMapPath, 0o600);
  console.log(`wave map: ${waveMapPath} (${waveMap.length} apps) — PLAINTEXT codes, gitignored, mode 600`);
  console.log(`TOTAL injected: ${total}`);
}

main();
