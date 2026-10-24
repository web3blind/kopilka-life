#!/usr/bin/env python3
"""Local HTTP/SQLite + isolated Playwright. No provider or native TalkBack claim.
Standalone: python3 tests/talkback-quick-feedback-browser-qa.py
KOPILKA_TALKBACK_CLIENT optionally tests a saved baseline app.js.
"""
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
RESULTS = []

def run(base, db):
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
            args=['--no-sandbox', '--disable-background-networking'])
        try:
            for lang in ['ru', 'en']:
                for mode in ['normal', 'gratitude', 'artifact', 'write-error', 'refresh-error', 'identity', 'identity-before-commit', 'rollover']:
                    ctx = browser.new_context(viewport={'width':390,'height':900}, service_workers='block')
                    try:
                        auth = ctx.request.post(base+'/api/auth/dev', data={'firstName':'Quick feedback fixture','locale':lang,'timezone':'UTC'}).json()
                        token, uid = auth['token'], auth['user']['id']
                        headers = {'Authorization':'Bearer '+token}
                        if mode == 'artifact':
                            for typ in ['important_task','dream_step','movement','kind_trace','food_water']:
                                response = ctx.request.post(base+'/api/entries', headers=headers, data={'type':typ,'note':'fixture seed'})
                                assert response.ok, response.text()
                        def local_only(r):
                            if not r.request.url.startswith(base+'/'): r.abort()
                            elif '/app.js' in r.request.url and os.environ.get('KOPILKA_TALKBACK_CLIENT'):
                                r.fulfill(content_type='application/javascript',body=Path(os.environ['KOPILKA_TALKBACK_CLIENT']).read_text())
                            else: r.continue_()
                        ctx.route('**/*', local_only)
                        ctx.add_init_script('localStorage.setItem("kopilkaToken",'+json.dumps(token)+');localStorage.setItem("kopilkaLocale",'+json.dumps(lang)+')')
                        p = ctx.new_page(); errors=[]; writes=[]; held=[]; held_posts=[]; committed=[]
                        p.on('pageerror', lambda e: errors.append(str(e)))
                        p.goto(base); p.wait_for_function('state.user && state.summary && state.product && !state.busy')
                        assert p.evaluate('state.user.id') == uid
                        p.evaluate('''() => {
                          window.qaStatuses=[];const original=setStatus;
                          setStatus=function(text,type,category){qaStatuses.push({text,type,category});return original(text,type,category)};
                          window.qaButtons=Array.from(document.querySelectorAll('#quickActions button'));
                        }''')
                        # 200% text exercises the real narrow mobile layout in both locales.
                        p.add_style_tag(content='html { font-size: 200% !important; }')
                        ax = ctx.new_cdp_session(p)
                        def quick_ax():
                            nodes=ax.send('Accessibility.getFullAXTree')['nodes']
                            return [n for n in nodes if n.get('role',{}).get('value')=='button' and any(x.get('name')=='pressed' for x in n.get('properties',[]))]
                        def intercept(r):
                            path = r.request.url.split('?',1)[0]
                            if r.request.method == 'POST' and path.endswith('/api/entries'):
                                writes.append(r.request.post_data_json)
                                held_posts.append(r)
                            elif r.request.method == 'GET' and any(x in path for x in ['/api/product','/api/history','/api/artifacts']): held.append(r)
                            else:r.continue_()
                        ctx.route('**/api/**', intercept)
                        typ = 'gratitude' if mode == 'gratitude' else 'sleep'
                        b = p.locator('[data-entry-type="sleep"]')
                        # Focus/touch/blur/swipe-like movement alone never commits.
                        b.focus();b.dispatch_event('touchstart',{'touches':[]});b.dispatch_event('touchmove',{'touches':[]});b.dispatch_event('touchend',{'touches':[]});b.dispatch_event('blur');p.wait_for_timeout(80)
                        assert not writes
                        if mode == 'gratitude':
                            p.locator('#gratitudeNote').fill('private fixture thanks')
                            trigger = p.locator('[data-gratitude-submit]')
                        else:
                            p.locator('#entryNote').fill('private fixture note');trigger=b
                        trigger.focus();p.keyboard.press('Enter')
                        p.wait_for_function('state.busy')
                        assert len(held_posts)==1 and not committed
                        assert b.get_attribute('aria-pressed')=='false'
                        assert b.get_attribute('data-used-today')=='false'
                        assert p.locator('#quickActions').get_attribute('aria-busy')=='true'
                        before_ax=quick_ax()
                        assert len(before_ax)==len(p.locator('#quickActions button').all())
                        ids_before=[n['backendDOMNodeId'] for n in before_ax]
                        names_before=[n['name']['value'] for n in before_ax]
                        if mode=='identity-before-commit':
                            p.evaluate('authEpoch++;state.user={...state.user,id:999999};state.token="fixture-replaced"')
                        route=held_posts.pop()
                        if mode=='write-error':
                            route.fulfill(status=503,content_type='application/json',body='{"error":"fixture write refused"}')
                        else:
                            response=route.fetch();assert response.ok,response.text();committed.append(response.json());route.fulfill(response=response)
                        if mode=='identity-before-commit':
                            p.wait_for_function('!state.busy')
                            assert b.get_attribute('aria-pressed')=='false'
                            assert not p.evaluate('qaStatuses.some(s=>s.category==="entry-success")')
                            assert not held
                            replacement=ctx.request.post(base+'/api/auth/dev',data={'firstName':'Other account','locale':lang,'timezone':'UTC'}).json()
                            p.evaluate('async (auth)=>{state.user=auth.user;state.token=auth.token;state.summary=await api("/api/summary/today");renderQuickActions()}',replacement)
                            assert not p.evaluate('state.summary.todayEntryTypes.length')
                            assert [n['backendDOMNodeId'] for n in quick_ax()]==ids_before
                            assert b.get_attribute('aria-pressed')=='false'
                            with sqlite3.connect('file:'+str(db)+'?mode=ro',uri=True) as conn:
                                assert conn.execute('SELECT count(*) FROM entries WHERE user_id=?',(replacement['user']['id'],)).fetchone()[0]==0
                                assert conn.execute('SELECT count(*) FROM entries WHERE user_id=?',(uid,)).fetchone()[0]==1
                            assert not errors,errors
                            RESULTS.append({'lang':lang,'mode':mode,'pass':True,'posts':1,'dbRows':1})
                            print(json.dumps(RESULTS[-1]),flush=True)
                            continue
                        p.wait_for_function('(type)=>state.summary.todayEntryTypes.includes(type) || document.getElementById("statusRegion").classList.contains("error")', arg=typ, timeout=5000)
                        if mode == 'write-error':
                            p.wait_for_function('!state.busy')
                            assert len(writes)==1 and not committed
                            assert p.locator('#entryNote').input_value()=='private fixture note'
                            assert not p.evaluate('qaStatuses.some(s=>s.category==="entry-success")')
                            assert b.get_attribute('data-used-today')=='false'
                        else:
                            assert committed and held, 'secondary reads must still be pending'
                            data=committed[0]
                            assert p.evaluate('state.busy')
                            if mode=='gratitude':
                                assert p.locator('[data-gratitude-submit]').is_disabled()
                                assert p.locator('#gratitudeNote').input_value()==''
                            else:
                                assert b.get_attribute('data-used-today')=='true'
                                assert b.get_attribute('aria-disabled')=='true' and b.evaluate('(e)=>!e.disabled')
                            assert p.locator('#totalLife').inner_text()==str(data['summary']['totalLife'])
                            assert p.locator('#todayLife').inner_text()==str(data['summary']['todayLife'])
                            assert p.evaluate('qaButtons.every((b,i)=>b===document.querySelectorAll("#quickActions button")[i])')
                            assert p.evaluate('!document.getElementById("statusRegion").closest(\'[aria-busy="true"]\')')
                            assert p.locator('#quickActions').get_attribute('aria-busy')=='false'
                            after_ax=quick_ax()
                            assert [n['backendDOMNodeId'] for n in after_ax]==ids_before
                            assert [n['name']['value'] for n in after_ax]==names_before
                            if mode!='gratitude':
                                saved_ax=next(n for n in after_ax if n['name']['value']==b.get_attribute('aria-label'))
                                assert saved_ax['description']['value']==p.evaluate('L("alreadyAddedToday")')
                            pressed=[n for n in after_ax if any(x.get('name')=='pressed' and x.get('value',{}).get('value')=='true' for x in n.get('properties',[]))]
                            assert len(pressed)==sum(1 for t in data['summary']['todayEntryTypes'] if p.locator('[data-entry-type="'+t+'"]').count())
                            if mode!='gratitude': assert b.get_attribute('aria-pressed')=='true'
                            assert p.evaluate('qaStatuses.filter(s=>s.category==="entry-success").length')==1
                            assert p.evaluate('state.history.selectedEntries.some(e=>e.id==='+str(data['entry']['id'])+')')
                            assert data['entry']['note'] in p.locator('#selectedDayEntries').text_content()
                            expected = p.evaluate('L("artifactUnlockedStatus",{title:'+json.dumps(data['awardedArtifacts'][0]['title'])+'})') if mode=='artifact' else p.evaluate('L("gratitudeSavedStatus")' if mode=='gratitude' else 'L("entrySaved")')
                            assert p.locator('#statusRegion').inner_text()==expected
                            if mode!='gratitude': assert b.evaluate('(e)=>e===document.activeElement')
                            # Repeated click while busy, and another unused action, do not queue/replay.
                            b.dispatch_event('click');p.locator('[data-entry-type="rest"]').dispatch_event('click')
                            assert len(writes)==1 and not p.evaluate('state.pendingQuickAfterRefresh')
                            if mode=='identity':
                                p.evaluate('authEpoch++;state.user={...state.user,id:999999};state.token="fixture-replaced";setStatus("new identity")')
                            for r in held[:]:
                                if mode=='refresh-error':r.fulfill(status=503,content_type='application/json',body='{"error":"fixture refresh refused"}')
                                else:r.fulfill(response=r.fetch())
                            p.wait_for_function('!state.busy')
                            assert len(writes)==1
                            assert p.evaluate('qaStatuses.filter(s=>s.category==="entry-success").length')==1
                            if mode=='identity':
                                assert p.locator('#statusRegion').inner_text()=='new identity'
                            elif mode=='refresh-error':
                                assert p.evaluate('state.refreshFailed')
                                assert p.evaluate('L("refreshPending")') in p.locator('#statusRegion').inner_text()
                                assert b.get_attribute('data-used-today')=='true'
                            elif mode=='artifact':
                                assert p.locator('#artifactToast').is_visible()
                                assert p.locator('#artifactToastClose').evaluate('(e)=>e===document.activeElement')
                                p.locator('#artifactToastClose').click()
                                p.wait_for_function('!state.artifactQueue.length')
                                assert b.evaluate('(e)=>e===document.activeElement')
                            elif mode!='gratitude':
                                assert b.evaluate('(e)=>e===document.activeElement')
                                p.keyboard.press('Space');assert len(writes)==1
                                next_button=b.evaluate('(e)=>Array.from(document.querySelectorAll("#quickActions button"))[Array.from(document.querySelectorAll("#quickActions button")).indexOf(e)+1].dataset.entryType')
                                p.keyboard.press('Tab');assert p.locator('[data-entry-type="'+next_button+'"]').evaluate('(e)=>e===document.activeElement')
                                p.keyboard.press('Shift+Tab');assert b.evaluate('(e)=>e===document.activeElement')
                            if mode=='rollover':
                                # Simulate midnight only in disposable SQLite, then use the real
                                # server's summary; never synthesize a successful API response.
                                with sqlite3.connect(db) as conn:
                                    conn.execute("UPDATE entries SET entry_date=date(entry_date,'-1 day') WHERE user_id=?",(uid,))
                                summary=ctx.request.get(base+'/api/summary/today',headers=headers).json()
                                assert not summary['todayEntryTypes']
                                p.evaluate('(summary)=>{state.summary=summary;renderQuickActions()}',summary)
                                assert b.get_attribute('aria-pressed')=='false'
                                assert b.get_attribute('aria-disabled') is None
                                assert [n['backendDOMNodeId'] for n in quick_ax()]==ids_before
                                assert b.evaluate('(e)=>e===document.activeElement')
                            if mode in ['normal','rollover']:
                                # An unused action (or yesterday's action) can commit normally.
                                ctx.unroute('**/api/**',intercept)
                                next_type='rest' if mode=='normal' else 'sleep'
                                rest=p.locator('[data-entry-type="'+next_type+'"]')
                                with p.expect_response(lambda r:r.request.method=='POST' and r.url.endswith('/api/entries')) as result:
                                    rest.click()
                                assert result.value.ok,result.value.text()
                                writes.append(result.value.request.post_data_json)
                                p.wait_for_function('(type)=>!state.busy && state.summary.todayEntryTypes.includes(type)',arg=next_type)
                                assert rest.get_attribute('aria-pressed')=='true'
                                assert b.get_attribute('aria-pressed')=='true'
                                assert [n['backendDOMNodeId'] for n in quick_ax()]==ids_before
                                with sqlite3.connect('file:'+str(db)+'?mode=ro',uri=True) as conn:
                                    assert conn.execute("SELECT count(*) FROM entries WHERE user_id=? AND type=?",(uid,next_type)).fetchone()[0]==(2 if mode=='rollover' else 1)
                            assert p.evaluate('qaButtons.every((b,i)=>b===document.querySelectorAll("#quickActions button")[i])')
                        with sqlite3.connect('file:'+str(db)+'?mode=ro',uri=True) as conn:
                            rows=conn.execute('SELECT type,note FROM entries WHERE user_id=? AND type=?',(uid,typ)).fetchall()
                        assert len(rows)==(0 if mode=='write-error' else 2 if mode=='rollover' else 1), rows
                        assert not errors, errors
                        RESULTS.append({'lang':lang,'mode':mode,'pass':True,'posts':len(writes),'dbRows':len(rows)})
                        print(json.dumps(RESULTS[-1]),flush=True)
                    finally:ctx.close()
        finally:browser.close()

