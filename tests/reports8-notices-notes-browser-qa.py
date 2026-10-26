#!/usr/bin/env python3
"""Owned Chromium + exact captured backend + isolated SQLite. No live providers."""
import base64, hashlib, hmac, itertools, json, os, shutil, sqlite3, subprocess, sys, tempfile, time, urllib.parse, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]; HERE=Path(os.environ.get('REPORTS8_AUDIT',str(ROOT/'audits/reports8-20261026')))/'parent-notices'; HERE.mkdir(parents=True,exist_ok=True); BASE='http://127.0.0.1:32772'; MODE=sys.argv[1] if len(sys.argv)>1 else 'green'
SRC=Path(os.environ.get('REPORTS8_SOURCE',str(ROOT))); APP=Path(os.environ.get('REPORTS8_APP',str(SRC/'public/app.js')))
def signed(uid,host='desktop'):
 v=dict(vk_app_id='54723764',vk_user_id=str(uid),vk_platform='mobile_android' if host=='android' else 'desktop_web',vk_ts=str(int(time.time())))
 v['sign']=base64.urlsafe_b64encode(hmac.new(b'browser-qa-vk-secure-key',urllib.parse.urlencode(sorted(v.items())).encode(),hashlib.sha256).digest()).decode().rstrip('=');return urllib.parse.urlencode(v)
