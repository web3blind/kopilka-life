#!/usr/bin/env python3
"""Profile logout regression against real app routes, disposable DB/CDP context.
Run directly; owns only ports 3176 and isolated browser contexts.
Provider proof/delivery is fixture-only, never a live Google account.
"""
import os
import sqlite3
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = 'http://127.0.0.1:3176'


def check(env):
    with sync_playwright() as pw:
        endpoint = os.environ.get('KOPILKA_QA_CDP_URL')
        browser = pw.chromium.connect_over_cdp(endpoint) if endpoint else pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        context = browser.new_context()
        # No third-party network requests/cookies. App API and fixture verifier stay real.
        context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(BASE) else route.abort())
        try:
            auth = context.request.post(BASE + '/api/auth/dev', data={'firstName': 'Logout QA'}).json()
            entry = context.request.post(BASE + '/api/entries', headers={'Authorization':'Bearer '+auth['token']}, data={'type':'movement','note':'History remains after logout'})
            assert entry.status == 201
            page = context.new_page()
            page.goto(BASE)
            assert page.evaluate('typeof setLoginStatus') == 'function', 'OAuth fallback calls missing setLoginStatus'
            page.evaluate('(token) => localStorage.setItem("kopilkaToken", token)', auth['token'])
            page.reload()
            page.wait_for_function('state.user && state.profile && !state.busy')
            page.locator('[data-tab="profile"]').click()
            assert page.locator('#tab-profile #signOutSite').count() == 1, 'Logout is missing from own Profile'
            assert page.locator('#signOutSite').is_visible()
            assert page.locator('#tab-settings #signOutSite').count() == 0
            # A notification opens / in a fresh same-origin tab. It must use the same cached session.
            fresh = context.new_page()
            fresh.goto(BASE + '/')
            fresh.wait_for_function('state.user && state.profile')
            assert fresh.evaluate('state.user.id') == auth['user']['id']
            print('PASS valid session survives fresh notification URL /', flush=True)
            fresh.close()
            cleanup = browser.new_context()
            cleanup.route('**/*', lambda route: route.continue_() if route.request.url.startswith(BASE) else route.abort())
            cleanup.add_init_script('''
              localStorage.setItem('kopilkaPushRetirePending','1');
              window.__cleanup = [];
              Object.defineProperty(navigator.serviceWorker,'getRegistration',{configurable:true,value:async () => ({
                pushManager:{getSubscription:async () => ({endpoint:'https://push.invalid/retire', unsubscribe:() => new Promise(() => {})})},
                getNotifications:async () => [], unregister:async () => {window.__cleanup.push('unregister'); return false;}
              })});
            ''')
            cleanup_page = cleanup.new_page()
            cleanup_page.goto(BASE + '/?signed_out=1')
            cleanup_page.wait_for_function('window.__cleanup.includes("unregister")', timeout=3000)
            assert cleanup_page.evaluate('localStorage.getItem("kopilkaPushRetirePending")') == '1'
            assert cleanup_page.evaluate('state.token') == ''
            result = cleanup_page.evaluate('''async () => {
              let deletes=0, unregisters=0; const original=fetch;
              window.fetch=async () => {deletes++;throw Error('offline');};
              Object.defineProperty(navigator.serviceWorker,'getRegistration',{configurable:true,value:async () => ({
                pushManager:{getSubscription:async () => ({endpoint:'https://push.invalid/retire', unsubscribe:() => new Promise(() => {})})},
                getNotifications:async () => [], unregister:async () => {unregisters++;return true;}
              })});
              const result=await Promise.race([retireBrowserPush('fixture'),new Promise(resolve => setTimeout(() => resolve('outer-timeout'),1000))]);
              window.fetch=original;return {result,deletes,unregisters};
            }''')
            assert result == {'result':True,'deletes':1,'unregisters':1}, result
            cleanup.close()
            print('PASS hanging unsubscribe + offline DELETE reaches unregister; signed-out cleanup retries and unresolved marker remains', flush=True)
            page.evaluate("state.user.locale='en'; storage.set('kopilkaLocale','en'); renderAll()")
            assert page.locator('#signOutSite').inner_text() == 'Sign out'
            page.evaluate("document.querySelector('#entryNote').value='PRIVATE DRAFT'; state.pendingMerge={mergeToken:'private'}; sessionStorage.setItem('kopilkaGoogleOAuthHandoff', JSON.stringify({token:'stale'})); storage.set('kopilkaVkMergeToken','private')")
            # Unreliable subscription API must not prevent logout. Both deletion and
            # local unsubscribe are attempted, with unregister as fallback.
            page.evaluate('''() => {
              window.__retire = [];
              Object.defineProperty(navigator.serviceWorker, 'getRegistration', { configurable:true, value:async () => ({
                pushManager:{getSubscription:async () => ({endpoint:'https://push.invalid/qa', unsubscribe:async () => {window.__retire.push('unsubscribe'); throw Error('unavailable');}})},
                getNotifications:async () => [], unregister:async () => {window.__retire.push('unregister'); return true;}
              })});
            }''')
            page.locator('#signOutSite').focus()
            with sqlite3.connect(env['DB_PATH']) as db:
                history_before = db.execute('SELECT * FROM entries WHERE user_id=? ORDER BY id', (auth['user']['id'],)).fetchall()
                identities_before = db.execute('SELECT * FROM login_identities WHERE user_id=? ORDER BY provider,subject', (auth['user']['id'],)).fetchall()
            assert page.evaluate('document.activeElement.id') == 'signOutSite'
            page.keyboard.press('Enter')
            page.wait_for_function('typeof state !== "undefined" && !state.token && !state.user && !document.querySelector("#loginScreen").hidden')
            page.wait_for_function('document.querySelector("#loginStatus").textContent.includes("Signed out")')
            assert page.evaluate('localStorage.getItem("kopilkaToken")') is None
            assert page.evaluate('sessionStorage.getItem("kopilkaGoogleOAuthHandoff")') is None
            assert page.evaluate('localStorage.getItem("kopilkaVkMergeToken")') is None
            assert page.locator('#entryNote').input_value() == ''
            assert page.evaluate('document.activeElement.id') == 'loginStatus'
            with sqlite3.connect(env['DB_PATH']) as db:
                assert db.execute('SELECT * FROM entries WHERE user_id=? ORDER BY id', (auth['user']['id'],)).fetchall() == history_before
                assert db.execute('SELECT * FROM login_identities WHERE user_id=? ORDER BY provider,subject', (auth['user']['id'],)).fetchall() == identities_before
            assert context.request.get(BASE + '/api/me', headers={'Authorization':'Bearer ' + auth['token']}).status == 200, 'Logout deleted account/history or invalidated unrelated sessions'
            print('PASS accessible EN logout despite push failure; private drafts/handoff cleared; account retained', flush=True)
            # Relogin via the real website OTP entrypoint (outbound delivery fixture).
            page.locator('#emailLoginAddress').fill('logout-qa@example.com')
            page.locator('#emailLoginForm button').click()
            page.locator('#emailCodeForm').wait_for(state='visible')
            import json
            code = json.loads(Path(env['KOPILKA_LINK_QA_CODES']).read_text())['code']
            page.locator('#emailLoginCode').fill(code)
            page.locator('#emailCodeForm button').click()
            page.wait_for_function('state.user && state.profile && !document.querySelector("#appShell").hidden')
            new_token = page.evaluate('state.token')
            assert page.evaluate('state.user.id') != auth['user']['id']
            assert page.locator('#entryNote').input_value() == ''
            page.evaluate("state.user.locale='ru'; storage.set('kopilkaLocale','ru'); renderAll()")
            page.locator('[data-tab="profile"]').click()
            assert page.locator('#signOutSite').inner_text() == 'Выйти из аккаунта'
            # Stale authenticated refresh responses must not restore old account.
            page.evaluate('''() => {
              const original = fetch; window.__releaseRefresh = null;
              window.fetch = async (...args) => {
                if (args[0] === '/api/me') { const response = await original(...args); await new Promise(resolve => {window.__releaseRefresh=resolve;}); return response; }
                return original(...args);
              };
              void loadData().catch(() => {});
            }''')
            page.wait_for_function('Boolean(window.__releaseRefresh)')
            # Delay SW retirement long enough to release the response before navigation.
            page.evaluate('''() => {
              Object.defineProperty(navigator.serviceWorker,'getRegistration',{configurable:true,value:() => new Promise(() => {})});
              state.googleOAuthWindow = window; state.googleOAuthChannel='stale'; state.googleOAuthAction='auth';
              state.vkOAuthWindow = window; state.vkOAuthChannel='stale'; state.vkOAuthAction='auth';
            }''')
            page.locator('#signOutSite').click()
            page.evaluate('''(token) => {
              window.__releaseRefresh();
              window.postMessage({type:'kopilka:google-oauth',channel:'stale',token},location.origin);
              window.postMessage({type:'kopilka:vk-oauth',channel:'stale',action:'auth',token},location.origin);
            }''', auth['token'])
            page.wait_for_function('document.querySelector("#loginStatus").textContent.includes("Вышли")')
            assert page.evaluate('state.token') == ''
            assert page.evaluate('state.user') is None
            print('PASS RU logout; stale refresh/Google/VK handoffs cannot restore account; retirement timeout bounded', flush=True)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            for provider in ('google', 'vk-oauth'):
                if provider == 'vk-oauth':
                    page.evaluate("sessionStorage.setItem('kopilkaVkOAuthHandoff', JSON.stringify({type:'kopilka:vk-oauth',action:'auth',error:'VK OAuth access denied'}))")
                    page.goto(BASE + '/?vk_oauth_return=1')
                else:
                    path = '/api/auth/' + provider + '/callback?state=replayed-state&error=access_denied'
                    page.goto(BASE + path)
                    page.wait_for_url(lambda url: '/api/' not in str(url))
                page.wait_for_function('Boolean(document.querySelector("#loginStatus")?.textContent)')
                assert page.locator('#loginScreen').is_visible()
                assert 'Нажмите кнопку входа' in page.locator('#loginStatus').inner_text(), provider
                assert page.evaluate('state.token') == ''
            assert not errors, errors
            page.evaluate("storage.set('kopilkaLocale','en')")
            page.goto(BASE + '/api/auth/google/callback?state=replayed-state&error=access_denied')
            page.wait_for_url(lambda url: '/api/' not in str(url))
            page.wait_for_function('document.querySelector("#loginStatus")?.textContent.includes("Start sign-in again")')
            page.evaluate("storage.set('kopilkaLocale','ru')")
            print('PASS denied/replayed Google callback + VK fallback fixture: actionable RU/EN status, no bootstrap JS errors', flush=True)
            # Public profiles never expose logout of the visitor's own account.
            own = context.request.get(BASE + '/api/profile', headers={'Authorization':'Bearer ' + new_token}).json()['profile']
            page.goto(BASE + '/p/' + own['refCode'])
            page.wait_for_function('typeof state !== "undefined" && state.publicReadOnly')
            assert page.locator('#signOutSite').is_hidden()
            print('PASS logout hidden on other/public profile', flush=True)
            # Signed Telegram launch continues to take precedence over cached site bearer.
            import hashlib, hmac, json
            from urllib.parse import urlencode
            fields = {'auth_date':str(int(time.time())), 'user':json.dumps({'id':9176001,'first_name':'Platform QA'}, separators=(',', ':'))}
            secret = hmac.new(b'WebAppData', env['BOT_TOKEN'].encode(), hashlib.sha256).digest()
            fields['hash'] = hmac.new(secret, '\n'.join(k+'='+v for k,v in sorted(fields.items())).encode(), hashlib.sha256).hexdigest()
            launch = context.new_page()
            launch.add_init_script('window.Telegram={WebApp:{initData:'+json.dumps(urlencode(fields))+',ready(){}}}')
            launch.goto(BASE)
            launch.wait_for_function('typeof state !== "undefined" && state.user && state.profile')
            assert launch.evaluate('state.user.firstName') == 'Platform QA'
            launch.locator('[data-tab="profile"]').click()
            assert launch.locator('#signOutSite').is_hidden()
            launch.close()
            print('PASS signed Mini App direct auth remains; website logout unavailable there', flush=True)
            # Expired and revision-invalid website tokens are distinguishable at
            # the real auth boundary; no fabricated API response or TTL change.
            script = "const {createToken}=require('./src/auth/session'); console.log(createToken(Number(process.argv[1]), Date.now()-8*86400000)); require('./src/db').closeDb()"
            expired = subprocess.check_output(['node','-e',script,str(auth['user']['id'])], cwd=ROOT, env=env, text=True).strip().splitlines()[-1]
            response = context.request.get(BASE+'/api/me', headers={'Authorization':'Bearer '+expired})
            assert response.status == 401 and response.json()['code'] == 'SESSION_EXPIRED'
            notification_context = browser.new_context()
            notification_context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(BASE) else route.abort())
            try:
                notification = notification_context.new_page()
                notification.goto(BASE)
                notification.evaluate('(token)=>localStorage.setItem("kopilkaToken",token)', expired)
                notification.reload()
                notification.wait_for_function('typeof state !== "undefined" && !state.token && !document.querySelector("#loginScreen").hidden')
                assert notification.locator('#appShell').is_hidden()
            finally:
                notification_context.close()
            print('PASS expired notification entrypoint explicitly requires login (SESSION_EXPIRED); valid token scenario above did not', flush=True)
            with sqlite3.connect(env['DB_PATH']) as db:
                db.execute('UPDATE users SET session_revision=session_revision+1 WHERE id=?', (auth['user']['id'],))
            invalid = context.request.get(BASE+'/api/me', headers={'Authorization':'Bearer '+auth['token']})
            assert invalid.status == 401 and invalid.json()['code'] == 'SESSION_INVALID'
            print('PASS revision-invalid token is SESSION_INVALID, not expiry; production bare401 is inconclusive', flush=True)
        finally:
            context.close()
            browser.close()


