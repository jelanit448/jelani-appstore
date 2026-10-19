'use strict';
/**
 * unlock_prices.js — set unlock prices across listings (run by the main agent).
 *
 * Usage: STORE_OWNER_PASS='...' node moneylayer/unlock_prices.js
 *
 * Reads every batch manifest.json, sets unlock_price_cents=199 for the
 * wave-1 apps (batches 1-10, which carry the in-app money layer) and 0 for
 * every other listing (their APKs don't have the unlock panel yet — selling
 * a code nobody can redeem would be dishonest; their wave sets 199 when
 * their rebuilt APKs land).
 *
 * POST /api/owner/apps/:id/unlock-price also (re)derives + stores each app's
 * unlock_code_hash from its APK package name, so this one script readies
 * the whole store.
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.STORE_BASE || 'https://jelani-appstore.onrender.com';
const ROOT = path.join(__dirname, '..');
const WAVE1 = new Set(Array.from({ length: 10 }, (_, i) => `batch${i + 1}`));

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
  for (const dir of fs.readdirSync(ROOT).filter((d) => /^batch\d+$/.test(d)).sort()) {
    const mp = path.join(ROOT, dir, 'manifest.json');
    if (!fs.existsSync(mp)) continue;
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    for (const a of m.apps || []) {
      if (a.listing_id) jobs.push({ batch: dir, slug: a.slug, id: a.listing_id, price: WAVE1.has(dir) ? 199 : 0 });
    }
  }
  console.log(`setting unlock prices for ${jobs.length} listings (wave1=199, rest=0)…`);
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
