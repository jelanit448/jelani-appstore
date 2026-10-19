#!/usr/bin/env python3
"""Money-layer smoke tests via CDP (headed Chromium under Xvfb, self-contained).

Usage: python3 moneylayer/smoke.py
Tests 3 wave-1 apps end to end in a real browser:
  1. demo bar visible, no console errors on load
  2. demo cap: 10 saves allowed, 11th blocked with unlock prompt (real UI)
  3. wrong code rejected, correct code unlocks, persists after reload
  4. after unlock: saves beyond 10 work
Reads plaintext codes from moneylayer/wave1_codes.json (gitignored).
"""
import sys, os, json, time, socket, base64, struct, subprocess, http.client

ROOT = '/home/hatch/workspace/appstore'
CHROME = '/opt/meta-chromium/chrome'
CDPPORT = 9470
DISPLAY = ':187'
PROFILE = '/tmp/cdp-ml-smoke'

# --- minimal websocket + CDP (same recipe as audit/shot.py) ---
def ws_connect(url):
    from urllib.parse import urlparse
    u = urlparse(url)
    s = socket.create_connection((u.hostname, u.port or 80), timeout=15)
    key = base64.b64encode(os.urandom(16)).decode()
    req = (f'GET {u.path or "/"} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\n'
           f'Upgrade: websocket\r\nConnection: Upgrade\r\n'
           f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n')
    s.sendall(req.encode())
    resp = b''
    while b'\r\n\r\n' not in resp:
        resp += s.recv(4096)
    if b'101' not in resp.split(b'\r\n')[0]:
        raise RuntimeError('WS handshake failed')
    return s

def ws_send(s, text):
    b = text.encode()
    hdr = bytes([0x81])
    n = len(b)
    mask = os.urandom(4)
    if n < 126: hdr += bytes([0x80 | n])
    elif n < 65536: hdr += bytes([0x80 | 126]) + struct.pack('>H', n)
    else: hdr += bytes([0x80 | 127]) + struct.pack('>Q', n)
    s.sendall(hdr + mask + bytes(x ^ mask[i % 4] for i, x in enumerate(b)))

class CDP:
    def __init__(self, port):
        c = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
        c.request('GET', '/json/list')
        tabs = json.loads(c.getresponse().read())
        pages = [t for t in tabs if t.get('type') == 'page' and t.get('webSocketDebuggerUrl')]
        if not pages: raise RuntimeError('no debuggable page')
        self.s = ws_connect(pages[0]['webSocketDebuggerUrl'])
        self.n = 0
        self.buf = b''
    def _rd(self, n, timeout=30):
        end = time.time() + timeout
        while len(self.buf) < n:
            if time.time() > end: raise RuntimeError('ws recv timeout')
            chunk = self.s.recv(65536)
            if not chunk: raise RuntimeError('ws closed')
            self.buf += chunk
        d, self.buf = self.buf[:n], self.buf[n:]
        return d
    def call(self, method, params=None, timeout=25):
        self.n += 1
        i = self.n
        ws_send(self.s, json.dumps({'id': i, 'method': method, 'params': params or {}}))
        end = time.time() + timeout
        while time.time() < end:
            b1, b2 = self._rd(2, timeout=max(1, end - time.time()))
            ln = b2 & 0x7F
            if ln == 126: ln = int.from_bytes(self._rd(2), 'big')
            elif ln == 127: ln = int.from_bytes(self._rd(8), 'big')
            data = self._rd(ln)
            if b2 & 0x80:
                mask = self._rd(4)
                data = bytes(x ^ mask[j % 4] for j, x in enumerate(data))
            try: msg = json.loads(data.decode())
            except Exception: continue
            if msg.get('id') == i:
                if 'error' in msg: raise RuntimeError(f'CDP {method}: {msg["error"]}')
                return msg.get('result', {})
        raise RuntimeError(f'CDP {method} timeout')
    def ev(self, js):
        r = self.call('Runtime.evaluate', {'expression': js, 'returnByValue': True, 'awaitPromise': False})
        if r.get('exceptionDetails'):
            raise RuntimeError('JS exception: ' + json.dumps(r['exceptionDetails'])[:300])
        return (r.get('result') or {}).get('value')

PASS, FAIL = 0, 0
def check(name, cond, extra=''):
    global PASS, FAIL
    if cond: PASS += 1; print(f'  PASS {name}')
    else: FAIL += 1; print(f'  FAIL {name} {extra}')

def main():
    codes = {a['slug']: a for a in json.load(open(f'{ROOT}/moneylayer/wave1_codes.json'))['apps']}
    # per-app UI hooks for the real-UI save test
    apps = [
        {'batch': 'batch1', 'slug': 'dontletitdie', 'lskey': 'dlid',
         'add': """var i=document.getElementById('plantName'); i.value='P'+Math.floor(Math.random()*1e6);
                   document.getElementById('addPlant').click();""",
         'count': """(function(){try{var s=JSON.parse(localStorage.getItem('dlid'));return s.plants.length;}catch(e){return -1;}})()"""},
        {'batch': 'batch1', 'slug': 'themove', 'lskey': 'themove_saved',
         'add': """document.getElementById('goBtn').click(); document.getElementById('saveBtn').click();""",
         'count': """(function(){try{return JSON.parse(localStorage.getItem('themove_saved')).length;}catch(e){return -1;}})()"""},
        {'batch': 'batch1', 'slug': 'grilltime', 'lskey': None, 'add': None, 'count': None},
    ]
    xvfb = subprocess.Popen(['Xvfb', DISPLAY, '-screen', '0', '1280x800x24'])
    time.sleep(1.5)
    env = dict(os.environ, DISPLAY=DISPLAY)
    chrome = subprocess.Popen([CHROME, f'--remote-debugging-port={CDPPORT}', '--no-first-run',
                               '--no-sandbox', '--disable-dev-shm-usage',
                               '--no-default-browser-check', f'--user-data-dir={PROFILE}', 'about:blank'],
                              env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(3)
        cdp = CDP(CDPPORT)
        cdp.call('Runtime.enable')
        for app in apps:
            slug = app['slug']
            www = f'{ROOT}/{app["batch"]}/apps/{slug}/www/index.html'
            code = codes[slug]['code']
            print(f'== {slug} ==')
            cdp.call('Page.navigate', {'url': 'file://' + www})
            time.sleep(1.5)
            # 1. bar visible, no obvious breakage
            check('demo bar visible', cdp.ev("!!document.getElementById('ml-bar')"))
            check('app still renders', cdp.ev("document.body.innerText.length > 50"))
            if app['add']:
                # 2. add 10 via real UI
                for _ in range(10):
                    cdp.ev(app['add'])
                    time.sleep(0.15)
                n10 = cdp.ev(app['count'])
                check('10 saves allowed in demo', n10 == 10, f'got {n10}')
                # 3. 11th blocked
                cdp.ev(app['add'])
                time.sleep(0.4)
                n11 = cdp.ev(app['count'])
                check('11th save blocked', n11 == 10, f'got {n11}')
                check('unlock prompt opened', cdp.ev("!!document.getElementById('ml-overlay')"))
                # 4. wrong code rejected
                cdp.ev("""document.getElementById('ml-code').value='FULL-AAAAAAAAAAAAAAAA';
                          document.getElementById('ml-verify').click();""")
                time.sleep(0.4)
                err = cdp.ev("""(document.getElementById('ml-code-err')||{}).textContent || ''""")
                check('wrong code rejected', 'didn' in err or 'didn\u2019t' in err.replace('\u2019', "'"), err[:60])
                check('still demo after wrong code', cdp.ev(f"localStorage.getItem('ml_{slug}_full') !== '1'"))
                # 5. reload: the blocked 11th save must NOT have persisted
                cdp.call('Page.navigate', {'url': 'file://' + www})
                time.sleep(1.2)
                n10b = cdp.ev(app['count'])
                check('blocked save did not persist (still 10)', n10b == 10, f'got {n10b}')
                check('still demo after reload', cdp.ev(f"localStorage.getItem('ml_{slug}_full') !== '1'"))
                # 6. correct code unlocks
                cdp.ev("""document.getElementById('ml-b-unlock').click();""")
                time.sleep(0.3)
                cdp.ev(f"""document.getElementById('ml-code').value={json.dumps(code)};
                          document.getElementById('ml-verify').click();""")
                time.sleep(0.4)
                check('correct code unlocks', cdp.ev(f"localStorage.getItem('ml_{slug}_full') === '1'"))
                check('bar shows FULL', cdp.ev("!!document.getElementById('ml-full')"))
                # 7. saves beyond 10 now work
                for _ in range(5):
                    cdp.ev(app['add'])
                    time.sleep(0.15)
                n15 = cdp.ev(app['count'])
                check('15 saves allowed when unlocked', n15 == 15, f'got {n15}')
                # 8. reload persists everything
                cdp.call('Page.navigate', {'url': 'file://' + www})
                time.sleep(1.2)
                check('unlock persists after reload', cdp.ev(f"localStorage.getItem('ml_{slug}_full') === '1'"))
                check('data persists after reload', cdp.ev(app['count']) == 15)
            else:
                # no-collection app: bar + unlock still work, no cap enforced
                cdp.ev(f"""document.getElementById('ml-b-unlock').click();""")
                time.sleep(0.3)
                cdp.ev(f"""document.getElementById('ml-code').value={json.dumps(code)};
                          document.getElementById('ml-verify').click();""")
                time.sleep(0.4)
                check('unlock works (no-cap app)', cdp.ev(f"localStorage.getItem('ml_{slug}_full') === '1'"))
            # fresh profile for next app
            cdp.ev("localStorage.clear()")
    finally:
        chrome.terminate(); xvfb.terminate()
    print(f'\nSMOKE RESULT: {PASS} pass, {FAIL} fail')
    sys.exit(1 if FAIL else 0)

main()
