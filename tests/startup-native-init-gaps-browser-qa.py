#!/usr/bin/env python3
"""7612072: real HTTP/SQLite/pinned SDK, synthetic iOS handler timing only.

Default is a regression gate (fails while either gap exists). To capture the
known pre-fix failure without treating it as a product PASS:
  python3 tests/startup-native-init-gaps-browser-qa.py --expect-current-gaps
Chromium iPhone UA is NOT native VK/iOS26 acceptance. No live provider calls.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import re
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SDK = ROOT / 'public/vendor/vk-bridge-3.0.2.min.js'
KEY = 'native-init-gap-fixture-key'
UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 VK/8.183.1'


def launch(base, language, user):
    params = dict(vk_app_id='54723764', vk_user_id=str(user),
                  vk_ts=str(int(time.time())), vk_platform='mobile_iphone', vk_language=language)
    proof = urllib.parse.urlencode(sorted(params.items())).encode()
    params['sign'] = base64.urlsafe_b64encode(hmac.new(KEY.encode(), proof, hashlib.sha256).digest()).decode().rstrip('=')
    return base + '/?' + urllib.parse.urlencode(params) + '&lang=' + language


def scenario(browser, base, db_path, language, name, user, args_red=False):
    context = browser.new_context(viewport={'width': 390, 'height': 844}, user_agent=UA, is_mobile=True, has_touch=True)
    external = []
    sdk_responses = []
    errors = []
    events = []
    statuses = []
    try:
        def route(r):
            if urllib.parse.urlsplit(r.request.url).netloc == urllib.parse.urlsplit(base).netloc:
                r.continue_()
            else:
                external.append(urllib.parse.urlsplit(r.request.url).hostname)
                r.abort()
        context.route('**/*', route)
        # Do not replace vkBridge, SDK transport or application functions. Only
        # install host-owned handlers; real SDK bytes arrive over local HTTP.
        mode = {'early-all': 'early', 'late-within-window': 'within',
                'early-close-late-init': 'partial', 'after-last-retry': 'late',
                'partial-replaced-map': 'replacement', 'late-20s': 'latest',
                'never-ready': 'never', 'missing-callable': 'missing',
                'no-ack': 'early', 'delayed-ack': 'early', 'failed-ack': 'early',
                'handler-throws': 'early', 'concurrent-callers': 'partial',
                'android': 'android', 'website': 'early', 'telegram': 'early',
                'invalid-launch': 'early'}[name]
        script = '''(() => {
          window.qaNative = {calls: [], readyAt: null, mode: MODE};
          const q = window.qaNative;
          const close = {postMessage() {}};
          const init = {postMessage(params) {
            q.calls.push({at: performance.now(), requestId: params.request_id});
            if (CASE === 'no-ack') return;
            if (CASE === 'handler-throws') throw new Error('synthetic ambiguous delivery');
            setTimeout(() => window.dispatchEvent(new CustomEvent('VKWebAppEvent', {
              detail: {type: CASE === 'failed-ack' ? 'VKWebAppInitFailed' : 'VKWebAppInitResult',
                data: {request_id: params.request_id, ...(CASE === 'failed-ack' ? {error_type:'client_error'} : {result:true})}}
            })), CASE === 'delayed-ack' ? 5000 : 0);
          }};
          function ready() {
            if (!window.webkit) window.webkit = {messageHandlers: {VKWebAppClose: close}};
            window.webkit.messageHandlers.VKWebAppInit = init;
            q.readyAt = performance.now();
          }
          if (q.mode === 'early') ready();
          if (q.mode === 'android') {
            window.AndroidBridge = {VKWebAppInit(p) {init.postMessage(JSON.parse(p));}};
            q.readyAt = performance.now();
          }
          if (q.mode === 'partial' || q.mode === 'replacement' || q.mode === 'missing') window.webkit = {messageHandlers: {VKWebAppClose: close}};
          if (q.mode === 'missing') webkit.messageHandlers.VKWebAppInit = {postMessage: 1};
          if (['within','partial','replacement','late','latest'].includes(q.mode)) setTimeout(() => {
            if (q.mode === 'replacement') window.webkit.messageHandlers = {VKWebAppClose:close};
            ready();
          }, q.mode === 'latest' ? 20000 : (q.mode === 'late' ? 9500 : 3500));
        })();'''.replace('MODE', json.dumps(mode)).replace('CASE', json.dumps(name))
        context.add_init_script(script)
        # UI locale is an existing local preference on anonymous website startup.
        context.add_init_script('localStorage.setItem("kopilkaLocale",' + json.dumps(language) + ');')
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        def response(r):
            if '/vendor/vk-bridge-3.0.2.min.js' in r.url:
                sdk_responses.append({'status': r.status, 'sha256': hashlib.sha256(r.body()).hexdigest()})
            if '/api/auth/vk' in r.url or '/api/auth/telegram' in r.url:
                statuses.append(r.status)
        page.on('response', response)
        def request(r):
            if '/api/client-log' in r.url:
                payload = json.loads(r.post_data or '{}')
                if payload.get('event', '').startswith('startup_'):
                    headers = r.all_headers()
                    assert not any(h in headers for h in ('authorization', 'cookie', 'referer')), headers.keys()
                    assert set(payload) == {'event', 'details', 'platform', 'version'}
                    details = payload['details']
                    # Accept the shipped empty baseline or the separately tested,
                    # fixed-field diagnostic candidate. Never arbitrary text.
                    assert details == '' or re.fullmatch(
                        r'boot=(?:[0-9a-f]{1,8}-[0-9a-f]{1,8}|unavailable);seq=\d{1,2};ms=\d{1,5}'
                        r';ready=(?:loading|interactive|complete|unknown)'
                        r';startup=(?:absent|hidden|unhidden);app=(?:absent|hidden|unhidden);login=(?:absent|hidden|unhidden)'
                        r';init=[01];close=[01];sdk=(?:unknown|web|webview)', details), details
                    events.append(payload['event'])
        page.on('request', request)
        url = launch(base, language, user)
        if name == 'android': url = url.replace('mobile_iphone', 'mobile_android')
        # Re-sign Android platform instead of altering an existing signed proof.
        if name == 'android':
            params = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query)); params.pop('sign'); params.pop('lang')
            proof = urllib.parse.urlencode(sorted(params.items())).encode()
            params['sign'] = base64.urlsafe_b64encode(hmac.new(KEY.encode(), proof, hashlib.sha256).digest()).decode().rstrip('=')
            url = base + '/?' + urllib.parse.urlencode(params) + '&lang=' + language
        anonymous = name in ('website','invalid-launch')
        if name in ('website','telegram'): url = base + '/?lang=' + language
        if name == 'telegram':
            data = {'auth_date': str(int(time.time())), 'user': json.dumps({'id': user, 'first_name': 'Fixture', 'language_code': language}, separators=(',', ':'))}
            secret = hmac.new(b'WebAppData', b'999999:local_fixture_bot_token', hashlib.sha256).digest()
            data['hash'] = hmac.new(secret, '\n'.join(k+'='+v for k,v in sorted(data.items())).encode(), hashlib.sha256).hexdigest()
            init_data = urllib.parse.urlencode(data)
            context.add_init_script('window.Telegram={WebApp:{initData:' + json.dumps(init_data) + ',ready(){},expand(){},onEvent(){},setHeaderColor(){},setBackgroundColor(){},MainButton:{hide(){}}}};')
        if name == 'invalid-launch': url = re.sub(r'sign=[^&]+', 'sign=invalid', url)
        private_requests = []
        page.on('request', lambda r: private_requests.append(r.url) if urllib.parse.urlsplit(r.url).path in ('/api/me','/api/summary','/api/entries') else None)
        page.goto(url)
        if anonymous:
            page.wait_for_function("!document.getElementById('loginScreen').hidden", timeout=15000)
        else:
            page.wait_for_function('Boolean(state.user && state.summary && !state.busy)', timeout=15000)
        if name == 'concurrent-callers':
            assert page.evaluate("(() => {const p=KopilkaStartup.initVkBridge(); return Array.from({length:40},()=>KopilkaStartup.initVkBridge()).every(x=>x===p)})()")
        if mode not in ('never','missing'):
            page.wait_for_function('Boolean(window.qaNative.readyAt !== null)', timeout=25000)
        # All connected cases use real wall time (no accelerated browser clock).
        horizon = 31000 if mode in ('never','missing') else (22000 if mode == 'latest' else 11000)
        page.wait_for_function(f'performance.now() >= {horizon}', timeout=35000)
        snapshot = page.evaluate('''(() => ({
          webview: vkBridge.isWebView(), user: state.user && state.user.id,
          appVisible: !document.getElementById('appShell').hidden,
          startupHidden: document.getElementById('startupScreen').hidden,
          readyAt: qaNative.readyAt, calls: qaNative.calls.slice(),
          callable: typeof window.webkit?.messageHandlers?.VKWebAppInit?.postMessage === 'function' || typeof window.AndroidBridge?.VKWebAppInit === 'function',
          statusTop: getComputedStyle(document.documentElement).getPropertyValue('--vk-status-top'),
          language: locale()
        }))()''')
        with sqlite3.connect(db_path) as db:
            identity = db.execute('SELECT ' + ('telegram_id' if name == 'telegram' else 'vk_id') + ' FROM users WHERE id=?', (snapshot['user'],)).fetchone()
            integrity = db.execute('PRAGMA integrity_check').fetchone()[0]
        if anonymous:
            assert identity is None and not snapshot['user'] and not private_requests
            assert statuses == ([401] if name == 'invalid-launch' else [])
            assert not snapshot['appVisible'] and snapshot['startupHidden']
        else:
            assert identity == (str(user),) and integrity == 'ok', (identity, integrity)
            assert statuses == [200], statuses
            assert snapshot['appVisible'] and snapshot['startupHidden'], snapshot
        if name == 'android': assert float(snapshot['statusTop'].replace('px','')) >= 64
        assert snapshot['language'] == language
        assert len(sdk_responses) == 1 and sdk_responses[0] == {'status': 200, 'sha256': hashlib.sha256(SDK.read_bytes()).hexdigest()}, sdk_responses
        assert not errors, errors
        # Positive controls must deliver automatically. These would invalidate
        # the reproduction if our fixture, pinned asset or HTTP app were broken.
        if name == 'early-all':
            assert snapshot['webview'] and snapshot['calls'], snapshot
            assert 'startup_init-native-recovery' not in events, events
        if name == 'late-within-window':
            assert not snapshot['webview'] and len(snapshot['calls']) == 1, snapshot
            assert events.count('startup_init-native-recovery') == 1, events
        # Freeze automatic-phase events before readiness probes manufacture an
        # InitResult. Probe acknowledgements are not startup success evidence.
        automatic_events = list(events)
        if name in ('early-close-late-init','partial-replaced-map'): assert snapshot['webview']
        if name == 'after-last-retry': assert not snapshot['webview'] and snapshot['readyAt'] >= 9400
        if not args_red:
            expected = 0 if name in ('website','telegram','never-ready','missing-callable') else 1
            assert len(snapshot['calls']) == expected, (name, snapshot)
        if name in ('never-ready','missing-callable'):
            # After expiry, callers/new callable handlers must not revive polling.
            page.evaluate("window.webkit={messageHandlers:{VKWebAppClose:{},VKWebAppInit:{postMessage(p){qaNative.calls.push(p)}}}}; for(let i=0;i<30;i++)KopilkaStartup.initVkBridge();")
            page.wait_for_timeout(500)
            assert page.evaluate('qaNative.calls.length') == 0
        return dict(name=name, language=language, automaticDelivered=bool(snapshot['calls']),
                    snapshot=snapshot, startupEvents=automatic_events, authStatuses=statuses,
                    sqliteIdentityVerified=True, sdk=sdk_responses[0], pageErrors=errors,
                    blockedExternalHosts=sorted(set(external)))
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expect-current-gaps', action='store_true')
    args = parser.parse_args()
    out = Path(os.environ.get('KOPILKA_NATIVE_INIT_QA_OUT', (tempfile.gettempdir() + '/kopilka-qa/kopilka-7612072-native-init-gaps')))
    out.mkdir(parents=True, exist_ok=True)
    port = int(os.environ.get('KOPILKA_QA_PORT', '3193'))
    base = f'http://127.0.0.1:{port}'
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(('127.0.0.1', port))
    cases = ('early-all', 'late-within-window', 'early-close-late-init', 'after-last-retry')
    if not args.expect_current_gaps:
        cases += ('partial-replaced-map','late-20s','never-ready','missing-callable','no-ack',
                  'delayed-ack','failed-ack','handler-throws','concurrent-callers','android','website','telegram','invalid-launch')
    rows = []
    with tempfile.TemporaryDirectory(prefix='native-init-qa-', dir=os.environ.get('TMPDIR', str(out))) as tmp:
        qa = Path(tmp)
        for name in ('public', 'migrations'):
            (qa / name).symlink_to(ROOT / name, target_is_directory=True)
        env = dict(PATH=os.environ['PATH'], HOME=tmp, NODE_ENV='test', PORT=str(port),
                   DB_PATH=str(qa / 'qa.sqlite'), SCHEDULER_ENABLED='false', DEV_AUTH_ENABLED='false',
                   BOT_TOKEN='999999:local_fixture_bot_token', VK_GROUP_TOKEN='', VK_APP_ID='54723764', VK_SECURE_KEY=KEY,
                   SESSION_SECRET='native-init-isolated-session', APP_BASE_URL=base, WEBAPP_URL=base)
        # Deny provider egress in the Node fixture as well as in Chromium.
        # No fabricated provider response: any accidental external call fails.
        deny = qa / 'deny-external.cjs'
        deny.write_text('''const allowed = h => ['127.0.0.1','localhost','::1'].includes(h);
const originalFetch = global.fetch;
global.fetch = (url, ...args) => { if (!allowed(new URL(String(url)).hostname)) throw Error('QA external fetch denied'); return originalFetch(url, ...args); };
for (const protocol of ['http','https']) { const mod = require(protocol), request = mod.request;
 mod.request = function(url, ...args) { const host = typeof url === 'string' || url instanceof URL ? new URL(url).hostname : (url.hostname || url.host || 'localhost'); if (!allowed(host)) throw Error('QA external request denied'); return request.call(this,url,...args); }; }
''')
        with (out / 'server.log').open('w') as log:
            proc = subprocess.Popen(['node', '--require', str(deny), str(ROOT / 'src/server.js')], cwd=qa, env=env, stdout=log, stderr=log)
            try:
                for _ in range(100):
                    try:
                        urllib.request.urlopen(base + '/health', timeout=1).close()
                        break
                    except Exception:
                        if proc.poll() is not None:
                            raise RuntimeError('Isolated server exited; see server.log')
                        time.sleep(.1)
                else:
                    raise RuntimeError('Isolated server unavailable')
                with sync_playwright() as pw:
                    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
                    try:
                        for language in ('ru', 'en'):
                            for name in cases:
                                row = scenario(browser, base, env['DB_PATH'], language, name, 981319300 + len(rows), args.expect_current_gaps)
                                rows.append(row)
                                (out / 'results.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2))
                                print(json.dumps(row, ensure_ascii=False), flush=True)
                    finally:
                        browser.close()
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                cleanup = dict(pid=proc.pid, exit=proc.returncode, alive=Path(f'/proc/{proc.pid}').exists(),
                               temporaryDB=True, scheduler=False, port=port)
                (out / 'cleanup.json').write_text(json.dumps(cleanup, indent=2))
                assert not cleanup['alive']
    assert not Path(tmp).exists(), 'Temporary SQLite/cwd not removed'
    controls = [r for r in rows if r['name'] in ('early-all', 'late-within-window')]
    gaps = [r for r in rows if r['name'] in ('early-close-late-init', 'after-last-retry')]
    assert len(rows) == len(cases) * 2 and len(controls) == 4 and len(gaps) == 4
    assert len({(r['name'],r['language']) for r in rows}) == len(rows)
    assert all(r['automaticDelivered'] for r in controls)
    if args.expect_current_gaps:
        assert all(not r['automaticDelivered'] for r in gaps), 'Known pre-fix gaps changed; run the regression gate'
        print('NATIVE_INIT_GAPS_REPRODUCED: 4 controls delivered; 4 RU/EN gap witnesses did not. NOT native acceptance.')
    else:
        failures = [r['name'] + '-' + r['language'] for r in gaps if not r['automaticDelivered']]
        assert not failures, 'Native initialization missing: ' + ', '.join(failures)
        print(f'NATIVE_INIT_CONNECTED_REGRESSION_PASS: {len(rows)} scenarios, real wall clock. NOT native acceptance.')


if __name__ == '__main__':
    main()
