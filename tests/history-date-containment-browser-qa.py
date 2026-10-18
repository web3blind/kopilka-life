#!/usr/bin/env python3
"""7612024: real local app/date border containment, no providers or production.
Run: python3 tests/history-date-containment-browser-qa.py
Only owned browsers, port 3322, temporary SQLite, scheduler disabled.
Linux Playwright WebKit is not native Safari/iOS acceptance.
"""
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('KOPILKA_DATE_OUT', (tempfile.gettempdir() + '/kopilka-qa/kopilka-date-7612024')))
OUT.mkdir(parents=True, exist_ok=True)
BASE = 'http://127.0.0.1:3322'
RESULT = {'cases': [], 'engines': {}, 'blockedExternalRequests': [], 'nativeSafari': 'not tested'}
GEOMETRY = '''e=>{
 const rect=n=>{const r=n.getBoundingClientRect();const s=getComputedStyle(n);return {left:r.left,right:r.right,width:r.width,display:s.display,grid:s.gridTemplateColumns,minWidth:s.minWidth,maxWidth:s.maxWidth,boxSizing:s.boxSizing,overflow:s.overflow,paddingLeft:parseFloat(s.paddingLeft),paddingRight:parseFloat(s.paddingRight),borderLeft:parseFloat(s.borderLeftWidth),borderRight:parseFloat(s.borderRightWidth)}};
 const s=getComputedStyle(e);return {field:rect(e),card:rect(e.closest('.history-picker')),ancestors:[rect(e.parentElement),rect(e.parentElement.parentElement),rect(e.parentElement.parentElement.parentElement)],fontSize:s.fontSize,appearance:s.appearance,outline:s.outlineStyle,outlineWidth:s.outlineWidth,labels:[...e.labels].map(l=>l.textContent.trim()),type:e.type,value:e.value,hasPicker:typeof e.showPicker==='function',viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth};
}'''

