#!/usr/bin/env python3
"""Scoped connected geometry checks; native SDK mocked, real local auth/API/DB.
Plan: RED/GREEN canvas/header/checkbox/history resize, characterize Useful/criterion.
Only disposable SQLite and browser contexts; physical Android acceptance is separate.
"""
import base64, hashlib, hmac, io, json, os, socket, subprocess, tempfile, time, urllib.parse, urllib.request
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('KOPILKA_GEOMETRY_OUT', (tempfile.gettempdir() + '/kopilka-qa/kopilka-remaining-native-geometry')))
OUT.mkdir(parents=True, exist_ok=True)
PORT = int(os.environ.get('KOPILKA_GEOMETRY_PORT', '3276'))
BASE = f'http://127.0.0.1:{PORT}'
KEY = 'geometry-local-fixture'
RESULTS = []

def signed(uid):
    v = {'vk_app_id':'54723764', 'vk_user_id':str(uid), 'vk_platform':'mobile_android', 'vk_ts':str(int(time.time()))}
    v['sign'] = base64.urlsafe_b64encode(hmac.new(KEY.encode(), urllib.parse.urlencode(sorted(v.items())).encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return urllib.parse.urlencode(v)

def check(name, fn):
    try:
        fn()
        RESULTS.append({'name': name, 'pass': True})
    except Exception as e:
        RESULTS.append({'name': name, 'pass': False, 'error': str(e)})
    print(json.dumps(RESULTS[-1], ensure_ascii=False), flush=True)
    (OUT / 'results.json').write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))

def styles(locator):
    return locator.evaluate('''e=>{let s=getComputedStyle(e),r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,paddingTop:s.paddingTop,paddingBottom:s.paddingBottom,paddingLeft:s.paddingLeft,paddingRight:s.paddingRight,appearance:s.appearance,background:s.backgroundColor,resize:s.resize,maxHeight:s.maxHeight,overflowY:s.overflowY,filter:s.backdropFilter,outline:s.outlineStyle,outlineWidth:s.outlineWidth}}''')

