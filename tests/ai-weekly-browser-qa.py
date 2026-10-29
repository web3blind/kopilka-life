#!/usr/bin/env python3
"""Connected private AI digest flow: real HTTP/SQLite, controlled provider, own Chromium."""
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
assert os.environ['NODE_ENV'] == 'test' and os.environ['DB_PATH'].endswith('qa.sqlite')
CALLS = Path(os.environ['KOPILKA_AI_QA_CALLS'])
def call_count():
    return len(json.loads(CALLS.read_text())) if CALLS.exists() else 0

def signed(uid):
    p = dict(vk_app_id='54723764', vk_user_id=str(uid), vk_platform='mobile_android', vk_ts=str(int(time.time())))
    p['sign'] = base64.urlsafe_b64encode(hmac.new(b'browser-qa-vk-secure-key', urllib.parse.urlencode(sorted(p.items())).encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return urllib.parse.urlencode(p)

def seed(uid, date, note='synthetic-walk'):
    with sqlite3.connect(os.environ['DB_PATH']) as db:
        db.execute("INSERT INTO entries (user_id,type,title,note,life_points,entry_date) VALUES (?,'movement','synthetic walk',?,2,?)", (uid,note,date))

results = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    try:
        for i, (lang, width, text_scale) in enumerate((('ru',320,100),('ru',320,200),('en',320,100),('en',320,200),('ru',390,100),('ru',390,200),('en',390,100),('en',390,200))):
            context = browser.new_context(viewport={'width':width,'height':850}, is_mobile=True, has_touch=True, service_workers='block')
            try:
                context.route('**/*', lambda r: r.continue_() if r.request.url.startswith(BASE+'/') else r.abort())
                query = signed(8299102800+i)
                auth = context.request.post(BASE+'/api/auth/vk', data={'launchParams':query}).json()
                assert auth.get('token'), auth
                headers={'Authorization':'Bearer '+auth['token']}
                assert context.request.post(BASE+'/api/settings/locale',headers=headers,data={'locale':lang}).ok
                info=context.request.get(BASE+'/api/ai-weekly-summary',headers=headers).json()
                seed(auth['user']['id'],info['period']['start'])
                before=call_count()
                p=context.new_page();errors=[]
                p.on('pageerror',lambda e: errors.append(str(e)))
                p.goto(BASE+'/?'+query)
                p.wait_for_function('state.user && state.history && state.product && !state.busy')
                p.locator('#tab-button-assistant').click()
                p.wait_for_function('document.getElementById("aiWeeklyPeriod").textContent.length>8')
                assert p.locator('#aiWeeklyHeading').inner_text()==('Личный взгляд на записи' if lang=='ru' else 'A personal look at your entries')
                assert p.locator('#aiWeeklyConsent').is_checked() is False
                assert p.locator('#aiWeeklyCreate').is_disabled()
                assert call_count()==before
                assert p.locator('.tab-bar [role="tab"]').count()==7
                assert p.locator('#tab-week #aiWeekly').count()==0
                assert p.locator('#aiWeeklyTopic option').count()==7
                p.locator('#aiWeeklyConsent').check()
                p.locator('#aiWeeklyDays').select_option('other')
                p.locator('#aiWeeklyCustomDays').fill('1')
                p.wait_for_function('!document.getElementById("aiWeeklyConsentBox").hidden')
                assert not p.locator('#aiWeeklyConsent').is_checked()
                p.locator('#aiWeeklyCustomDays').fill('0')
                assert p.locator('#aiWeeklyConsentBox').is_hidden()
                p.locator('#aiWeeklyCustomDays').fill('31')
                assert p.locator('#aiWeeklyConsentBox').is_hidden()
                p.locator('#aiWeeklyCustomDays').fill('1.5')
                assert p.locator('#aiWeeklyConsentBox').is_hidden()
                p.locator('#aiWeeklyDays').select_option('30')
                p.wait_for_function('!document.getElementById("aiWeeklyConsentBox").hidden')
                p.locator('#aiWeeklyConsent').check()
                p.locator('#aiWeeklyTopic').select_option('rest')
                p.wait_for_function('!document.getElementById("aiWeeklyConsentBox").hidden')
                assert not p.locator('#aiWeeklyConsent').is_checked()
                assert call_count()==before
                p.locator('#aiWeeklyDays').select_option('7')
                p.wait_for_function('!document.getElementById("aiWeeklyConsentBox").hidden')
                p.locator('#aiWeeklyTopic').select_option('summary')
                p.wait_for_function('!document.getElementById("aiWeeklyConsentBox").hidden')
                p.locator('#tab-button-week').click()
                assert p.locator('#aiWeekly').is_hidden()
                p.go_back()
                p.wait_for_function('state.activeTab==="assistant"')
                # Hold an actual HTTP metadata response while a newer selection completes.
                held=[]
                def hold_read(route):
                    held.append((route,route.fetch()))
                p.route('**/api/ai-weekly-summary?days=7&topic=calm',hold_read)
                p.locator('#aiWeeklyTopic').select_option('calm')
                deadline=time.monotonic()+5
                while not held and time.monotonic()<deadline:p.wait_for_timeout(20)
                assert held
                p.locator('#aiWeeklyTopic').select_option('rest')
                p.wait_for_function('!document.getElementById("aiWeeklyConsentBox").hidden')
                held[0][0].fulfill(response=held[0][1])
                p.wait_for_timeout(100)
                assert p.locator('#aiWeeklyTopic').input_value()=='rest'
                assert p.locator('#aiWeeklyTopic option:checked').inner_text() in p.locator('#aiWeeklyPurpose').inner_text()
                p.unroute('**/api/ai-weekly-summary?days=7&topic=calm')
                p.locator('#aiWeeklyTopic').select_option('summary')
                p.wait_for_function('!document.getElementById("aiWeeklyConsentBox").hidden')
                # Example and disclosure do not contact any model.
                p.locator('#aiWeeklyExample summary').click()
                p.locator('#aiWeeklyDisclosure summary').click()
                assert 'OpenRouter' in p.locator('#aiWeeklyDisclosure').inner_text()
                assert call_count()==before
                p.evaluate('(scale)=>document.documentElement.style.fontSize=scale+"%"',text_scale)
                assert p.evaluate('document.documentElement.scrollWidth<=innerWidth'),(lang,width,text_scale)
                assert p.locator('#aiWeeklyStatus').get_attribute('role')=='status'
                p.locator('#tab-button-assistant').focus();p.keyboard.press('Home')
                assert p.evaluate('state.activeTab')=='today'
                p.keyboard.press('End')
                assert p.evaluate('state.activeTab')=='assistant'
                p.wait_for_function('!document.getElementById("aiWeeklyConsentBox").hidden')
                assert p.evaluate('''() => [...document.querySelectorAll('.tab-bar button')].every(b => {
                    const r=b.getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight;
                })''')
                p.set_viewport_size({'width':width,'height':480})
                p.locator('#aiWeeklyTopic').focus()
                p.wait_for_timeout(350)
                geometry=p.evaluate('''() => ({field:document.getElementById('aiWeeklyTopic').getBoundingClientRect().toJSON(),nav:document.querySelector('.tab-bar').getBoundingClientRect().toJSON(),active:document.activeElement.id,scrollY,innerHeight})''')
                assert geometry['field']['top']>=0 and geometry['field']['bottom']<=geometry['nav']['top']-4,(lang,width,text_scale,geometry)
                p.set_viewport_size({'width':width,'height':850})
                p.wait_for_function('''() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--measured-nav-height'))-document.querySelector('.tab-bar').getBoundingClientRect().height)<1''')
                p.wait_for_timeout(100)
                p.locator('#aiWeeklyConsent').focus()
                p.wait_for_timeout(350)
                geometry=p.evaluate('''() => ({field:document.getElementById('aiWeeklyConsent').getBoundingClientRect().toJSON(),nav:document.querySelector('.tab-bar').getBoundingClientRect().toJSON(),active:document.activeElement.id,scrollY,innerHeight})''')
                assert geometry['field']['top']>=0 and geometry['field']['bottom']<=geometry['nav']['top']-4,(lang,width,text_scale,geometry)
                p.keyboard.press('Space')
                assert p.locator('#aiWeeklyConsent').is_checked()
                assert p.locator('#tab-button-assistant').inner_text()==('ИИ-помощник' if lang=='ru' else 'AI assistant')
                assert p.evaluate("parseFloat(getComputedStyle(document.getElementById('appShell')).paddingBottom)>=document.querySelector('.tab-bar').getBoundingClientRect().height")
                for control in p.locator('#aiWeekly input, #aiWeekly select, #aiWeekly button, #aiWeekly summary, #aiWeekly a').all():
                    if control.is_visible() and control.is_enabled():
                        control.focus()
                        try:
                            p.wait_for_function('''e => {const r=e.getBoundingClientRect();return r.top>=0 && r.bottom<=document.querySelector('.tab-bar').getBoundingClientRect().top-4;}''',arg=control.element_handle(),timeout=3000)
                        except Exception:
                            raise AssertionError((lang,width,text_scale,control.evaluate("e=>({id:e.id,tag:e.tagName,text:e.textContent,rect:e.getBoundingClientRect().toJSON(),nav:document.querySelector('.tab-bar').getBoundingClientRect().toJSON(),active:document.activeElement.id})")))
                        bounds=control.evaluate('''e => {const r=e.getBoundingClientRect();return {id:e.id || e.tagName,left:r.left,right:r.right,top:r.top,bottom:r.bottom,navTop:document.querySelector('.tab-bar').getBoundingClientRect().top,width:innerWidth};}''')
                        assert bounds['left']>=0 and bounds['right']<=bounds['width'] and bounds['top']>=0 and bounds['bottom']<=bounds['navTop']-4,(lang,width,text_scale,bounds)
                p.locator('#aiWeeklyCreate').focus();p.keyboard.press('Enter')
                p.wait_for_function('document.querySelector("#aiWeeklyResult .ai-weekly-text")')
                assert call_count()==before+1
                assert not p.evaluate('Boolean(window.aiInjected)')
                assert p.locator('#aiWeeklyResult img').count()==0
                assert p.locator('#aiWeeklyConsentBox').is_hidden()
                assert p.locator('#aiWeeklyCreate').is_hidden()
                quota=context.request.get(BASE+'/api/ai-weekly-summary?days=30&topic=rest',headers=headers).json()['quota']
                assert quota['allowed'] is False and quota['nextAvailableAt']
                assert p.locator('#aiWeeklyQuota').inner_text()
                p.locator('#aiWeeklyDays').select_option('30')
                p.wait_for_function('document.getElementById("aiWeeklyQuota").textContent.length>5')
                assert p.locator('#aiWeeklyCreate').is_hidden()
                text=p.locator('#aiWeeklyResult .ai-weekly-text').inner_text()
                assert text
                other='en' if lang=='ru' else 'ru'
                assert context.request.post(BASE+'/api/settings/locale',headers=headers,data={'locale':other}).ok
                p.evaluate('loadData()')
                assert p.locator('#aiWeeklyResult .ai-weekly-text').inner_text()==text
                assert ('English' if lang=='en' else 'Русский') in p.locator('#aiWeeklyResult').inner_text()
                assert context.request.post(BASE+'/api/settings/locale',headers=headers,data={'locale':lang}).ok
                p.evaluate('loadData()')
                # Returning/refreshing are pure reads and show the saved text.
                p.locator('#tab-button-today').click();p.locator('#tab-button-assistant').click()
                p.wait_for_function('document.querySelector("#aiWeeklyResult .ai-weekly-text")')
                assert p.locator('#aiWeeklyResult .ai-weekly-text').inner_text()==text
                p.reload();p.wait_for_function('state.user && state.history && state.product && !state.busy')
                p.locator('#tab-button-assistant').click();p.wait_for_function('document.querySelector("#aiWeeklyResult .ai-weekly-text")')
                assert call_count()==before+1
                # Ordinary product/foreground redraw must retain the same logical control.
                delete=p.locator('#aiWeeklyResult button');delete.focus()
                saved_id=delete.get_attribute('id')
                p.evaluate('renderAll()')
                assert p.evaluate('document.activeElement.id')==saved_id
                # Accessible confirmation, cancellation and actual deletion.
                p.locator('#aiWeeklyResult button').click()
                assert p.locator('#aiWeeklyDeleteConfirm').is_visible()
                assert p.evaluate('document.activeElement.id')=='aiWeeklyDeleteCancel'
                p.evaluate('renderAll()');p.keyboard.press('Escape');assert p.locator('#aiWeeklyDeleteConfirm').is_hidden()
                assert p.evaluate('document.activeElement.id')==saved_id
                p.locator('#aiWeeklyResult button').click();p.locator('#aiWeeklyDeleteYes').click()
                p.wait_for_function('!document.querySelector("#aiWeeklyResult .ai-weekly-text") && /удал|deleted/i.test(document.getElementById("aiWeeklyStatus").textContent)')
                assert call_count()==before+1
                assert p.locator('#aiWeeklyCreate').is_hidden()
                assert context.request.get(BASE+'/api/ai-weekly-summary?days=1&topic=goal',headers=headers).json()['quota']['allowed'] is False
                # Rest template uses the existing editable form; no auto contract.
                p.locator('#tab-button-contract').click()
                p.locator('[data-template-id="rest-evenings"]').click()
                assert '20:00' in p.locator('#contractTarget').input_value()
                p.locator('#contractTarget').fill('One evening after 21:30')
                assert p.locator('#contractTarget').input_value()=='One evening after 21:30'
                assert not errors,errors
                print(f'PASS UI {lang} {width}px {text_scale}%',flush=True)
                results.append({'locale':lang,'width':width,'textPercent':text_scale,'calls':1,'savedReopen':True,'delete':True,'pageErrors':errors})
            finally: context.close()
        # Each recommendation topic is an independent owner, not a weakened shared quota.
        for index,topic in enumerate(('calm','hard-days','rest','kindness','self-support','goal')):
            context=browser.new_context(service_workers='block')
            try:
                context.route('**/*',lambda r:r.continue_() if r.request.url.startswith(BASE+'/') else r.abort())
                query=signed(8299103300+index)
                auth=context.request.post(BASE+'/api/auth/vk',data={'launchParams':query}).json()
                headers={'Authorization':'Bearer '+auth['token']}
                info=context.request.get(BASE+'/api/ai-weekly-summary?days=7&topic='+topic,headers=headers).json()
                seed(auth['user']['id'],info['period']['end'])
                before=call_count();p=context.new_page();p.goto(BASE+'/?'+query)
                p.wait_for_function('state.user && state.history && !state.busy')
                p.locator('#tab-button-assistant').click()
                p.wait_for_function('!document.getElementById("aiWeeklyConsentBox").hidden')
                p.locator('#aiWeeklyTopic').select_option(topic)
                p.wait_for_function('!document.getElementById("aiWeeklyConsentBox").hidden')
                p.locator('#aiWeeklyConsent').check();p.locator('#aiWeeklyCreate').click()
                p.wait_for_function('document.querySelector("#aiWeeklyResult .ai-weekly-text")')
                text=p.locator('#aiWeeklyResult .ai-weekly-text').inner_text()
                assert 'Необязательные идеи:' in text and call_count()==before+1
                assert topic==json.loads(json.loads(CALLS.read_text())[-1]['messages'][1]['content'])['selection']['topic']
                meta=context.request.get(BASE+'/api/ai-weekly-summary?days=1&topic=summary',headers=headers).json()
                blocked=context.request.post(BASE+'/api/ai-weekly-summary',headers={**headers,'Origin':BASE},data={'consent':True,'consentVersion':meta['consentVersion'],'periodKey':meta['period']['key'],'days':1,'topic':'summary'})
                assert blocked.status==429 and blocked.json()['code']=='AI_QUOTA_EXCEEDED'
                p.reload();p.wait_for_function('state.user && state.history && !state.busy')
                p.locator('#tab-button-assistant').click()
                p.wait_for_function('document.getElementById("aiWeeklyQuota").textContent.length>5')
                assert p.locator('#aiWeeklyCreate').is_hidden() and call_count()==before+1
                results.append({'topic':topic,'commonQuota':True,'reloadNoGeneration':True})
            finally:context.close()
        # A saved old result is not a permanent terminal flag; a later slot may create a new topic.
        context=browser.new_context(service_workers='block')
        try:
            context.route('**/*',lambda r:r.continue_() if r.request.url.startswith(BASE+'/') else r.abort())
            query=signed(8299103400)
            auth=context.request.post(BASE+'/api/auth/vk',data={'launchParams':query}).json()
            headers={'Authorization':'Bearer '+auth['token']}
            info=context.request.get(BASE+'/api/ai-weekly-summary',headers=headers).json()
            seed(auth['user']['id'],info['period']['end'])
            p=context.new_page();p.goto(BASE+'/?'+query)
            p.wait_for_function('state.user && state.history && !state.busy');p.locator('#tab-button-assistant').click()
            p.wait_for_function('!document.getElementById("aiWeeklyConsentBox").hidden')
            before=call_count();p.locator('#aiWeeklyConsent').check();p.locator('#aiWeeklyCreate').click()
            p.wait_for_function('document.querySelector("#aiWeeklyResult .ai-weekly-text")')
            old=p.locator('#aiWeeklyResult .ai-weekly-text').inner_text()
            # Only the disposable fixture's durable claim timestamp is advanced beyond 168h.
            with sqlite3.connect(os.environ['DB_PATH']) as db:
                db.execute('UPDATE ai_weekly_summaries SET started_at=started_at-? WHERE user_id=?',(8*24*60*60*1000,auth['user']['id']))
            assert context.request.post(BASE+'/api/settings/locale',headers=headers,data={'locale':'en'}).ok
            p.evaluate('loadData()')
            p.wait_for_function('!document.getElementById("aiWeeklyConsentBox").hidden')
            p.locator('#aiWeeklyTopic').select_option('goal')
            p.wait_for_function('!document.getElementById("aiWeeklyConsentBox").hidden')
            p.locator('#aiWeeklyConsent').check();p.locator('#aiWeeklyCreate').click()
            p.wait_for_function('!document.getElementById("aiWeeklyArchive").hidden')
            p.locator('#aiWeeklyArchive summary').click()
            assert p.locator('#aiWeeklyArchiveItems .ai-weekly-text').inner_text()==old
            assert 'Русский' in p.locator('#aiWeeklyArchiveItems').inner_text()
            assert 'English' in p.locator('#aiWeeklyResult').inner_text()
            assert call_count()==before+2
            results.append({'oldResultAllowsLaterSlot':True,'archiveOriginalLanguage':True})
        finally:context.close()
        # Empty week never contacts the provider. Rejected and uncertain states never blind-resend.
        for index, note in enumerate((None,'fixture_reject','fixture_uncertain')):
            context=browser.new_context(service_workers='block')
            try:
                context.route('**/*',lambda r:r.continue_() if r.request.url.startswith(BASE+'/') else r.abort())
                query=signed(8299102900+index)
                auth=context.request.post(BASE+'/api/auth/vk',data={'launchParams':query}).json();headers={'Authorization':'Bearer '+auth['token']}
                info=context.request.get(BASE+'/api/ai-weekly-summary',headers=headers).json()
                if note:seed(auth['user']['id'],info['period']['start'],note)
                before=call_count();p=context.new_page();p.goto(BASE+'/?'+query)
                p.wait_for_function('state.user && state.history && !state.busy');p.locator('#tab-button-assistant').click()
                p.wait_for_function('document.getElementById("aiWeeklyPeriod").textContent.length>8')
                if p.locator('#aiWeeklyConsent').is_visible():
                    p.locator('#aiWeeklyConsent').check();p.locator('#aiWeeklyCreate').click()
                p.wait_for_function('s=>new RegExp(s,"i").test(document.getElementById("aiWeeklyStatus").textContent)',arg='нет отметок|nothing to send' if note is None else ('не создана|could not be created' if note=='fixture_reject' else 'не подтверждён|could not be confirmed'))
                if note is None:
                    assert p.locator('#aiWeeklyResult .ai-weekly-text').count()==0
                    assert p.locator('#aiWeeklyCreate').is_visible()
                    assert context.request.get(BASE+'/api/ai-weekly-summary?days=7&topic=summary',headers=headers).json()['quota']['allowed']
                expected=0 if note is None else 1
                assert call_count()==before+expected
                if p.locator('#aiWeeklyRefresh').is_visible():
                    p.locator('#aiWeeklyRefresh').click();p.wait_for_load_state('networkidle')
                    assert call_count()==before+expected
                results.append({'scenario':note or 'empty','calls':expected,'noBlindRetry':True})
            finally:context.close()
        # Genuine server-side session revision expiry: safe reads recover, writes never replay.
        for scenario in ('expired-get','expired-post'):
            context=browser.new_context(service_workers='block')
            try:
                context.route('**/*',lambda r:r.continue_() if r.request.url.startswith(BASE+'/') else r.abort())
                query=signed(8299103100+(scenario=='expired-post'))
                auth=context.request.post(BASE+'/api/auth/vk',data={'launchParams':query}).json()
                headers={'Authorization':'Bearer '+auth['token']}
                info=context.request.get(BASE+'/api/ai-weekly-summary',headers=headers).json()
                seed(auth['user']['id'],info['period']['start'])
                p=context.new_page();p.goto(BASE+'/?'+query)
                p.wait_for_function('state.user && state.history && state.product && !state.busy')
                traffic=[]
                p.on('request',lambda req:traffic.append((req.method,urllib.parse.urlparse(req.url).path)))
                before=call_count()
                def expire():
                    with sqlite3.connect(os.environ['DB_PATH']) as db:
                        db.execute('UPDATE users SET session_revision=session_revision+1 WHERE id=?',(auth['user']['id'],))
                if scenario=='expired-get':expire()
                p.locator('#tab-button-assistant').click();p.wait_for_function('document.getElementById("aiWeeklyPeriod").textContent.length>8')
                if scenario=='expired-post':
                    p.locator('#aiWeeklyConsent').check();expire();p.locator('#aiWeeklyCreate').click()
                    p.wait_for_function('!document.getElementById("aiWeeklyRecover").hidden')
                    assert 'не будет повторён автоматически' in p.locator('#aiWeeklyStatus').inner_text()
                    assert p.locator('#aiWeeklyCreate').is_hidden()
                    assert traffic.count(('POST','/api/ai-weekly-summary'))==1
                    assert call_count()==before
                    p.locator('#aiWeeklyRecover').click()
                    p.wait_for_function('document.getElementById("aiWeeklyRecover").hidden && !document.getElementById("aiWeeklyConsentBox").hidden')
                    assert traffic.count(('POST','/api/ai-weekly-summary'))==1
                assert ('POST','/api/auth/vk') in traffic
                assert not p.locator('#aiWeeklyConsent').is_checked()
                assert p.locator('#aiWeeklyCreate').is_disabled()
                assert call_count()==before
                assert p.evaluate('state.user.id')==auth['user']['id']
                results.append({'scenario':scenario,'calls':0,'safeRecovery':True,'noPostReplay':True})
            finally:context.close()
        for call in json.loads(CALLS.read_text()):
            assert call['model'].endswith(':free') == (os.environ['AI_WEEKLY_PAID_ENABLED'] != 'true')
            assert call['provider']['max_price']['prompt'] <= 0.10
            assert call['provider']['max_price']['completion'] <= 0.40
            assert call['provider']['allow_fallbacks'] is False
            assert call['provider']['data_collection']=='deny'
            assert call['provider']['zdr'] is True
        print(json.dumps({'pass':True,'provider':'controlled fixture, not a live OpenRouter proof','checks':results},ensure_ascii=False))
    finally:browser.close()