with socket.socket() as sock:
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(('127.0.0.1', 3322))
with tempfile.TemporaryDirectory(prefix='date-qa-', dir=OUT) as tmp:
    qa = Path(tmp)
    for name in ('public', 'migrations'):
        (qa/name).symlink_to(ROOT/name, target_is_directory=True)
    env = dict(PATH=os.environ['PATH'], HOME=tmp, NODE_ENV='test', PORT='3322',
               DB_PATH=str(qa/'qa.sqlite'), SCHEDULER_ENABLED='false', DEV_AUTH_ENABLED='true',
               BOT_TOKEN='fixture-not-provider', VK_GROUP_TOKEN='', VK_SECURE_KEY='',
               SESSION_SECRET='date-containment-local-only', APP_BASE_URL=BASE, WEBAPP_URL=BASE,
               RESEND_API_KEY='', GOOGLE_CLIENT_ID='', GOOGLE_CLIENT_SECRET='')
    with (OUT/'date-server.log').open('w') as log:
        proc = subprocess.Popen(['node', str(ROOT/'src/server.js')], cwd=qa, env=env, stdout=log, stderr=log)
        try:
            for _ in range(150):
                try:
                    urllib.request.urlopen(BASE+'/health', timeout=1).close()
                    break
                except Exception:
                    if proc.poll() is not None:
                        raise RuntimeError('isolated server failed; see date-server.log')
                    time.sleep(.1)
            else:
                raise RuntimeError('isolated server health timeout')
            with sync_playwright() as pw:
                for engine in ('chromium', 'webkit'):
                    try:
                        launch_options = {'executable_path':'/usr/bin/chromium','args':['--no-sandbox']} if engine=='chromium' else {}
                        if engine=='webkit' and os.environ.get('KOPILKA_WEBKIT_EXECUTABLE'):
                            launch_options['executable_path']=os.environ['KOPILKA_WEBKIT_EXECUTABLE']
                        browser = getattr(pw,engine).launch(**launch_options)
                    except Exception as exc:
                        RESULT['engines'][engine] = {'status':'unavailable','error':str(exc)}
                        print(engine.upper()+'_UNAVAILABLE', str(exc), flush=True)
                        if engine=='chromium':
                            raise
                        continue
                    RESULT['engines'][engine] = {'status':'tested','version':browser.version}
                    try:
                        for lang in ('ru','en'):
                            for width in (320,393,430,768):
                                for scale in (1,2):
                                    case = f'{engine}-{lang}-{width}-{scale*100}text'
                                    context = browser.new_context(viewport={'width':width,'height':1000}, locale=lang, is_mobile=width<500, has_touch=width<500)
                                    try:
                                        def route(r):
                                            if r.request.url.startswith(BASE+'/'):
                                                r.continue_()
                                            else:
                                                RESULT['blockedExternalRequests'].append(r.request.url)
                                                r.abort()
                                        context.route('**/*',route)
                                        auth = context.request.post(BASE+'/api/auth/dev', data={'firstName':'Date QA','locale':lang,'timezone':'UTC'})
                                        assert auth.ok, auth.text()
                                        token=auth.json()['token']
                                        page=context.new_page()
                                        page.add_init_script('localStorage.setItem("kopilkaToken", '+json.dumps(token)+');')
                                        errors=[]
                                        page.on('pageerror',lambda e:errors.append(str(e)))
                                        page.goto(BASE)
                                        page.wait_for_function('state.history && state.summary && !state.busy')
                                        css=context.request.get(BASE+'/styles.css')
                                        assert css.ok and css.text()==(ROOT/'public/styles.css').read_text()
                                        page.locator('#tab-button-week').click()
                                        page.evaluate("setStatus('');document.documentElement.style.fontSize='"+str(100*scale)+"%';document.body.style.fontSize='"+str(15.5*scale if width<=560 else 16*scale)+"px'")
                                        field=page.locator('#historyDate')
                                        field.scroll_into_view_if_needed()
                                        before=field.evaluate(GEOMETRY)
                                        assert before['type']=='date' and before['labels']==[('Дата' if lang=='ru' else 'Date')], before
                                        assert abs(float(before['fontSize'][:-2])-(15.5*scale if width<=560 else 16*scale))<.1, before
                                        for value in ('2024-10-08','2000-01-01','2026-10-08'):
                                            field.fill(value)
                                            field.dispatch_event('change')
                                            page.wait_for_function('(v)=>state.historyDate===v && !state.busy',arg=value)
                                            assert field.input_value()==value
                                        # Keyboard focus, existing outline, and next control are retained.
                                        page.locator('label[for=historyDate]').click()
                                        assert field.evaluate('e=>e===document.activeElement')
                                        page.keyboard.press('Escape')
                                        # Native date segments may consume multiple Tab steps.
                                        traversal=[]
                                        for _ in range(8):
                                            page.keyboard.press('Tab')
                                            traversal.append(page.evaluate('document.activeElement.id'))
                                            if page.locator('#historyPrevious').evaluate('e=>e===document.activeElement'):
                                                break
                                        else:
                                            raise AssertionError(('date keyboard traversal did not reach Previous',traversal,page.locator('.history-nav').inner_text(),page.locator('#historyPrevious').is_disabled()))
                                        page.keyboard.press('Shift+Tab')
                                        page.keyboard.press('Escape')
                                        field.focus()
                                        geom=field.evaluate(GEOMETRY)
                                        assert geom['outline']=='solid' and float(geom['outlineWidth'][:-2])>=3, geom
                                        f,c=geom['field'],geom['card']
                                        content_left=c['left']+c['borderLeft']+c['paddingLeft']
                                        content_right=c['right']-c['borderRight']-c['paddingRight']
                                        assert f['left']>=content_left-.5 and f['right']<=content_right+.5, geom
                                        assert f['right']+6<=c['right'] and f['left']-6>=c['left'], ('focus outline outside card',geom)
                                        assert geom['scrollWidth']<=width,geom
                                        page.screenshot(path=str(OUT/(case+'.png')))
                                        # Explicit shrink contract catches native intrinsic sizing even
                                        # where Linux Chromium happens to fit the old field already.
                                        assert f['minWidth']=='0px' and f['boxSizing']=='border-box', geom
                                        assert not errors,errors
                                        RESULT['cases'].append({'name':case,'pass':True,'geometry':geom,'dateNavigation':True,'keyboard':True,'servedCssSha256':hashlib.sha256(css.body()).hexdigest()})
                                        print('PASS',case,json.dumps({'fieldRight':f['right'],'cardContentRight':content_right,'font':geom['fontSize'],'appearance':geom['appearance']}),flush=True)
                                    finally:
                                        context.close()
                    finally:
                        browser.close()
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill();proc.wait()
            with socket.socket() as sock:
                closed=sock.connect_ex(('127.0.0.1',3322))!=0
            RESULT['cleanup']={'serverExited':proc.poll() is not None,'portClosed':closed,'temporaryDbRemovedOnExit':True,'schedulerEnabled':False}
            (OUT/'date-results.json').write_text(json.dumps(RESULT,ensure_ascii=False,indent=2))
expected=16*sum(e['status']=='tested' for e in RESULT['engines'].values())
assert len(RESULT['cases'])==expected and expected>=16
assert RESULT['cleanup']['serverExited'] and RESULT['cleanup']['portClosed']
print('HISTORY_DATE_CONTAINMENT_PASS',len(RESULT['cases']))
