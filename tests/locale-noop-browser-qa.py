#!/usr/bin/env python3
"""7617692: real locale HTTP/SQLite, isolated RU/EN contexts, no live providers.

Run with tests/run-browser-qa.py; attach to CDP without closing the shared browser.
"""
import base64
import hashlib
import hmac
import json
import os
import sqlite3
import time
import urllib.parse
from playwright.sync_api import sync_playwright

BASE = os.environ['KOPILKA_QA_BASE_URL']
assert os.environ['NODE_ENV'] == 'test' and 'qa.sqlite' in os.environ['DB_PATH']


def launch(uid):
    params = {'vk_app_id': os.environ['VK_APP_ID'], 'vk_user_id': str(uid),
              'vk_platform': 'mobile_android', 'vk_ts': str(int(time.time()))}
    params['sign'] = base64.urlsafe_b64encode(hmac.new(
        os.environ['VK_SECURE_KEY'].encode(),
        urllib.parse.urlencode(sorted(params.items())).encode(), hashlib.sha256
    ).digest()).decode().rstrip('=')
    return urllib.parse.urlencode(params)


with sync_playwright() as pw:
    browser = pw.chromium.connect_over_cdp(os.environ.get('KOPILKA_QA_CDP_URL', 'http://127.0.0.1:18800'))
    for initial, uid in [('ru', 819976176921), ('en', 819976176922)]:
        context = browser.new_context(viewport={'width': 393, 'height': 852}, service_workers='block')
        try:
            def local_only(route):
                if '/vendor/vk-bridge' in route.request.url:
                    route.fulfill(content_type='application/javascript', body='window.vkBridge={send:()=>Promise.resolve({result:false}),subscribe(){},supports:()=>true};')
                elif route.request.url.startswith(BASE + '/'):
                    route.continue_()
                else:
                    route.abort()
            context.route('**/*', local_only)
            context.add_init_script('localStorage.setItem("kopilkaLocale",' + json.dumps(initial) + ');')
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(BASE + '/?' + launch(uid))
            page.wait_for_function('state.user && state.summary && state.history && !state.busy')
            page.locator('#tab-button-settings').click()
            page.wait_for_load_state('networkidle')
            user_id = page.evaluate('state.user.id')
            traffic = []
            page.on('request', lambda request: traffic.append((request.method, urllib.parse.urlparse(request.url).path)))

            def selected(language):
                assert page.locator('#lang-' + language).get_attribute('aria-pressed') == 'true'
                other = 'en' if language == 'ru' else 'ru'
                assert page.locator('#lang-' + other).get_attribute('aria-pressed') == 'false'
                assert page.evaluate('locale()') == language
                assert page.evaluate('storage.get("kopilkaLocale")') == language
                with sqlite3.connect(os.environ['DB_PATH']) as db:
                    assert db.execute('SELECT locale FROM users WHERE id=?', (user_id,)).fetchone() == (language,)

            def burst(language):
                # Every click after a completed save is allowed by the busy guard.
                # Await individual click microtasks so this is not merely one synchronous burst.
                page.evaluate('''async language => {
                  for (let i=0;i<100;i++) {
                    document.querySelector('#lang-'+language).click();
                    await new Promise(resolve=>setTimeout(resolve,0));
                  }
                }''', language)
                page.evaluate('async language => { await setLanguage(language.toUpperCase()); await setLanguage(language + "-QA"); }', language)
                page.wait_for_load_state('networkidle')
                assert traffic == [], ('same-locale clicks must emit zero HTTP requests', traffic)
                assert page.evaluate('!state.busy')
                selected(language)

            selected(initial)
            burst(initial)
            print('PASS', initial, '100 active-locale clicks: 0 HTTP requests', flush=True)
            target = 'en' if initial == 'ru' else 'ru'
            pending = []
            context.route('**/api/settings/locale', lambda route: pending.append(route))
            page.locator('#lang-' + target).click()
            page.wait_for_function('state.busy')
            page.wait_for_timeout(100)
            assert len(pending) == 1
            assert json.loads(pending[0].request.post_data) == {'locale': target}
            page.evaluate('''() => {
              for (let i=0;i<100;i++) {
                for (const button of document.querySelectorAll('[data-lang]')) {
                  if (!button.disabled) throw Error('language control must be disabled while saving');
                  button.click();
                  button.dispatchEvent(new MouseEvent('click', {bubbles:true}));
                }
              }
            }''')
            page.wait_for_timeout(100)
            assert traffic == [('POST', '/api/settings/locale')], traffic
            pending[0].continue_()
            context.unroute('**/api/settings/locale')
            page.wait_for_function('!state.busy')
            page.wait_for_load_state('networkidle')
            assert [r for r in traffic if r[0] == 'POST'] == [('POST', '/api/settings/locale')], traffic
            assert any(path == '/api/me' for method, path in traffic), 'real post-save refresh must run'
            selected(target)
            print('PASS', initial, '->', target, 'delayed switch + busy burst: 1 locale POST; selection/storage/SQLite correct', flush=True)
            traffic.clear()
            burst(target)
            print('PASS', target, '100 clicks after save: 0 HTTP requests', flush=True)

            def fail_save(route):
                route.fulfill(status=503, content_type='application/json', body=json.dumps({'error': 'Fixture locale save failed'}))
            context.route('**/api/settings/locale', fail_save)
            page.locator('#lang-' + initial).click()
            page.wait_for_function('!state.busy && document.querySelector("#statusRegion").classList.contains("error")')
            page.wait_for_load_state('networkidle')
            assert traffic == [('POST', '/api/settings/locale')], traffic
            assert page.locator('#statusRegion').inner_text() == 'Fixture locale save failed'
            selected(target)
            context.unroute('**/api/settings/locale', fail_save)
            traffic.clear()
            page.locator('#lang-' + initial).click()
            page.wait_for_function('!state.busy && locale() === ' + json.dumps(initial))
            page.wait_for_load_state('networkidle')
            assert [r for r in traffic if r[0] == 'POST'] == [('POST', '/api/settings/locale')], traffic
            selected(initial)
            print('PASS', initial, 'failed change retains prior selection; retry: 1 real POST and persisted', flush=True)
            traffic.clear()
            burst(initial)
            page.reload()
            page.wait_for_function('state.user && state.summary && !state.busy')
            page.wait_for_load_state('networkidle')
            selected(initial)
            assert not errors, errors
            with sqlite3.connect(os.environ['DB_PATH']) as db:
                assert db.execute('SELECT COUNT(*) FROM entries WHERE user_id=?', (user_id,)).fetchone() == (0,)
                assert db.execute('SELECT COUNT(*) FROM user_support_actions WHERE user_id=?', (user_id,)).fetchone() == (0,)
            print('PASS', initial, 'retry followed by 100 no-op clicks + reload persistence; no entries/rewards or page errors', flush=True)
        finally:
            context.close()
    # Do not close the shared browser or foreign contexts/tabs.
