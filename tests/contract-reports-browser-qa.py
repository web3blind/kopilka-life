#!/usr/bin/env python3
"""7654525/7654526: real local HTTP/SQLite and RU/EN UI, no native acceptance."""
import base64, hashlib, hmac, json, os, sqlite3, subprocess, tempfile, time, urllib.parse, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
PORT = int(os.environ.get('KOPILKA_QA_PORT', '3197'))
BASE = f'http://127.0.0.1:{PORT}'
# Same UTC instant is Thursday/Friday in different owner timezones.
CASES = [('2026-10-29T12:30:00Z','UTC',4,'2026-10-29','2026-10-26','2026-11-01'),
         ('2026-10-29T12:30:00Z','Pacific/Kiritimati',3,'2026-10-30','2026-10-26','2026-11-01'),
         ('2026-10-31T12:30:00Z','UTC',2,'2026-10-31','2026-10-26','2026-11-01'),
         ('2026-10-31T12:30:00Z','Pacific/Kiritimati',7,'2026-11-02','2026-11-02','2026-11-08'),
         ('2026-10-26T12:30:00Z','UTC',7,'2026-10-26','2026-10-26','2026-11-01')]
results=[]
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-background-networking'])
 try:
  for instant,zone,days,start,week_start,end in CASES:
   with tempfile.TemporaryDirectory(prefix='contract-reports-') as tmp:
    qa=Path(tmp)
    for name in ('public','migrations'): (qa/name).symlink_to(ROOT/name,target_is_directory=True)
    env=dict(PATH=os.environ['PATH'],HOME=tmp,NODE_ENV='test',PORT=str(PORT),DB_PATH=str(qa/'qa.sqlite'),SCHEDULER_ENABLED='false',DEV_AUTH_ENABLED='false',VK_APP_ID='54723764',VK_SECURE_KEY='contract-fixture-key',SESSION_SECRET='contract-fixture-session-key',APP_BASE_URL=BASE,WEBAPP_URL=BASE,RATE_LIMIT_API_MAX='10000',RATE_LIMIT_AUTH_MAX='10000')
    guard=qa/'server.cjs'
    guard.write_text("const RealDate=Date;const fixed="+json.dumps(instant)+";global.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[fixed]))}static now(){return new RealDate(fixed).getTime()}};const deny=()=>{throw Error('QA outbound prohibited')};global.fetch=deny;for(const n of ['http','https']){const m=require(n);m.request=m.get=deny;}const app=require("+json.dumps(str(ROOT/'src/server'))+").createApp();require("+json.dumps(str(ROOT/'src/db'))+").getDb().function('current_timestamp',()=>fixed.replace('T',' ').replace('Z',''));app.listen("+str(PORT)+",'127.0.0.1');")
    with (qa/'server.log').open('w+') as log:
     proc=subprocess.Popen(['node',str(guard)],cwd=qa,env=env,stdout=log,stderr=log)
     try:
      for _ in range(100):
       try: urllib.request.urlopen(BASE+'/health',timeout=.5).close();break
       except Exception:
        if proc.poll() is not None:
         log.seek(0);raise RuntimeError(log.read())
        time.sleep(.1)
      else: raise RuntimeError('server unavailable')
      for index,lang in enumerate(('ru','en')):
       ctx=browser.new_context(service_workers='block',viewport={'width':390,'height':844})
       def route(r):
        if not r.request.url.startswith(BASE+'/'):r.abort()
        elif '/vendor/vk-bridge' in r.request.url:r.fulfill(content_type='application/javascript',body='window.vkBridge={send(){return Promise.resolve({result:true})},subscribe(){},supports(){return true}}')
        else:r.continue_()
       ctx.route('**/*',route)
       try:
        from datetime import datetime
        params=dict(vk_app_id='54723764',vk_user_id=str(98970000+index),vk_ts=str(int(datetime.fromisoformat(instant.replace('Z','+00:00')).timestamp())))
        params['sign']=base64.urlsafe_b64encode(hmac.new(b'contract-fixture-key',urllib.parse.urlencode(sorted(params.items())).encode(),hashlib.sha256).digest()).decode().rstrip('=')
        launch=urllib.parse.urlencode(params)
        auth=ctx.request.post(BASE+'/api/auth/vk',data={'launchParams':launch,'locale':lang,'timezone':zone}).json()
        headers={'Authorization':'Bearer '+auth['token']}
        p=ctx.new_page();errors=[];p.on('pageerror',lambda e:errors.append(str(e)))
        p.goto(BASE+'/?'+launch);p.wait_for_function('state.user && state.product && !state.busy')
        p.locator('#tab-button-contract').click()
        assert p.evaluate('state.product.contractDays')==days
        if days<7:
         warning=p.locator('#contractDaysWarning');assert warning.is_visible()
         assert str(days) in warning.inner_text()
         assert ('невозможно' if lang=='ru' else 'cannot be completed') in warning.inner_text()
        else:assert p.locator('#contractDaysWarning').count()==0
        p.locator('[data-template-id="sleep-5-of-7"]').click()
        assert p.locator('#contractTitle').input_value()==('Сон 5 из 7' if lang=='ru' else 'Sleep 5 of 7')
        # Warning path deliberately leaves every template/custom target editable.
        p.locator('#contractTarget').fill('Three chosen evenings')
        for amount in ('','0','12.50'):
         if amount!='':
          p.locator('[data-close-status="cancelled"]').click();p.wait_for_function('!state.currentContract && !state.busy')
          p.locator('#contractTitle').fill('Custom goal');p.locator('#contractTarget').fill('Three chosen evenings')
         p.locator('#stakeAmount').fill(amount)
         p.locator('#contractForm button[type="submit"]').click()
         p.wait_for_function('state.currentContract && !state.busy')
         c=p.evaluate('state.currentContract')
         assert c['week_start']==week_start and c['week_end']==end and c['display_start']==start,c
         assert c['target_value']=='Three chosen evenings'
         card=p.locator('#contractCurrent')
         assert f'{start} — {end}' in card.inner_text()
         fund=card.locator('p').filter(has_text='Фонд заботы:' if lang=='ru' else 'Care fund:').inner_text()
         assert fund==(('Фонд заботы: не указан' if lang=='ru' else 'Care fund: not specified') if amount=='' else ('Фонд заботы: ' if lang=='ru' else 'Care fund: ')+amount+' RUB'),fund
         p.reload();p.wait_for_function('state.currentContract && state.product && !state.busy');p.locator('#tab-button-contract').click()
         assert card.locator('p').filter(has_text='Фонд заботы:' if lang=='ru' else 'Care fund:').inner_text()==fund
         assert f'{start} — {end}' in card.inner_text()
         with sqlite3.connect(f'file:{qa / "qa.sqlite"}?mode=ro',uri=True) as db:
          stored=db.execute('SELECT week_start,week_end,stake_amount,stake_currency,target_value FROM weekly_contracts WHERE id=?',(c['id'],)).fetchone()
          assert stored==(week_start,end,amount,'RUB','Three chosen evenings'),stored
        assert not errors,errors
        results.append({'instant':instant,'zone':zone,'locale':lang,'days':days,'amounts':['','0','12.50']})
       finally:ctx.close()
     finally:
      proc.terminate()
      try:proc.wait(timeout=10)
      except subprocess.TimeoutExpired:proc.kill();proc.wait()
 finally:browser.close()
print(json.dumps({'connected_cases':len(results),'results':results},ensure_ascii=False))
