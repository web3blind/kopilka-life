#!/usr/bin/env python3
"""Real isolated HTTP/SQLite + pinned VK SDK, synthetic native only; never live VK."""
import base64, hashlib, hmac, json, os, socket, subprocess, tempfile, time, urllib.parse, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('KOPILKA_STARTUP_QA_OUT', (tempfile.gettempdir() + '/kopilka-qa/kopilka-critical-20261007/startup-fix')))
OUT.mkdir(parents=True, exist_ok=True)
PORT = int(os.environ.get('KOPILKA_QA_PORT', '3191'))
assert PORT == 3191, 'Dedicated startup QA port required'
BASE = f'http://127.0.0.1:{PORT}'
KEY = 'startup-isolated-fixture-key'
rows = []

def launch(valid=True):
    v = {'vk_app_id': '54723764', 'vk_user_id': '81993191', 'vk_ts': str(int(time.time()))}
    v['sign'] = base64.urlsafe_b64encode(hmac.new(KEY.encode(), urllib.parse.urlencode(sorted(v.items())).encode(), hashlib.sha256).digest()).decode().rstrip('=') if valid else 'invalid-fixture'
    return BASE + '/?' + urllib.parse.urlencode(v)

def record(name, fn):
    try:
        data = fn()
        rows.append({'name': name, 'pass': True, 'data': data})
    except Exception as e:
        rows.append({'name': name, 'pass': False, 'error': str(e)})
    (OUT / 'results.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    print(json.dumps(rows[-1], ensure_ascii=False), flush=True)

with socket.socket() as s:
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('127.0.0.1', PORT))
with tempfile.TemporaryDirectory(prefix='startup-qa-', dir=os.environ.get('TMPDIR', str(OUT))) as tmp:
    qa = Path(tmp)
    for name in ('public', 'migrations'):
        (qa / name).symlink_to(ROOT / name, target_is_directory=True)
    env = dict(PATH=os.environ['PATH'], HOME=tmp, NODE_ENV='test', PORT=str(PORT), DB_PATH=str(qa / 'qa.sqlite'),
               SCHEDULER_ENABLED='false', DEV_AUTH_ENABLED='false', BOT_TOKEN='', VK_GROUP_TOKEN='',
               VK_APP_ID='54723764', VK_SECURE_KEY=KEY, SESSION_SECRET='startup-isolated-session', APP_BASE_URL=BASE, WEBAPP_URL=BASE)
    with (OUT / 'server.log').open('w') as log:
        proc = subprocess.Popen(['node', str(ROOT / 'src/server.js')], cwd=qa, env=env, stdout=log, stderr=log)
        try:
            for _ in range(100):
                try:
                    urllib.request.urlopen(BASE + '/health', timeout=1).close()
                    break
                except Exception:
                    if proc.poll() is not None:
                        raise RuntimeError('Isolated server failed; see server.log')
                    time.sleep(.1)
            else:
                raise RuntimeError('Isolated server unavailable')
            with sync_playwright() as pw:
                browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
                sdk = (ROOT / 'public/vendor/vk-bridge-3.0.2.min.js').read_text()
                def context():
                    c = browser.new_context(viewport={'width': 390, 'height': 844})
                    c.route('**/*', lambda r: r.continue_() if urllib.parse.urlsplit(r.request.url).hostname == '127.0.0.1' else r.abort())
                    return c
                def blocked(lang, asset):
                    c = context(); held = []
                    try:
                        c.route('**/' + asset + '?*', lambda r: held.append(r))
                        # Keep secondary code pending as well: UI/localization/retry must not depend on it.
                        c.route('**/i18n.js?*', lambda r: held.append(r))
                        p = c.new_page(); p.goto(BASE + '/?lang=' + lang, wait_until='commit')
                        # Initial surface must exist and receive a paint opportunity well
                        # before the ten-second failure watchdog, with requests still held.
                        p.wait_for_function('!!document.getElementById("startupScreen") && !!window.KopilkaStartup', timeout=1500)
                        assert p.locator('#startupScreen').is_visible()
                        assert p.locator('#startupHeading').inner_text() == ('Life Harbor' if lang == 'en' else 'Копилка жизни')
                        assert p.evaluate('() => Promise.race([new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))), new Promise(r => setTimeout(() => r(false), 1500))])'), 'Stylesheet prevented first startup paint'
                        p.wait_for_timeout(11000)
                        data = p.evaluate('''({body:!!document.body,guard:!!window.KopilkaStartup,ready:document.readyState,text:document.getElementById('startupMessage')?.textContent,heading:document.getElementById('startupHeading')?.textContent,retry:document.getElementById('startupReload')?.textContent})''')
                        assert data['body'] and data['guard'], data
                        assert p.locator('#startupScreen').is_visible() and p.locator('#startupReload').is_enabled(), data
                        assert ('could not' if lang == 'en' else 'Не удалось') in data['text'], data
                        assert data['retry'] == ('Load again' if lang == 'en' else 'Загрузить ещё раз'), data
                        assert p.locator('#appShell').is_hidden() and p.locator('#loginScreen').is_hidden()
                        # RAF callback opportunity + actual nonzero visible text box, not just hidden attribute.
                        assert p.evaluate('() => Promise.race([new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))), new Promise(r => setTimeout(() => r(false), 1500))])'), 'Stylesheet prevented first paint opportunity'
                        assert p.locator('#startupScreen').bounding_box()['height'] > 80
                        c.unroute('**/i18n.js?*'); c.unroute('**/' + asset + '?*')
                        p.locator('#startupReload').click()
                        p.locator('#loginScreen').wait_for(state='visible')
                        assert p.locator('#startupScreen').is_hidden()
                        return data | {'retryRecovered': True}
                    finally:
                        for r in held:
                            try: r.abort()
                            except Exception: pass
                        c.close()
                for asset in ('startup.js', 'styles.css'):
                    for lang in ('ru', 'en'):
                        record('pending-' + asset + '-' + lang, lambda lang=lang, asset=asset: blocked(lang, asset))
                def native(delay, valid=True, early=False):
                    c = context()
                    try:
                        calls = []
                        injection = '''window.nativeCalls=[];window.injectNative=function(){window.webkit={messageHandlers:{VKWebAppClose:{postMessage(){}},VKWebAppInit:{postMessage(p){nativeCalls.push(p);}}}}};'''
                        c.add_init_script(injection + ('injectNative();' if early else ''))
                        if not valid:
                            # A real cached QA session must not be consulted before the
                            # current, deliberately invalid signed launch is rejected.
                            response = c.request.post(BASE + '/api/auth/vk', data={'launchParams': urllib.parse.urlsplit(launch()).query})
                            assert response.ok, 'Could not seed isolated cached session'
                            token = response.json()['token']
                            c.add_init_script('localStorage.setItem("kopilkaToken",' + json.dumps(token) + ');')
                        code = sdk + ('' if early else f'\nsetTimeout(injectNative,{delay});')
                        c.route('**/vendor/vk-bridge-3.0.2.min.js*', lambda r: r.fulfill(body=code, content_type='application/javascript'))
                        c.add_cookies([{'name': 'qa_private_cookie', 'value': 'fixture', 'url': BASE}])
                        p = c.new_page(); logs = []; private = []; errors = []
                        p.on('pageerror', lambda e: errors.append(str(e)))
                        p.on('request', lambda r: logs.append(r) if '/api/client-log' in r.url else private.append(r.url) if any(x in r.url for x in ['/api/summary', '/api/history', '/api/me']) else None)
                        p.goto(launch(valid))
                        if valid:
                            p.wait_for_function('state.user && state.summary && !state.busy')
                        else:
                            p.locator('#loginScreen').wait_for(state='visible')
                        p.wait_for_timeout(9000)
                        data = p.evaluate('({count:nativeCalls.length,webview:vkBridge.isWebView(),app:!document.getElementById("appShell").hidden})')
                        assert data['count'] == 1, data
                        assert data['webview'] == early, data
                        assert data['app'] == valid, data
                        if not valid:
                            assert not private, private
                            assert p.evaluate('!state.user'), 'Unsigned launch became identity'
                        assert not errors, errors
                        for r in logs:
                            payload = json.loads(r.post_data)
                            if not payload.get('event', '').startswith('startup_'):
                                continue  # Existing application telemetry is outside this startup guard scope.
                            headers = r.all_headers()
                            assert not any(k in headers for k in ('authorization', 'cookie', 'referer')), list(headers)
                            assert set(payload) == {'event', 'details', 'platform', 'version'}
                            details = payload['details']
                            assert details == '' or __import__('re').fullmatch(
                                r'boot=(?:[0-9a-f]{1,8}-[0-9a-f]{1,8}|unavailable);seq=\d{1,2};ms=\d{1,5}'
                                r';ready=(?:loading|interactive|complete|unknown)'
                                r';startup=(?:absent|hidden|unhidden);app=(?:absent|hidden|unhidden);login=(?:absent|hidden|unhidden)'
                                r';init=[01];close=[01];sdk=(?:unknown|web|webview)', details), details
                            assert not any(x in r.post_data for x in ['81993191', 'sign=', 'fixture-key', 'invalid-fixture'])
                        recoveries = [r for r in logs if 'startup_init-native-recovery' in r.post_data]
                        assert len(recoveries) == (0 if early else 1)
                        p.evaluate("KopilkaStartup.mark('bridge-loaded');KopilkaStartup.mark('bridge-loaded')")
                        assert p.evaluate('nativeCalls.length') == data['count']
                        return data | {'authValid': valid, 'recoveryLogs': len(recoveries), 'privateRequests': len(private)}
                    finally: c.close()
                for delay in (3500, 7000):
                    record('pinned-sdk-native-' + str(delay), lambda delay=delay: native(delay))
                record('signed-launch-failure-native-not-identity', lambda: native(3500, valid=False))
                record('sdk-native-no-recovery-duplicate', lambda: native(0, early=True))
                browser.close()
        finally:
            proc.terminate()
            try: proc.wait(timeout=10)
            except subprocess.TimeoutExpired: proc.kill(); proc.wait()
            (OUT / 'cleanup.json').write_text(json.dumps({'pid': proc.pid, 'exit': proc.returncode, 'alive': Path('/proc/' + str(proc.pid)).exists(), 'scheduler': False, 'temporaryDB': True, 'port': PORT}))
assert rows and all(r['pass'] for r in rows), 'Startup regression failures; see results.json'
print('STARTUP_CRITICAL_CONNECTED_PASS', len(rows), flush=True)
