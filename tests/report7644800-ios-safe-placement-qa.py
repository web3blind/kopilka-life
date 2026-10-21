#!/usr/bin/env python3
"""Report7644800: isolated HTTP/SQLite + CDP geometry, not native VK acceptance.
SOURCE_PUBLIC optionally selects exact preimage/candidate assets. Only own contexts
and child server are closed. All outbound browser AND Node requests are blocked.
"""
import base64, hashlib, hmac, itertools, json, os, socket, sqlite3, subprocess, tempfile, time, urllib.parse, urllib.request
from pathlib import Path
import asyncio, threading
from contextlib import contextmanager
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from playwright.sync_api import sync_playwright

@contextmanager
def filtered_cdp(endpoint):
    """Client-local CDP filter avoids Playwright attaching foreign worker contexts.
    Does not close, detach, inspect or modify any existing page/worker.
    """
    remote=json.load(urllib.request.urlopen(endpoint+'/json/version'))['webSocketDebuggerUrl']
    ready=threading.Event(); stop=threading.Event(); address=[]
    async def proxy(client):
        async with connect(remote,max_size=None) as upstream:
            async def forward():
                async for raw in client:
                    msg=json.loads(raw)
                    if msg.get('method')=='Target.setAutoAttach':
                        msg['params']['filter']=[{'type':'service_worker','exclude':True},{'type':'shared_worker','exclude':True}]+msg['params'].get('filter',[{'type':'tab','exclude':True},{}])
                    await upstream.send(json.dumps(msg))
            async def backward():
                async for raw in upstream: await client.send(raw)
            tasks=[asyncio.create_task(forward()),asyncio.create_task(backward())]
            try: await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
            finally:
                for t in tasks:t.cancel()
    async def run():
        async with serve(proxy,'127.0.0.1',0,max_size=None) as server:
            address.append('ws://127.0.0.1:'+str(next(iter(server.sockets)).getsockname()[1]));ready.set()
            while not stop.is_set():await asyncio.sleep(.05)
    thread=threading.Thread(target=lambda:asyncio.run(run()),daemon=True);thread.start()
    assert ready.wait(10),'CDP proxy start timeout'
    try:yield address[0]
    finally:stop.set();thread.join(10);assert not thread.is_alive()

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('REPORT7644800_OUT') or tempfile.mkdtemp(prefix='report7644800-green-'))
OUT.mkdir(parents=True, exist_ok=True)
PUBLIC = Path(os.environ.get('SOURCE_PUBLIC', str(ROOT/'public')))
BASE = ''
KEY = 'report7644800-local-only'
results = []

