#!/usr/bin/env python3
"""Connected production-byte regression; local proofs and bridge only, no live providers."""
import base64, hashlib, hmac, json, os, shutil, sqlite3, subprocess, sys, time, urllib.parse, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
HERE=Path(os.environ.get('REPORTS8_AUDIT',str(ROOT/'audits/reports8-20261026')))/'parent-entry'; HERE.mkdir(parents=True,exist_ok=True)
SOURCE=Path(os.environ.get('REPORTS8_SOURCE',str(ROOT)))
BASE='http://127.0.0.1:32771'
MODE=sys.argv[1] if len(sys.argv)>1 else 'green'
RUN=HERE/('run-'+MODE)
KEY=b'entry-context-fixture'
def signed(uid=720001, age=0):
    fields={'vk_app_id':'54723764','vk_user_id':str(uid),'vk_ts':str(int(time.time())-age)}
    raw=urllib.parse.urlencode(sorted(fields.items()))
    fields['sign']=base64.urlsafe_b64encode(hmac.new(KEY,raw.encode(),hashlib.sha256).digest()).decode().rstrip('=')
    return urllib.parse.urlencode(fields)
def post(path,data):
    req=urllib.request.Request(BASE+path,json.dumps(data).encode(),{'content-type':'application/json'})
    with urllib.request.urlopen(req) as r: return json.load(r)
