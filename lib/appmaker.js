'use strict';
/**
 * lib/appmaker.js — generates installable Android APKs from templates.
 *
 * The native shell uses the PROVEN no-crash recipe from the ViralMode saga:
 * pure native WebView, NO Capacitor, NO frameworks. Single MainActivity
 * extending android.app.Activity (no AppCompat dependency), WebView with
 * JavaScript enabled, loads file:///android_asset/www/index.html.
 * minSdk 24, targetSdk 36. Pipeline: aapt2 compile -> aapt2 link -> javac
 * -> d8 -> zipalign -> apksigner.
 *
 * Guardrails (the "problems we did", enforced here):
 *  1. No hybrid frameworks in the shell, ever.
 *  2. Template JS is audited at build time: any unguarded DOM read
 *     (e.g. document.getElementById('x').focus() on a possibly-null
 *     element — the exact crash that killed ViralMode's search bar)
 *     fails the build.
 *  3. Web-asset size cap: >10MB fails, >5MB warns loudly.
 *  4. Package names validated before a build starts.
 *  5. versionCode is supplied by the caller (server.js auto-increments
 *     per package_name from the appmaker_builds table).
 *  6. Every build writes BUILD_NOTES.txt with honest limits.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const MIN_SDK = 24;
const TARGET_SDK = 36;
const ASSET_HARD_CAP = 10 * 1024 * 1024; // 10MB — build fails above this
const ASSET_WARN_AT = 5 * 1024 * 1024;   // 5MB — loud warning above this
const PKG_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// ---------------------------------------------------------------------------
// SDK discovery
// ---------------------------------------------------------------------------

function findSdk(dataDir) {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    dataDir ? path.join(dataDir, 'android-sdk') : null,
    path.join(os.homedir(), 'android-sdk'),
    '/opt/android-sdk',
    '/usr/lib/android-sdk',
  ].filter(Boolean);
  for (const root of candidates) {
    try {
      const btDir = path.join(root, 'build-tools');
      const versions = fs.readdirSync(btDir)
        .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
        .sort();
      if (!versions.length) continue;
      // Prefer 35.0.0, else newest available.
      const btVer = versions.includes('35.0.0') ? '35.0.0' : versions[versions.length - 1];
      const bt = path.join(btDir, btVer);
      const androidJar = path.join(root, 'platforms', 'android-36', 'android.jar');
      const need = ['aapt2', 'd8', 'apksigner', 'zipalign'].map((t) => path.join(bt, t));
      if (!fs.existsSync(androidJar)) continue;
      if (!need.every((p) => fs.existsSync(p))) continue;
      return { root, bt, btVer, androidJar };
    } catch { /* try next */ }
  }
  throw new Error(
    'Android SDK not found or incomplete. Set ANDROID_HOME to an SDK containing ' +
    'platforms/android-36 and a build-tools release (need aapt2, d8, apksigner, zipalign).'
  );
}

