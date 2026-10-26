import json, os, sqlite3, subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
HERE=Path(os.environ.get('REPORTS8_AUDIT',str(ROOT/'audits/reports8-20261026')))/'parent-copy'; HERE.mkdir(parents=True,exist_ok=True)
MODE=sys.argv[1] if len(sys.argv)>1 else 'green'; root=Path(os.environ.get('REPORTS8_SOURCE',str(ROOT))); base='http://127.0.0.1:32773'; db=HERE/(MODE+'.sqlite')
for suffix in ['', '-wal','-shm']:Path(str(db)+suffix).unlink(missing_ok=True)
(HERE/'block-outbound.cjs').write_text("require('dotenv').config=()=>({});global.fetch=()=>Promise.reject(Error('QA outbound blocked'));for(const n of ['http','https']){const m=require(n);m.request=m.get=()=>{throw Error('QA outbound blocked')}};")
env={'PATH':os.environ['PATH'],'HOME':str(Path.home()),'NODE_ENV':'test','PORT':'32773','DB_PATH':str(db),'DEV_AUTH_ENABLED':'true','SCHEDULER_ENABLED':'false','SESSION_SECRET':'copy-slice-local-only','BOT_TOKEN':'','VK_SECURE_KEY':'','APP_BASE_URL':base,'WEBAPP_URL':base,'GEO_COUNTRY_DB_PATH':str(HERE/'absent.mmdb'),'NODE_OPTIONS':'--require='+str(HERE/'block-outbound.cjs')}
results=[]
with (HERE/(MODE+'-server.log')).open('w') as log:
 proc=subprocess.Popen(['node',str(root/'src/server.js')],cwd=root,env=env,stdout=log,stderr=log)
 try:
  for _ in range(150):
   try: urllib.request.urlopen(base+'/health',timeout=1).close();break
   except Exception:
    if proc.poll() is not None:raise RuntimeError('server died')
    time.sleep(.2)
  with sync_playwright() as pw:
   browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-background-networking'])
   try:
    for width in [390,1280]:
     ctx=browser.new_context(viewport={'width':width,'height':900},service_workers='block')
     ctx.route('**/*',lambda r:r.continue_() if r.request.url.startswith(base+'/') else r.abort())
     try:
      auth=ctx.request.post(base+'/api/auth/dev',data={'firstName':'Copy fixture','locale':'ru','timezone':'UTC'}).json();token=auth['token'];uid=auth['user']['id'];headers={'Authorization':'Bearer '+token}
      with sqlite3.connect(db) as c:c.execute('UPDATE users SET is_demo=0 WHERE id=?',(uid,))
      assert ctx.request.post(base+'/api/entries',headers=headers,data={'type':'sleep','note':'PRIVATE-COPY-SLICE-NOTE'}).ok
      ctx.add_init_script('localStorage.setItem("kopilkaToken",'+json.dumps(token)+');localStorage.setItem("kopilkaLocale","ru")')
      p=ctx.new_page();errors=[];p.on('pageerror',lambda e:errors.append(str(e)))
      p.goto(base);p.wait_for_function('state.user && state.profile && !state.busy')
      before=ctx.request.get(base+'/api/profile',headers=headers).json()['profile']
      failures=[]; snapshots=[]
      for lang in ['ru','en','ru']:
       p.locator('#tab-button-settings').click();p.locator('#lang-'+lang).click();p.wait_for_function('!state.busy && locale() === '+json.dumps(lang))
       footer=p.locator('.legal-links a');labels=footer.all_text_contents();hrefs=[footer.nth(i).get_attribute('href') for i in range(footer.count())]
       expected=['О сервисе','Партнёрам','Политика конфиденциальности','Условия использования','Сообщить о проблеме'] if lang=='ru' else ['About','Partnerships','Privacy policy','Terms of use','Report a problem']
       if labels!=expected:failures.append({'lang':lang,'actual':labels,'expected':expected})
       assert hrefs[:2]==['/about','/partners'];assert hrefs[-1]=='https://vk.ru/life_harbor_game'
       assert footer.nth(4).get_attribute('target')=='_blank';assert footer.nth(4).get_attribute('rel')=='noopener'
       # Follow actual anchors using keyboard, then return to settings.
       for i,path in [(0,'/about'),(1,'/partners')]:
        footer.nth(i).focus();p.keyboard.press('Enter')
        if i==0:
         dialog=p.get_by_role('dialog');dialog.locator('h1').wait_for();assert p.url==base+'/';dialog.get_by_role('button',name='Return to the app' if lang=='en' else 'Вернуться в приложение').click();assert not dialog.is_visible()
        else:
         p.wait_for_url(base+path);assert p.locator('h1').is_visible();p.go_back();p.wait_for_function('state.user && state.profile && !state.busy')
        p.locator('#tab-button-settings').click();footer=p.locator('.legal-links a')
       p.locator('#tab-button-profile').click();notice=p.locator('#referralPrivacyNotice').inner_text()
       if lang=='ru' and 'твой публичный профиль' not in notice:failures.append({'lang':lang,'notice':notice})
       assert ('Личные заметки не показываются.' if lang=='ru' else 'Private notes are not shown.') in notice
       assert p.locator('#copyRefLink').get_attribute('aria-describedby')=='referralPrivacyNotice';assert p.locator('#shareRefLink').get_attribute('aria-describedby')=='referralPrivacyNotice'
       p.evaluate('''() => {window.qaCopies=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async v=>qaCopies.push(v)}})}''')
       link=p.locator('#refLink').input_value();assert link==before['profileLink'];p.locator('#copyRefLink').click();p.wait_for_function('qaCopies.length===1');assert p.evaluate('qaCopies[0]')==link
       snapshots.append({'locale':lang,'labels':labels,'hrefs':hrefs,'privacyNotice':notice})
      after=ctx.request.get(base+'/api/profile',headers=headers).json()['profile']
      for k in ['refCode','refLink','profileLink','botLink','vkRefLink']:assert before.get(k)==after.get(k),k
      public=ctx.request.get(base+'/api/public/'+before['refCode']);assert public.ok;assert 'PRIVATE-COPY-SLICE-NOTE' not in public.text()
      with sqlite3.connect(db) as c:assert c.execute('SELECT note FROM entries WHERE user_id=?',(uid,)).fetchone()[0]=='PRIVATE-COPY-SLICE-NOTE'
      assert not errors,errors
      results.append({'width':width,'snapshots':snapshots,'failures':failures,'profileURLsPreserved':True,'publicPrivateNoteAbsent':True})
     finally:ctx.close()
   finally:browser.close()
 finally:
  proc.terminate()
  try:proc.wait(timeout=10)
  except subprocess.TimeoutExpired:proc.kill();proc.wait()
(HERE/(MODE+'-connected.json')).write_text(json.dumps(results,ensure_ascii=False,indent=2))
print(json.dumps(results,ensure_ascii=False))
assert len(results)==2
assert not any(r['failures'] for r in results),'copy contracts failed'
print('COPY_CONNECTED_PASS: mobile+desktop RU->EN->RU, real navigation and copy, profile/API/SQLite privacy')