def snapshot_db():
    with sqlite3.connect(RUN/'test.sqlite') as db:
        return {n:db.execute('select * from "'+n+'" order by rowid').fetchall() for (n,) in db.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")}
def main():
    RUN.mkdir(exist_ok=True)
    for n in ['test.sqlite','test.sqlite-wal','test.sqlite-shm']:
        (RUN/n).unlink(missing_ok=True)
    for n in ['public','migrations']:
        if (RUN/n).exists(): shutil.rmtree(RUN/n)
        shutil.copytree(SOURCE/n,RUN/n)
    if MODE!='red': shutil.copy2(Path(os.environ.get('REPORTS8_DOCUMENT',str(SOURCE/'public/document-navigation.js'))),RUN/'public/document-navigation.js')
    preload=RUN/'block-outbound.cjs'
    preload.write_text("const net=require('node:net');const old=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){const a=net._normalizeArgs(args)[0];if(a.host&&!['127.0.0.1','localhost','::1'].includes(a.host))throw new Error('QA outbound blocked');return old.apply(this,args);};")
    env=dict(PATH=os.environ['PATH'],HOME=str(RUN),NODE_ENV='test',NODE_OPTIONS='--require='+str(preload),PORT='32771',DB_PATH=str(RUN/'test.sqlite'),SESSION_SECRET='entry-context-isolated-session',BOT_TOKEN='',BOT_USERNAME='HarborLifeBot',VK_GROUP_TOKEN='test-entry-context-no-delivery',VK_GROUP_ID='240966481',VK_APP_ID='54723764',VK_SECURE_KEY=KEY.decode(),VK_OAUTH_CLIENT_ID='',SCHEDULER_ENABLED='false',DEV_AUTH_ENABLED='false',APP_BASE_URL=BASE,WEBAPP_URL=BASE,GEO_COUNTRY_DB_PATH=str(RUN/'missing.mmdb'),RATE_LIMIT_AUTH_MAX='1000')
    results=[]
    with (RUN/'server.log').open('w+') as log:
        proc=subprocess.Popen(['node',str(SOURCE/'src/server.js')],cwd=RUN,env=env,stdout=log,stderr=log)
        try:
            for _ in range(150):
                try: urllib.request.urlopen(BASE+'/health',timeout=1).close(); break
                except Exception:
                    if proc.poll() is not None: raise RuntimeError((RUN/'server.log').read_text())
                    time.sleep(.1)
            else: raise RuntimeError('health timeout')
            with (RUN/'node-gate.log').open('w') as gate:
                subprocess.run(['node','--test',str(ROOT/'tests/reports8-entry-http.cjs')],cwd=RUN,env=env,stdout=gate,stderr=gate,check=True)
            account=post('/api/auth/vk',{'launchParams':signed(720009)})
            cached=account['token']
            before=snapshot_db()
            with sync_playwright() as pw:
                browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
                try:
                    for surface in ['vk','web']:
                        for lang in ['ru','en']:
                            for width in [390,1280]:
                                ctx=browser.new_context(viewport={'width':width,'height':800},accept_downloads=True)
                                errors=[]; calls=[]; fetches=[]
                                ctx.on('page',lambda p:p.on('pageerror',lambda e:errors.append(str(e))))
                                ctx.add_cookies([{'name':'private-probe','value':'do-not-forward','url':BASE}])
                                def route(r):
                                    url=urllib.parse.urlparse(r.request.url)
                                    if url.hostname!='127.0.0.1': r.fulfill(status=200,body='',content_type='application/javascript'); return
                                    if '/vendor/vk-bridge' in url.path:
                                        r.fulfill(content_type='application/javascript',body="window.__bridgeCalls=[];window.vkBridge={isWebView:()=>false,supports:()=>true,subscribe(){},send:async(method,args)=>{window.__bridgeCalls.push({method,args});if(method==='VKWebAppGetUserInfo')return {id:720001,first_name:'Fixture'};if(method==='VKWebAppAllowMessagesFromGroup'||method==='VKWebAppShowStoryBox')throw {error_data:{error_reason:'User denied',error_code:4}};return {result:true};}};"); return
                                    r.continue_()
                                ctx.route('**/*',route)
                                ctx.add_init_script('try{if(!sessionStorage.getItem("qaSeeded")){localStorage.setItem("kopilkaLocale",'+json.dumps(lang)+');localStorage.setItem("kopilkaToken",'+json.dumps(cached)+');sessionStorage.setItem("qaSeeded","1");}}catch{}')
                                page=ctx.new_page(); page.set_default_timeout(12000);page.emulate_media(reduced_motion='reduce')
                                reads=[]
                                page.on('request',lambda r:reads.append(r.headers.get('authorization','')) if any(x in r.url for x in ['/api/summary','/api/history','/api/profile']) else None)
                                page.on('request',lambda r:fetches.append(r) if urllib.parse.urlparse(r.url).path in ['/about','/en/about'] else None)
                                launch=BASE+'/?'+signed() if surface=='vk' else BASE+'/'
                                page.goto(launch)
                                page.wait_for_function('typeof state!=="undefined" && state.user && state.summary && !state.busy')
                                user=page.evaluate('state.user.id')
                                assert user!=(account['user']['id']) if surface=='vk' else user==account['user']['id']
                                page.locator('#entryNote').fill('Private unsaved entry context draft')
                                page.locator('#tab-button-settings').click()
                                page.locator('#lang-'+lang).click()
                                page.wait_for_function('(lang)=>document.documentElement.lang===lang && !state.busy',arg=lang)
                                page.locator('#eveningReminderTime').fill('21:17');page.locator('#eveningReminderTime').dispatch_event('change')
                                expected=page.evaluate('({user:state.user.id,token:state.token,dirty:state.settingsDirty,links:document.querySelector("#accountLinksSection").hidden,logout:document.querySelector("#siteLogoutSection").hidden,reminders:document.querySelector("#vkReminderBox").hidden,story:document.querySelector("#daySceneShare").textContent,tab:state.activeTab})')
                                assert expected['links']==(surface=='vk') and expected['logout']==(surface=='vk') and expected['reminders']==(surface!='vk'),expected
                                page.evaluate('window.__ownerDocument=document;window.__entry=document.querySelector("#entryNote");window.__settings=document.querySelector("#eveningReminderTime");window.__storage=JSON.stringify({...localStorage});window.__session=JSON.stringify({...sessionStorage});window.__user=state.user')
                                opener=page.locator('.legal-links a[href="/about"]')
                                opener.scroll_into_view_if_needed();opener.focus()
                                scroll=page.evaluate('({x:scrollX,y:scrollY})')
                                opener.click()
                                if MODE=='red':
                                    page.wait_for_url('**/about')
                                    page.locator('main a[href="/"]').click()
                                    page.wait_for_function('typeof state!=="undefined" && state.user && state.summary && !state.busy')
                                    observed=page.evaluate('({links:document.querySelector("#accountLinksSection").hidden,logout:document.querySelector("#siteLogoutSection").hidden,reminders:document.querySelector("#vkReminderBox").hidden,story:document.querySelector("#daySceneShare").textContent})')
                                    assert observed['links']!=expected['links'] and observed['reminders']!=expected['reminders'] and observed['story']!=expected['story']
                                    results.append({'case':'original actual about href -> root CTA','before':expected,'after':observed,'outcome':'RED reproduced 3 context changes'})
                                    ctx.close(); print(json.dumps(results,ensure_ascii=False),flush=True); return
                                dialog=page.get_by_role('dialog');dialog.locator('h1').wait_for()
                                assert dialog.locator('main').get_attribute('lang')==lang
                                assert page.url==launch
                                assert page.evaluate('document.activeElement===document.querySelector("dialog h1")')
                                for _ in range(6):
                                    page.keyboard.press('Tab');assert page.evaluate('document.querySelector("dialog").contains(document.activeElement)')
                                return_name='Return to the app' if lang=='en' else 'Вернуться в приложение'
                                dialog.get_by_role('button',name=return_name).click();dialog.wait_for(state='hidden')
                                assert page.evaluate('document===window.__ownerDocument && document.querySelector("#entryNote")===window.__entry && document.querySelector("#eveningReminderTime")===window.__settings && state.user===window.__user')
                                actual=page.evaluate('({user:state.user.id,token:state.token,dirty:state.settingsDirty,links:document.querySelector("#accountLinksSection").hidden,logout:document.querySelector("#siteLogoutSection").hidden,reminders:document.querySelector("#vkReminderBox").hidden,story:document.querySelector("#daySceneShare").textContent,tab:state.activeTab})')
                                assert actual==expected,(actual,expected)
                                assert page.locator('#entryNote').input_value()=='Private unsaved entry context draft'
                                assert page.locator('#eveningReminderTime').input_value()=='21:17'
                                assert opener.evaluate('el=>document.activeElement===el')
                                assert page.evaluate('({x:scrollX,y:scrollY})')==scroll,(scroll,page.evaluate('({x:scrollX,y:scrollY})'))
                                assert page.evaluate('JSON.stringify({...localStorage})===window.__storage && JSON.stringify({...sessionStorage})===window.__session')
                                for action in ['escape','back','close']:
                                    opener.click();dialog.locator('h1').wait_for()
                                    if action=='escape': page.keyboard.press('Escape')
                                    elif action=='back': page.go_back()
                                    else: dialog.locator('[data-document-close]').click()
                                    dialog.wait_for(state='hidden');assert page.url==launch
                                # Browser forward reopens retained DOM; Back returns to the same app.
                                page.go_forward();dialog.locator('h1').wait_for();page.go_back();dialog.wait_for(state='hidden')
                                # About fetch failures never replace the app; Retry reloads public copy.
                                about_path='/en/about' if lang=='en' else '/about'
                                for mode in ['http','invalid','network']:
                                    def fail(route):
                                        if mode=='network': route.abort()
                                        else: route.fulfill(status=503 if mode=='http' else 200,body='<main>Not an About page</main>',content_type='text/html')
                                    pattern='**'+about_path+'*'
                                    page.route(pattern,fail);opener.click()
                                    dialog.locator('[role="alert"]').wait_for()
                                    assert page.url==launch and page.evaluate('document===window.__ownerDocument')
                                    page.unroute(pattern,fail);dialog.locator('.document-content button').click();dialog.locator('h1').wait_for()
                                    partner=dialog.locator('a[href$="/partners"]')
                                    assert partner.get_attribute('target')=='_blank' and partner.get_attribute('rel')=='noopener noreferrer'
                                    dialog.locator('[data-document-close]').click();dialog.wait_for(state='hidden')
                                # Existing legal reader remains connected from the same footer.
                                page.locator('.legal-links a[href="/privacy.html"]').click();dialog.locator('h1').wait_for()
                                assert dialog.locator('section').get_attribute('lang')==lang
                                dialog.locator('[data-document-close]').click();dialog.wait_for(state='hidden')
                                assert page.url==launch and page.locator('#entryNote').input_value()=='Private unsaved entry context draft'
                                # Exercise the actual Profile and Today report paths too.
                                for tab in ['profile','today']:
                                    page.locator('#tab-button-'+tab).click();opener.click();dialog.locator('h1').wait_for()
                                    dialog.get_by_role('button',name=return_name).click();dialog.wait_for(state='hidden')
                                    assert page.evaluate('state.activeTab')==tab
                                    assert page.locator('#accountLinksSection').evaluate('e=>e.hidden')==(surface=='vk')
                                    assert page.locator('#siteLogoutSection').evaluate('e=>e.hidden')==(surface=='vk')
                                    assert page.locator('#vkReminderBox').evaluate('e=>e.hidden')==(surface!='vk')
                                page.locator('#tab-button-settings').click()
                                if surface=='vk':
                                    page.locator('#enableVkReminders').click();page.wait_for_timeout(250)
                                    assert page.evaluate('window.__bridgeCalls.some(c=>c.method==="VKWebAppAllowMessagesFromGroup")')
                                    assert not page.evaluate('Boolean(state.user.vkMessagesAllowed)')
                                page.locator('#tab-button-today').click()
                                if surface=='web':
                                    with page.expect_download() as download: page.locator('#daySceneShare').click()
                                    assert download.value.suggested_filename=='kartina-dnya.png'
                                else:
                                    page.locator('#daySceneShare').click();page.wait_for_function('window.__bridgeCalls.some(c=>c.method==="VKWebAppShowStoryBox")')
                                    page.wait_for_function('!state.busy && document.querySelector("#statusRegion").textContent===L("daySceneStoryCanceled")')
                                    assert not page.evaluate('window.__bridgeCalls.some(c=>c.method==="VKWebAppShare")')
                                for req in fetches:
                                    if req.is_navigation_request(): raise AssertionError('About escaped the reader')
                                    assert urllib.parse.urlparse(req.url).query==('lang=en' if lang=='en' else '')
                                    assert not any(k in req.headers for k in ['authorization','cookie','referer']),req.headers.keys()
                                assert reads and all(h=='Bearer '+page.evaluate('state.token') for h in reads)
                                if surface=='vk': assert all(h!='Bearer '+cached for h in reads)
                                assert len(ctx.pages)==1 and not errors,errors
                                results.append({'surface':surface,'lang':lang,'width':width,'outcome':'PASS actual href -> About -> return; identity/native controls/drafts/settings/focus/history/storage retained; permission denial or PNG fallback; no leak/JS error'})
                                ctx.close()
                    # Invalid or expired launch must never read cached website identity.
                    for kind in ['invalid','expired']:
                        ctx=browser.new_context();ctx.route('https://**/*',lambda r:r.abort())
                        ctx.route('**/vendor/vk-bridge*',lambda r:r.fulfill(content_type='application/javascript',body='window.vkBridge={isWebView:()=>false,send:async()=>({result:true}),subscribe(){}};'))
                        ctx.add_init_script('localStorage.setItem("kopilkaToken",'+json.dumps(cached)+')')
                        page=ctx.new_page();private=[]
                        page.on('request',lambda r:private.append(r.url) if '/api/summary' in r.url or '/api/history' in r.url else None)
                        raw=signed(age=9999999) if kind=='expired' else signed()+'&sign=malformed'
                        if kind=='invalid': raw=raw.replace('vk_user_id=720001','vk_user_id=720002')
                        page.goto(BASE+'/?'+raw);page.wait_for_timeout(3000)
                        assert page.evaluate('!state.user') and not private,(kind,private)
                        # Anonymous About still closes without promoting cached bearer.
                        link=page.locator('#loginScreen a[href="/about"]')
                        if link.count():
                            link.click();page.get_by_role('dialog').locator('h1').wait_for();page.get_by_role('dialog').locator('[data-document-close]').click();page.get_by_role('dialog').wait_for(state='hidden')
                            assert page.evaluate('!state.user') and not private
                        results.append({'case':kind+' launch with cached other identity','outcome':'PASS no private read / no auth fallback'})
                        ctx.close()
                finally: browser.close()
            after=snapshot_db()
            for table in before:
                if table not in ['users','rate_limits','client_logs']:
                    assert before[table]==after[table],('unexpected persisted mutation',table)
            with sqlite3.connect(RUN/'test.sqlite') as db:
                assert db.execute('pragma integrity_check').fetchone()[0]=='ok'
                assert not db.execute('pragma foreign_key_check').fetchall()
                assert db.execute('select count(*) from entries').fetchone()[0]==0
                assert db.execute('select count(*) from users where vk_messages_allowed!=0 or reminders_enabled!=0 or evening_reminder_time!="20:00"').fetchone()[0]==0
            results.append({'case':'DB safety','outcome':'PASS no entries/identity links/contracts/reminder grants; integrity and FK clean'})
        finally:
            proc.terminate();proc.wait(timeout=10)
            (HERE/('results-'+MODE+'.json')).write_text(json.dumps(results,ensure_ascii=False,indent=2))
            print(json.dumps(results,ensure_ascii=False,indent=2),flush=True)
if __name__=='__main__': main()