with socket.socket() as sock:
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(('127.0.0.1', PORT))
with tempfile.TemporaryDirectory(prefix='geometry-', dir=OUT) as tmp:
    qa = Path(tmp)
    for name in ('public', 'migrations'):
        (qa / name).symlink_to(ROOT / name, target_is_directory=True)
    env = dict(PATH=os.environ['PATH'], HOME=tmp, NODE_ENV='test', PORT=str(PORT), DB_PATH=str(qa/'qa.sqlite'),
               SCHEDULER_ENABLED='false', DEV_AUTH_ENABLED='false', BOT_TOKEN='fixture-bot', VK_GROUP_TOKEN='',
               VK_APP_ID='54723764', VK_SECURE_KEY=KEY, SESSION_SECRET='geometry-session-fixture', APP_BASE_URL=BASE, WEBAPP_URL=BASE)
    with (OUT/'server.log').open('w') as log:
        proc = subprocess.Popen(['node', str(ROOT/'src/server.js')], cwd=qa, env=env, stdout=log, stderr=log)
        try:
            for _ in range(150):
                try:
                    urllib.request.urlopen(BASE+'/health', timeout=1).close(); break
                except Exception:
                    if proc.poll() is not None: raise RuntimeError('isolated server failed')
                    time.sleep(.1)
            with sync_playwright() as pw:
                b = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
                try:
                    for lang in ('ru','en'):
                        for width, scale in ((393,1),(320,1),(393,2),(320,2)):
                            case=f'{lang}-{width}-{scale*100}text'
                            c=b.new_context(viewport={'width':width,'height':852})
                            try:
                                c.route('**/*', lambda r:r.continue_() if r.request.url.startswith(BASE+'/') else r.abort())
                                c.route('**/vendor/vk-bridge*', lambda r:r.fulfill(status=200, content_type='application/javascript', body='window.vkBridge={send:()=>Promise.resolve({}),supports:()=>true,subscribe:()=>{}};'))
                                launch=signed(8199276000+(lang=='en')*100+width+scale)
                                auth=c.request.post(BASE+'/api/auth/vk',data={'launchParams':launch}).json()
                                headers={'Authorization':'Bearer '+auth['token']}
                                if lang=='en': assert c.request.post(BASE+'/api/settings/locale',headers=headers,data={'locale':'en'}).ok
                                response=c.request.post(BASE+'/api/entries',headers=headers,data={'type':'joy','note':'geometry fixture'})
                                assert response.ok or response.status==409, response.text()
                                p=c.new_page(); errors=[];p.on('pageerror',lambda e:errors.append(str(e)))
                                p.goto(BASE+'/?'+launch);p.wait_for_function('state.user&&state.history&&!state.busy')
                                p.evaluate("setStatus(''); document.documentElement.style.fontSize='"+str(scale*100)+"%'")
                                def canvas():
                                    samples=[]
                                    for tab in ('today','week','contract','settings','support','profile'):
                                        p.locator('#tab-button-'+tab).click();p.evaluate('scrollTo(0,0)')
                                        p.wait_for_timeout(80)
                                        # Isolate canvas paint from intentional card/drop-shadow surfaces;
                                        # visibility retains the actual short/long tab document geometry.
                                        p.locator('#appShell').evaluate('e=>e.style.visibility="hidden"')
                                        image=Image.open(io.BytesIO(p.screenshot()))
                                        samples.append((tab,[image.getpixel((0,y))[:3] for y in (0,100,400,700)]))
                                        p.evaluate('scrollTo(0,document.body.scrollHeight)');p.wait_for_timeout(80)
                                        image=Image.open(io.BytesIO(p.screenshot()))
                                        assert samples[-1][1]==[image.getpixel((0,y))[:3] for y in (0,100,400,700)], ('scroll-dependent canvas',tab,samples[-1])
                                        p.locator('#appShell').evaluate('e=>e.style.visibility=""')
                                    assert all(s[1]==samples[0][1] for s in samples), ('tab-dependent canvas',samples)
                                    p.evaluate('scrollTo(0,0)')
                                    assert p.evaluate('document.body.getBoundingClientRect().top')==0,'collapsed top margin leaves a band'
                                check('canvas-'+case,canvas)
                                def header():
                                    p.evaluate('scrollTo(0,0)')
                                    s=styles(p.locator('.top-card'))
                                    image=Image.open(io.BytesIO(p.screenshot()))
                                    rgb=image.getpixel((int(s['x']+s['width']/2),int(s['y']+6)))[:3]
                                    assert min(rgb)>200, ('header is dark',rgb)
                                    assert s['y']>=64, ('header overlaps reserved native chrome',s)
                                    title=p.locator('.top-card [data-i18n="appName"]')
                                    status=p.locator('#connectionStatus')
                                    assert float(title.evaluate('e=>getComputedStyle(e).fontSize').replace('px',''))>float(status.evaluate('e=>getComputedStyle(e).fontSize').replace('px','')), 'connection text dominates title'
                                    assert p.locator('.top-card').get_attribute('aria-label')==('Копилка жизни' if lang=='ru' else 'Life Harbor')
                                check('light-header-'+case,header)
                                def checkbox():
                                    p.locator('#tab-button-settings').click()
                                    field=p.locator('.checkbox-label input[type=checkbox]').first
                                    s=styles(field)
                                    assert all(float(s[k].replace('px',''))==0 for k in ('paddingTop','paddingBottom','paddingLeft','paddingRight')),s
                                    assert s['appearance']=='auto',s
                                    assert field.evaluate('e=>getComputedStyle(e).boxShadow')=='none', 'text-input inset shadow affects native checkbox stroke'
                                    assert field.evaluate('e=>e.labels.length>0')
                                    before=field.is_checked();field.focus();field.press('Space');assert field.is_checked()!=before
                                    assert styles(field)['outline']=='solid' and float(styles(field)['outlineWidth'].replace('px',''))>=3
                                    p.screenshot(path=str(OUT/('checkbox-'+case+'.png')))
                                    field.press('Space');assert field.is_checked()==before
                                check('checkbox-'+case,checkbox)
                                def labels_padding():
                                    p.locator('#tab-button-support').click()
                                    label=p.locator('#tab-button-support .tab-label'); ls=styles(label);bs=styles(p.locator('#tab-button-support'))
                                    assert abs((ls['x']-bs['x'])-(bs['x']+bs['width']-ls['x']-ls['width']))<1,('Useful label gutters',ls,bs)
                                    heading=p.locator('#tab-support h1'); hs=styles(heading);ps=styles(p.locator('#tab-support'))
                                    assert abs((hs['x']-ps['x'])-(ps['x']+ps['width']-hs['x']-hs['width']))<1,('Useful heading gutters',hs,ps)
                                    assert heading.inner_text()==('Полезное рядом' if lang=='ru' else 'Useful nearby')
                                    p.locator('#tab-button-contract').click(); field=p.locator('#contractTarget');s=styles(field)
                                    assert s['paddingTop']==s['paddingBottom'],s
                                    assert field.evaluate('e=>e.labels.length===1 && !!e.placeholder')
                                    field.focus();field.press('Tab');assert not field.evaluate('e=>document.activeElement===e')
                                    assert p.evaluate('document.documentElement.scrollWidth<=innerWidth'), 'horizontal overflow'
                                check('labels-padding-'+case,labels_padding)
                                def history():
                                    p.locator('#tab-button-week').click();p.locator('[data-history-edit]').first.click()
                                    field=p.locator('[data-history-edit-form] textarea');field.fill('Resize draft: unchanged');field.focus()
                                    s=styles(field)
                                    assert s['resize']=='vertical' and s['maxHeight']!='none' and s['overflowY']=='auto',('unbounded editor',s)
                                    assert styles(p.locator('#tab-week'))['filter']=='none','blurred resizing ancestor'
                                    assert field.evaluate('e=>e.labels.length===1')
                                    field.scroll_into_view_if_needed()
                                    # Real Chromium grip drag, followed by an oversized CSS height to
                                    # exercise clamp at values a pointer cannot fit in the viewport.
                                    rect=field.bounding_box();p.mouse.move(rect['x']+rect['width']-3,rect['y']+rect['height']-3)
                                    p.mouse.down();p.mouse.move(rect['x']+rect['width']-3,rect['y']+rect['height']+80,steps=12);p.mouse.up()
                                    for height in (120,9000,160,7000,120):
                                        field.evaluate('(e,h)=>e.style.height=h+"px"',height)
                                        field.scroll_into_view_if_needed();p.wait_for_timeout(30)
                                        s=styles(field);assert s['height']<=max(852/2,5.2*16*scale)+1,s
                                        assert field.input_value()=='Resize draft: unchanged'
                                        assert field.evaluate('e=>document.activeElement===e')
                                        assert p.locator('[data-history-edit-form] button[type=submit]').is_visible()
                                        image=Image.open(io.BytesIO(p.screenshot()))
                                        box=field.bounding_box();x=int(box['x']+10);y=int(box['y']+box['height']/2)
                                        # Sample empty padding, not centered text (which wraps at 200%).
                                        image.save(OUT/f'history-resize-{case}-{height}.png')
                                        assert min(image.getpixel((x,y))[:3])>180, ('editor blank/dark paint',case,height,image.getpixel((x,y)))
                                    field.press('Tab');assert p.locator('[data-history-edit-form] button[type=submit]').evaluate('e=>e===document.activeElement')
                                    p.screenshot(path=str(OUT/('history-'+case+'.png')))
                                check('history-resize-'+case,history)
                                check('console-'+case,lambda: (_ for _ in ()).throw(AssertionError(errors)) if errors else None)
                            finally:c.close()
                finally:b.close()
        finally:
            proc.terminate()
            try:proc.wait(timeout=10)
            except subprocess.TimeoutExpired:proc.kill();proc.wait()
            with socket.socket() as sock:closed=sock.connect_ex(('127.0.0.1',PORT))!=0
            (OUT/'cleanup.json').write_text(json.dumps({'pid':proc.pid,'alive':Path('/proc/'+str(proc.pid)).exists(),'portClosed':closed,'scheduler':False}))
assert RESULTS and all(r['pass'] for r in RESULTS), 'connected native geometry checks failed'
print('REMAINING_NATIVE_GEOMETRY_CONNECTED_PASS',len(RESULTS))
