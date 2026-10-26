#!/usr/bin/env python3
"""Exact published shell + selected JS; isolated canonical HTTP/SQLite runner.
No production/provider writes. Android is Chromium emulation, not native VK.
"""
import base64, hashlib, hmac, itertools, json, os, sqlite3, time, urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
AUDIT=Path(os.environ.get('REPORT7649404_AUDIT',str(ROOT/'audits/report7649404-20261026')))
APP=Path(os.environ['REPORT7649404_APP']);SHELL=Path(os.environ.get('REPORT7649404_SHELL',str(AUDIT/'published-before/index.html')))
BASE=os.environ['KOPILKA_QA_BASE_URL'];MODE=os.environ.get('REPORT7649404_MODE','green')
assert os.environ['NODE_ENV']=='test' and os.environ['SCHEDULER_ENABLED']=='false' and 'qa.sqlite' in os.environ['DB_PATH']
results=[]
def signed(uid,host):
    v=dict(vk_app_id='54723764',vk_user_id=str(uid),vk_platform='mobile_android' if host=='android' else 'desktop_web',vk_ts=str(int(time.time())))
    v['sign']=base64.urlsafe_b64encode(hmac.new(b'browser-qa-vk-secure-key',urllib.parse.urlencode(sorted(v.items())).encode(),hashlib.sha256).digest()).decode().rstrip('=')
    return urllib.parse.urlencode(v)