def main():
    with tempfile.TemporaryDirectory(prefix='profile-logout-qa-') as tmp:
        env = dict(os.environ, NODE_ENV='test', PORT='3176', DB_PATH=str(Path(tmp, 'qa.sqlite')),
                   SCHEDULER_ENABLED='false', DEV_AUTH_ENABLED='true', BOT_TOKEN='test-bot-token',
                   BOT_USERNAME='HarborLifeBot', SESSION_SECRET='profile-logout-qa-secret',
                   TELEGRAM_WEBHOOK_SECRET='profile_logout_qa_secret_123456', VK_GROUP_TOKEN='',
                   VK_SECURE_KEY='qa-only-vk', VK_APP_ID='54723764', VK_GROUP_ID='240966481',
                   VK_OAUTH_CLIENT_ID='54723764', VK_OAUTH_CLIENT_SECRET='qa-only-vk-oauth', GOOGLE_CLIENT_ID='fixture-google-client',
                   GOOGLE_CLIENT_SECRET='fixture-google-secret', RESEND_API_KEY='fixture-only',
                   GEO_COUNTRY_DB_PATH='', APP_BASE_URL=BASE, WEBAPP_URL=BASE,
                   VAPID_PUBLIC_KEY='', VAPID_PRIVATE_KEY='',
                   KOPILKA_LINK_QA_CODES=str(Path(tmp, 'code.json')),
                   NODE_OPTIONS=f'--require={ROOT / "tests/fixtures/link-provider-preload.cjs"}')
        # cwd contains no .env: dotenv cannot ingest real provider credentials.
        for name in ('public', 'migrations'):
            Path(tmp, name).symlink_to(ROOT / name, target_is_directory=True)
        with Path(tmp, 'server.log').open('w+') as log:
            proc = subprocess.Popen(['node', str(ROOT / 'src/server.js')], cwd=tmp, env=env, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 30
                while True:
                    try:
                        urllib.request.urlopen(BASE + '/health', timeout=1).close()
                        break
                    except Exception:
                        if proc.poll() is not None or time.monotonic() > deadline:
                            log.seek(0)
                            raise RuntimeError(log.read())
                        time.sleep(.1)
                check(env)
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()


if __name__ == '__main__':
    main()
