'use strict';
/**
 * unlock_prices.js — set unlock prices across listings (run by the main agent).
 *
 * Usage: STORE_OWNER_PASS='...' node moneylayer/unlock_prices.js [--live=1-10,11-20]
 *
 * Reads every batch manifest.json (BOTH shapes: {apps:[...]} and bare
 * lists — the bare-list batches were silently skipped before Oct 19),
 * sets unlock_price_cents=199 for listings in LIVE batches (batches whose
 * rebuilt APKs carry the in-app money layer; --live takes batch numbers
 * and ranges, default 1-10) and 0 for every other listing (their APKs
 * don't have the unlock panel yet — selling a code nobody can redeem
 * would be dishonest; their wave sets 199 when their rebuilt APKs land).
 *
 * POST /api/owner/apps/:id/unlock-price also (re)derives + stores each app's
 * unlock_code_hash from its APK package name, so this one script readies
 * the whole store.
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.STORE_BASE || 'https://jelani-appstore.onrender.com';
const ROOT = path.join(__dirname, '..');

function parseLiveBatches() {
  const arg = process.argv.find((a) => a.startsWith('--live='));
  const spec = arg ? arg.slice('--live='.length) : '1-10';
  const out = new Set();
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) { console.error(`bad --live part: ${part}`); process.exit(1); }
    const lo = Number(m[1]), hi = m[2] ? Number(m[2]) : lo;
    for (let n = lo; n <= hi; n++) out.add(`batch${n}`);
  }
  return out;
}
const LIVE = parseLiveBatches();

async function main() {
  const pass = process.env.STORE_OWNER_PASS;
  if (!pass) { console.error('STORE_OWNER_PASS env required'); process.exit(1); }
  const login = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'jelani', password: pass }),
  });
  if (!login.ok) { console.error('login failed:', login.status); process.exit(1); }
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const H = { 'Content-Type': 'application/json', Cookie: cookie };

  const jobs = [];
  const seenIds = new Set();
  for (const dir of fs.readdirSync(ROOT).filter((d) => /^batch\d+$/.test(d)).sort()) {
    const mp = path.join(ROOT, dir, 'manifest.json');
    if (!fs.existsSync(mp)) continue;
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const apps = Array.isArray(m) ? m : (m.apps || []);
    for (const a of apps) {
      if (!a.listing_id || seenIds.has(a.listing_id)) continue;
      seenIds.add(a.listing_id);
      jobs.push({ batch: dir, slug: a.slug, id: a.listing_id, price: LIVE.has(dir) ? 199 : 0 });
    }
  }
  console.log(`setting unlock prices for ${jobs.length} listings (live batches ${[...LIVE].join(', ')} =199, rest=0)…`);
  let ok = 0, fail = 0;
  const failed = [];
  for (const j of jobs) {
    try {
      const r = await fetch(`${BASE}/api/owner/apps/${j.id}/unlock-price`, {
        method: 'POST', headers: H, body: JSON.stringify({ unlock_price_cents: j.price }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
      ok++;
    } catch (e) {
      fail++;
      failed.push(`${j.batch}/${j.slug} (#${j.id}): ${e.message}`);
    }
    if ((ok + fail) % 100 === 0) console.log(`  …${ok + fail}/${jobs.length}`);
  }
  console.log(`done: ${ok} ok, ${fail} failed`);
  if (failed.length) {
    console.log('failures:');
    for (const f of failed.slice(0, 20)) console.log('  ' + f);
    process.exitCode = 2;
  }
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
