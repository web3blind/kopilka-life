#!/usr/bin/env python3
"""7648429: exact shipped shell + selected app, real signed local HTTP/SQLite.
The shipped language controls are RU/EN buttons, NOT a SELECT. Do not invent one.
Run through canonical run-browser-qa.py with three-reports-preload.cjs only.
"""
import ast, asyncio, base64, hashlib, hmac, json, os, sqlite3, threading, time, urllib.parse, urllib.request
from contextlib import contextmanager
from pathlib import Path
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
source=ast.parse((ROOT/'tests/report7644800-ios-safe-placement-qa.py').read_text());namespace=dict(globals())
exec(compile(ast.Module(body=[n for n in source.body if isinstance(n,ast.FunctionDef) and n.name=='filtered_cdp'],type_ignores=[]),'filtered-cdp','exec'),namespace)
filtered_cdp=namespace['filtered_cdp'];BASE=os.environ['KOPILKA_QA_BASE_URL']
assert os.environ['NODE_ENV']=='test' and os.environ['SCHEDULER_ENABLED']=='false' and 'qa.sqlite' in os.environ['DB_PATH']
OUT=Path(os.environ['REPORT7648429_OUT']);OUT.mkdir(parents=True,exist_ok=True)
APP=Path(os.environ.get('REPORT7648429_APP',ROOT/'public/app.js'));SHELL=Path(os.environ.get('REPORT7648429_SHELL',ROOT/'public/index.html'))
results=[]
def launch(uid,platform):
    p=dict(vk_app_id='54723764',vk_user_id=str(uid),vk_platform=platform,vk_ts=str(int(time.time())))
    p['sign']=base64.urlsafe_b64encode(hmac.new(b'browser-qa-vk-secure-key',urllib.parse.urlencode(sorted(p.items())).encode(),hashlib.sha256).digest()).decode().rstrip('=')
    return urllib.parse.urlencode(p)
