#!/usr/bin/env python3
"""Connected VK Testers regressions. Temporary DB; controlled native bridge only."""
import base64
import hashlib
import hmac
import os
import sqlite3
import time
import urllib.parse
from playwright.sync_api import sync_playwright

BASE = os.environ['KOPILKA_QA_BASE_URL']
DB = os.environ['DB_PATH']
assert os.environ['NODE_ENV'] == 'test' and 'qa.sqlite' in DB


def launch(actor):
    values = {'vk_app_id': '54723764', 'vk_user_id': str(actor), 'vk_ts': str(int(time.time()))}
    check = urllib.parse.urlencode(sorted(values.items()))
    values['sign'] = base64.urlsafe_b64encode(hmac.new(os.environ['VK_SECURE_KEY'].encode(), check.encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return urllib.parse.urlencode(values)


BRIDGE = '''window.bridgeCalls=[];window.bridgeMode='success';window.vkBridge={
 send(method,params){window.bridgeCalls.push({method,params});
  if(method==='VKWebAppOpenApp'){
   if(window.bridgeMode==='reject')return Promise.reject({error_data:{error_reason:'native failure'}});
   if(window.bridgeMode==='false')return Promise.resolve({result:false});
   if(window.bridgeMode==='pending')return new Promise(resolve=>window.resolveOpen=resolve);
   return Promise.resolve({result:true});
  }
  if(method==='VKWebAppOpenURL')return Promise.reject({error_type:'unsupported event'});
  if(method==='VKWebAppCopyText')return Promise.resolve({result:true});
  return Promise.resolve({});
 },subscribe(){},supports(){return true}
};'''


def ready(page):
    page.wait_for_function('state.user && state.summary && state.product && !state.busy', timeout=20000)


def idle(page):
    page.wait_for_function('!state.busy', timeout=20000)


with sqlite3.connect(DB) as db:
    for slug, title, url in [('qa-app', 'QA App', 'https://vk.ru/app12345#path=start'), ('qa-group', 'QA Group', 'https://vk.ru/club12345')]:
        db.execute('INSERT INTO support_actions (slug,title,description,button_label,url,platform) VALUES (?,?,?,?,?,?)', (slug,title,'QA fixture','Open QA',url,'vk'))

with sync_playwright() as pw:
    browser = pw.chromium.connect_over_cdp(os.environ.get('KOPILKA_QA_CDP_URL', 'http://127.0.0.1:18800'))
    context = browser.new_context(viewport={'width': 390, 'height': 800})
    try:
        # Never send provider/community requests. Only local app/API/SQLite are real.
        context.route('https://**/*', lambda r: r.fulfill(status=200, body='', content_type='application/javascript'))
        context.route('**/vendor/vk-bridge*', lambda r: r.fulfill(status=200, body=BRIDGE, content_type='application/javascript'))
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(BASE + '/?' + launch(81991006))
        ready(page)
        user_id = page.evaluate('state.user.id')
        token = page.evaluate('state.token')
        headers = {'authorization': 'Bearer ' + token}
        page.evaluate('window.documentMarker={};window.markerBefore=window.documentMarker')

        # Template cancellation is reached through the real button and in-app dialog.
        page.locator('#tab-button-contract').click()
        fields = ['contractTitle','contractTarget','stakeAmount','stakeCurrency','rewardDescription','fundDescription']
        draft = ['Мой полный черновик','Два шага без спешки','12,5','RUB','Мой подарок','Мой фонд']
        for field, value in zip(fields, draft):
            page.locator('#' + field).fill(value)
        page.locator('[data-template-id]').first.click()
        page.locator('#templateReplaceDialog').wait_for(state='visible')
        page.locator('[data-template-choice="cancel"]').click()
        page.locator('#templateReplaceDialog').wait_for(state='detached')
        assert [page.locator('#' + field).input_value() for field in fields] == draft
        page.locator('[data-template-id]').first.click()
        page.locator('#templateReplaceDialog').wait_for(state='visible')
        page.locator('[data-template-choice="confirm"]').click()
        page.locator('#templateReplaceDialog').wait_for(state='detached')
        page.wait_for_function('!templateReplaceDecision')
        assert page.locator('#contractTitle').input_value() != draft[0]
        # Browser accepts comma decimals and rejects letters/negative/exponent.
        limits = [120,300,40,20,300,300]
        for field, limit in zip(fields, limits):
            assert page.locator('#' + field).get_attribute('maxlength') == str(limit)
        for amount, valid in [('TEST',False),('-1',False),('1e3',False),('12,5',True),('0',True),('',True)]:
            page.locator('#stakeAmount').fill(amount)
            assert page.locator('#stakeAmount').evaluate('(el)=>el.checkValidity()') is valid
        # Bypass native constraints: real server HTTP413 must retain the full draft.
        page.evaluate("document.querySelector('#contractTitle').value='x'.repeat(70000);document.querySelector('#contractTarget').value='small';document.querySelector('#stakeAmount').value='';document.querySelector('#contractForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))")
        idle(page)
        assert 'Текст слишком длинный' in page.locator('#statusRegion').inner_text()
        assert 'Payload' not in page.locator('#statusRegion').inner_text()
        assert page.locator('#contractTitle').input_value() == 'x' * 70000
        with sqlite3.connect(DB) as db:
            assert db.execute('SELECT COUNT(*) FROM weekly_contracts').fetchone()[0] == 0
        page.locator('#contractTitle').fill(draft[0]); page.locator('#contractTarget').fill(draft[1])
        page.locator('#stakeAmount').fill('12,5')
        page.locator('#contractForm button[type=submit]').click(); idle(page)
        page.wait_for_function('!!state.currentContract')
        assert page.evaluate('state.currentContract.title') == draft[0]
        assert page.evaluate('state.currentContract.target_value') == draft[1]
        assert page.evaluate('state.currentContract.stake_amount') == '12.5'
        page.reload(); ready(page)
        assert page.evaluate('state.currentContract.title') == draft[0]
        assert page.evaluate('state.currentContract.target_value') == draft[1]
        print('PASS template cancel/confirm, field limits, amount grammar, connected contract persistence', flush=True)

        # Every day navigation ends loading; failure keeps selected history and explicit error.
        page.locator('#tab-button-week').click()
        page.locator('#historyPrevious').click(); idle(page)
        assert page.locator('#statusRegion').inner_text() == 'История обновлена.'
        assert page.evaluate('document.activeElement.id') == 'selectedDayHeading'
        page.locator('#historyNext').click(); idle(page)
        assert 'История обновлена.' in page.locator('#statusRegion').inner_text()
        page.locator('#historyToday').click(); idle(page)
        selected = page.locator('#historyDate').input_value()
        page.route('**/api/history?**', lambda r: r.fulfill(status=503, json={'error':'QA unavailable'}))
        page.locator('#historyPrevious').click(); idle(page)
        assert page.locator('#historyDate').input_value() == selected
        assert page.locator('#statusRegion').inner_text() == 'QA unavailable'
        page.unroute('**/api/history?**')
        print('PASS history navigation completion/focus/error preserves selected date', flush=True)

        page.evaluate('window.documentMarker={};window.markerBefore=window.documentMarker')
        page.locator('#tab-button-support').click()
        app_button = page.get_by_role('article', name='QA App', exact=True).locator('button')
        def credits():
            with sqlite3.connect(DB) as db:
                return db.execute("SELECT COUNT(*) FROM user_support_actions ua JOIN support_actions a ON a.id=ua.action_id WHERE ua.user_id=? AND a.slug='qa-app' AND ua.credited_at IS NOT NULL", (user_id,)).fetchone()[0]
        for mode in ['reject','false']:
            page.evaluate('(mode)=>window.bridgeMode=mode', mode)
            app_button.click(); idle(page)
            assert credits() == 0
            assert 'undefined' not in page.locator('#statusRegion').inner_text()
            assert 'Не удалось открыть' in page.locator('#statusRegion').inner_text()
        page.evaluate("window.bridgeMode='pending'")
        app_button.click(); page.wait_for_function("typeof window.resolveOpen==='function'")
        assert credits() == 0
        page.evaluate('window.resolveOpen({result:true})'); idle(page)
        assert credits() == 1
        call = page.evaluate("window.bridgeCalls.filter(c=>c.method==='VKWebAppOpenApp').at(-1)")
        assert call['params'] == {'app_id':12345,'location':'path=start'}
        page.evaluate("window.bridgeMode='success'"); app_button.click(); idle(page)
        assert credits() == 1
        assert not page.evaluate("window.bridgeCalls.some(c=>c.method==='VKWebAppOpenURL')")
        # Community opens a separate context, not a join/permission operation.
        group_button = page.get_by_role('article', name='QA Group', exact=True).locator('button')
        current_url = page.url
        with page.expect_popup() as opened:
            group_button.click()
        popup = opened.value
        popup.wait_for_load_state(); popup.close(); idle(page)
        assert page.url == current_url and len(context.pages) == 1
        assert page.evaluate('window.documentMarker===window.markerBefore') is True
        assert not page.evaluate("window.bridgeCalls.some(c=>/JoinGroup|AllowMessagesFromGroup/.test(c.method))")
        print('PASS VK supported app bridge/failure/no early or duplicate credit; community separate window', flush=True)

        page.locator('#tab-button-settings').click()
        page.locator('[data-lang=en]:visible').first.click(); idle(page)
        page.locator('#tab-button-week').click(); page.locator('#historyPrevious').click(); idle(page)
        assert page.locator('#statusRegion').inner_text() == 'History updated.'
        page.locator('#tab-button-support').click()
        page.evaluate("window.bridgeMode='reject'"); app_button.click(); idle(page)
        assert 'Could not open the link.' in page.locator('#statusRegion').inner_text()
        assert not errors, errors
        print('PASS RU/EN statuses, JS errors=0', flush=True)
    finally:
        context.close()
        browser.close()
