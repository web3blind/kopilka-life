#!/usr/bin/env python3
"""7612044/7612066 connected regressions; temporary SQLite and local-only contexts."""
import tempfile
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import sqlite3
import time
import urllib.parse
from playwright.sync_api import sync_playwright

BASE = os.environ['KOPILKA_QA_BASE_URL']
assert os.environ['NODE_ENV'] == 'test' and 'qa.sqlite' in os.environ['DB_PATH']
OUT = Path(os.environ.get('KOPILKA_FIX_QA_OUTPUT', (tempfile.gettempdir() + '/kopilka-qa/kopilka-settings-stake-fixes')))
OUT.mkdir(parents=True, exist_ok=True)
results = []
failures = []

def launch(uid):
    params = {'vk_app_id': os.environ['VK_APP_ID'], 'vk_user_id': str(uid), 'vk_platform': 'mobile_android', 'vk_ts': str(int(time.time()))}
    params['sign'] = base64.urlsafe_b64encode(hmac.new(os.environ['VK_SECURE_KEY'].encode(), urllib.parse.urlencode(sorted(params.items())).encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return urllib.parse.urlencode(params)

with sync_playwright() as pw:
    browser = pw.chromium.connect_over_cdp(os.environ.get('KOPILKA_QA_CDP_URL', 'http://127.0.0.1:18800'))
    for language in ('ru', 'en'):
        for case in ('settings', 'stake'):
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
                context.add_init_script('localStorage.setItem("kopilkaLocale",' + json.dumps(language) + ');')
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(BASE + '/?' + launch(819976120440 + len(results)))
                page.wait_for_function('state.user && state.summary && state.history && !state.busy')
                page.wait_for_load_state('networkidle')
                uid = page.evaluate('state.user.id')
                if case == 'settings':
                    page.locator('#tab-button-settings').click()
                    page.wait_for_load_state('networkidle')
                    traffic = []
                    page.on('request', lambda r: traffic.append((r.method, urllib.parse.urlparse(r.url).path)))
                    page.evaluate('setStatus("")')
                    for _ in range(3):
                        page.locator('#settingsForm button[type=submit]').click()
                        page.wait_for_load_state('networkidle')
                    assert not traffic, ('unchanged settings emitted HTTP', traffic)
                    assert page.locator('#statusRegion').inner_text() == '', 'unchanged settings must not emit success toast'
                    initial_reminders = page.locator('#remindersEnabled').is_checked()
                    page.locator('#remindersEnabled').set_checked(not initial_reminders)
                    page.locator('#remindersEnabled').set_checked(initial_reminders)
                    page.locator('#settingsForm button[type=submit]').click()
                    page.wait_for_load_state('networkidle')
                    assert not traffic, ('reverted draft must be no-op', traffic)
                    old = page.evaluate('state.user.eveningReminderTime')
                    target = '19:17' if old != '19:17' else '18:16'
                    page.locator('#eveningReminderTime').fill(target)
                    def fail_save(route):
                        route.fulfill(status=503, content_type='application/json', body='{"error":"Fixture settings failure"}')
                    context.route('**/api/settings/reminders', fail_save)
                    page.locator('#settingsForm button[type=submit]').click()
                    page.wait_for_function('!state.busy && document.querySelector("#statusRegion").classList.contains("error")')
                    assert page.evaluate('state.settingsDirty')
                    assert page.locator('#eveningReminderTime').input_value() == target
                    assert page.evaluate('state.user.eveningReminderTime') == old
                    context.unroute('**/api/settings/reminders', fail_save)
                    page.locator('#settingsForm button[type=submit]').click()
                    page.wait_for_function('!state.busy && !state.settingsDirty')
                    page.wait_for_load_state('networkidle')
                    assert len([r for r in traffic if r == ('POST', '/api/settings/reminders')]) == 2
                    with sqlite3.connect(os.environ['DB_PATH']) as db:
                        assert db.execute('SELECT evening_reminder_time FROM users WHERE id=?', (uid,)).fetchone() == (target,)
                    traffic.clear()
                    page.evaluate('setStatus("")')
                    page.locator('#settingsForm button[type=submit]').click()
                    page.wait_for_load_state('networkidle')
                    assert not traffic and page.locator('#statusRegion').inner_text() == ''
                    page.locator('#remindersEnabled').set_checked(not initial_reminders)
                    page.locator('#timezone').select_option('UTC')
                    page.locator('#settingsForm button[type=submit]').click()
                    page.wait_for_function('!state.busy && !state.settingsDirty')
                    page.wait_for_load_state('networkidle')
                    assert len([r for r in traffic if r == ('POST', '/api/settings/reminders')]) == 1
                    with sqlite3.connect(os.environ['DB_PATH']) as db:
                        assert db.execute('SELECT timezone, reminders_enabled FROM users WHERE id=?', (uid,)).fetchone() == ('UTC', int(not initial_reminders))
                    page.reload()
                    page.wait_for_function('state.user && state.summary && !state.busy')
                    assert page.evaluate('state.user.eveningReminderTime') == target
                else:
                    page.locator('#tab-button-contract').click()
                    amount = page.locator('#stakeAmount')
                    amount.fill('')
                    amount.press_sequentially('abc')
                    assert amount.input_value() == '', 'letters must not appear while typing'
                    amount.press_sequentially('12,50')
                    assert amount.input_value() == '12,50'
                    page.evaluate('document.querySelector("#stakeAmount").setSelectionRange(2,2)')
                    amount.press_sequentially('x')
                    assert amount.input_value() == '12,50'
                    assert page.evaluate('document.querySelector("#stakeAmount").selectionStart') == 2
                    amount.press_sequentially('3')
                    assert amount.input_value() == '123,50'
                    for value in ('', '0', '0.005', '00012,500', '12.', '.5', ','):
                        amount.fill(value)
                        assert amount.input_value() == value, ('valid partial edit lost', value)
                    amount.fill('12.50')
                    for text in ('abc', '-1', '1e3', '1,2.3'):
                        page.evaluate('''text => { const el=document.querySelector('#stakeAmount'); el.setSelectionRange(0,el.value.length); const data=new DataTransfer();data.setData('text/plain',text); const e=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}); const allowed=el.dispatchEvent(e); if(allowed){el.setRangeText(text,el.selectionStart,el.selectionEnd,'end');el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertFromPaste',data:text}));} }''', text)
                        assert amount.input_value() == '12.50', ('invalid paste changed draft', text)
                    # Browsers without cancellable beforeinput still reject an
                    # invalid input event and retain the last accepted draft.
                    page.evaluate('''() => {const el=document.querySelector('#stakeAmount'); el.value='12x.50'; el.dispatchEvent(new InputEvent('input',{bubbles:true}));}''')
                    assert amount.input_value() == '12.50'
                    page.evaluate('''() => {const el=document.querySelector('#stakeAmount'); el.setSelectionRange(0,el.value.length); const data=new DataTransfer(); data.setData('text/plain','0,005'); const e=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}); if(el.dispatchEvent(e)){el.setRangeText('0,005',0,el.value.length,'end');el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertFromPaste'}));}}''')
                    assert amount.input_value() == '0,005'
                    amount.press('End')
                    amount.press('Backspace')
                    assert amount.input_value() == '0,00'
                    amount.fill('12.50')
                    page.evaluate('''() => { const el=document.querySelector('#stakeAmount'); el.setSelectionRange(2,2);el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.value='12漢.50';el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,data:'漢'})); }''')
                    assert amount.input_value() == '12漢.50', 'do not interrupt active IME composition'
                    page.evaluate('document.querySelector("#stakeAmount").dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:"漢"}))')
                    assert amount.input_value() == '12.50'
                    assert page.evaluate('document.querySelector("#stakeAmount").selectionStart') == 2
                    amount.fill('12,50')
                    page.locator('#contractTitle').fill('Fixture goal')
                    page.locator('#contractTarget').fill('Fixture step')
                    page.locator('#contractForm button[type=submit]').click()
                    page.wait_for_function('!state.busy && state.currentContract')
                    with sqlite3.connect(os.environ['DB_PATH']) as db:
                        assert db.execute('SELECT stake_amount FROM weekly_contracts WHERE user_id=?', (uid,)).fetchone() == ('12.50',)
                assert not errors, errors
                results.append({'locale': language, 'case': case, 'passed': True})
                print('PASS', language, case, flush=True)
            except Exception as error:
                failures.append(str(error))
                results.append({'locale': language, 'case': case, 'passed': False, 'error': str(error)})
                print('FAIL', language, case, str(error), flush=True)
            finally:
                context.close()
(OUT / 'results.json').write_text(json.dumps(results, indent=2))
assert not failures, failures
