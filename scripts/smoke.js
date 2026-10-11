'use strict';
/**
 * Smoke test for Jelani's App Store.
 * Run: npm start (in one terminal) then node scripts/smoke.js
 * Exits 0 on success, 1 on first failure. Prints PASS/FAIL per check.
 */
const BASE = process.env.BASE_URL || 'http://localhost:3000';

let failures = 0;
function pass(name) { console.log(`  ✅ PASS  ${name}`); }
function fail(name, detail) {
  failures++;
  console.log(`  ❌ FAIL  ${name}${detail ? ' — ' + detail : ''}`);
}
function check(name, cond, detail) { cond ? pass(name) : fail(name, detail); }

// --- tiny cookie-jar client (session auth) ---
function makeClient() {
  let cookies = '';
  const client = {
    async req(method, path, body, raw) {
      const headers = { Cookie: cookies };
      let payload;
      if (raw) { payload = raw; }
      else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
      const res = await fetch(BASE + path, { method, headers, body: payload });
      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const sc of setCookies) cookies += sc.split(';')[0] + '; ';
      let data = null;
      const text = await res.text();
      try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text.slice(0, 120) }; }
      return { status: res.status, data, text };
    },
  };
  client.get = (p) => client.req('GET', p);
  client.post = (p, b) => client.req('POST', p, b);
  return client;
}

