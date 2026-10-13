'use strict';
/**
 * Regression test: AppMaker shell must handle <input type="file">.
 *
 * Builds a real APK through lib/appmaker.js (same pipeline as the store),
 * then proves:
 *   1. The full build pipeline still works (compile -> dex -> sign -> verify).
 *   2. classes.dex contains the file-chooser hook (onShowFileChooser) — i.e.
 *      tapping "Choose file" in any generated app opens the system picker.
 *   3. The generated manifest requests NO storage permissions.
 *   4. The starter template JS still passes the build-time JS audit.
 *
 * Run: node scripts/test-filechooser.js
 * Exits 0 on success, 1 on first failure. Prints PASS/FAIL per check.
 * Uses /tmp scratch dirs only; never touches the store DB or live store.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const am = require('../lib/appmaker.js');

let failures = 0;
function pass(name) { console.log(`  ✅ PASS  ${name}`); }
function fail(name, detail) {
  failures++;
  console.log(`  ❌ FAIL  ${name}${detail ? ' — ' + detail : ''}`);
}
function check(name, cond, detail) { cond ? pass(name) : fail(name, detail); }

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

async function main() {
  // --- scratch setup: point ensureSdk at the real local SDK without downloads ---
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amdata-'));
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amwork-'));
  const sdkLink = path.join(dataDir, 'android-sdk');
  fs.symlinkSync(path.join(os.homedir(), 'android-sdk'), sdkLink);
  fs.writeFileSync(path.join(sdkLink, '.appmaker-sdk-ready'), '');
  fs.symlinkSync('/usr/lib/jvm/java-17-openjdk-amd64', path.join(dataDir, 'jdk17'));
  check('scratch data dir ready', fs.existsSync(path.join(sdkLink, '.appmaker-sdk-ready')));

  // --- 1. build a real test app through the AppMaker pipeline ---
  console.log('Building test APK via generateApk (starter template)…');
  let result;
  try {
    result = am.generateApk({
      appName: 'FileChooser Test',
      packageName: 'com.example.filechoosertest',
      template: 'starter',
      color: '#c9a227',
      versionCode: 1,
      versionName: '1.0',
      workRoot,
      dataDir,
    });
  } catch (e) {
    fail('generateApk builds', e.message);
    process.exit(1);
  }
  pass('generateApk builds');
  console.log(`  APK: ${result.apkPath} (${result.size} bytes)`);
  check('APK file exists', fs.existsSync(result.apkPath));
  check('size is sane (< 1MB)', result.size > 10000 && result.size < 1024 * 1024, `${result.size} bytes`);

  // --- 2. dex contains the file-chooser hook ---
  const apkTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apkdex-'));
  run('unzip', ['-q', '-o', result.apkPath, 'classes.dex'], apkTmp);
  const dex = path.join(apkTmp, 'classes.dex');
  check('classes.dex extracted', fs.existsSync(dex));
  let stringsOut = '';
  try { stringsOut = run('strings', [dex]); } catch { stringsOut = ''; }
  // (Note: ACTION_OPEN_DOCUMENT / MODE_OPEN_MULTIPLE are static final constants —
  // javac inlines their values, so the dex holds the literal strings/ints,
  // not the constant names. Assert the values instead.)
  const need = [
    'onShowFileChooser',
    'WebChromeClient',
    'FileChooserParams',
    'parseResult',
    'android.intent.action.OPEN_DOCUMENT', // inlined value of Intent.ACTION_OPEN_DOCUMENT
    'android.intent.action.GET_CONTENT',  // inlined fallback value
    'ValueCallback',
  ];
  for (const s of need) {
    check(`dex contains ${s}`, stringsOut.includes(s));
  }

  // --- 3. generated source + manifest sanity ---
  const src = fs.readFileSync(
    path.join(result.workDir, 'src', 'com', 'example', 'filechoosertest', 'MainActivity.java'), 'utf8');
  for (const s of ['setWebChromeClient', 'onShowFileChooser', 'onActivityResult',
                   'parseResult', 'ACTION_OPEN_DOCUMENT', 'ACTION_GET_CONTENT',
                   'EXTRA_ALLOW_MULTIPLE', 'startActivityForResult']) {
    check(`MainActivity.java contains ${s}`, src.includes(s));
  }
  const manifest = fs.readFileSync(path.join(result.workDir, 'AndroidManifest.xml'), 'utf8');
  check('manifest has NO storage permissions',
    !/READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE/.test(manifest));
  check('manifest still has launcher activity', manifest.includes('android.intent.action.MAIN'));

  // --- 4. template JS still passes the build-time audit (no regression) ---
  const jsFiles = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f); else if (f.endsWith('.js')) jsFiles.push(f);
    }
  })(path.join(result.workDir, 'assets', 'www'));
  check('starter template has JS files', jsFiles.length > 0);
  let auditOk = true;
  for (const f of jsFiles) {
    try { am.auditJs(fs.readFileSync(f, 'utf8'), path.basename(f)); }
    catch (e) { auditOk = false; fail(`auditJs on ${path.basename(f)}`, e.message); }
  }
  if (auditOk) pass('auditJs green on starter template JS');

  // --- 5. signing + badging sanity (pipeline unchanged) ---
  const bt = path.join(os.homedir(), 'android-sdk', 'build-tools', '35.0.0');
  const verify = run(path.join(bt, 'apksigner'), ['verify', '--print-certs', result.apkPath]);
  check('apksigner verify OK', verify.includes('Signer #1'));
  const badging = run(path.join(bt, 'aapt2'), ['dump', 'badging', result.apkPath]);
  check('badging: package com.example.filechoosertest',
    badging.includes("package: name='com.example.filechoosertest'"));
  check('badging: versionCode 1', badging.includes("versionCode='1'"));

  console.log(failures === 0 ? '\nALL CHECKS PASSED ✅' : `\n${failures} CHECK(S) FAILED ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