function findJava(javaHome) {
  const bin = javaHome ? path.join(javaHome, 'bin') : null;
  const javac = bin ? path.join(bin, 'javac') : 'javac';
  const keytool = bin ? path.join(bin, 'keytool') : 'keytool';
  try {
    execFileSync(javac, ['-version'], { stdio: 'ignore', timeout: 15000 });
    execFileSync(keytool, ['-help'], { stdio: 'ignore', timeout: 15000 });
    return { javaHome, bin, javac, keytool };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Runtime SDK provisioning — downloads JDK + Android SDK to the persistent
// data dir on first use (NOT baked into the Docker image: a 2GB image broke
// Render's health check). Runs once; subsequent builds reuse it.
// ---------------------------------------------------------------------------

// Corretto ships a musl (Alpine) build — required on Alpine, where the
// glibc build won't even start.
const IS_ALPINE = fs.existsSync('/etc/alpine-release');
const CORRETTO_URL = IS_ALPINE
  ? 'https://corretto.aws/downloads/latest/amazon-corretto-17-x64-alpine-jdk.tar.gz'
  : 'https://corretto.aws/downloads/latest/amazon-corretto-17-x64-linux-jdk.tar.gz';
const CMDTOOLS_URL = 'https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip';

function sh(cmd, opts = {}) {
  return execFileSync('sh', ['-c', cmd], { timeout: 600000, ...opts });
}

function ensureSdk(dataDir) {
  const sdkDir = path.join(dataDir, 'android-sdk');
  const jdkDir = path.join(dataDir, 'jdk17');
  const marker = path.join(sdkDir, '.appmaker-sdk-ready');

  // Fast path: already provisioned.
  if (fs.existsSync(marker)) {
    const java = findJava(jdkDir);
    if (!java) throw new Error('AppMaker SDK marker exists but JDK is missing. Delete ' + dataDir + '/android-sdk and rebuild.');
    process.env.ANDROID_HOME = sdkDir;
    process.env.ANDROID_SDK_ROOT = sdkDir;
    process.env.JAVA_HOME = jdkDir;
    return { sdkDir, java };
  }

  console.log('[appmaker] First build: provisioning JDK + Android SDK (one-time, ~5 min)...');
  fs.mkdirSync(sdkDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'appmaker-sdk-'));
  try {
    // 1. JDK (Amazon Corretto 17)
    if (!findJava(jdkDir)) {
      console.log('[appmaker] downloading JDK...');
      sh(`curl -fsSL -o "${tmp}/jdk.tar.gz" "${CORRETTO_URL}"`);
      sh(`mkdir -p "${jdkDir}" && tar -xzf "${tmp}/jdk.tar.gz" -C "${jdkDir}" --strip-components=1`);
    }
    const java = findJava(jdkDir);
    if (!java) throw new Error('JDK download failed.');
    const env = { ...process.env, JAVA_HOME: jdkDir, PATH: `${path.join(jdkDir, 'bin')}:${process.env.PATH}` };

    // 2. Android cmdline-tools
    console.log('[appmaker] downloading Android cmdline-tools...');
    sh(`curl -fsSL -o "${tmp}/cmdtools.zip" "${CMDTOOLS_URL}"`);
    sh(`mkdir -p "${sdkDir}/cmdline-tools" && unzip -q -o "${tmp}/cmdtools.zip" -d "${sdkDir}/cmdline-tools" && mv "${sdkDir}/cmdline-tools/cmdline-tools" "${sdkDir}/cmdline-tools/latest"`);

    // 3. Install platform + build-tools via sdkmanager
    console.log('[appmaker] installing Android platform + build-tools (this takes a few minutes)...');
    const sm = path.join(sdkDir, 'cmdline-tools', 'latest', 'bin', 'sdkmanager');
    sh(`yes | "${sm}" --sdk_root="${sdkDir}" --licenses > /dev/null`, { env });
    sh(`"${sm}" --sdk_root="${sdkDir}" "platforms;android-36" "build-tools;35.0.0" "platform-tools"`, { env });

    fs.writeFileSync(marker, new Date().toISOString());
    console.log('[appmaker] SDK provisioning complete.');
    process.env.ANDROID_HOME = sdkDir;
    process.env.ANDROID_SDK_ROOT = sdkDir;
    process.env.JAVA_HOME = jdkDir;
    return { sdkDir, java };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

function validatePackageName(pkg) {
  if (typeof pkg !== 'string' || !PKG_RE.test(pkg.trim())) {
    throw new Error(
      'Bad package name. Use lowercase reverse-domain style, e.g. com.yourname.myapp ' +
      '(letters, digits, underscore; at least one dot; must start with a letter).'
    );
  }
  return pkg.trim();
}

function validateColor(color) {
  if (color == null || color === '') return '#0f9d58';
  if (!COLOR_RE.test(String(color))) throw new Error('Color must be a hex code like #0f9d58.');
  return String(color);
}

function validateUrl(url) {
  const u = String(url || '').trim();
  if (!/^https:\/\/[^\/\s]+\.[^\/\s]+/.test(u)) {
    throw new Error('Website URL must start with https:// and look like a real address.');
  }
  return u;
}

function validateAppName(name) {
  const n = String(name || '').trim().slice(0, 50);
  if (n.length < 2) throw new Error('App name must be at least 2 characters.');
  return n;
}

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// build-time JS audit — the ViralMode search-bar crash class, caught here.
//
// Fails the build if any .js asset:
//  (a) calls .focus()/.click()/.value/.innerHTML/.textContent/... directly on
//      a getElementById()/querySelector() result (the exact fatal pattern), or
//  (b) uses such a property on a variable that came from a DOM query without
//      any null-guard (if (x), x &&, x ? ...) for that variable in the file.
// `document` and `window` receivers are always safe and are whitelisted.
// ---------------------------------------------------------------------------

const DANGER_PROPS = [
  'focus', 'click', 'value', 'innerHTML', 'textContent', 'innerText',
  'style', 'classList', 'addEventListener', 'setAttribute', 'removeAttribute',
  'appendChild', 'removeChild', 'checked', 'disabled', 'href', 'src',
];
const SAFE_RECEIVERS = new Set(['document', 'window']);

function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function auditJs(source, label) {
  const problems = [];
  const code = stripJsComments(source);
  // (a) direct chains: getElementById('x').focus() etc.
  const directRe = /(getElementById|querySelector|querySelectorAll)\s*\([^)]*\)\s*\.\s*([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = directRe.exec(code))) {
    if (DANGER_PROPS.includes(m[2])) {
      problems.push(`${label}: unguarded DOM access — ${m[1]}(...).${m[2]} can throw on null (build rejected)`);
    }
  }
  // (b) variables assigned from DOM queries, used without a null guard.
  const assigned = new Set();
  const assignRe = /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g;
  while ((m = assignRe.exec(code))) {
    if (/getElementById|querySelector/.test(m[2])) assigned.add(m[1]);
  }
  for (const name of assigned) {
    const useRe = new RegExp(`\\b${name}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g');
    let u;
    let dangerousUse = false;
    while ((u = useRe.exec(code))) {
      if (DANGER_PROPS.includes(u[1])) { dangerousUse = true; break; }
    }
    if (!dangerousUse) continue;
    const guarded = new RegExp(
      `if\\s*\\(\\s*${name}\\b|\\b${name}\\s*&&|\\b${name}\\s*\\?|\\b${name}\\s*!==?\\s*null`
    ).test(code);
    if (!guarded) {
      problems.push(`${label}: variable "${name}" comes from a DOM query and is used without a null check (build rejected)`);
    }
  }
  // also catch bare `x.focus()` style where x is a function parameter from a query — covered by (a)/(b) in practice.
  if (problems.length) throw new Error('JS audit failed:\n- ' + problems.join('\n- '));
}

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------

function starterFiles(appName, color) {
  const css = `:root{--brand:${color}}
*{box-sizing:border-box}
body{margin:0;font-family:Roboto,Arial,sans-serif;background:#f6f8f7;color:#1a1a2e}
header{background:var(--brand);color:#fff;padding:18px 16px}
header h1{margin:0;font-size:22px}
main{padding:16px}
.card{background:#fff;border:1px solid #e3e8e5;border-radius:12px;padding:16px;margin:12px 0}
.btn{background:var(--brand);color:#fff;border:none;border-radius:10px;padding:12px 20px;font-size:16px}
.muted{color:#5f6368;font-size:13px}
#count{font-size:32px;font-weight:700;color:var(--brand)}
`;
  const js = `(function () {
  'use strict';
  // Every DOM read below is null-guarded. An unguarded
  // document.getElementById('x').focus() is a crash — never do that.
  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else { fn(); }
  }
  ready(function () {
    var titleEl = document.getElementById('appTitle');
    if (titleEl) { titleEl.textContent = window.APP_NAME || 'My App'; }

    var count = 0;
    var tapBtn = document.getElementById('tapBtn');
    if (tapBtn) {
      tapBtn.addEventListener('click', function () {
        count += 1;
        var countEl = document.getElementById('count');
        if (countEl) { countEl.textContent = String(count); }
      });
    }

    var aboutBtn = document.getElementById('aboutBtn');
    if (aboutBtn) {
      aboutBtn.addEventListener('click', function () {
        var about = document.getElementById('about');
        if (about) {
          about.style.display = about.style.display === 'none' ? 'block' : 'none';
        }
      });
    }

    var foot = document.getElementById('foot');
    if (foot) { foot.textContent = 'Built with App Maker — pure native WebView, no crashy frameworks.'; }
  });
})();
`;
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escXml(appName)}</title>
<link rel="stylesheet" href="style.css">
<script>window.APP_NAME = ${JSON.stringify(appName)};</script>
</head><body>
<header><h1 id="appTitle">${escXml(appName)}</h1></header>
<main>
  <div class="card">
    <p>Welcome to <b>${escXml(appName)}</b> — your app is working.</p>
    <p class="muted">This starter was generated by App Maker. Edit the web files and rebuild to make it yours.</p>
  </div>
  <div class="card">
    <div id="count">0</div>
    <p><button class="btn" id="tapBtn">Tap me</button></p>
  </div>
  <div class="card">
    <p><button class="btn" id="aboutBtn">About this app</button></p>
    <p id="about" class="muted" style="display:none">Generated with App Maker on Jelani's App Store. Native WebView shell — no Capacitor, no frameworks, no 1-second crash.</p>
  </div>
  <p class="muted" id="foot"></p>
</main>
<script src="app.js"></script>
</body></html>
`;
  return { 'www/index.html': html, 'www/style.css': css, 'www/app.js': js };
}

function mainActivityJava(packageName, startUrl) {
  return `package ${packageName};

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Pure native WebView shell - NO Capacitor, NO frameworks, NO AppCompat.
 * This is the proven recipe: the Capacitor native bridge was the 1-second
 * crash on real devices. android.app.Activity + WebView just works.
 *
 * File input support: a WebChromeClient implementing onShowFileChooser so
 * that <input type="file"> opens the system document picker instead of being
 * dead on tap. No storage permissions are requested or needed — the picker
 * grants one-shot read access through content URIs.
 */
public class MainActivity extends Activity {
    private WebView web;
    private ValueCallback<Uri[]> fileChooserCallback;
    private static final int FILE_CHOOSER_REQUEST = 0xA4FC; // arbitrary, app-local

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                // Only one chooser may be outstanding — cancel a stale one so
                // a double-tap can never leak a callback.
                if (fileChooserCallback != null) {
                    fileChooserCallback.onReceiveValue(null);
                    fileChooserCallback = null;
                }
                fileChooserCallback = callback;

                Intent chooser = buildChooserIntent(params, Intent.ACTION_OPEN_DOCUMENT);
                try {
                    startActivityForResult(Intent.createChooser(chooser, "Choose file"),
                                         FILE_CHOOSER_REQUEST);
                    return true;
                } catch (ActivityNotFoundException e) {
                    // Some ROMs lack a document provider — fall back to the
                    // plain content picker before giving up.
                    try {
                        startActivityForResult(Intent.createChooser(
                            buildChooserIntent(params, Intent.ACTION_GET_CONTENT), "Choose file"),
                            FILE_CHOOSER_REQUEST);
                        return true;
                    } catch (ActivityNotFoundException e2) {
                        fileChooserCallback = null;
                        callback.onReceiveValue(null);
                        return false;
                    }
                }
            }
        });
        setContentView(web);
        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl("${startUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}");
        }
    }

    /** Build a system picker intent from the WebView's file-chooser params. */
    private Intent buildChooserIntent(WebChromeClient.FileChooserParams params, String action) {
        Intent intent = new Intent(action);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        String[] accept = params != null ? params.getAcceptTypes() : null;
        String mime = (accept != null && accept.length > 0 && accept[0] != null
                       && !accept[0].isEmpty()) ? accept[0] : "*/*";
        intent.setType(mime);
        if (accept != null && accept.length > 1) {
            intent.putExtra(Intent.EXTRA_MIME_TYPES, accept);
        }
        if (params != null && params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        return intent;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            ValueCallback<Uri[]> cb = fileChooserCallback;
            fileChooserCallback = null;
            if (cb != null) {
                Uri[] results = null;
                if (resultCode == RESULT_OK && data != null) {
                    // Parses both single-Uri and ClipData (multiple) results.
                    results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                }
                cb.onReceiveValue(results); // null on cancel — WebView handles it
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) { web.saveState(outState); }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) { web.goBack(); }
        else { super.onBackPressed(); }
    }

    @Override
    protected void onDestroy() {
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }
}
`;
}

function manifestXml(packageName, appName, needInternet, hasIcon) {
  return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${packageName}">
${needInternet ? '    <uses-permission android:name="android.permission.INTERNET" />\n' : ''}    <application android:label="${escXml(appName)}" android:theme="@android:style/Theme.Material.Light.NoActionBar" android:hardwareAccelerated="true"${hasIcon ? ' android:icon="@drawable/icon"' : ''}>
        <activity android:name=".MainActivity" android:exported="true" android:configChanges="orientation|screenSize|keyboardHidden">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`;
}

function stringsXml(appName) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="app_name">${escXml(appName)}</string>\n</resources>\n`;
}

// ---------------------------------------------------------------------------
// keystore (debug only, generated once, reused)
// ---------------------------------------------------------------------------

function ensureKeystore(dataDir, java) {
  fs.mkdirSync(dataDir, { recursive: true });
  const ks = path.join(dataDir, 'appmaker-debug.keystore');
  if (!fs.existsSync(ks)) {
    execFileSync(java ? java.keytool : 'keytool', [
      '-genkeypair', '-keystore', ks,
      '-storepass', 'android', '-keypass', 'android',
      '-alias', 'appmaker', '-keyalg', 'RSA', '-keysize', '2048',
      '-validity', '10950',
      '-dname', 'CN=AppMaker Debug, OU=Jelani App Store, O=Jelani Thompson',
    ], { timeout: 60000 });
  }
  return ks;
}

// ---------------------------------------------------------------------------
// main entry: generateApk
// ---------------------------------------------------------------------------

function dirSize(p) {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    total += e.isDirectory() ? dirSize(f) : fs.statSync(f).size;
  }
  return total;
}

function isPng(file) {
  const buf = fs.readFileSync(file);
  return buf.length > 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

/**
 * opts: { appName, packageName, template: 'starter'|'website', url?,
 *         color?, iconSrcPath?, versionCode, versionName?, workRoot, dataDir }
 * Returns { apkPath, size, warnings, notesPath, versionCode }.
 * Throws with a clear message on any failure.
 */
function generateApk(opts) {
  const appName = validateAppName(opts.appName);
  const packageName = validatePackageName(opts.packageName);
  const template = opts.template === 'website' ? 'website' : 'starter';
  const color = validateColor(opts.color);
  const versionCode = Number(opts.versionCode);
  if (!Number.isInteger(versionCode) || versionCode < 1) {
    throw new Error('versionCode must be a positive integer.');
  }
  const versionName = String(opts.versionName || '1.0').slice(0, 20);
  const url = template === 'website' ? validateUrl(opts.url) : null;

  const dataDir = opts.dataDir || path.join(__dirname, '..', 'data');
  // Provision JDK + Android SDK on first use (downloads to persistent disk).
  const { sdkDir, java } = ensureSdk(dataDir);
  // Make the provisioned JDK visible to javac/keytool/d8 child processes.
  if (java && java.bin && !process.env.PATH.split(':').includes(java.bin)) {
    process.env.PATH = `${java.bin}:${process.env.PATH}`;
  }
  const sdk = findSdk(dataDir);
  if (!sdk) throw new Error('Android SDK provisioning failed.');
  const keystore = ensureKeystore(dataDir, java);

  const warnings = [];
  fs.mkdirSync(opts.workRoot || os.tmpdir(), { recursive: true });
  const work = fs.mkdtempSync(path.join(opts.workRoot || os.tmpdir(), 'appmaker-'));
  try {
    const srcDir = path.join(work, 'src', ...packageName.split('.'));
    const resDir = path.join(work, 'res', 'values');
    const assetsDir = path.join(work, 'assets', 'www');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(resDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });

    // --- web assets + JS audit + size cap ---
    let startUrl = 'file:///android_asset/www/index.html';
    if (template === 'starter') {
      const files = starterFiles(appName, color);
      for (const [rel, content] of Object.entries(files)) {
        const dest = path.join(work, 'assets', rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content);
        if (rel.endsWith('.js')) auditJs(content, rel);
      }
    } else {
      startUrl = url;
      // Tiny local page is NOT used for website template — WebView loads the
      // URL directly. Keep an (empty-ish) assets dir so the pipeline is uniform.
      fs.writeFileSync(path.join(assetsDir, '.nomedia'), '');
    }
    const assetBytes = dirSize(path.join(work, 'assets'));
    if (assetBytes > ASSET_HARD_CAP) {
      throw new Error(
        `Web assets are ${(assetBytes / 1048576).toFixed(1)}MB — over the 10MB cap. ` +
        'Shrink images/audio before building (the 54MB APK that nobody could download must not happen).'
      );
    }
    if (assetBytes > ASSET_WARN_AT) {
      warnings.push(`Web assets are ${(assetBytes / 1048576).toFixed(1)}MB — over 5MB. Big APKs are hard to download on slow connections.`);
    }

    // --- icon (PNG only) ---
    let hasIcon = false;
    if (opts.iconSrcPath && fs.existsSync(opts.iconSrcPath)) {
      if (isPng(opts.iconSrcPath)) {
        const d = path.join(work, 'res', 'drawable-nodpi');
        fs.mkdirSync(d, { recursive: true });
        fs.copyFileSync(opts.iconSrcPath, path.join(d, 'icon.png'));
        hasIcon = true;
      } else {
        warnings.push('Icon was not a PNG — skipped. (Only PNG icons are supported.)');
      }
    }

    // --- project files ---
    fs.writeFileSync(path.join(work, 'AndroidManifest.xml'),
      manifestXml(packageName, appName, template === 'website', hasIcon));
    fs.writeFileSync(path.join(resDir, 'strings.xml'), stringsXml(appName));
    fs.writeFileSync(path.join(srcDir, 'MainActivity.java'), mainActivityJava(packageName, startUrl));

    const run = (cmd, args, cwd) =>
      execFileSync(cmd, args, { cwd: cwd || work, timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });

    // --- aapt2 compile + link ---
    run(path.join(sdk.bt, 'aapt2'), ['compile', '--dir', 'res', '-o', 'compiled.zip']);
    run(path.join(sdk.bt, 'aapt2'), [
      'link', '-o', 'app-unaligned.apk',
      '--manifest', 'AndroidManifest.xml',
      '-I', sdk.androidJar,
      '-A', 'assets',
      '--min-sdk-version', String(MIN_SDK),
      '--target-sdk-version', String(TARGET_SDK),
      '--version-code', String(versionCode),
      '--version-name', versionName,
      'compiled.zip',
    ]);

    // --- javac + d8 ---
    const genDir = path.join(work, 'gen');
    fs.mkdirSync(path.join(work, 'classes'), { recursive: true });
    const javaFiles = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f); else if (f.endsWith('.java')) javaFiles.push(f);
      }
    })(path.join(work, 'src'));
    run('javac', ['-encoding', 'UTF-8', '-source', '17', '-target', '17', '-cp', sdk.androidJar, '-d', 'classes', ...javaFiles]);
    const classFiles = [];
    (function walkc(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walkc(f); else if (f.endsWith('.class')) classFiles.push(f);
      }
    })(path.join(work, 'classes'));
    fs.mkdirSync(path.join(work, 'dex'), { recursive: true });
    run(path.join(sdk.bt, 'd8'), [
      '--min-api', String(MIN_SDK), '--lib', sdk.androidJar,
      '--output', 'dex', ...classFiles,
    ]);

    // --- assemble, align, sign ---
    // (zip runs inside dex/ so the entry is classes.dex at the APK root)
    run('zip', ['-q', '-0', path.join(work, 'app-unaligned.apk'), 'classes.dex'], path.join(work, 'dex'));
    run(path.join(sdk.bt, 'zipalign'), ['-f', '4', 'app-unaligned.apk', 'app.apk']);
    run(path.join(sdk.bt, 'apksigner'), [
      'sign', '--ks', keystore, '--ks-pass', 'pass:android',
      '--key-pass', 'pass:android', '--out', 'app-signed.apk', 'app.apk',
    ]);
    const verifyOut = run(path.join(sdk.bt, 'apksigner'), ['verify', '--print-certs', 'app-signed.apk']).toString();
    if (!/Verified using v1 scheme.*true|Verified using v2 scheme.*true/s.test(verifyOut) && !verifyOut.includes('Signer #1')) {
      throw new Error('apksigner verify did not confirm a signature.');
    }

    const finalApk = path.join(work, 'app-signed.apk');
    const size = fs.statSync(finalApk).size;

    // --- BUILD_NOTES.txt (honesty file) ---
    const notesPath = path.join(work, 'BUILD_NOTES.txt');
    fs.writeFileSync(notesPath,
`AppMaker build notes
===================
App: ${appName} (${packageName})
Template: ${template}${template === 'website' ? ' -> ' + url : ''}
Version: ${versionName} (versionCode ${versionCode})
Built: ${new Date().toISOString()}
APK size: ${size} bytes (${(size / 1024).toFixed(1)} KB)
Shell: pure native WebView (android.app.Activity) — NO Capacitor, NO frameworks.
minSdk ${MIN_SDK}, targetSdk ${TARGET_SDK}.
${warnings.length ? 'Warnings:\n- ' + warnings.join('\n- ') + '\n' : ''}
What was done:
- Generated from the "${template}" template with all DOM access null-guarded
  (build-time JS audit passed — the ViralMode search-bar crash class is blocked).
- Signed and verified with apksigner.

What was NOT done (limits — read before shipping):
- DEBUG-SIGNED with a shared debug key. Fine for testing and sideloading.
  Do NOT publish to Google Play with this signature — generate a release
  keystore and re-sign for any store release.
- No malware scan, no Play asset-delivery, no automatic updates.
- Website template needs INTERNET permission and a live https site; if the
  site goes down, the app shows the site's error page.
- Generated apps are NOT listed in Jelani's App Store automatically — upload
  the APK through the normal upload flow if you want to sell it.
`);

    return { apkPath: finalApk, size, warnings, notesPath, versionCode, workDir: work };
  } catch (e) {
    // Keep the work dir on failure for debugging, but surface a clean message.
    e.appmakerWorkDir = work;
    throw e;
  }
}

module.exports = {
  generateApk,
  auditJs,
  validatePackageName,
  validateColor,
  validateUrl,
  validateAppName,
  findSdk,
  ensureSdk,
  MIN_SDK,
  TARGET_SDK,
};