results=[]
with tempfile.TemporaryDirectory(prefix='notices-notes-',dir=os.environ['TMPDIR']) as tmp:
 work=Path(tmp); src=SRC
 for name in ['src','public','migrations']:shutil.copytree(src/name,work/name)
 (work/'node_modules').symlink_to(ROOT/'node_modules',target_is_directory=True)
 preload=work/'block.cjs';preload.write_text("require('dotenv').config=()=>({});global.fetch=()=>Promise.reject(Error('QA outbound blocked'));for(const n of ['http','https']){const m=require(n);m.request=m.get=()=>{throw Error('QA outbound blocked')}};")
 env=dict(os.environ,NODE_ENV='test',PORT='32772',DB_PATH=str(work/'qa.sqlite'),SCHEDULER_ENABLED='false',DEV_AUTH_ENABLED='true',BOT_TOKEN='test-bot-token',BOT_USERNAME='HarborLifeBot',SESSION_SECRET='browser-qa-session-secret',TELEGRAM_WEBHOOK_SECRET='browser_qa_webhook_secret_123456',VK_GROUP_TOKEN='',VK_GROUP_ID='240966481',VK_APP_ID='54723764',VK_SECURE_KEY='browser-qa-vk-secure-key',VK_OAUTH_CLIENT_ID='54723764',VK_OAUTH_CLIENT_SECRET='fixture-only',APP_BASE_URL=BASE,WEBAPP_URL=BASE,GEO_COUNTRY_DB_PATH=str(work/'absent.mmdb'),RESEND_API_KEY='',NODE_OPTIONS='--require='+str(preload))
 log=(HERE/f'server-{MODE}.log').open('w'); proc=subprocess.Popen(['node',str(work/'src/server.js')],cwd=work,env=env,stdout=log,stderr=log)
 try:
  for _ in range(100):
   try:urllib.request.urlopen(BASE+'/health',timeout=1).close();break
   except Exception:
    if proc.poll() is not None:raise RuntimeError('server exited; see log')
    time.sleep(.1)
  with sync_playwright() as pw:
   browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
   try:
    for case,(lang,host) in enumerate(itertools.product(['ru','en'],['desktop','android'])):
     checks=[];errors=[];traffic=[];bugs=[]
     context=browser.new_context(viewport={'width':393,'height':852} if host=='android' else {'width':1280,'height':900},is_mobile=host=='android',has_touch=host=='android',service_workers='block')
     def route(r):
      path=urllib.parse.urlparse(r.request.url).path
      if not r.request.url.startswith(BASE+'/'):r.abort()
      elif path.startswith('/vendor/vk-bridge'):r.fulfill(content_type='application/javascript',body='// isolated bridge installed by init script')
      elif path=='/app.js':r.fulfill(content_type='application/javascript',body=APP.read_text())
      elif path=='/' and os.environ.get('REPORTS8_SHELL'):r.fulfill(content_type='text/html',body=Path(os.environ['REPORTS8_SHELL']).read_text())
      elif path=='/i18n.js':r.fulfill(content_type='application/javascript',body=(SRC/'public/i18n.js').read_text())
      else:r.continue_()
     context.route('**/*',route)
     context.add_init_script("window.opened=[];window.open=(url)=>{opened.push(url);return {opener:null,focus(){}}};window.bridgeCalls=[];window.storyMode='cancel';window.vkBridge={supports:()=>true,subscribe:()=>{},send:async(m,p)=>{bridgeCalls.push({m,p});if(m==='VKWebAppShowStoryBox'){if(storyMode==='cancel')throw {error_data:{error_reason:'User denied'}};if(storyMode==='error')throw Error('fixture story error');return {result:true}}return {result:true}}};")
     q=signed(81997649697+case,host);auth=context.request.post(BASE+'/api/auth/vk',data={'launchParams':q}).json();headers={'Authorization':'Bearer '+auth['token']};uid=auth['user']['id']
     context.request.post(BASE+'/api/settings/locale',headers=headers,data={'locale':lang})
     p=context.new_page();p.on('pageerror',lambda e:errors.append(str(e)));context.on('request',lambda r:traffic.append((r.method,urllib.parse.urlparse(r.url).path)))
     def loaded():p.wait_for_function('Boolean(state.user && state.product && state.summary && !state.busy)');p.wait_for_load_state('networkidle')
     def text():return p.locator('#statusRegion').text_content()
     def click_story():
      p.locator('#tab-button-today').click();p.locator('#daySceneShare').click()
      try:p.wait_for_function('document.getElementById("statusRegion").textContent===L("daySceneStoryCanceled")',timeout=10000)
      except Exception:
       print(p.evaluate('({status:document.getElementById("statusRegion").textContent,bridge:bridgeCalls,vk:isVkMiniApp(),scene:Boolean(window.KopilkaDayScene),busy:state.busy,disabled:document.getElementById("daySceneShare").disabled,html:document.getElementById("daySceneShare").outerHTML,images:[...document.images].map(i=>({src:i.src,loaded:i.complete,w:i.naturalWidth})),resources:performance.getEntriesByType("resource").map(r=>r.name)})'),errors,flush=True);raise
     def dismiss():
      ready_before=p.evaluate('readyNoticeDismissed');p.locator('#dismissStatus').focus();p.keyboard.press('Enter');assert text()=='';assert p.evaluate('readyNoticeDismissed')==ready_before
     p.goto(BASE+'/?'+q);loaded();p.evaluate('setStatus("")');traffic.clear();click_story();saved=text()
     assert p.evaluate('bridgeCalls.some(c=>c.m==="VKWebAppShowStoryBox")')
     p.locator('#tab-button-week').click();p.wait_for_timeout(5300)
     if MODE=='red':bugs.append(text()==saved)
     else:assert text()==''
     checks.append('actual-day-scene-canvas-bridge-cancellation-tab-5s')
     click_story()
     if MODE=='green':
      dismiss();assert p.evaluate('document.activeElement.id')=='daySceneShare'
      click_story();p.evaluate('Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"))');p.wait_for_timeout(5300);p.evaluate('Object.defineProperty(document,"hidden",{configurable:true,value:false});document.dispatchEvent(new Event("visibilitychange"));window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}))');assert text()==''
      checks.append('explicit-story-dismiss-focus-and-synthetic-retained-DOM-expiry')
      p.evaluate('storyMode="error"');p.locator('#daySceneShare').click();p.wait_for_function('document.getElementById("statusRegion").classList.contains("error")');err=text();p.wait_for_timeout(5300);assert text()==err and p.locator('#dismissStatus').is_hidden();p.evaluate('storyMode="cancel"')
      checks.append('story-error-durable-not-published')
      p.evaluate('storyMode="opened"');p.locator('#daySceneShare').click();p.wait_for_function('document.getElementById("statusRegion").textContent===L("daySceneStoryOpened")');assert text()==p.evaluate('L("daySceneStoryOpened")');p.evaluate('storyMode="cancel"')
      click_story();stale=text();p.reload();loaded();assert text()!=stale
      checks.append('successful-editor-open-not-publication-and-full-reload-clears-cancellation')
     p.locator('#tab-button-support').click();p.wait_for_function('Boolean(state.support?.actions?.length)');action=p.evaluate('state.support.actions.find(a=>a.url && a.kind==="open_url")');assert action
     aid=action['id'];assert context.request.post(BASE+f'/api/support/actions/{aid}/open',headers=headers,data={'source':'vk'}).ok
     # Canonical read refresh makes this the reported repeat-open path, not first reward.
     p.evaluate('async()=>{await loadData();renderAll()}');p.wait_for_function('!state.busy');traffic.clear()
     button=p.locator(f'[data-support-open="{aid}"]');button.click();p.wait_for_function('!state.busy && document.getElementById("statusRegion").textContent===L("supportOpened")');saved=text();assert p.evaluate('(url)=>opened.includes(url)',action['url'])
     assert not [r for r in traffic if r[0]=='POST' and '/support/actions/' in r[1]],traffic
     p.locator('#tab-button-today').click();p.wait_for_timeout(5300)
     if MODE=='red':bugs.append(text()==saved)
     else:assert text()==''
     checks.append('actual-repeat-support-open-no-credit-post-tab-expiry')
     if MODE=='green':
      p.locator('#tab-button-support').click();button.click();p.wait_for_function('statusCategory==="link-opened" && !state.busy');dismiss();assert p.evaluate('document.activeElement.dataset.supportOpen')==str(aid)
     # All quick types except gratitude exhausted: note remains enabled until final real save.
     types=p.evaluate('I18N.entryTypes(locale()).map(t=>t.type)');assert 'gratitude' not in types
     for typ in types[:-1]:
      assert context.request.post(BASE+'/api/entries',headers=headers,data={'type':typ,'note':'fixture '+typ}).ok
     p.evaluate('async()=>{await loadData();renderAll()}');p.locator('#tab-button-today').click();assert p.locator('#entryNote').is_enabled() and p.locator('#gratitudeNote').is_enabled()
     p.locator('#entryNote').fill('actual quick\nlast note');p.locator(f'[data-entry-type="{types[-1]}"]').click();p.wait_for_function('!state.busy');p.wait_for_load_state('networkidle')
     if MODE=='green':assert p.locator('#entryNote').is_disabled() and p.locator('#gratitudeNote').is_enabled()
     assert p.locator('#entryNote').input_value()==''
     history=context.request.get(BASE+'/api/history?days=7',headers=headers).json();last=next(e for e in history['selectedEntries'] if e['type']==types[-1]);assert last['note']=='actual quick\nlast note'
     deleted=context.request.delete(BASE+'/api/entries/'+str(last['id']),headers=headers,data={'confirm':True});assert deleted.ok,(deleted.status,deleted.text(),last)
     p.evaluate('async()=>{await loadData();renderAll()}');p.locator('#entryNote').fill('preserved quick\ndraft')
     assert context.request.post(BASE+'/api/entries',headers=headers,data={'type':types[-1],'note':'fixture restored'}).ok
     p.evaluate('async()=>{await loadData();renderAll()}');assert p.locator('#gratitudeNote').is_enabled()
     p.locator('#gratitudeNote').fill('gratitude independent\nsecond line');p.locator('[data-gratitude-submit]').click();p.wait_for_function('!state.busy && state.summary.todayEntryTypes.includes("gratitude")');p.wait_for_load_state('networkidle')
     if MODE=='red':bugs.append(p.locator('#entryNote').is_enabled())
     else:assert p.locator('#entryNote').is_disabled() and p.locator('#entryNote').get_attribute('aria-disabled')=='true'
     assert p.locator('#gratitudeNote').is_disabled();assert p.locator('#entryNote').input_value()=='preserved quick\ndraft'
     with sqlite3.connect('file:'+str(work/'qa.sqlite')+'?mode=ro',uri=True) as db:
      rows=db.execute('SELECT type,note FROM entries WHERE user_id=?',(uid,)).fetchall();assert len(rows)==len(types)+1;assert dict(rows)['gratitude']=='gratitude independent\nsecond line';before=db.execute('SELECT COUNT(*) FROM entries WHERE user_id=?',(uid,)).fetchone()[0]
     checks.append('actual-gratitude-handler-last-type-disables-independent-note-after-busy-SQLite-proof')
     if MODE=='green':
      # A real timezone setting changes the authoritative user-local day, without touching entries.
      with sqlite3.connect('file:'+str(work/'qa.sqlite')+'?mode=ro',uri=True) as db:day=db.execute('SELECT entry_date FROM entries WHERE user_id=? LIMIT 1',(uid,)).fetchone()[0]
      original_zone=p.evaluate('state.user.timezone')
      for zone in ['Pacific/Kiritimati','Etc/GMT+12']:
       response=context.request.post(BASE+'/api/settings/reminders',headers=headers,data={'timezone':zone,'reminders_enabled':False});assert response.ok,response.text()
       summary=context.request.get(BASE+'/api/summary/today',headers=headers).json()
       if not summary['todayEntryTypes']:break
      else:raise AssertionError('timezone extremes did not cross fixture local date')
      traffic.clear();p.evaluate('async()=>{await loadData();renderAll()}');assert p.locator('#entryNote').is_enabled() and p.locator('#gratitudeNote').is_enabled();assert p.locator('#entryNote').input_value()=='preserved quick\ndraft'
      assert not [r for r in traffic if r[0] in ['POST','PATCH','DELETE']],traffic
      assert context.request.post(BASE+'/api/settings/reminders',headers=headers,data={'timezone':original_zone,'reminders_enabled':False}).ok
      p.evaluate('async()=>{await loadData();renderAll()}');assert p.locator('#entryNote').is_disabled() and p.locator('#gratitudeNote').is_disabled()
      checks.append('canonical-timezone-local-day-rollover-and-back-preserves-draft-no-entry-writes')
      # Delete a fixture entry with canonical API: authoritative daily availability changes without clearing draft.
      history=context.request.get(BASE+'/api/history?days=7',headers=headers).json();entry=next(e for e in history['selectedEntries'] if e['type']!='gratitude')
      assert context.request.delete(BASE+'/api/entries/'+str(entry['id']),headers=headers,data={'confirm':True}).ok
      p.evaluate('async()=>{await loadData();renderAll()}');assert p.locator('#entryNote').is_enabled();assert p.locator('#entryNote').input_value()=='preserved quick\ndraft';assert p.locator('#gratitudeNote').is_disabled()
      checks.append('canonical-delete-reenables-quick-note-with-draft-and-gratitude-still-used')
      p.reload();loaded();assert p.locator('#entryNote').is_enabled();assert p.locator('#gratitudeNote').is_disabled()
      p.goto(BASE+'/?'+signed(82997649697+case,host));loaded();new_uid=p.evaluate('state.user.id');assert new_uid!=uid;assert p.locator('#entryNote').is_enabled() and p.locator('#gratitudeNote').is_enabled()
      with sqlite3.connect('file:'+str(work/'qa.sqlite')+'?mode=ro',uri=True) as db:
       assert db.execute('SELECT COUNT(*) FROM entries WHERE user_id=?',(new_uid,)).fetchone()==(0,)
       assert db.execute('SELECT COUNT(*) FROM entries WHERE user_id=?',(uid,)).fetchone()==(before-1,)
       assert db.execute('SELECT COUNT(*) FROM reminders WHERE user_id=?',(uid,)).fetchone()==(0,)
      checks.append('fresh-signed-account-availability-zero-false-entry-writes-original-records-retained')
     if MODE=='red':assert all(bugs) and len(bugs)==3,bugs
     assert not errors,errors
     results.append({'locale':lang,'host':host,'mode':MODE,'checks':checks,'reproduced_original_bugs':bugs,'page_errors':errors,'app_sha256':hashlib.sha256(APP.read_bytes()).hexdigest()});print(json.dumps(results[-1]),flush=True);context.close()
   finally:browser.close()
 finally:
  proc.terminate();proc.wait(timeout=10);log.close();(HERE/f'browser-{MODE}.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
assert len(results)==4