async function main() {
  console.log('Smoke test →', BASE);

  // 1. config
  {
    const c = makeClient();
    const r = await c.req('GET', '/api/config');
    check('config: demoMode true', r.status === 200 && r.data.demoMode === true, JSON.stringify(r.data));
    check('config: stripe NOT configured', r.data.stripeConfigured === false);
    check('config: fee is 10% (1000 bps)', r.data.platformFeeBps === 1000);
  }

  // 2. signup validation
  {
    const c = makeClient();
    let r = await c.req('POST', '/api/signup', { username: 'alice', email: 'alice@example.com', password: 'AlicePass1!', birthdate: '2000-01-01', accept_terms: true });
    check('signup alice works', r.status === 200 && r.data.ok === true, `status=${r.status} ${JSON.stringify(r.data)}`);
    r = await c.req('POST', '/api/signup', { username: 'kiddo', email: 'kid@example.com', password: 'KidPass12!', birthdate: '2020-01-01', accept_terms: true });
    check('under-13 signup rejected', r.status === 400, `status=${r.status}`);
    r = await c.req('POST', '/api/signup', { username: 'noterms', email: 'nt@example.com', password: 'NoTerms12!', birthdate: '2000-01-01', accept_terms: false });
    check('signup without terms rejected', r.status === 400, `status=${r.status}`);
  }

  // 3. retroactive Terms gate (legacy account seeded with stale terms)
  const legacy = makeClient();
  {
    let r = await legacy.req('POST', '/api/login', { username: 'legacyfan', password: 'Test1234!' });
    check('legacy login works', r.status === 200 && r.data.ok === true);
    check('legacy flagged must_accept_terms', r.data.must_accept_terms === true, JSON.stringify(r.data));
    r = await legacy.req('GET', '/api/apps');
    check('legacy blocked with TERMS_UPDATE_REQUIRED', r.status === 403 && r.data.error === 'TERMS_UPDATE_REQUIRED', `status=${r.status}`);
    r = await legacy.req('POST', '/api/accept-terms', { accept: true });
    check('legacy accepts new terms', r.status === 200 && r.data.ok === true);
    r = await legacy.req('GET', '/api/apps');
    check('legacy unblocked after accepting', r.status === 200 && Array.isArray(r.data.apps));
  }

  // 4. owner: forced password change + terms, then works
  const owner = makeClient();
  {
    let r = await owner.req('POST', '/api/login', { username: 'jelani', password: 'ChangeMe123!' });
    check('owner login works', r.status === 200 && r.data.user.role === 'owner');
    check('owner must change password', r.data.must_change_password === true);
    check('owner must accept terms (retroactive)', r.data.must_accept_terms === true);
    r = await owner.req('GET', '/api/owner/pending');
    check('owner blocked before terms', r.status === 403, `status=${r.status}`);
    await owner.req('POST', '/api/accept-terms', { accept: true });
    r = await owner.req('POST', '/api/change-password', { current: 'ChangeMe123!', next: 'OwnerPass456!' });
    check('owner changes password', r.status === 200 && r.data.ok === true, `status=${r.status}`);
    const owner2 = makeClient();
    r = await owner2.req('POST', '/api/login', { username: 'jelani', password: 'OwnerPass456!' });
    check('owner login with new password', r.status === 200 && r.data.ok === true);
  }

  // 5. developer uploads via chunked upload (6MB → 2 chunks); attestation enforced
  const dev = makeClient();
  let appId;
  {
    let r = await dev.req('POST', '/api/signup', { username: 'bobdev', email: 'bob@example.com', password: 'BobPass12!', birthdate: '1998-03-03', accept_terms: true });
    check('developer signup', r.status === 200);
    r = await dev.req('POST', '/api/become-developer', {});
    check('become-developer', r.status === 200 && r.data.role === 'developer');

    const file = Buffer.alloc(6 * 1024 * 1024, 'A'); // 6MB → 2 chunks of 5MB
    const CHUNK = 5 * 1024 * 1024;
    r = await dev.req('POST', '/api/upload/init', { filename: 'coolgame.apk', size_bytes: file.length, kind: 'appfile' });
    check('upload init', r.status === 200 && r.data.upload_id, `status=${r.status}`);
    const upId = r.data.upload_id;
    for (let i = 0; i < Math.ceil(file.length / CHUNK); i++) {
      const rr = await dev.req('POST', `/api/upload/chunk?upload_id=${upId}&index=${i}`, undefined, file.subarray(i * CHUNK, (i + 1) * CHUNK));
      if (rr.status !== 200) { fail('chunk upload', `chunk ${i} status=${rr.status}`); break; }
      if (i === 1) check('chunked upload (2 chunks)', true);
    }
    // attestation missing → rejected
    r = await dev.req('POST', '/api/upload/complete', { upload_id: upId, name: 'Cool Game', description: 'A fun game', category: 'Games', version: '1.0', price_cents: 100, copyright_attested: false });
    check('upload blocked without copyright attestation', r.status === 400, `status=${r.status}`);
    r = await dev.req('POST', '/api/upload/complete', { upload_id: upId, name: 'Cool Game', description: 'A fun game', category: 'Games', version: '1.0', price_cents: 100, copyright_attested: true });
    check('upload completes with attestation → pending', r.status === 200 && r.data.status === 'pending', `status=${r.status} ${JSON.stringify(r.data)}`);
    appId = r.data.app_id;
  }

  // 6. public listing: ViralMode visible, pending app hidden
  {
    const anon = makeClient();
    const r = await anon.req('GET', '/api/apps');
    const names = r.data.apps.map((a) => a.name);
    check('ViralMode is listed publicly', names.includes('ViralMode'), names.join(','));
    check('pending app hidden from public', !names.includes('Cool Game'));
    const v = r.data.apps.find((a) => a.name === 'ViralMode');
    check('ViralMode is free', v && v.price_cents === 0);
  }

  // 7. owner approves → app goes live
  {
    let r = await owner.req('GET', '/api/owner/pending');
    check('owner sees moderation queue', r.status === 200 && r.data.pending.some((a) => a.name === 'Cool Game'));
    r = await owner.req('POST', '/api/owner/approve', { app_id: appId, approve: true });
    check('owner approves app', r.status === 200 && r.data.status === 'approved');
    const anon = makeClient();
    const l = await anon.req('GET', '/api/apps');
    check('approved app now public', l.data.apps.some((a) => a.name === 'Cool Game'));
  }

  // 8. download counter (free app, anonymous)
  {
    const anon = makeClient();
    const list = await anon.req('GET', '/api/apps');
    const v = list.data.apps.find((a) => a.name === 'ViralMode');
    const before = v.download_count;
    const d = await anon.req('GET', `/api/apps/${v.id}/download`);
    check('free download works', d.status === 200, `status=${d.status}`);
    const after = (await anon.req('GET', '/api/apps')).data.apps.find((a) => a.name === 'ViralMode').download_count;
    check('download counter increments', after === before + 1, `${before} → ${after}`);
  }

  // 9. paid purchase: $1 → $0.90 dev / $0.10 platform, ledger written
  const alice = makeClient();
  let ledgerId;
  {
    await alice.req('POST', '/api/login', { username: 'alice', password: 'AlicePass1!' });
    let r = await alice.req('GET', `/api/apps/${appId}/download`);
    check('paid download blocked before purchase (402)', r.status === 402, `status=${r.status}`);
    r = await alice.req('POST', '/api/purchase', { app_id: appId });
    check('purchase succeeds', r.status === 200 && r.data.ok === true, `status=${r.status} ${JSON.stringify(r.data)}`);
    check('purchase split: $0.90 dev / $0.10 platform', r.data.developer_share === '$0.90' && r.data.platform_fee === '$0.10', JSON.stringify(r.data));
    check('purchase flagged demo', r.data.demo === true);
    ledgerId = r.data.ledger_id;
    r = await alice.req('GET', `/api/apps/${appId}/download`);
    check('download works after purchase', r.status === 200, `status=${r.status}`);
  }

  // 10. owner finance: totals + reconciliation
  {
    const r = await owner.req('GET', '/api/owner/finance');
    const t = Object.fromEntries(r.data.totals.map((x) => [x.type, x]));
    check('finance: purchase gross = 100c', t.purchase && t.purchase.gross === 100, JSON.stringify(t));
    check('finance: platform fee = 10c', t.purchase && t.purchase.fees === 10);
    check('finance: developer net = 90c', t.purchase && t.purchase.net === 90);
    check('reconciliation: all rows valid', r.data.reconciliation.ok === true && r.data.reconciliation.checked >= 1, JSON.stringify(r.data.reconciliation));
    check('reconciliation: no missing fees', r.data.reconciliation.mismatches.length === 0);
    const owed = r.data.perDeveloper.find((p) => p.developer === 'bobdev');
    check('bobdev owed $0.90', owed && owed.owed_cents === 90, JSON.stringify(r.data.perDeveloper));
  }

  // 11. developer earnings
  {
    const r = await dev.req('GET', '/api/dev/earnings');
    const e = r.data.earnings.find((x) => x.app_id === appId);
    check('developer sees $0.90 earnings', e && e.net_cents === 90 && e.sales === 1, JSON.stringify(r.data.earnings));
  }

  // 12. refund → negative ledger row, books still reconcile
  {
    let r = await owner.req('POST', '/api/refund', { ledger_id: ledgerId });
    check('owner refunds purchase', r.status === 200 && r.data.ok === true, `status=${r.status}`);
    r = await owner.req('GET', '/api/owner/finance');
    check('reconciliation still clean after refund', r.data.reconciliation.ok === true, JSON.stringify(r.data.reconciliation.mismatches));
    const e = await dev.req('GET', '/api/dev/earnings');
    const row = e.data.earnings.find((x) => x.app_id === appId);
    check('developer net back to $0.00 after refund', row && row.net_cents === 0, JSON.stringify(e.data.earnings));
    r = await alice.req('GET', `/api/apps/${appId}/download`);
    check('download blocked again after refund (402)', r.status === 402, `status=${r.status}`);
  }

  // 13. reviews
  {
    const r = await alice.req('POST', `/api/apps/${appId}/reviews`, { rating: 5, text: 'Great game!' });
    check('review posted', r.status === 200 && r.data.ok === true);
    const anon = makeClient();
    const d = await anon.req('GET', '/api/apps/' + appId);
    check('review visible publicly', d.status === 200 && d.data.reviews.some((x) => x.text === 'Great game!'));
  }

  // 14. Stripe routes in DEMO mode (no STRIPE_SECRET_KEY in this env)
  {
    const anon = makeClient();
    const cfg = await anon.req('GET', '/api/config');
    check('config reports demoMode when Stripe not connected',
      cfg.data.demoMode === true && cfg.data.stripeConfigured === false, JSON.stringify(cfg.data));

    // checkout creation is refused in demo mode, with a demo fallback pointer
    const co = await alice.req('POST', '/api/purchase/checkout', { app_id: appId });
    check('checkout returns 503 STRIPE_UNCONFIGURED in demo mode',
      co.status === 503 && co.data.code === 'STRIPE_UNCONFIGURED' && co.data.fallback === '/api/purchase',
      `status=${co.status}`);

    // webhook rejects unsigned/forged payloads
    const wh = await anon.req('POST', '/api/webhook/stripe',
      undefined,
      JSON.stringify({ type: 'checkout.session.completed' }));
    check('webhook rejects bad signature (400)', wh.status === 400, `status=${wh.status}`);

    // session-status needs auth and a real session id
    const ss0 = await anon.req('GET', '/api/purchase/session-status?session_id=nope');
    check('session-status requires auth', ss0.status === 401 || ss0.status === 403, `status=${ss0.status}`);
    const ss1 = await alice.req('GET', '/api/purchase/session-status?session_id=cs_bogus');
    check('session-status 404 for unknown session', ss1.status === 404, `status=${ss1.status}`);
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED ✅' : `\n${failures} CHECK(S) FAILED ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('SMOKE CRASH:', e); process.exit(1); });
