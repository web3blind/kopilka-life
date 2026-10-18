#!/usr/bin/env python3
"""Real local API/SQLite, controlled native dialogs; no live providers."""
import tempfile
import json, os, sqlite3
from pathlib import Path
from playwright.sync_api import sync_playwright
BASE = os.environ['KOPILKA_QA_BASE_URL']
assert BASE.startswith('http://127.0.0.1:') and os.environ['NODE_ENV'] == 'test'
assert 'qa.sqlite' in os.environ['DB_PATH']
report = {'cases': [], 'failures': [], 'pageerrors': [], 'external_requests_blocked': []}
def check(name, actual, expected):
    report['cases'].append({'name': name, 'actual': actual, 'expected': expected})
    if actual != expected: report['failures'].append(name)
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'], env={**os.environ, 'TMPDIR': (tempfile.gettempdir() + '/kopilka-qa')})
    ctx = browser.new_context(viewport={'width':390,'height':800})
    try:
        def route(r):
            if r.request.url.startswith(BASE+'/app.js') and os.environ.get('VK_RETURN_QA_APP'):
                r.fulfill(status=200, body=Path(os.environ['VK_RETURN_QA_APP']).read_text(), content_type='application/javascript')
            elif r.request.url.startswith(BASE+'/'): r.continue_()
            else:
                report['external_requests_blocked'].append(r.request.url)
                r.fulfill(status=200, body='', content_type='application/javascript')
        ctx.route('**/*', route)
        auth = ctx.request.post(BASE+'/api/auth/dev', data={'firstName':'Return QA','locale':'ru','timezone':'UTC'}).json()
        p = ctx.new_page()
        p.on('pageerror', lambda e: report['pageerrors'].append(str(e)))
        p.add_init_script('localStorage.setItem("kopilkaToken",'+json.dumps(auth['token'])+')')
        p.goto(BASE); p.wait_for_function('state.user && state.profile && !state.busy')
        uid = p.evaluate('state.user.id')
        with sqlite3.connect(os.environ['DB_PATH']) as db:
            db.execute('UPDATE users SET vk_id=?, is_demo=0 WHERE id=?',(910000000+uid,uid))
        p.evaluate('''() => {
          isVkMiniApp=()=>true;getPublicConfig=async()=>({vkGroupId:1,vkMessagesEnabled:true});
          state.user.vkLinked=true;renderAll();window.qaMode='allowed';window.qaCalls=[];
          window.vkBridge={send:async(m)=>{qaCalls.push(m);
            if(m==='VKWebAppAllowMessagesFromGroup') {
              if(qaMode==='timeout')return new Promise(()=>{});
              if(qaMode==='denied')throw {error_type:'client_error',error_data:{error_code:4}};
              return {result:true};
            }
            if(m==='VKWebAppShare')return new Promise((resolve,reject)=>{window.qaShareResolve=resolve;window.qaShareReject=reject});
            return {result:true};
          }};
          window.qaLoads=0;const oldLoad=loadData;loadData=async(...args)=>{qaLoads++;return oldLoad(...args)};
        }''')
        p.locator('#tab-button-settings').click()
        for mode, key in [('allowed','vkReminderAllowed'), ('denied','vkReminderDenied'), ('timeout','vkReminderNoResult')]:
            p.locator('[data-lang="ru"]').first.click();p.wait_for_function('locale()==="ru" && !state.busy')
            p.evaluate('(m)=>{qaMode=m;qaCalls=[]}', mode)
            p.locator('#enableVkReminders').click()
            p.wait_for_function('!document.querySelector("#enableVkReminders").disabled', timeout=12000)
            check(mode+' RU notice', p.locator('#vkReminderStatus').inner_text(), p.evaluate('(k)=>L(k)',key))
            p.locator('[data-lang="en"]').first.click();p.wait_for_function('locale()==="en" && !state.busy')
            check(mode+' EN notice after saved language', p.locator('#vkReminderStatus').inner_text(), p.evaluate('(k)=>L(k)',key))
            with sqlite3.connect(os.environ['DB_PATH']) as db:
                check(mode+' SQLite locale and permission', list(db.execute('SELECT locale,vk_messages_allowed,reminders_enabled FROM users WHERE id=?',(uid,)).fetchone()), ['en',1,1])
        for lang in ['ru','en']:
            p.locator('[data-lang="'+lang+'"]').first.click();p.wait_for_function('(l)=>locale()===l && !state.busy',arg=lang)
            p.locator('#tab-button-profile').click()
            for button in ['shareRefLink','shareProfile']:
                p.evaluate('''()=>{
                  qaCalls=[];qaLoads=0;qaShareReject=null;qaShareResolve=null;
                  document.querySelector('#shareFallback').hidden=true;
                  state.lastRefresh=0;refreshedDay=localDay();
                }''')
                p.locator('#'+button).click();p.wait_for_function('Boolean(qaShareReject)')
                p.wait_for_timeout(600) # Settle click/tab scroll before native return.
                before = p.evaluate('({scroll:scrollY,focus:document.activeElement.id,tab:state.activeTab})')
                # Host events may precede or follow the Bridge cancellation callback.
                p.evaluate('''()=>{window.dispatchEvent(new Event('focus'));
                  document.dispatchEvent(new Event('visibilitychange'))}''')
                p.wait_for_timeout(150)
                pending_loads = p.evaluate('qaLoads')
                p.evaluate('qaShareReject({error_type:"client_error",error_data:{error_code:4}})')
                p.wait_for_timeout(150)
                fallback = p.locator('#shareFallback').is_visible()
                after = p.evaluate('({scroll:scrollY,focus:document.activeElement.id,tab:state.activeTab})')
                p.evaluate('window.dispatchEvent(new Event("focus"));document.dispatchEvent(new Event("visibilitychange"))')
                p.wait_for_timeout(150)
                check(lang+' '+button+' no refresh while native dialog',pending_loads,0)
                check(lang+' '+button+' no forced manual field',fallback,False)
                check(lang+' '+button+' stable scroll/focus/tab',after,before)
                check(lang+' '+button+' no return refresh churn',p.evaluate('qaLoads'),0)
                check(lang+' '+button+' no fallback provider',p.evaluate('qaCalls'),['VKWebAppShare'])
                check(lang+' '+button+' honest cancellation status',p.locator('#statusRegion').inner_text(),p.evaluate('L("shareCancelled")'))
                p.wait_for_timeout(1100)
            # Ordinary stale return still refreshes outside the native-return window.
            p.evaluate('document.activeElement.blur();qaLoads=0;state.lastRefresh=0;window.dispatchEvent(new Event("focus"))')
            p.wait_for_function('qaLoads>0 && !state.busy')
            check(lang+' normal return preserved',p.evaluate('qaLoads'),1)
            # Success remains honest; real failure still offers existing copy fallback.
            for result in ['success','failure']:
                p.evaluate('qaCalls=[];qaShareReject=null;qaShareResolve=null')
                p.locator('#shareProfile').click();p.wait_for_function('Boolean(qaShareResolve)')
                p.evaluate('qaShareResolve({result:true})' if result=='success' else 'qaShareReject({error_type:"client_error",error_data:{error_code:5}})')
                p.wait_for_timeout(200)
                check(lang+' '+result+' share calls',p.evaluate('qaCalls'),['VKWebAppShare'] if result=='success' else ['VKWebAppShare','VKWebAppCopyText'])
                check(lang+' '+result+' status',p.locator('#statusRegion').inner_text(),p.evaluate('L("shareActionCompleted")' if result=='success' else 'L("copied")'))
                p.wait_for_timeout(1100)
            p.locator('#tab-button-settings').click()
        # Missing native callback: exercise real refresh/API boundary without
        # actually waiting 30s or sending a provider message.
        p.locator('#tab-button-profile').click()
        p.evaluate("qaLoads=0;qaShareResolve=null;qaShareReject=null;state.lastRefresh=0;setStatus('pending')")
        p.locator('#shareProfile').click();p.wait_for_function('Boolean(qaShareResolve)')
        p.evaluate("window.qaLostResolve=qaShareResolve;window.qaClock=Date.now;Date.now=()=>qaClock()+31000;document.activeElement.blur();window.dispatchEvent(new Event('focus'))")
        p.wait_for_function('qaLoads===1 && !state.refreshPending && !state.busy')
        check('lost callback permits real stale API refresh',p.evaluate('qaLoads'),1)
        p.evaluate("qaShareResolve=null;qaShareReject=null;setStatus('pending')")
        p.locator('#shareProfile').click();p.wait_for_function('Boolean(qaShareResolve)')
        p.evaluate('qaLostResolve({result:true})');p.wait_for_timeout(100)
        check('older callback cannot claim newer share success',p.locator('#statusRegion').inner_text(),'pending')
        check('newer request keeps its own lease',p.evaluate('vkSharePending.size'),1)
        p.evaluate('qaShareReject({error_type:"client_error",error_data:{error_code:4}})');p.wait_for_timeout(100)
        check('newer cancellation remains exact',p.locator('#statusRegion').inner_text(),p.evaluate('L("shareCancelled")'))
        p.evaluate('Date.now=qaClock;vkShareReturnUntil=0')
        # The reporter's video shows public-profile SEND, not only cancellation.
        # Exercise the real public API renderer, including already-visible fallback.
        for lang in ['ru','en']:
            p.evaluate('(l)=>{state.user.locale=l}',lang)
            assert p.evaluate('renderPublicProfile(state.profile.refCode)')
            for outcome in ['cancel','send']:
                p.evaluate('''()=>{qaCalls=[];qaLoads=0;qaShareReject=null;qaShareResolve=null;
                  document.querySelector('#shareFallback').hidden=false;
                  document.querySelector('#shareFallbackLink').value=state.publicProfileTarget.profileLink;
                  setStatus(L('shareUnconfirmed'));state.lastRefresh=0;
                  window.qaPublicNode=document.querySelector('#publicStats');
                  window.qaShellChanges=[];
                  window.qaShellObserver=new MutationObserver(rows=>qaShellChanges.push(...rows.map(r=>r.attributeName)));
                  qaShellObserver.observe(document.querySelector('#appShell'),{attributes:true,attributeFilter:['hidden','style']});
                }''')
                p.locator('#shareProfile').click();p.wait_for_function('Boolean(qaShareResolve)')
                # Settle click focus/scrollIntoView and preceding tab layout before
                # measuring the native return (do not mistake browser animation for it).
                p.wait_for_timeout(600)
                before=p.evaluate('({scroll:scrollY,focus:document.activeElement.id,tab:state.activeTab})')
                p.evaluate('''()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));
                  for(const type of ['VKWebAppViewHide','VKWebAppViewRestore','VKWebAppUpdateConfig'])
                    window.dispatchEvent(new CustomEvent('VKWebAppEvent',{detail:{type,data:{scheme:'bright_light'}}}));
                }''')
                p.evaluate('qaShareReject({error_type:"client_error",error_data:{error_code:4}})' if outcome=='cancel' else 'qaShareResolve({type:"message",users:[{id:1}]})')
                p.wait_for_timeout(150)
                p.evaluate('window.dispatchEvent(new Event("focus"));document.dispatchEvent(new Event("visibilitychange"))')
                p.wait_for_timeout(150)
                check(lang+' public '+outcome+' unchanged profile node',p.evaluate('qaPublicNode===document.querySelector("#publicStats")'),True)
                check(lang+' public '+outcome+' stable focus/scroll',p.evaluate('({scroll:scrollY,focus:document.activeElement.id,tab:state.activeTab})'),before)
                check(lang+' public '+outcome+' no hiding/navigation/refresh',p.evaluate('({loads:qaLoads,changes:qaShellChanges,readonly:state.publicReadOnly})'),{'loads':0,'changes':[],'readonly':True})
                check(lang+' public '+outcome+' no manual field',p.locator('#shareFallback').is_visible(),False)
                check(lang+' public '+outcome+' exact share/status',p.evaluate('({calls:qaCalls,status:document.querySelector("#statusRegion").textContent})'),{'calls':['VKWebAppShare'],'status':p.evaluate('L("shareCancelled")' if outcome=='cancel' else 'L("shareCompleted")')})
                p.evaluate('qaShellObserver.disconnect()');p.wait_for_timeout(1100)
        check('pageerrors',report['pageerrors'],[])
        check('only known blocked SDK request', sorted(set(report['external_requests_blocked'])), ['https://telegram.org/js/telegram-web-app.js'])
    finally:
        ctx.unroute_all(behavior='ignoreErrors');ctx.close();browser.close()
out=Path(os.environ['VK_RETURN_QA_OUT']);out.parent.mkdir(parents=True,exist_ok=True)
out.write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({'cases':len(report['cases']),'failures':report['failures'],'artifact':str(out)},ensure_ascii=False))
assert not report['failures'], report['failures']
