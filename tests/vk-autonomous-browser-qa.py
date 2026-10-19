#!/usr/bin/env python3
"""Isolated real HTTP/CDP VK OAuth regression; local provider only, no live accounts."""
import importlib.util
import base64
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
import urllib.request
import urllib.parse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PORT = os.environ.get('KOPILKA_QA_PORT', '3186')
BASE = 'http://127.0.0.1:' + PORT
PROVIDER = 'http://localhost:' + os.environ.get('KOPILKA_QA_PROVIDER_PORT', '4186')

def main():
    spec = importlib.util.spec_from_file_location('oauth_fixture', ROOT / 'tests/browser-audit-qa.py')
    assert spec is not None and spec.loader is not None
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    provider = fixture.OAuthStandIn(PROVIDER)
    provider.__enter__()
    with tempfile.TemporaryDirectory(prefix='vk-autonomous-', dir=os.environ.get('TMPDIR')) as tmp:
        db = str(Path(tmp, 'qa.sqlite'))
        env = dict(os.environ, NODE_ENV='test', PORT=PORT, DB_PATH=db, SCHEDULER_ENABLED='false', DEV_AUTH_ENABLED='true',
                   BOT_TOKEN='test-bot-token', BOT_USERNAME='HarborLifeBot', SESSION_SECRET='vk-autonomous-fixture-session',
                   TELEGRAM_WEBHOOK_SECRET='fixture_webhook_secret_123456', RESEND_API_KEY='', GOOGLE_CLIENT_ID='', GOOGLE_CLIENT_SECRET='',
                   VK_GROUP_TOKEN='', VK_GROUP_ID='240966481', VK_APP_ID='54723764', VK_SECURE_KEY='fixture-vk-key',
                   VK_OAUTH_CLIENT_ID='54723764', VK_OAUTH_CLIENT_SECRET='fixture-only', VK_OAUTH_AUTHORIZE_URL=PROVIDER+'/authorize',
                   VK_OAUTH_TOKEN_URL=PROVIDER+'/token', APP_BASE_URL=BASE, WEBAPP_URL=BASE, GEO_COUNTRY_DB_PATH=str(Path(tmp,'missing.mmdb')),
                   VAPID_PUBLIC_KEY='', VAPID_PRIVATE_KEY='', NODE_OPTIONS=f"--require={ROOT / 'tests/fixtures/vk-login-recovery-preload.cjs'}")
        with Path(tmp, 'server.log').open('w+') as log:
            proc = subprocess.Popen(['node', str(ROOT/'src/server.js')], cwd=ROOT, env=env, stdout=log, stderr=log)
            try:
                deadline = time.monotonic()+30
                while True:
                    try:
                        urllib.request.urlopen(BASE+'/health', timeout=1).close()
                        break
                    except Exception:
                        if proc.poll() is not None or time.monotonic()>deadline:
                            log.seek(0)
                            raise RuntimeError(log.read())
                        time.sleep(.1)
                with sync_playwright() as p:
                    browser = p.chromium.connect_over_cdp(os.environ.get('KOPILKA_QA_CDP_URL','http://127.0.0.1:18800'))
                    contexts = []
                    def isolated_context():
                        ctx = browser.new_context()
                        ctx.route('**/*', lambda route: route.continue_() if route.request.url.startswith((BASE+'/', PROVIDER+'/')) else route.abort())
                        return ctx
                    def guard_duplicates(ctx):
                        def callback(route):
                            def snapshot():
                                with sqlite3.connect(db) as connection:
                                    return list(connection.iterdump())
                            before = snapshot()
                            exchanges = sum(kind == 'token' for kind, _ in provider.requests)
                            # Two real background GETs with the browser's HttpOnly
                            # cookie, followed by the visible browser document GET.
                            for headers in [{}, {'Purpose': 'prefetch'}]:
                                response = ctx.request.get(route.request.url, headers=headers)
                                assert response.status == 200
                                assert 'set-cookie' not in response.headers
                                assert '/api/auth/vk-oauth/complete' in response.text()
                            assert snapshot() == before, 'background GET mutated SQLite'
                            assert sum(kind == 'token' for kind, _ in provider.requests) == exchanges
                            route.continue_()
                        ctx.route('**/api/auth/vk-oauth/callback?**', callback)
                    def fresh(token=None):
                        ctx = isolated_context()
                        contexts.append(ctx); guard_duplicates(ctx)
                        page = ctx.new_page()
                        if token:
                            page.add_init_script('localStorage.setItem("kopilkaToken", '+json.dumps(token)+');')
                        page.goto(BASE, wait_until='domcontentloaded')
                        page.locator('#appShell' if token else '#loginScreen').wait_for(state='visible')
                        return ctx, page
                    def who(ctx, token):
                        result = ctx.request.get(BASE+'/api/me', headers={'Authorization':'Bearer '+token})
                        assert result.ok, result.text()
                        user = result.json()['user']
                        with sqlite3.connect(db) as connection:
                            user['vk_id'] = connection.execute('SELECT vk_id FROM users WHERE id=?', (user['id'],)).fetchone()[0]
                        return user
                    try:
                        # After the opener has created the intent, hold its start request
                        # and suspend only the opener; the external flow must finish.
                        ctx, page = fresh()
                        session = ctx.new_cdp_session(page)
                        def paused_window(route):
                            session.send('Emulation.setScriptExecutionDisabled', {'value': True})
                            route.continue_()
                        ctx.route('**/api/auth/vk-oauth/start?**', paused_window)
                        with page.expect_popup() as opened:
                            page.locator('#vkLoginButton').click()
                        popup = opened.value
                        for _ in range(100):
                            if provider.authorize_seen.is_set(): break
                            popup.wait_for_timeout(50)
                        assert provider.authorize_seen.is_set(), 'popup failed to reach provider while opener disabled'
                        assert any(c.get('name')=='kopilka_oauth_browser' and c.get('httpOnly') for c in ctx.cookies(BASE+'/api/auth/vk-oauth/start'))
                        provider.authorize_gate.set()
                        popup.locator('#appShell').wait_for(state='visible', timeout=20000)
                        token = popup.evaluate('localStorage.getItem("kopilkaToken")')
                        assert str(who(ctx,token)['vk_id']) == str(provider.user_id)
                        authorization = next(fields for kind, fields in provider.requests if kind == 'authorize')
                        exchange = next(fields for kind, fields in provider.requests if kind == 'token')
                        challenge = base64.urlsafe_b64encode(hashlib.sha256(exchange['code_verifier'][0].encode()).digest()).decode().rstrip('=')
                        assert authorization['code_challenge_method'] == ['S256']
                        assert authorization['code_challenge'] == [challenge]
                        assert exchange['state'] == authorization['state']
                        assert popup.evaluate('window.name') == ''
                        assert popup.evaluate('sessionStorage.getItem("kopilkaVkOAuthBootstrap")') is None
                        assert token not in popup.url
                        session.send('Emulation.setScriptExecutionDisabled', {'value': False})
                        print('PASS intent created before opener suspension: start/PKCE/callback + same-tab fallback')
                        ctx.close(); contexts.remove(ctx)

                        # Normal popup return and origin/source/channel/action rejection.
                        ctx, page = fresh()
                        provider.authorize_seen.clear(); provider.authorize_gate.clear()
                        with page.expect_popup() as opened: page.locator('#vkLoginButton').click()
                        popup = opened.value
                        for _ in range(100):
                            if provider.authorize_seen.is_set(): break
                            page.wait_for_timeout(30)
                        channel = page.evaluate('state.vkOAuthChannel')
                        page.evaluate("channel => receiveVkOAuthHandoff({origin:location.origin,source:window,data:{type:'kopilka:vk-oauth',action:'auth',channel,token:'forged'}})",channel)
                        assert page.evaluate('state.token') == ''
                        provider.authorize_gate.set()
                        page.locator('#appShell').wait_for(state='visible',timeout=20000)
                        assert str(who(ctx,page.evaluate('state.token'))['vk_id']) == str(provider.user_id)
                        page.wait_for_timeout(200)
                        assert popup.is_closed(), 'handoff not acknowledged/closed'
                        print('PASS normal auth handoff; forged same-origin source rejected')
                        ctx.close(); contexts.remove(ctx)

                        # Link from original authenticated account; no login replacement.
                        ctx = isolated_context(); contexts.append(ctx); guard_duplicates(ctx)
                        created = ctx.request.post(BASE+'/api/auth/dev', data={'firstName':'Link fixture'}).json()
                        token = created['token']; target = created['user']['id']
                        page = ctx.new_page(); page.add_init_script('localStorage.setItem("kopilkaToken",'+json.dumps(token)+');')
                        page.goto(BASE); page.locator('#appShell').wait_for(state='visible')
                        provider.user_id = 770088
                        with page.expect_popup() as opened: page.evaluate("startVkOAuth('link')")
                        page.wait_for_function('state.vkOAuthWindow === null',timeout=20000)
                        user = who(ctx,page.evaluate('state.token'))
                        for _ in range(100):
                            user = who(ctx,page.evaluate('state.token'))
                            if str(user.get('vk_id')) == str(provider.user_id): break
                            page.wait_for_timeout(50)
                        assert user['id'] == target and str(user['vk_id']) == str(provider.user_id)
                        with sqlite3.connect(db) as connection:
                            assert connection.execute('SELECT consumed_at FROM vk_oauth_link_proofs WHERE target_user_id=?',(target,)).fetchone()[0] is not None
                        print('PASS link preserves initiating account; authenticated finalize consumes proof')
                        ctx.close(); contexts.remove(ctx)

                        # Link opener suspended after intent creation retains the session in
                        # the popup fallback and finalize only its verified proof.
                        ctx = isolated_context(); contexts.append(ctx); guard_duplicates(ctx)
                        created = ctx.request.post(BASE+'/api/auth/dev', data={'firstName':'Paused link fixture'}).json()
                        target = created['user']['id']; token = created['token']
                        page = ctx.new_page(); page.add_init_script('localStorage.setItem("kopilkaToken",'+json.dumps(token)+');')
                        page.goto(BASE); page.locator('#appShell').wait_for(state='visible')
                        session = ctx.new_cdp_session(page)
                        def paused_link_window(route):
                            session.send('Emulation.setScriptExecutionDisabled', {'value': True})
                            route.continue_()
                        ctx.route('**/api/auth/vk-oauth/start?**', paused_link_window)
                        provider.user_id = 770089
                        with page.expect_popup() as opened: page.evaluate("startVkOAuth('link')")
                        popup = opened.value
                        popup.locator('#appShell').wait_for(state='visible',timeout=20000)
                        user = who(ctx,popup.evaluate('state.token'))
                        assert user['id'] == target and str(user['vk_id']) == str(provider.user_id)
                        assert popup.evaluate('window.name') == ''
                        session.send('Emulation.setScriptExecutionDisabled', {'value': False})
                        print('PASS paused link opener: popup fallback finalizes original account only')
                        ctx.close(); contexts.remove(ctx)

                        # Blocked popup keeps explicit first-party fallback.
                        ctx, page = fresh()
                        page.evaluate('window.open=()=>null')
                        page.locator('#vkLoginButton').click()
                        link = page.locator('#loginStatus a'); link.wait_for(state='visible')
                        url = link.get_attribute('href')
                        assert url is not None
                        assert url.startswith(BASE+'/api/auth/vk-oauth/start?intent=')
                        assert page.locator('#vkLoginButton').is_enabled()
                        page.goto(url); page.locator('#appShell').wait_for(state='visible',timeout=20000)
                        assert str(who(ctx,page.evaluate('state.token'))['vk_id']) == str(provider.user_id)
                        print('PASS popup-blocked explicit fallback completes auth')
                        ctx.close(); contexts.remove(ctx)

                        # Cancellation restores controls without authenticating.
                        ctx, page = fresh()
                        provider.authorize_gate.clear(); provider.authorize_seen.clear()
                        ctx.route(PROVIDER+'/authorize?**', lambda route: route.fulfill(content_type='text/html', body='<p>Local cancellation fixture</p>'))
                        with page.expect_popup() as opened: page.locator('#vkLoginButton').click()
                        popup = opened.value
                        popup.close()
                        page.wait_for_function('!document.getElementById("vkLoginButton").disabled')
                        assert page.evaluate('state.token') == ''
                        assert page.locator('#loginStatus').inner_text()
                        provider.authorize_gate.set()
                        print('PASS cancelled popup restores login control')
                        ctx.close(); contexts.remove(ctx)

                        # Cross-site Mini App explicit recovery with third-party cookies restricted.
                        ctx = isolated_context(); contexts.append(ctx); guard_duplicates(ctx)
                        host = ctx.new_page()
                        cdp = ctx.new_cdp_session(host)
                        cdp.send('Network.enable')
                        cdp.send('Network.setCookieControls', {'enableThirdPartyCookieRestriction': True, 'disableThirdPartyCookieMetadata': True, 'disableThirdPartyCookieHeuristics': True})
                        embedded = BASE+'/?vk_app_id=54723764&vk_user_id=1&sign=invalid'
                        host.goto(PROVIDER+'/frame?'+urllib.parse.urlencode({'app':embedded}))
                        frame = next(f for f in host.frames if f.url.startswith(BASE))
                        frame.locator('#loginScreen').wait_for(state='visible')
                        with host.expect_popup() as opened: frame.evaluate("startVkOAuth('auth', document.getElementById('loginStatus'))")
                        frame.locator('#appShell').wait_for(state='visible',timeout=20000)
                        assert str(who(ctx,frame.evaluate('state.token'))['vk_id']) == str(provider.user_id)
                        assert not host.evaluate("window.oauthMessages.some(m=>m.hasToken)")
                        print('PASS cross-site iframe recovery with third-party cookies blocked; host gets no token')
                        ctx.close(); contexts.remove(ctx)

                        assert sum(kind == 'authorize' for kind, _ in provider.requests) == sum(kind == 'token' for kind, _ in provider.requests), 'each completed authorization exchanges exactly once'
                        print('PASS every completed flow: duplicate background GETs inert, visible POST exchanges once')

                        # Intent/network failure is visible and reaches the opener.
                        ctx, page = fresh()
                        ctx.route('**/api/auth/vk-oauth/intent', lambda route: route.fulfill(status=503,content_type='application/json',body='{"error":"fixture"}'))
                        with page.expect_popup() as opened: page.locator('#vkLoginButton').click()
                        popup = opened.value
                        page.wait_for_function('!document.getElementById("vkLoginButton").disabled')
                        page.wait_for_function("document.getElementById('loginStatus').textContent === L('oauthLoginRetry')")
                        assert page.evaluate('state.token') == ''
                        print('PASS failed intent surfaces error and restores login')
                    finally:
                        provider.authorize_gate.set()
                        for ctx in contexts: ctx.close()
            finally:
                proc.terminate()
                try: proc.wait(timeout=10)
                except subprocess.TimeoutExpired: proc.kill(); proc.wait()
                provider.__exit__()
                assert proc.poll() is not None

if __name__ == '__main__': main()