with filtered_cdp(os.environ.get('KOPILKA_QA_CDP_URL','http://127.0.0.1:18800')) as endpoint,sync_playwright() as pw:
    browser=pw.chromium.connect_over_cdp(endpoint)
    for i,(host,scale) in enumerate((h,s) for h in ('desktop','android') for s in (1,2)):
        name=f'{host}-{scale*100}';checks=[];traffic=[];errors=[];proof={}
        viewport={'width':1280,'height':900} if host=='desktop' else {'width':393,'height':852}
        ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36' if host=='desktop' else 'Mozilla/5.0 (Linux; Android 15; Realme QA) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36'
        context=browser.new_context(viewport=viewport,service_workers='block',user_agent=ua,is_mobile=host=='android',has_touch=host=='android')
        try:
            def route(r):
                if not r.request.url.startswith(BASE+'/'):r.abort()
                elif '/app.js' in r.request.url:r.fulfill(content_type='application/javascript',body=APP.read_text())
                elif urllib.parse.urlparse(r.request.url).path=='/':r.fulfill(content_type='text/html',body=SHELL.read_text())
                else:r.continue_()
            context.route('**/*',route)
            query=launch(81997648429+i,'desktop_web' if host=='desktop' else 'mobile_android')
            auth=context.request.post(BASE+'/api/auth/vk',data={'launchParams':query}).json();assert auth.get('token'),auth
            headers={'Authorization':'Bearer '+auth['token']}
            assert context.request.post(BASE+'/api/settings/locale',headers=headers,data={'locale':'ru'}).ok
            p=context.new_page();p.on('pageerror',lambda e:errors.append(str(e)))
            p.on('request',lambda r:traffic.append((r.method,urllib.parse.urlparse(r.url).path,r.post_data)))
            p.goto(BASE+'/?'+query);p.wait_for_function('state.user && state.summary && !state.busy')
            uid=p.evaluate('state.user.id');p.evaluate("scale=>{document.documentElement.style.fontSize=scale*100+'%';setStatus('');readyNoticeDismissed=false}",scale)
            p.locator('#tab-button-settings').click();p.wait_for_load_state('networkidle')
            assert p.locator('[data-lang]').count()==2 and p.locator('select[data-lang]').count()==0
            checks.append('actual-shipped-RU-EN-buttons-not-SELECT')
            def persisted(lang,reminder=None):
                assert p.evaluate('locale()')==lang
                assert p.evaluate('storage.get("kopilkaLocale")')==lang
                assert p.locator('#lang-'+lang).get_attribute('aria-pressed')=='true'
                response=context.request.get(BASE+'/api/me',headers=headers);assert response.ok,response.text()
                user=response.json()['user'];assert user['locale']==lang,user
                with sqlite3.connect('file:'+os.environ['DB_PATH']+'?mode=ro',uri=True) as db:
                    row=db.execute('SELECT locale,evening_reminder_time FROM users WHERE id=?',(uid,)).fetchone()
                assert row[0]==lang,row
                if reminder is not None:assert user['eveningReminderTime']==reminder and row[1]==reminder,(user,row)
                proof['last_persisted']={'locale':row[0],'eveningReminderTime':row[1]}
            def switch(lang):
                traffic.clear()
                with p.expect_response(lambda r:r.url.endswith('/api/settings/locale') and r.request.method=='POST') as response:p.locator('#lang-'+lang).click()
                assert response.value.ok,response.value.text()
                assert response.value.request.post_data_json=={'locale':lang}
                p.wait_for_function('!state.busy');p.wait_for_load_state('networkidle')
                assert len([t for t in traffic if t[:2]==('POST','/api/settings/locale')])==1
                assert any(t[1]=='/api/me' for t in traffic)
                persisted(lang)
                assert p.locator('#statusRegion').text_content()==p.evaluate('L("settingsSaved")')
            def reminders(value):
                p.locator('#eveningReminderTime').fill(value)
                expected=p.evaluate('({timezone:document.getElementById("timezone").value,remindersEnabled:document.getElementById("remindersEnabled").checked,eveningReminderTime:document.getElementById("eveningReminderTime").value})')
                assert p.evaluate('state.settingsDirty')
                with p.expect_response(lambda r:r.url.endswith('/api/settings/reminders') and r.request.method=='POST') as response:p.locator('#settingsForm button[type=submit]').click()
                assert response.value.ok,response.value.text()
                assert response.value.request.post_data_json==expected
                p.wait_for_function('!state.busy');p.wait_for_load_state('networkidle')
                assert not p.evaluate('state.settingsDirty')
                persisted(p.evaluate('locale()'),value)
                assert p.locator('#statusRegion').text_content()==p.evaluate('L("settingsSaved")')
            def notice(label):
                button=p.get_by_role('button',name=p.evaluate('L("dismissNotification")'),exact=True)
                assert button.is_visible(),label
                # Role/name locator already checks the computed accessible name.
                # Keep expensive full-AX snapshots/screenshots out of the live 5s
                # window: cold Chromium capture can expire an otherwise valid notice.
                box=button.bounding_box();assert box and box['y']>=8 and box['y']+box['height']<=viewport['height'],box
                assert button.evaluate('(e)=>{let r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e}')
                proof.setdefault('notices',{})[label]={'accessible_name':p.evaluate('L("dismissNotification")'),'box':box}
                return button
            # Initial Settings form reminder save is real, before any language switch.
            reminders('21:17');initial=p.locator('#statusRegion').text_content()
            original=not p.locator('#dismissStatus').is_visible()
            if original:
                p.wait_for_timeout(5300);assert p.locator('#statusRegion').text_content()==initial
                p.screenshot(path=str(OUT/f'{name}-original-ru-reminder-persistent.png'))
                checks.append('original-real-reminder-save-persists-over-5.3s')
                switch('en');text=p.locator('#statusRegion').text_content();p.wait_for_timeout(5300)
                assert p.locator('#statusRegion').text_content()==text and p.locator('#dismissStatus').is_hidden()
                p.screenshot(path=str(OUT/f'{name}-original-en-locale-persistent.png'))
                switch('ru');text=p.locator('#statusRegion').text_content();p.wait_for_timeout(5300)
                assert p.locator('#statusRegion').text_content()==text and p.locator('#dismissStatus').is_hidden()
                p.screenshot(path=str(OUT/f'{name}-original-ru-locale-persistent.png'))
                checks.extend(['original-real-RU-EN-RU-POST-GET-SQLite-persistence','original-both-localized-notices-persist-over-5.3s'])
                raise AssertionError('7648429 reproduced on exact original: real reminder save and RU->EN->RU locale POSTs persist in SQLite/GET; success notices have no dismiss button and survive 5.3 seconds')
            button=notice('ru-reminder');button.focus();p.keyboard.press('Enter')
            assert p.locator('#statusRegion').text_content()=='' and p.evaluate('document.activeElement.id')!='dismissStatus'
            assert p.evaluate('readyNoticeDismissed') is False
            checks.append('initial-real-reminder-payload-dirty-GET-SQLite-keyboard-Enter')
            traffic.clear();p.locator('#lang-ru').click();p.wait_for_load_state('networkidle')
            assert not [t for t in traffic if t[1]=='/api/settings/locale'] and p.locator('#statusRegion').text_content()==''
            checks.append('same-locale-no-POST-no-success-no-timer')
            switch('en');button=notice('en-locale');button.focus();p.wait_for_timeout(5300)
            assert p.locator('#statusRegion').text_content()==''
            assert p.evaluate('document.activeElement.id') in ('lang-en','tab-button-settings')
            checks.append('real-EN-switch-5s-expiry-safe-focused-close')
            reminders('21:18');button=notice('en-reminder');p.locator('#eveningReminderTime').focus();p.wait_for_timeout(5300)
            assert p.locator('#statusRegion').text_content()=='' and p.evaluate('document.activeElement.id')=='eveningReminderTime'
            checks.append('real-EN-reminder-expiry-does-not-steal-input-focus')
            switch('ru');button=notice('ru-locale');button.focus();p.keyboard.press('Space')
            assert p.locator('#statusRegion').text_content()=='' and p.evaluate('readyNoticeDismissed') is False
            checks.append('real-RU-return-Space-dismiss')
            # Real settings save owns the timer; a newer durable error wins both closures.
            switch('en');p.evaluate('window.oldClose=document.getElementById("dismissStatus").onclick;setStatus("new durable error","error");oldClose()')
            p.wait_for_timeout(5300);assert p.locator('#statusRegion').text_content()=='new durable error' and p.locator('#dismissStatus').is_hidden()
            checks.append('actual-save-stale-timer-and-handler-cannot-clear-new-error')
            def fail(r):r.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'fixture save rejected'}))
            p.route('**/api/settings/locale',fail);p.locator('#lang-ru').click()
            p.wait_for_function('!state.busy && document.getElementById("statusRegion").classList.contains("error")')
            assert p.locator('#statusRegion').text_content()=='fixture save rejected';persisted('en')
            p.unroute('**/api/settings/locale',fail)
            p.route('**/api/settings/reminders',fail);p.locator('#eveningReminderTime').fill('21:19');p.locator('#settingsForm button[type=submit]').click()
            p.wait_for_function('!state.busy && document.getElementById("statusRegion").classList.contains("error")')
            assert p.evaluate('state.settingsDirty') and p.locator('#statusRegion').text_content()=='fixture save rejected';persisted('en','21:18')
            p.unroute('**/api/settings/reminders',fail)
            checks.append('failed-locale-and-reminder-API-no-success-no-storage-drift-dirty-retained')
            # Mutation commits, but its real post-commit GET fails: retain the warning.
            p.route('**/api/me',lambda r:r.fulfill(status=503,content_type='application/json',body='{"error":"fixture refresh failed"}'))
            p.locator('#lang-ru').click();p.wait_for_function('!state.busy && state.refreshFailed')
            persisted('ru','21:18');warning=p.locator('#statusRegion').text_content()
            assert p.evaluate('L("settingsSaved")') in warning and p.evaluate('L("refreshPending")') in warning
            assert p.locator('#dismissStatus').is_hidden();p.wait_for_timeout(5300)
            assert p.locator('#statusRegion').text_content()==warning
            p.unroute('**/api/me');checks.append('committed-locale-failed-refresh-warning-durable-and-nondismissible')
            p.evaluate('state.refreshFailed=false;setStatus(L("shareUnconfirmed"),"info","share-unconfirmed")')
            text=p.locator('#statusRegion').text_content();p.locator('#tab-button-settings').click();p.keyboard.press('Escape');p.wait_for_timeout(5300)
            assert p.locator('#statusRegion').text_content()==text
            p.locator('#dismissStatus').focus();p.keyboard.press('Enter');assert p.evaluate('readyNoticeDismissed') is False
            p.evaluate('setStatus(L("ready"),"info","ready")');p.locator('#dismissStatus').focus();p.keyboard.press('Enter')
            p.evaluate('setStatus(L("ready"),"info","ready")');assert p.locator('#statusRegion').text_content()==''
            checks.append('long-share-no-timer-no-outside-Escape-dismiss-Ready-suppression-independent')
            p.reload();p.wait_for_function('state.user && state.summary && !state.busy');persisted('ru','21:18')
            assert not errors,errors
            with sqlite3.connect('file:'+os.environ['DB_PATH']+'?mode=ro',uri=True) as db:
                assert db.execute('SELECT COUNT(*) FROM entries WHERE user_id=?',(uid,)).fetchone()==(0,)
            checks.append('reload-persisted-no-entry-writes-no-page-errors')
            results.append(dict(name=name,passed=True,checks=checks,proof=proof,app_sha256=hashlib.sha256(APP.read_bytes()).hexdigest(),shell_sha256=hashlib.sha256(SHELL.read_bytes()).hexdigest()))
        except Exception:
            import traceback
            results.append(dict(name=name,passed=False,error=traceback.format_exc(),checks=checks,proof=proof,app_sha256=hashlib.sha256(APP.read_bytes()).hexdigest()))
        finally:
            context.close();(OUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2));print(json.dumps(results[-1],ensure_ascii=False),flush=True)
assert len(results)==4 and all(r['passed'] for r in results),results
