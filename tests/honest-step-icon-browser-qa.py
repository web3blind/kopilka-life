#!/usr/bin/env python3
"""7616454: connected local API/SQLite; SVG needs no OS emoji glyph.
Not a native Windows 10/Chrome 139 test. No external provider calls.
"""
import base64
import hashlib
import hmac
import json
import os
import time
import urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = os.environ['KOPILKA_QA_BASE_URL']
assert os.environ['NODE_ENV'] == 'test' and 'qa.sqlite' in os.environ['DB_PATH']
OUT = Path(os.environ['HONEST_STEP_QA_OUT'])
OUT.mkdir(parents=True, exist_ok=True)
results = []
with sync_playwright() as pw:
    engines = [('chromium', pw.chromium, {'executable_path': '/usr/bin/chromium', 'args': ['--no-sandbox']})]
    if os.environ.get('KOPILKA_WEBKIT_EXECUTABLE'):
        engines.append(('webkit', pw.webkit, {'executable_path': os.environ['KOPILKA_WEBKIT_EXECUTABLE']}))
    for name, engine, launch in engines:
        browser = engine.launch(headless=True, **launch)
        try:
            for lang in ['ru', 'en']:
                for width in [320, 393]:
                    uid = 819990000 + len(results)
                    ctx = browser.new_context(viewport={'width': width, 'height': 844})
                    external = []
                    def route(r):
                        if r.request.url == 'https://telegram.org/js/telegram-web-app.js':
                            r.fulfill(content_type='application/javascript', body='/* isolated SDK fixture: no delivery */')
                        elif not r.request.url.startswith(BASE + '/'):
                            external.append(r.request.url.split('?')[0])
                            r.abort()
                        elif '/vendor/vk-bridge' in r.request.url:
                            r.fulfill(content_type='application/javascript', body='window.vkBridge={send(){return Promise.resolve({result:false})},subscribe(){},supports(){return true}}')
                        else:
                            r.continue_()
                    ctx.route('**/*', route)
                    ctx.add_init_script('localStorage.setItem("kopilkaLocale",' + json.dumps(lang) + ')')
                    p = ctx.new_page()
                    errors = []
                    p.on('pageerror', lambda e: errors.append(str(e)))
                    params = dict(vk_app_id='54723764', vk_user_id=str(uid), vk_ts=str(int(time.time())), vk_platform='desktop_web')
                    params['sign'] = base64.urlsafe_b64encode(hmac.new(os.environ['VK_SECURE_KEY'].encode(), urllib.parse.urlencode(sorted(params.items())).encode(), hashlib.sha256).digest()).decode().rstrip('=')
                    p.goto(BASE + '/?' + urllib.parse.urlencode(params))
                    p.wait_for_function('state.user && state.summary && !state.busy')
                    button = p.locator('[data-entry-type="honest_step"]')
                    icon = button.locator('.qa-icon')
                    assert icon.locator('svg').count() == 1, 'unused Honest step still relies on an OS emoji glyph'
                    assert icon.inner_text() == ''
                    assert icon.get_attribute('aria-hidden') == 'true'
                    assert icon.locator('svg').get_attribute('focusable') == 'false'
                    assert icon.locator('svg circle').evaluate('(e)=>e.getBBox().width') > 0
                    label = button.get_attribute('aria-label')
                    assert label is not None
                    assert ('Честный шаг' if lang == 'ru' else 'Honest step') in label
                    assert '\U0001f9ed' not in label
                    assert p.locator('[data-entry-type="sleep"] .qa-icon').inner_text() != '', 'other action icons were changed'
                    icon.scroll_into_view_if_needed()
                    before = icon.screenshot()
                    p.add_style_tag(content='.qa-icon{font-family:monospace!important}')
                    assert icon.screenshot() == before, 'SVG appearance depends on text font'
                    (OUT / f'{name}-{lang}-{width}-icon.png').write_bytes(before)
                    p.evaluate('renderQuickActions()')
                    assert icon.locator('svg').count() == 1, 'same-locale rerender lost SVG'
                    p.evaluate('state.user.locale=locale()==="ru"?"en":"ru";renderQuickActions()')
                    assert icon.locator('svg').count() == 1, 'locale replacement lost SVG'
                    button.focus()
                    p.keyboard.press('Enter')
                    p.wait_for_function('state.summary.todayEntryTypes.includes("honest_step") && !state.busy')
                    assert icon.locator('svg').count() == 0
                    used = icon.locator('img')
                    used_src = used.get_attribute('src')
                    assert used_src is not None and '/assets/day-scene/honest_step.webp' in used_src
                    used.evaluate('(e)=>e.decode()')
                    assert used.evaluate('(e)=>e.naturalWidth') > 0
                    assert button.get_attribute('aria-disabled') == 'true'
                    assert p.evaluate('state.summary.todayLife') == 2
                    p.keyboard.press('Enter')
                    p.wait_for_timeout(150)
                    assert p.evaluate('state.summary.todayLife') == 2, 'duplicate reward'
                    p.reload()
                    p.wait_for_function('state.user && state.summary && !state.busy')
                    assert p.evaluate('state.summary.todayLife') == 2
                    assert p.locator('[data-entry-type="honest_step"] .qa-icon img').count() == 1
                    assert not errors, errors
                    assert not external, external
                    results.append({'engine': name, 'locale': lang, 'width': width, 'initialSvg': True, 'fontIndependent': True, 'sameLocaleRerender': True, 'localeReplacement': True, 'keyboardSaved': True, 'usedImage': True, 'reloadLife': 2})
                    ctx.close()
        finally:
            browser.close()
(OUT / 'results.json').write_text(json.dumps({'cases': len(results), 'results': results}, indent=2))
print('HONEST_STEP_ICON_QA', len(results), 'cases passed')
