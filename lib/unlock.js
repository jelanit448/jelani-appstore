'use strict';
/**
 * unlock.js — per-app "full version" unlock codes for the free-demo model.
 *
 * Scheme (deterministic, server-derivable):
 *   code = 'FULL-' + 16 chars drawn from a 32-symbol alphabet (80 bits),
 *          grouped as FULL-XXXX-XXXX-XXXX-XXXX
 *   code = f(UNLOCK_CODE_SECRET, 'jelani-unlock-v1:' + packageName)
 *   stored server-side:  SHA-256(code) hex only (never the plaintext)
 *   baked into the app:  the same SHA-256 hex; the app verifies offline
 *   buyer delivery:      GET /api/apps/:id/unlock-code re-derives the code
 *                        for buyers with an APPROVED unlock order.
 *
 * The secret comes from the UNLOCK_CODE_SECRET env var. A clearly-labeled
 * DEV fallback exists so local tests run; production MUST set the env var
 * (see moneylayer/BUILD_REPORT.md for the deploy step).
 *
 * KNOWN LIMITATION (documented, accepted): the in-app check is client-side.
 * Anyone who can read the baked hash still cannot reverse it (SHA-256
 * preimage), but a determined person can patch the app or flip the
 * localStorage flag and skip paying. This is a friction mechanism for
 * honest users at the $1.99 price point — the same accepted weakness as the
 * East Side Dash unlock-pack codes. It is never presented as unbreakable.
 */

const crypto = require('crypto');

// No easily-confused characters (no 0/O, 1/I/L).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function getSecret() {
  const s = process.env.UNLOCK_CODE_SECRET;
  if (s && s.length >= 16) return s;
  // Dev/test fallback — NEVER the production secret.
  return 'DEV-ONLY-unlock-fallback-not-for-production';
}

function isDevSecret() {
  const s = process.env.UNLOCK_CODE_SECRET;
  return !(s && s.length >= 16);
}

/**
 * Deterministically derive the unlock code for an app identity
 * (the Android package name, e.g. 'com.jelani.grilltime').
 */
function deriveCode(packageName) {
  const pkg = String(packageName || '').trim().toLowerCase();
  if (!pkg) throw new Error('deriveCode: package name required');
  const digest = crypto
    .createHmac('sha256', getSecret())
    .update('jelani-unlock-v1:' + pkg)
    .digest();
  // Bit-reader: acc always holds exactly `bits` unconsumed bits in its low bits.
  let acc = 0;
  let bits = 0;
  let bi = 0;
  let payload = '';
  while (payload.length < 16) {
    while (bits < 5) {
      if (bi >= digest.length) throw new Error('deriveCode: entropy exhausted (impossible)');
      acc = (acc << 8) | digest[bi++];
      bits += 8;
    }
    // NOTE: >>> binds LOOSER than &, so the inner parens are required.
    const idx = ((acc >>> (bits - 5)) & 31);
    bits -= 5;
    acc &= (1 << bits) - 1;
    if (idx === 31) continue; // rejection sampling: keeps the no-confusion 31-symbol alphabet uniform
    payload += ALPHABET[idx];
  }
  const groups = payload.match(/.{1,4}/g).join('-');
  return 'FULL-' + groups;
}

/** SHA-256 hex of a canonical code — the value baked into apps and stored in the DB. */
function codeHash(code) {
  return crypto.createHash('sha256').update(normalizeCode(code)).digest('hex');
}

/**
 * Normalize user-typed input to canonical form: uppercase, strip everything
 * except A-Z0-9, then re-insert dashes as FULL-XXXX-XXXX-XXXX-XXXX.
 * Throws on input that cannot be a code.
 */
function normalizeCode(input) {
  const clean = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^FULL[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{16}$/.test(clean)) {
    throw new Error('That code does not look right — check it and try again.');
  }
  const payload = clean.slice(4);
  return 'FULL-' + payload.match(/.{1,4}/g).join('-');
}

/** Verify a user-entered code against a baked/stored hash. */
function verifyCode(input, expectedHash) {
  let canonical;
  try {
    canonical = normalizeCode(input);
  } catch {
    return false;
  }
  const got = crypto.createHash('sha256').update(canonical).digest('hex');
  const a = Buffer.from(got, 'hex');
  const b = Buffer.from(String(expectedHash || ''), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Extract the Android package name from an APK via aapt2 dump badging. */
function packageNameFromApk(apkPath, aapt2Path) {
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  if (!apkPath || !fs.existsSync(apkPath)) return null;
  try {
    const out = execFileSync(aapt2Path, ['dump', 'badging', apkPath], {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    }).toString();
    const m = out.match(/package:\s*name='([^']+)'/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

module.exports = {
  ALPHABET,
  getSecret,
  isDevSecret,
  deriveCode,
  codeHash,
  normalizeCode,
  verifyCode,
  packageNameFromApk,
};