def main():
    # No project .env, inherited provider variables, shared browser or production DB.
    scratch=os.environ.get('TMPDIR',str(Path.home()/'.hermes/cache/scratch'))
    with tempfile.TemporaryDirectory(prefix='talkback-quick-feedback-',dir=scratch) as tmp:
        tmp=Path(tmp)
        for name in ['public','migrations']:(tmp/name).symlink_to(ROOT/name,target_is_directory=True)
        with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
        base='http://127.0.0.1:'+str(port);db=tmp/'qa.sqlite'
        env={'PATH':os.environ['PATH'],'HOME':str(Path.home()),'NODE_ENV':'test','PORT':str(port),
             'DB_PATH':str(db),'DEV_AUTH_ENABLED':'true','SCHEDULER_ENABLED':'false',
             'SESSION_SECRET':'talkback-quick-feedback-local-fixture','BOT_TOKEN':'','VK_SECURE_KEY':'',
             'APP_BASE_URL':base,'WEBAPP_URL':base,'GEO_COUNTRY_DB_PATH':str(tmp/'missing.mmdb')}
        with (tmp/'server.log').open('w+') as log:
            proc=subprocess.Popen(['node',str(ROOT/'src/server.js')],cwd=tmp,env=env,stdout=log,stderr=log)
            try:
                deadline=time.monotonic()+30
                while True:
                    try:urllib.request.urlopen(base+'/health',timeout=1).close();break
                    except Exception:
                        if proc.poll() is not None or time.monotonic()>deadline:
                            log.seek(0);raise RuntimeError(log.read())
                        time.sleep(.1)
                run(base,db)
            finally:
                proc.terminate()
                try:proc.wait(timeout=10)
                except subprocess.TimeoutExpired:proc.kill();proc.wait()
    print('TALKBACK_QUICK_FEEDBACK_CONNECTED_PASS',len(RESULTS),flush=True)

if __name__=='__main__':main()
