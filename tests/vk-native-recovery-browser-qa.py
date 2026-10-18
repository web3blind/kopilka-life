#!/usr/bin/env python3
"""Real local HTTP recovery; host bridge/reparent and provider stand-ins, not native proof."""
import base64
import hashlib
import hmac
import json
import os
import time
import urllib.parse
import http.server
import threading
from playwright.sync_api import sync_playwright

BASE = os.environ.get('KOPILKA_QA_BASE_URL', 'http://127.0.0.1:3119')

def launch(language, user, expired=True):
    params = dict(vk_app_id='54723764', vk_user_id=str(user), vk_language=language,
                  vk_ts=str(1 if expired else int(time.time())))
    message = '&'.join(k+'='+params[k] for k in sorted(params))
    params['sign'] = base64.urlsafe_b64encode(hmac.new(b'browser-qa-vk-secure-key', message.encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return '?' + urllib.parse.urlencode(params)

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        for language in ['ru', 'en']:
            context = browser.new_context()
            try:
                # Provider page deliberately stays open: models a native reparented
                # window with closed=false and no handoff. Never calls live VK.
                context.route('http://localhost:4138/authorize?**', lambda r: r.fulfill(content_type='text/html', body='<p>Local provider/reparent cancellation fixture</p>'))
                context.route('**/*vk-bridge*', lambda r: r.fulfill(content_type='application/javascript', body='/* bridge supplied by host fixture */'))
                page = context.new_page()
                statuses = []
                page.on('response', lambda r: statuses.append(r.status) if r.url.endswith('/api/auth/vk') else None)
                fresh = launch(language, 981002)
                page.add_init_script('localStorage.setItem("kopilkaLocale", '+json.dumps(language)+'); window.bridgeCalls=[]; window.vkBridge={isWebView:()=>true, send:async method=>{bridgeCalls.push(method); return method==="VKWebAppGetLaunchParams" ? '+json.dumps(fresh)+' : {result:true};}};')
                page.goto(BASE+launch(language, 981001), wait_until='domcontentloaded')
                page.locator('#loginScreen').wait_for(state='visible')
                page.wait_for_function('bridgeCalls.includes("VKWebAppGetLaunchParams")')
                assert statuses == [401, 401], statuses
                assert page.evaluate('bridgeCalls.includes("VKWebAppInit")')
                assert len(context.pages) == 1, 'automatic OAuth is forbidden'
                for selector in ['#emailLoginForm', '#googleLoginButton', '#telegramLoginButton']:
                    assert page.locator(selector).is_hidden()
                assert page.evaluate('state.token') == ''
                # Closed popup cancellation restores the button.
                with page.expect_popup() as opened:
                    page.locator('#vkLoginButton').click()
                popup = opened.value
                popup.wait_for_url('http://localhost:4138/authorize?**', wait_until='commit')
                popup.close()
                page.wait_for_function('!document.getElementById("vkLoginButton").disabled')
                # Reparent/lost handoff: proxy still open. Advance only client clock,
                # not server/provider time or any provider quota/cooldown.
                with page.expect_popup() as opened:
                    page.locator('#vkLoginButton').click()
                popup = opened.value
                popup.wait_for_url('http://localhost:4138/authorize?**', wait_until='commit')
                assert page.evaluate('state.vkOAuthWindow.closed') is False
                page.evaluate('window.expiredVkWindow=state.vkOAuthWindow; window.expiredVkChannel=state.vkOAuthChannel')
                page.evaluate('window.nativeTestNow=Date.now(); Date.now=()=>window.nativeTestNow+121000')
                page.wait_for_function('!document.getElementById("vkLoginButton").disabled', timeout=3000)
                assert page.evaluate('state.vkOAuthChannel') == ''
                assert page.evaluate('state.vkOAuthWindow') is None
                assert page.evaluate('state.token') == ''
                assert not popup.is_closed(), 'do not close a possibly reparented native window'
                assert page.locator('#loginStatus').inner_text()
                assert page.evaluate('locale()') == language
                page.evaluate("receiveVkOAuthHandoff({origin:location.origin,source:window.expiredVkWindow,data:{type:'kopilka:vk-oauth',action:'auth',channel:window.expiredVkChannel,token:'late-forged-token'}})")
                assert page.evaluate('state.token') == '', 'late expired handoff must be ignored'
                # A genuine fresh signed bridge proof succeeds via the real auth
                # and private-data routes, with no OAuth or cached-user fallback.
                verified_id = 981003 if language == 'ru' else 981004
                valid = launch(language, verified_id, expired=False)
                page.evaluate('proof => {window.vkBridge.send=async method=>{bridgeCalls.push(method);return method==="VKWebAppGetLaunchParams" ? proof : {result:true};};}', valid)
                page.evaluate('handleVkAuth()')
                page.locator('#appShell').wait_for(state='visible')
                assert statuses == [401, 401, 401, 200], statuses
                import sqlite3
                with sqlite3.connect(os.environ['DB_PATH']) as db:
                    identity = db.execute('SELECT vk_id FROM users WHERE id=?', (page.evaluate('state.user.id'),)).fetchone()
                assert identity == (str(verified_id),), identity
                assert page.evaluate('locale()') == language
                print('PASS', language, 'signed401/bridge401 explicit recovery; close/open-window timeout; late handoff ignored; fresh bridge200 verified identity')
            finally:
                context.close()

if __name__ == '__main__':
    class Provider(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(b'<p>Local provider/reparent cancellation fixture</p>')
        def log_message(self, format, *args):
            pass
    with http.server.ThreadingHTTPServer(('127.0.0.1', 4138), Provider) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            main()
        finally:
            server.shutdown()
            thread.join()