def signed(platform, uid):
    v = dict(vk_app_id='54723764', vk_user_id=str(uid), vk_platform=platform, vk_ts=str(int(time.time())))
    v['sign'] = base64.urlsafe_b64encode(hmac.new(KEY.encode(), urllib.parse.urlencode(sorted(v.items())).encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return urllib.parse.urlencode(v)

def geometry(page, floor):
    d = page.evaluate('''() => {const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
      const e=document.querySelector('#dismissStatus'), n=document.querySelector('#statusNotice')||document.querySelector('#statusRegion');
      const r=e&&!e.hidden?rect(e):null;return {notice:rect(n),button:r,header:rect(document.querySelector('.top-card')),
      hit:r?document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e:true,
      viewport:[innerWidth,innerHeight],live:document.querySelector('#statusRegion').getAttribute('role')}}''')
    assert d['notice']['y'] >= floor-.5, ('notice native overlap', floor, d)
    assert d['header']['y'] >= floor-.5, ('header native overlap', floor, d)
    assert d['live']=='status', d
    if d['button']:
        r=d['button']; assert r['y']>=floor-.5 and r['bottom']<=d['viewport'][1] and r['x']>=0 and r['right']<=d['viewport'][0], d
        assert d['hit'], ('dismiss center obstructed', d)
        assert r['height']>=40, ('dismiss touch height',d)
    return d

with socket.socket() as s:
    s.bind(('127.0.0.1',0)); port=s.getsockname()[1]
BASE=f'http://127.0.0.1:{port}'
with tempfile.TemporaryDirectory(prefix='report7644800-',dir=OUT) as tmp:
    qa=Path(tmp)
    (qa/'public').symlink_to(PUBLIC, target_is_directory=True)
    (qa/'migrations').symlink_to(ROOT/'migrations', target_is_directory=True)
    # Disable any accidental future provider request at the Node network boundary.
    (qa/'outbound.cjs').write_text("const deny=()=>{throw new Error('QA outbound blocked')};global.fetch=deny;for(const n of ['http','https']){const m=require(n);m.request=deny;m.get=deny;}")
    env=dict(PATH=os.environ['PATH'],HOME=tmp,NODE_ENV='test',PORT=str(port),DB_PATH=str(qa/'qa.sqlite'),SCHEDULER_ENABLED='false',DEV_AUTH_ENABLED='true',BOT_TOKEN='fixture-bot',VK_GROUP_TOKEN='',VK_APP_ID='54723764',VK_SECURE_KEY=KEY,SESSION_SECRET='report7644800-fixture',APP_BASE_URL=BASE,WEBAPP_URL=BASE,RATE_LIMIT_API_MAX='10000',RATE_LIMIT_AUTH_MAX='1000',NODE_OPTIONS='--require='+str(qa/'outbound.cjs'))
    with (OUT/'server.log').open('w') as log:
        proc=subprocess.Popen(['node',str(ROOT/'src/server.js')],cwd=qa,env=env,stdout=log,stderr=log)
        try:
            for _ in range(200):
                try: urllib.request.urlopen(BASE+'/health',timeout=1).close();break
                except Exception:
                    if proc.poll() is not None: raise RuntimeError('server exited: '+(OUT/'server.log').read_text())
                    time.sleep(.1)
            else: raise RuntimeError('health timeout')
            with filtered_cdp(os.environ.get('KOPILKA_QA_CDP_URL','http://127.0.0.1:18800')) as endpoint, sync_playwright() as pw:
                browser=pw.chromium.connect_over_cdp(endpoint)
                # iPhone11 CSS dimensions and physical safe areas, plus non-VK controls.
                cases=list(itertools.product(['mobile_iphone','mobile_web','mobile_android','website','telegram'], ['ru','en'], [1,2], ['portrait','landscape']))
                assert len(cases)==40
                selected=os.environ.get('REPORT7644800_PLATFORMS','').split(',')
                if selected!=['']:cases=[case for case in cases if case[0] in selected]
                assert cases,'empty platform selection'
                for i,(platform,lang,scale,orientation) in enumerate(cases):
                    name=f'{platform}-{lang}-{scale*100}-{orientation}'
                    context=browser.new_context(viewport={'width':414 if orientation=='portrait' else 896,'height':896 if orientation=='portrait' else 414},is_mobile=True,has_touch=True,service_workers='block',user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148')
                    errors=[]; blocked=[]
                    try:
                        context.route('**/*',lambda r:r.continue_() if r.request.url.startswith(BASE+'/') else (blocked.append(r.request.url),r.abort())[1])
                        page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
                        cdp=context.new_cdp_session(page)
                        safe=44 if orientation=='portrait' else 0
                        cdp.send('Emulation.setSafeAreaInsetsOverride',{'insets':dict(top=safe,bottom=34 if orientation=='portrait' else 21,left=0 if orientation=='portrait' else 44,right=0 if orientation=='portrait' else 44)})
                        launch=signed(platform,81997644800+i)
                        # Actual signed VK auth; controls use actual dev-auth only in this temporary test DB.
                        auth=context.request.post(BASE+'/api/auth/vk',data={'launchParams':launch}).json()
                        assert auth.get('token'),auth
                        assert context.request.post(BASE+'/api/settings/locale',headers={'Authorization':'Bearer '+auth['token']},data={'locale':lang}).ok
                        if platform in ['website','telegram']:
                            context.add_init_script('localStorage.setItem("kopilkaToken",'+json.dumps(auth['token'])+');')
                        if platform=='telegram':
                            tg=dict(auth_date=str(int(time.time())),user=json.dumps(dict(id=81997644800+i,first_name='QA'),separators=(',',':')))
                            secret=hmac.new(b'WebAppData',b'fixture-bot',hashlib.sha256).digest()
                            tg['hash']=hmac.new(secret,'\n'.join(k+'='+tg[k] for k in sorted(tg)).encode(),hashlib.sha256).hexdigest()
                            tg_auth=context.request.post(BASE+'/api/auth/telegram',data={'initData':urllib.parse.urlencode(tg)}).json()
                            assert tg_auth.get('token'),tg_auth
                            assert context.request.post(BASE+'/api/settings/locale',headers={'Authorization':'Bearer '+tg_auth['token']},data={'locale':lang}).ok
                            context.add_init_script('window.Telegram={WebApp:{initData:'+json.dumps(urllib.parse.urlencode(tg))+',initDataUnsafe:{},ready(){},expand(){}}};')
                        page.goto(BASE+'/?'+launch if platform.startswith('mobile_') else BASE+'/')
                        page.wait_for_function('state.user && !state.busy',timeout=25000)
                        with sqlite3.connect(qa/'qa.sqlite') as db:
                            assert db.execute('select count(*) from users where vk_id=?',(str(81997644800+i),)).fetchone()[0]==1
                        page.evaluate('(scale)=>{document.documentElement.style.fontSize=scale*100+"%";setStatus("");readyNoticeDismissed=false;setStatus(L("ready"),"info","ready")}',scale)
                        floor=(max(96,safe+64) if platform in ['mobile_iphone','mobile_web'] else 64 if platform=='mobile_android' else safe+8*scale)
                        # Non-VK header has only device safe-area, not the notification's .5rem gap.
                        notice_floor=floor
                        if platform not in ['mobile_iphone','mobile_web','mobile_android']:
                            floor=safe
                        d=geometry(page,floor)
                        assert d['notice']['y']>=notice_floor-.5,d
                        if platform in ['website','telegram']: assert d['notice']['y']<64 or scale==2,d
                        button=page.get_by_role('button',name='Закрыть уведомление' if lang=='ru' else 'Dismiss notification',exact=True)
                        assert button.is_visible(),page.locator('#dismissStatus').get_attribute('aria-label')
                        button.focus();page.keyboard.press('Enter');assert not page.locator('#statusRegion').inner_text()
                        assert page.evaluate('document.activeElement.id')=='tab-button-today'
                        page.evaluate('readyNoticeDismissed=false;setStatus(L("ready"),"info","ready")')
                        page.locator('#dismissStatus').tap();assert not page.locator('#statusRegion').inner_text()
                        samples=[d]
                        for category,kind in [('copy','info'),('entry-success','info'),('error','error')]:
                            page.evaluate('([category,kind])=>setStatus("QA "+category,kind,category)',[category,kind]);samples.append(geometry(page,floor))
                        # Cached HTML without wrapper: keep same native floor and live region.
                        page.evaluate('''()=>{const n=document.querySelector('#statusNotice'),r=document.querySelector('#statusRegion');n.replaceWith(r);setStatus('QA legacy error','error')}''')
                        samples.append(geometry(page,floor))
                        if platform in ['mobile_iphone','mobile_web']:
                            cdp.send('Emulation.setSafeAreaInsetsOverride',{'insets':{'top':0,'left':0,'right':0,'bottom':0}})
                            legacy=page.locator('#statusRegion').bounding_box()
                            assert legacy and legacy['y']>=96
                            samples.append({'zeroSafeAreaLegacy':legacy})
                        assert not errors,errors
                        results.append(dict(name=name,passed=True,geometry=samples,blocked=len(blocked)))
                    except Exception as e:
                        results.append(dict(name=name,passed=False,error=str(e)))
                    finally:
                        context.close()
                        (OUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
                        print(json.dumps({k:v for k,v in results[-1].items() if k!='geometry'},ensure_ascii=False),flush=True)
                assert len(results)==len(cases)
        finally:
            proc.terminate()
            try: proc.wait(timeout=10)
            except subprocess.TimeoutExpired:proc.kill();proc.wait()
            with socket.socket() as s: closed=s.connect_ex(('127.0.0.1',port))!=0
            (OUT/'cleanup.json').write_text(json.dumps(dict(server_stopped=proc.poll() is not None,port_closed=closed,port=port)))
            assert closed
failed=[r for r in results if not r['passed']]
print(json.dumps(dict(total=len(results),passed=len(results)-len(failed),failed=len(failed))))
assert not failed, f'{len(failed)} failed; see {OUT}/results.json'
