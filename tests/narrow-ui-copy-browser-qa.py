#!/usr/bin/env python3
"""Four scoped app-owned refinements; isolated connected HTTP/SQLite fixture only."""
import base64
import hashlib
import hmac
import json
import os
import sqlite3
import time
import urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = os.environ['KOPILKA_QA_BASE_URL']
assert os.environ['NODE_ENV'] == 'test' and 'qa.sqlite' in os.environ['DB_PATH']
OUT = Path(os.environ['KOPILKA_NARROW_PROOF_DIR'])
OUT.mkdir(parents=True, exist_ok=True)
results = []
STYLE = '''e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return {
  outline:s.outlineStyle,outlineWidth:parseFloat(s.outlineWidth),focusVisible:e.matches(':focus-visible'),
  focused:e===document.activeElement,disabled:e.disabled,aria:e.getAttribute('aria-disabled'),
  background:s.backgroundImage,backgroundColor:s.backgroundColor,color:s.color,border:s.borderColor,
  opacity:s.opacity,shadow:s.boxShadow,width:r.width,height:r.height,transform:s.transform}}'''

def contrast(fg, bg):
    import re
    def luminance(rgb):
        values = [int(v) / 255 for v in re.findall(r'\d+', rgb)[:3]]
        values = [v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in values]
        return sum(v * w for v, w in zip(values, [.2126, .7152, .0722]))
    a, b = sorted([luminance(fg), luminance(bg)])
    return (b + .05) / (a + .05)

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                                args=['--no-sandbox', '--disable-background-networking'])
    try:
        for lang, uid in [('ru', '819939071'), ('en', '819939072')]:
            ctx = browser.new_context(viewport={'width': 393, 'height': 852}, reduced_motion='reduce')
            def route(r):
                if not r.request.url.startswith(BASE + '/'):
                    r.abort()
                elif '/vendor/vk-bridge' in r.request.url:
                    r.fulfill(content_type='application/javascript', body='window.vkBridge={send:()=>Promise.resolve({}),subscribe(){},supports:()=>false};')
                else:
                    r.continue_()
            ctx.route('**/*', route)
            ctx.add_init_script('localStorage.setItem("kopilkaLocale",' + json.dumps(lang) + ')')
            p = ctx.new_page()
            errors = []
            p.on('pageerror', lambda e: errors.append(str(e)))
            params = dict(vk_app_id=os.environ['VK_APP_ID'], vk_user_id=uid,
                          vk_platform='mobile_android', vk_ts=str(int(time.time())))
            params['sign'] = base64.urlsafe_b64encode(hmac.new(os.environ['VK_SECURE_KEY'].encode(),
                urllib.parse.urlencode(sorted(params.items())).encode(), hashlib.sha256).digest()).decode().rstrip('=')
            try:
                p.goto(BASE + '/?' + urllib.parse.urlencode(params))
                p.wait_for_function('state.user && state.history && !state.busy')
                p.evaluate('lang=>{state.user.locale=lang;renderAll()}', lang)
                assert p.locator('[data-i18n="todayIntro"]').inner_text() == (
                    'Рады видеть тебя. Выбери, что сегодня было в твоей жизни.' if lang == 'ru'
                    else 'Good to see you. Choose what was present in your life today.'
                ), '7614170 greeting must be warm and localized without guessed personal data'
                def check(report, run):
                    try:
                        detail = run()
                        results.append(dict(id=report, locale=lang, passed=True, detail=detail))
                    except AssertionError as e:
                        results.append(dict(id=report, locale=lang, passed=False, error=str(e)))

                def heading():
                    p.locator('#tab-button-support').click()
                    h = p.locator('#heading-support')
                    h.click()
                    pointer = h.evaluate(STYLE)
                    p.screenshot(path=str(OUT / (lang + '-support-pointer.png')))
                    p.locator('#tab-button-today').click()
                    p.locator('#tab-button-support').focus()
                    p.keyboard.press('Enter')
                    keyboard = h.evaluate(STYLE)
                    p.screenshot(path=str(OUT / (lang + '-support-keyboard.png')))
                    assert pointer['focused'] and not pointer['focusVisible'], pointer
                    assert pointer['outlineWidth'] == 0 or pointer['outline'] == 'none', pointer
                    assert keyboard['focused'] and keyboard['focusVisible'] and keyboard['outlineWidth'] >= 3, keyboard
                    assert h.get_attribute('tabindex') == '-1'
                    assert h.get_attribute('data-i18n') == 'tabSupport'
                    assert h.evaluate('e=>e.tagName') == 'H1'
                    return dict(pointer=pointer, keyboard=keyboard)
                check('7615195', heading)

                def history():
                    p.locator('#tab-button-week').click()
                    p.wait_for_function('!state.busy')
                    b = p.locator('#historyNext')
                    p.mouse.move(1, 1)
                    p.wait_for_timeout(250)
                    disabled = b.evaluate(STYLE)
                    today = p.locator('#historyDate').input_value()
                    b.scroll_into_view_if_needed()
                    p.screenshot(path=str(OUT / (lang + '-history-today.png')))
                    assert disabled['disabled'] and disabled['aria'] == 'true', disabled
                    b.dispatch_event('click')
                    p.wait_for_timeout(100)
                    assert p.locator('#historyDate').input_value() == today
                    p.locator('#historyPrevious').click()
                    p.wait_for_function('!state.busy && !$(' + json.dumps('historyNext') + ').disabled')
                    p.mouse.move(1, 1)
                    p.wait_for_timeout(250)
                    enabled = b.evaluate(STYLE)
                    p.screenshot(path=str(OUT / (lang + '-history-yesterday.png')))
                    assert not enabled['disabled'] and enabled['aria'] == 'false', enabled
                    assert disabled['width'] == enabled['width'] and disabled['height'] == enabled['height'], (disabled, enabled)
                    assert disabled['background'] == 'none' and disabled['backgroundColor'] != enabled['backgroundColor'], (disabled, enabled)
                    assert disabled['border'] != enabled['border'] and disabled['color'] != enabled['color'], (disabled, enabled)
                    assert disabled['opacity'] == '1' and contrast(disabled['color'], disabled['backgroundColor']) >= 4.5, disabled
                    b.click()
                    p.wait_for_function('!state.busy && $("historyNext").disabled')
                    b.hover()
                    p.wait_for_timeout(250)
                    hovered = b.evaluate(STYLE)
                    assert hovered['shadow'] == 'none' and hovered['transform'] == 'none', hovered
                    assert p.locator('#historyDate').input_value() == today
                    return dict(disabled=disabled, enabled=enabled, contrast=contrast(disabled['color'], disabled['backgroundColor']))
                check('7614725', history)

                def report_link():
                    p.locator('#tab-button-settings').click()
                    links = p.locator('[data-i18n="reportProblem"]:visible')
                    assert links.count() == 1, {'visibleCount': links.count()}
                    assert p.locator('#tab-settings [data-i18n="reportProblem"]').count() == 0
                    link = links.first
                    assert link.get_attribute('href') == 'https://vk.ru/life_harbor_game'
                    assert link.inner_text() == ('Сообщить о проблеме' if lang == 'ru' else 'Report a problem')
                    p.evaluate('document.documentElement.style.fontSize="200%"')
                    try:
                        link.scroll_into_view_if_needed()
                        link.focus()
                        assert link.evaluate('e=>e===document.activeElement')
                        box = link.bounding_box()
                        assert link.evaluate('e=>Array.from(e.getClientRects()).some(r=>{const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return hit===e||e.contains(hit)})'), box
                        link.click(trial=True)
                        p.screenshot(path=str(OUT / (lang + '-report-link-200.png')))
                    finally:
                        p.evaluate('document.documentElement.style.fontSize=""')
                    return dict(visibleCount=links.count(), reachableAt200Percent=True)
                check('7613129', report_link)

                def contract_copy():
                    with sqlite3.connect(os.environ['DB_PATH']) as db:
                        before = db.execute('SELECT COUNT(*) FROM weekly_contracts').fetchone()[0]
                    p.locator('#tab-button-contract').click()
                    note = p.locator('#contractForm [data-i18n="contractCreateNote"]')
                    assert note.is_visible()
                    text = note.inner_text()
                    expected = (['календарную', 'понедельника по воскресенье', 'текущ', 'оставшиеся дни', 'не семь полных дней', 'воскресенье', 'следующей'] if lang == 'ru' else
                                ['calendar', 'Monday to Sunday', 'current', 'remaining days', 'not seven full days', 'Sunday', 'following'])
                    assert all(word in text for word in expected), text
                    assert p.locator('#contractForm').get_attribute('aria-describedby') == note.get_attribute('id')
                    p.screenshot(path=str(OUT / (lang + '-contract-precreation.png')))
                    with sqlite3.connect(os.environ['DB_PATH']) as db:
                        after = db.execute('SELECT COUNT(*) FROM weekly_contracts').fetchone()[0]
                    assert before == after, (before, after)
                    return dict(text=text, contractsCreated=after-before)
                check('7613126', contract_copy)
                assert not errors, errors
            finally:
                ctx.close()
    finally:
        browser.close()
(OUT / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
failed = [r for r in results if not r['passed']]
print('NARROW_UI_COPY', len(results), 'PASS', len(results)-len(failed), 'FAIL', len(failed), json.dumps(failed, ensure_ascii=False), flush=True)
assert not failed, failed
