#!/usr/bin/env python3
"""Narrow Testers 7656574/7656590 contracts; isolated HTTP/SQLite, zero AI calls.
Run through run-browser-qa.py with the outbound-denying preload supplied in NODE_OPTIONS.
AI_ACTIONS_BASELINE points to a private saved source directory for identical RED checks.
"""
import base64, hashlib, hmac, json, os, sqlite3, time, urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright
BASE = os.environ['KOPILKA_QA_BASE_URL']
DB = os.environ['DB_PATH']
assert os.environ['NODE_ENV'] == 'test' and DB.endswith('qa.sqlite')
assert Path(DB).parent.name.startswith('kopilka-browser-suite-')
assert urllib.parse.urlsplit(BASE).hostname == '127.0.0.1'
assert 'ai-result-actions-preload.cjs' in os.environ.get('NODE_OPTIONS',''), 'Outbound-denying fixture preload required'
ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ['AI_ACTIONS_REPORT'])
results = []
def signed(uid):
    p = dict(vk_app_id='54723764', vk_user_id=str(uid), vk_platform='mobile_android', vk_ts=str(int(time.time())))
    p['sign'] = base64.urlsafe_b64encode(hmac.new(b'browser-qa-vk-secure-key', urllib.parse.urlencode(sorted(p.items())).encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return urllib.parse.urlencode(p)
def readonly(sql, args=()):
    with sqlite3.connect('file:'+DB+'?mode=ro', uri=True) as db:
        return db.execute(sql,args).fetchall()
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    try:
        for lang in ['ru','en']:
            for width in [320,360,390,412,1280]:
                for scale in [100,200]:
                    ctx=browser.new_context(viewport={'width':width,'height':900},service_workers='block')
                    label=f'{lang}-{width}-{scale}'
                    try:
                        ctx.route('**/*',lambda r:r.continue_() if r.request.url.startswith(BASE+'/') else r.abort())
                        q=signed(8399100000+len(results))
                        auth=ctx.request.post(BASE+'/api/auth/vk',data={'launchParams':q}).json()
                        headers={'Authorization':'Bearer '+auth['token']}
                        assert ctx.request.post(BASE+'/api/settings/locale',headers=headers,data={'locale':lang}).ok
                        meta=ctx.request.get(BASE+'/api/ai-weekly-summary',headers=headers).json()
                        now=int(time.time()*1000); period=meta['period']; uid=auth['user']['id']
                        # Seed only this runner's disposable DB, no generation endpoint/provider.
                        with sqlite3.connect(DB) as db:
                            db.execute("INSERT INTO entries(user_id,type,title,note,life_points,entry_date) VALUES(?,'movement','Fixture walk','Private fixture note',1,?)",(uid,period['end']))
                            digest=db.execute('''INSERT INTO ai_weekly_summaries(user_id,period_start,period_end,timezone,period_key,locale,status,text,provider,model,consent_version,consent_at,started_at,deadline_at,created_at,topic,days)
                              VALUES(?,?,?,?,?,?,'ready',?,'Google Gemini','fixture-model',?,?,?,?,?,'summary',7)''',
                              (uid,period['start'],period['end'],period['timezone'],period['key'],lang,('Recorded walk.\n'*180),meta['consentVersion'],now,now,now+60000,now)).lastrowid
                        before=readonly('SELECT user_id,started_at,consent_at,period_key FROM ai_weekly_summaries WHERE id=?',(digest,))
                        p=ctx.new_page();errors=[];traffic=[]
                        p.on('pageerror',lambda e:errors.append(str(e)))
                        p.on('request',lambda r:traffic.append((r.method,urllib.parse.urlsplit(r.url).path)))
                        if os.environ.get('AI_ACTIONS_BASELINE'):
                            for name in ['ai-weekly.js','styles.css']:
                                path=Path(os.environ['AI_ACTIONS_BASELINE'])/name
                                p.route('**/'+name+'*',lambda r,request,path=path:r.fulfill(path=path))
                        p.goto(BASE+'/?'+q)
                        p.wait_for_function('state.user && state.history && !state.busy')
                        p.locator('#tab-button-assistant').click()
                        p.wait_for_selector('#aiWeeklyResult .ai-weekly-text')
                        p.evaluate('(s)=>{document.documentElement.style.fontSize=s+"%";document.body.style.fontSize=(16*s/100)+"px"}',scale)
                        # Check native select layout policy, full accessible option and purpose.
                        p.locator('#aiWeeklyTopic').select_option('goal')
                        p.wait_for_function('document.getElementById("aiWeeklyPurpose").textContent.includes(document.getElementById("aiWeeklyTopic").selectedOptions[0].textContent)')
                        layout=p.locator('#aiWeeklyTopic').evaluate('(s)=>({tag:s.tagName,overflow:getComputedStyle(s).textOverflow,width:s.getBoundingClientRect().width,body:document.documentElement.clientWidth,option:s.selectedOptions[0].textContent})')
                        failures=[]
                        if layout['overflow']!='ellipsis': failures.append('native-topic-missing-ellipsis')
                        assert layout['tag']=='SELECT' and layout['width']<=layout['body']
                        assert layout['option'] and p.locator('#aiWeeklyPurpose').inner_text().endswith(layout['option'])
                        if label=='en-320-100':
                            p.locator('#aiWeeklyTopic').scroll_into_view_if_needed()
                            p.screenshot(path=str(OUT.with_name(OUT.stem+'-topic.png')))
                        p.locator('#aiWeeklyTopic').select_option('summary')
                        p.wait_for_selector('#aiWeeklyResult .ai-weekly-text')
                        button=p.locator(f'#ai-weekly-delete-{digest}');button.click()
                        box=p.locator('#aiWeeklyDeleteConfirm'); cancel=p.locator('#aiWeeklyDeleteCancel')
                        assert box.is_visible() and cancel.evaluate('(n)=>document.activeElement===n')
                        geo=box.evaluate('(n)=>{const b=n.getBoundingClientRect();const t=document.querySelector("[id^=ai-weekly-delete-]").getBoundingClientRect();return {adjacent:n.previousElementSibling?.id===document.querySelector("[id^=ai-weekly-delete-]").id,navTop:document.querySelector(".tab-bar").getBoundingClientRect().top,top:b.top,bottom:b.bottom,height:innerHeight,buttonBottom:t.bottom}}')
                        if label in ['ru-1280-100','en-320-100']:p.screenshot(path=str(OUT.with_name(OUT.stem+'-'+label+'-confirm.png')))
                        if not geo['adjacent']:failures.append('confirmation-not-adjacent')
                        if geo['bottom']-geo['top'] <= geo['navTop']-16:
                            if geo['top']<0 or geo['bottom']>geo['height']:failures.append('confirmation-outside-viewport')
                            if geo['bottom']>geo['navTop']:failures.append('confirmation-obscured-by-navigation')
                        else:
                            # Enlarged text can exceed a whole viewport; all words remain
                            # scrollable, but both decision controls must remain in view.
                            for selector in ['#aiWeeklyDeleteCancel','#aiWeeklyDeleteYes']:
                                bounds=p.locator(selector).bounding_box()
                                if bounds['y']<0 or bounds['y']+bounds['height']>geo['navTop']:failures.append('zoom-confirmation-action-obscured')
                        # Escape and explicit Cancel return to the same connected control.
                        cancel.press('Escape');assert box.is_hidden() and button.evaluate('(n)=>document.activeElement===n')
                        button.click();cancel.click();assert button.evaluate('(n)=>document.activeElement===n')
                        assert readonly('SELECT status FROM ai_weekly_summaries WHERE id=?',(digest,))==[('ready',)]
                        # Routine GET retains same result DOM and pending confirmation.
                        button.click();p.evaluate('window.__savedButton=document.querySelector("[id^=ai-weekly-delete-]")')
                        p.evaluate('document.getElementById("aiWeeklyRefresh").click()')
                        p.wait_for_function('!document.getElementById("aiWeeklyRefresh").disabled')
                        assert p.evaluate('window.__savedButton===document.querySelector("[id^=ai-weekly-delete-]")')
                        assert box.is_visible();cancel.click()
                        # Selection cancels stale deletion intent, even if same saved result remains.
                        button.click();p.locator('#aiWeeklyTopic').select_option('goal')
                        p.wait_for_function('!document.getElementById("aiWeeklyRefresh").disabled')
                        if box.is_visible():failures.append('selection-keeps-stale-confirmation');cancel.click()
                        p.locator('#aiWeeklyTopic').select_option('summary');p.wait_for_selector('#aiWeeklyResult .ai-weekly-text')
                        # Identity refresh closes pending intent and fences the old metadata read.
                        button.click()
                        p.evaluate('window.__fixtureUser=state.user; state.user={...state.user,id:state.user.id+100000}; aiWeekly.sync()')
                        assert box.is_hidden()
                        p.evaluate('document.getElementById("aiWeeklyDeleteYes").click()')
                        assert not any(method=='DELETE' for method,path in traffic)
                        p.evaluate('state.user=window.__fixtureUser; aiWeekly.sync(); void aiWeekly.load()')
                        p.wait_for_selector('#aiWeeklyResult .ai-weekly-text')
                        # Hold a pre-delete GET, then delete exactly once and release old metadata.
                        held=[]
                        def hold(route):held.append((route,route.fetch()))
                        p.route('**/api/ai-weekly-summary?*',hold)
                        p.evaluate('document.getElementById("aiWeeklyRefresh").click()')
                        p.wait_for_function('document.getElementById("aiWeeklyRefresh").disabled')
                        deadline=time.monotonic()+5
                        while not held and time.monotonic()<deadline:p.wait_for_timeout(20)
                        assert held
                        deletes=[]
                        p.route(f'**/api/ai-weekly-summary/{digest}',lambda route:deletes.append((route,route.fetch())))
                        button.click()
                        p.locator('#aiWeeklyDeleteYes').click()
                        deadline=time.monotonic()+5
                        while not deletes and time.monotonic()<deadline:p.wait_for_timeout(20)
                        assert len(deletes)==1
                        assert button.is_disabled() and p.locator('#aiWeeklyRefresh').is_disabled()
                        p.evaluate('document.getElementById("aiWeeklyDeleteYes").click();document.getElementById("aiWeeklyDeleteYes").click()')
                        assert len(deletes)==1
                        deletes[0][0].fulfill(response=deletes[0][1])
                        p.unroute(f'**/api/ai-weekly-summary/{digest}')
                        p.wait_for_function('!document.getElementById("aiWeeklyResult").querySelector(".ai-weekly-text")')
                        # Delete's own subsequent read is also held. Complete stale then fresh.
                        deadline=time.monotonic()+5
                        while len(held)<2 and time.monotonic()<deadline:p.wait_for_timeout(20)
                        assert len(held)==2
                        held[0][0].fulfill(response=held[0][1]);p.wait_for_timeout(80)
                        if p.locator('#aiWeeklyResult .ai-weekly-text').count():failures.append('stale-read-restores-deleted-text')
                        held[1][0].fulfill(response=held[1][1]);p.unroute('**/api/ai-weekly-summary?*')
                        p.wait_for_function('!document.getElementById("aiWeeklyRefresh").disabled')
                        assert p.locator('[id^=ai-weekly-delete-]').count()==0
                        assert p.locator('#aiWeeklyCreate').is_hidden()
                        if not p.locator('#aiWeeklyRefresh').evaluate('(n)=>document.activeElement===n'):failures.append('delete-focus-not-returned-to-surviving-control')
                        p.locator('#aiWeeklyRefresh').click();p.wait_for_function('!document.getElementById("aiWeeklyRefresh").disabled')
                        assert 'No new AI request' in p.locator('#aiWeeklyStatus').inner_text() if lang=='en' else 'Новый запрос к ИИ не отправлялся' in p.locator('#aiWeeklyStatus').inner_text()
                        assert traffic.count(('DELETE',f'/api/ai-weekly-summary/{digest}'))==1
                        assert not any(method=='POST' and path=='/api/ai-weekly-summary' for method,path in traffic)
                        assert readonly('SELECT status,text FROM ai_weekly_summaries WHERE id=?',(digest,))==[('deleted',None)]
                        assert readonly('SELECT user_id,started_at,consent_at,period_key FROM ai_weekly_summaries WHERE id=?',(digest,))==before
                        assert readonly('SELECT type,title,note,life_points,entry_date FROM entries WHERE user_id=?',(uid,))==[('movement','Fixture walk','Private fixture note',1,period['end'])]
                        final=ctx.request.get(BASE+'/api/ai-weekly-summary',headers=headers).json()
                        assert not final['quota']['allowed'] and final['quota']['nextAvailableAt']
                        # A second saved result proves shared confirmation controls re-enable
                        # after being moved out of a deleted article, without losing quota.
                        with sqlite3.connect(DB) as db:
                            archived=db.execute('''INSERT INTO ai_weekly_summaries(user_id,period_start,period_end,timezone,period_key,locale,status,text,provider,model,consent_version,consent_at,started_at,deadline_at,created_at,topic,days)
                              SELECT user_id,period_start,period_end,timezone,period_key,locale,'ready','Older saved fixture',provider,model,consent_version,consent_at,started_at-691200000,deadline_at-691200000,created_at-691200000,topic,days FROM ai_weekly_summaries WHERE id=?''',(digest,)).lastrowid
                        p.locator('#aiWeeklyRefresh').click();p.wait_for_function('!document.getElementById("aiWeeklyRefresh").disabled')
                        assert p.locator('#aiWeeklyResult .ai-weekly-text').count()==0
                        p.locator('#aiWeeklyArchive summary').click()
                        second=p.locator(f'#ai-weekly-delete-{archived}');second.click()
                        assert not p.locator('#aiWeeklyDeleteYes').is_disabled() and not cancel.is_disabled()
                        cancel.click();assert second.evaluate('(n)=>document.activeElement===n')
                        p.route('**/api/ai-weekly-summary?*',lambda route:route.fulfill(status=503,content_type='application/json',body='{"error":"fixture metadata failure"}'))
                        second.click();p.locator('#aiWeeklyDeleteYes').click()
                        p.wait_for_function('!document.getElementById("aiWeeklyRefresh").disabled')
                        assert readonly('SELECT status,text FROM ai_weekly_summaries WHERE id=?',(archived,))==[('deleted',None)]
                        assert p.locator('[id^=ai-weekly-delete-]').count()==0
                        assert p.locator('#aiWeeklyCreate').is_hidden()
                        p.unroute('**/api/ai-weekly-summary?*')
                        p.locator('#aiWeeklyRefresh').click();p.wait_for_function('!document.getElementById("aiWeeklyRefresh").disabled')
                        assert p.locator('[id^=ai-weekly-delete-]').count()==0
                        assert traffic.count(('DELETE',f'/api/ai-weekly-summary/{archived}'))==1
                        assert not errors,errors
                        results.append({'case':label,'failures':failures,'geometry':geo,'layout':layout,'fixtureDeleted':True,'archivedFixtureDeleted':True,'deleteRequests':sum(method=='DELETE' for method,path in traffic),'generationRequests':sum(method=='POST' and path=='/api/ai-weekly-summary' for method,path in traffic),'quotaPreserved':True})
                        print(label,failures,flush=True)
                    finally:ctx.close()
    finally:
        browser.close()
        OUT.write_text(json.dumps({'cases':results,'count':len(results),'failures':sum(len(r['failures']) for r in results)},ensure_ascii=False,indent=2))
assert len(results)==20 and not any(r['failures'] for r in results), 'AI result UI contracts failed; see report'