with sync_playwright() as pw:
    # Own disposable unauthenticated browser; never touch shared authenticated tabs/workers.
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    try:
        for i,(host,lang,scale) in enumerate(list(itertools.product(('desktop','android'),('ru','en'),(1,2)))[:1 if os.environ.get('REPORT7649404_SMOKE') else 8]):
            name=f'{host}-{lang}-{scale*100}';checks=[];proof={};errors=[];traffic=[]
            context=browser.new_context(viewport={'width':1280,'height':900} if host=='desktop' else {'width':393,'height':852},is_mobile=host=='android',has_touch=host=='android',service_workers='block',user_agent='Mozilla/5.0 (Linux; Android 16; Samsung QA) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36' if host=='android' else 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36')
            try:
                def route(r):
                    path=urllib.parse.urlparse(r.request.url).path
                    if not r.request.url.startswith(BASE+'/'):r.abort()
                    elif path=='/app.js':r.fulfill(content_type='application/javascript',body=APP.read_text())
                    elif path=='/':r.fulfill(content_type='text/html',body=SHELL.read_text())
                    else:r.continue_()
                context.route('**/*',route)
                query=signed(81997649404+i,host)
                auth=context.request.post(BASE+'/api/auth/vk',data={'launchParams':query}).json();assert auth.get('token'),auth
                headers={'Authorization':'Bearer '+auth['token']}
                assert context.request.post(BASE+'/api/settings/locale',headers=headers,data={'locale':lang}).ok
                p=context.new_page();p.on('pageerror',lambda e:errors.append(str(e)))
                context.on('request',lambda r:traffic.append((r.method,urllib.parse.urlparse(r.url).path)))
                def loaded():
                    p.wait_for_function('state.user && state.product && state.history && !state.busy')
                    p.wait_for_load_state('networkidle')
                    p.evaluate('s=>{document.documentElement.style.fontSize=s*100+"%";setStatus("")}',scale)
                    assert p.evaluate('locale()')==lang
                p.goto(BASE+'/?'+query);loaded();uid=p.evaluate('state.user.id')
                def history():p.locator('#tab-button-week').click()
                history()
                assert p.locator('#practiceGoal').is_visible()
                def change():
                    traffic.clear()
                    old=p.locator('#practiceGoal').input_value()
                    goal=next(v for v in p.locator('#practiceGoal option').evaluate_all('(items)=>items.map(o=>o.value)') if v!=old)
                    p.locator('#practiceGoal').focus()
                    with p.expect_response(lambda r:'/api/product/practices?' in r.url and r.request.method=='GET') as response:p.locator('#practiceGoal').select_option(goal)
                    assert response.value.ok,response.value.text()
                    p.wait_for_function('document.getElementById("statusRegion").textContent.includes(L("practicesUpdated"))')
                    assert p.evaluate('state.product.practices.goal')==goal
                    assert p.locator('#practiceGoal').input_value()==goal
                    assert ('GET','/api/product/practices') in traffic
                    assert not [r for r in traffic if r[0]=='POST'],traffic
                    return goal
                def text():return p.locator('#statusRegion').text_content()
                def notice():
                    button=p.get_by_role('button',name=p.evaluate('L("dismissNotification")'),exact=True)
                    assert button.is_visible()
                    box=button.bounding_box();assert box and box['y']>=0 and box['y']+box['height']<=p.viewport_size['height'],box
                    assert button.evaluate('(e)=>{const r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e}')
                    assert p.locator('#statusRegion').get_attribute('role')=='status'
                    proof['accessible_dismiss']={'name':p.evaluate('L("dismissNotification")'),'box':box}
                    return button
                change();saved=text()
                if MODE=='red':
                    assert p.locator('#dismissStatus').is_hidden()
                    p.locator('#tab-button-today').click();p.wait_for_timeout(5300)
                    assert text()==saved
                    checks.append('original-real-goal-GET-notice-persists-over-5s-across-tab')
                    p.evaluate('window.retainedStatus=document.getElementById("statusRegion");Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"))')
                    p.wait_for_timeout(300)
                    p.evaluate('Object.defineProperty(document,"hidden",{configurable:true,value:false});document.dispatchEvent(new Event("visibilitychange"));window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}))')
                    assert text()==saved and p.evaluate('window.retainedStatus===document.getElementById("statusRegion")')
                    checks.append('original-synthetic-hide-show-retained-DOM-still-stale-not-native-device-proof')
                    p.reload();loaded();assert saved not in text()
                    checks.append('reload-reinitializes-status-not-equivalent-to-retained-DOM-resume')
                    # Expected regression assertion, same visible acceptance used for candidate.
                    history();change();p.wait_for_timeout(5300);assert text()=='','BUG7649404: exact shipped real handler leaves practices notice after 5 seconds'
                else:
                    button=notice();button.focus();p.locator('#tab-button-today').click();p.wait_for_timeout(5300)
                    assert text()=='' and p.evaluate('document.activeElement.id')=='heading-today', {'status':text(),'focus':p.evaluate('document.activeElement.id')}
                    checks.append('actual-goal-GET-success-5s-expiry-after-tab-navigation-no-focus-steal')
                    history();change();notice().focus();p.keyboard.press('Enter')
                    assert text()=='' and p.evaluate('document.activeElement.id')=='practiceGoal' and not p.evaluate('readyNoticeDismissed')
                    checks.append('localized-keyboard-Enter-dismiss-restores-goal-focus')
                    change();notice().focus();p.keyboard.press('Space');assert text()==''
                    checks.append('keyboard-Space-dismiss')
                    change();notice();p.evaluate('window.retainedStatus=document.getElementById("statusRegion");Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"))')
                    p.wait_for_timeout(5300)
                    p.evaluate('Object.defineProperty(document,"hidden",{configurable:true,value:false});document.dispatchEvent(new Event("visibilitychange"));window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}))')
                    assert text()=='' and p.evaluate('window.retainedStatus===document.getElementById("statusRegion")')
                    checks.append('synthetic-retained-DOM-hide-show-expires-not-physical-VK-acceptance')
                    history();change();saved=text();p.reload();loaded();assert saved not in text()
                    checks.append('actual-page-reload-clears-ephemeral-state')
                    p.close();p=context.new_page();p.on('pageerror',lambda e:errors.append(str(e)));p.goto(BASE+'/?'+query);loaded();assert saved not in text()
                    checks.append('actual-page-close-reopen-reinitializes-state')
                    history()
                    def fail(r):r.fulfill(status=503,content_type='application/json',body='{"error":"fixture goal GET rejected"}')
                    p.route('**/api/product/practices?*',fail)
                    old=p.evaluate('state.product.practices.goal');p.locator('#practiceGoal').select_option(next(v for v in p.locator('#practiceGoal option').evaluate_all('(items)=>items.map(o=>o.value)') if v!=old))
                    p.wait_for_function('document.getElementById("statusRegion").classList.contains("error")');assert text()=='fixture goal GET rejected'
                    p.wait_for_timeout(5300);assert text()=='fixture goal GET rejected' and p.locator('#dismissStatus').is_hidden() and p.evaluate('state.product.practices.goal')==old
                    p.unroute('**/api/product/practices?*',fail);checks.append('failed-goal-GET-error-durable-no-success-no-product-change')
                    held=[]
                    def hold(r):held.append(r)
                    p.route('**/api/product/practices?*',hold);p.evaluate('setStatus("")');p.locator('#practiceGoal').select_option(old)
                    p.wait_for_timeout(300);assert len(held)==1 and text()==''
                    held.pop().continue_();p.wait_for_function('statusCategory==="practices-updated"');notice().click();assert text()==''
                    p.unroute('**/api/product/practices?*',hold);checks.append('delayed-goal-GET-no-premature-success-then-real-response')
                    change();p.evaluate('window.oldClose=document.getElementById("dismissStatus").onclick;setStatus("new durable warning","error");oldClose()');p.wait_for_timeout(5300)
                    assert text()=='new durable warning' and p.locator('#dismissStatus').is_hidden()
                    checks.append('newer-error-survives-practice-timer-and-stale-close')
                    # Locale is a real POST unlike practice selection (which is read-only GET).
                    p.locator('#tab-button-settings').click();opposite='en' if lang=='ru' else 'ru'
                    p.route('**/api/settings/locale',fail);p.locator('#lang-'+opposite).click();p.wait_for_function('!state.busy && document.getElementById("statusRegion").classList.contains("error")')
                    assert p.evaluate('locale()')==lang and p.locator('#dismissStatus').is_hidden()
                    assert context.request.get(BASE+'/api/me',headers=headers).json()['user']['locale']==lang
                    p.unroute('**/api/settings/locale',fail);checks.append('failed-locale-POST-no-success-no-identity-or-locale-drift')
                    held=[];p.route('**/api/settings/locale',hold);p.locator('#lang-'+opposite).click();p.wait_for_timeout(300)
                    assert len(held)==1 and p.evaluate('locale()')==lang and p.locator('#dismissStatus').is_hidden()
                    held.pop().continue_();p.wait_for_function('arg=>!state.busy && locale()===arg',arg=opposite);p.wait_for_load_state('networkidle')
                    assert p.evaluate('statusCategory')=='settings-saved';notice().click();p.unroute('**/api/settings/locale',hold)
                    assert context.request.get(BASE+'/api/me',headers=headers).json()['user']['locale']==opposite
                    checks.append('delayed-real-locale-POST-commit-GET-and-settings-dismiss-preserved')
                    p.evaluate('setStatus(L("shareUnconfirmed"),"info","share-unconfirmed")');share=text();p.keyboard.press('Escape');p.locator('#tab-button-today').click();p.wait_for_timeout(5300)
                    assert text()==share;notice().click();assert not p.evaluate('readyNoticeDismissed')
                    for category in ('template-applied','settings-saved'):
                        p.evaluate('c=>setStatus(c,"info",c)',category);notice().click();assert text()=='' and not p.evaluate('readyNoticeDismissed')
                    p.evaluate('setStatus(L("ready"),"info","ready")');notice().click();p.evaluate('setStatus(L("ready"),"info","ready")');assert text()==''
                    checks.append('share-untimed-outside-Escape-safe-Ready-template-settings-independent')
                    with sqlite3.connect('file:'+os.environ['DB_PATH']+'?mode=ro',uri=True) as db:
                        assert db.execute('SELECT COUNT(*) FROM entries WHERE user_id=?',(uid,)).fetchone()==(0,)
                        assert db.execute('SELECT locale FROM users WHERE id=?',(uid,)).fetchone()==(opposite,)
                    assert not errors,errors;checks.append('fixture-SQLite-locale-readback-zero-entry-writes-no-page-errors')
                results.append(dict(name=name,passed=True,checks=checks,proof=proof))
            except Exception:
                import traceback
                results.append(dict(name=name,passed=False,checks=checks,proof=proof,error=traceback.format_exc()))
            finally:
                context.close();(AUDIT/f'browser-{MODE}-results.json').write_text(json.dumps(dict(app_sha256=hashlib.sha256(APP.read_bytes()).hexdigest(),shell_sha256=hashlib.sha256(SHELL.read_bytes()).hexdigest(),results=results),ensure_ascii=False,indent=2));print(json.dumps(results[-1],ensure_ascii=False),flush=True)
    finally:browser.close()
assert len(results)==(1 if os.environ.get('REPORT7649404_SMOKE') else 8) and all(r['passed'] for r in results),[(r['name'],r.get('error')) for r in results if not r['passed']]
