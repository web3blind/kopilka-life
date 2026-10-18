#!/usr/bin/env python3
"""7615502: real signed fixture VK auth/start/data + deferred stale merge HTTP.
Run with tests/run-browser-qa.py; only its isolated SQLite is used, never VK.
"""
import base64
import hashlib
import hmac
import json
import os
import time
import urllib.parse
from playwright.sync_api import sync_playwright

BASE = os.environ['KOPILKA_QA_BASE_URL']
KEY = 'browser-qa-vk-secure-key'


def launch(user_id, lang):
    params = {'vk_app_id': '54723764', 'vk_user_id': str(user_id), 'vk_ts': str(int(time.time()))}
    params['sign'] = base64.urlsafe_b64encode(hmac.new(KEY.encode(), urllib.parse.urlencode(sorted(params.items())).encode(), hashlib.sha256).digest()).decode().rstrip('=')
    params['lang'] = lang
    return BASE + '/?' + urllib.parse.urlencode(params)


with sync_playwright() as pw:
    # A disposable unauthenticated browser: no live provider or shared contexts.
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    try:
        for lang, user_id in [('ru', 819976155), ('en', 819976156)]:
            context = browser.new_context(viewport={'width': 390, 'height': 844})
            try:
                context.route('**/*', lambda route: route.continue_() if urllib.parse.urlsplit(route.request.url).hostname == '127.0.0.1' else route.abort())
                context.add_init_script("localStorage.setItem('kopilkaVkMergeToken','stale-fixture-merge-token');localStorage.setItem('kopilkaLocale'," + json.dumps(lang) + ");")
                held = []
                context.route('**/api/account/merge-vk/preview', lambda route: held.append(route))
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(launch(user_id, lang), wait_until='domcontentloaded')
                page.wait_for_function('state.user && state.summary && !state.busy')
                deadline = time.monotonic() + 10
                while not held and time.monotonic() < deadline:
                    page.wait_for_timeout(50)
                assert len(held) == 1, 'actual start did not reach merge preview'
                early = page.locator('#statusRegion').inner_text()
                if early:
                    # The pre-fix flow: dismiss handleVkAuth Ready while preview is pending.
                    page.locator('#dismissStatus').click()
                    assert page.locator('#statusRegion').inner_text() == ''
                stale = held.pop()
                response = stale.fetch()
                assert response.status >= 400, 'stale offer must be rejected by real isolated API'
                stale.fulfill(response=response)
                page.wait_for_function("!localStorage.getItem('kopilkaVkMergeToken')")
                page.wait_for_timeout(100)
                if early:
                    assert page.locator('#statusRegion').inner_text() == '', '7615502: dismissed Ready resurrected after stale merge rejection'
                assert not early, 'Ready published before pending merge resolved'
                assert page.locator('#statusRegion').inner_text() == page.evaluate("L('ready')")
                page.locator('#dismissStatus').click()
                assert page.locator('#statusRegion').inner_text() == ''
                page.wait_for_timeout(250)
                assert page.locator('#statusRegion').inner_text() == ''
                assert page.locator('#dismissStatus').is_hidden()
                page.evaluate('start()')
                assert page.locator('#dismissStatus').is_visible(), 'new startup must get its own Ready'
                page.locator('#dismissStatus').click()
                page.evaluate('handleVkAuth()')
                assert page.locator('#statusRegion').inner_text() == page.evaluate("L('ready')"), 'standalone auth lost Ready'
                assert page.locator('#dismissStatus').is_visible()
                assert not errors, errors
                print(json.dumps({'scenario': '7615502-' + lang, 'pass': True, 'earlyReady': False, 'staleHTTP': response.status, 'dismissPreserved': True, 'newStartupReady': True, 'standaloneReady': True}), flush=True)
            finally:
                context.close()
    finally:
        browser.close()
print('STARTUP_READY_RACE_CONNECTED_PASS 2', flush=True)
