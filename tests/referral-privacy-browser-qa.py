#!/usr/bin/env python3
"""Report 7643046. Real HTTP/SQLite, standalone Chromium; all data synthetic.
KOPILKA_REFERRAL_PREIMAGES can serve the saved public files for RED replay.
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
                ctx = browser.new_context(viewport={'width':390,'height':900}, service_workers='block')
                try:
                    auth = ctx.request.post(base+'/api/auth/dev', data={'firstName':'Privacy fixture', 'locale':lang,'timezone':'UTC'}).json()
                    token, uid = auth['token'], auth['user']['id']
                    headers = {'Authorization':'Bearer '+token}
                    # Dev users are normally non-public: enable just this synthetic fixture.
                    with sqlite3.connect(db) as c:
                        c.execute('UPDATE users SET is_demo=0 WHERE id=?',(uid,))
                    response = ctx.request.post(base+'/api/entries', headers=headers,
                                                data={'type':'sleep','note':'PRIVATE-NOTE-7643046'})
                    assert response.ok, response.text()
                    def local_only(r):
                        if not r.request.url.startswith(base+'/'):
                            r.abort(); return
                        preimages = os.environ.get('KOPILKA_REFERRAL_PREIMAGES')
                        name = r.request.url.split('?',1)[0].rsplit('/',1)[-1]
                        if preimages and (name in ['app.js','i18n.js'] or r.request.url==base+'/'):
                            name = name if name else 'index.html'
                            r.fulfill(body=(Path(preimages)/name).read_text(),content_type='text/html' if name=='index.html' else 'application/javascript')
                        else:r.continue_()
                    ctx.route('**/*',local_only)
                    ctx.add_init_script('localStorage.setItem("kopilkaToken",'+json.dumps(token)+');localStorage.setItem("kopilkaLocale",'+json.dumps(lang)+')')
                    p=ctx.new_page(); errors=[]
                    p.on('pageerror',lambda e:errors.append(str(e)))
                    p.goto(base);p.wait_for_function('state.user && state.profile && !state.busy')
                    p.evaluate('switchTab("profile")')
                    before=p.evaluate('JSON.parse(JSON.stringify(state.profile))')
                    notice=p.locator('#referralPrivacyNotice');assert notice.is_visible(), 'persistent disclosure absent'
                    text=notice.inner_text();assert len(text)>60
                    for button in ['copyRefLink','shareRefLink']:
                        assert p.locator('#'+button).get_attribute('aria-describedby')=='referralPrivacyNotice'
                    # Snapshot does not include descriptions on every Playwright version: check real AX tree instead.
                    ax=ctx.new_cdp_session(p).send('Accessibility.getFullAXTree')['nodes']
                    for label in [p.locator('#copyRefLink').inner_text(),p.locator('#shareRefLink').inner_text()]:
                        assert any(n.get('role',{}).get('value')=='button' and n.get('name',{}).get('value')==label and text in n.get('description',{}).get('value','') for n in ax)
                    p.evaluate('''() => {window.qaCopies=[];Object.defineProperty(navigator,'share',{configurable:true,value:undefined});Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async v=>{qaCopies.push(v)}}});}''')
                    link=p.locator('#refLink').input_value()
                    p.locator('#copyRefLink').click();p.wait_for_function('document.getElementById("statusRegion").textContent.includes(L("copied"))')
                    assert p.evaluate('qaCopies')==[link]
                    assert text in p.locator('#statusRegion').inner_text()
                    assert p.locator('#copyRefLink').evaluate('(e)=>document.activeElement===e')
                    p.locator('#shareRefLink').click();p.wait_for_function('qaCopies.length===2')
                    assert p.evaluate('qaCopies[1]')==before['refLink'];assert text in p.locator('#statusRegion').inner_text()
                    for mode in ['fail','none']:
                        p.evaluate('''mode=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:mode==='none'?undefined:{writeText:async()=>{throw Error('fixture denied')}}})''',mode)
                        p.locator('#copyRefLink').click();assert p.locator('#shareFallback').is_visible()
                        assert p.locator('#shareFallbackLink').input_value()==link
                        assert 'referralPrivacyNotice' in (p.locator('#shareFallbackLink').get_attribute('aria-describedby') or '')
                        status=p.locator('#statusRegion').inner_text()
                        assert text in status and p.evaluate('L("copyFailed")') in status
                        assert p.evaluate('L("copied")') not in status
                        p.locator('#shareRefLink').click();p.wait_for_timeout(50)
                        assert p.locator('#shareFallbackLink').input_value()==before['refLink']
                        assert text in p.locator('#statusRegion').inner_text()
                    # Referral native action sees persistent notice before invocation, payload unchanged.
                    p.evaluate('''() => {window.qaShares=[];Object.defineProperty(navigator,'share',{configurable:true,value:async args=>qaShares.push({args,priorNotice:!document.getElementById('referralPrivacyNotice').hidden})})}''')
                    p.locator('#shareRefLink').click();p.wait_for_function('qaShares.length===1')
                    share=p.evaluate('qaShares[0]');assert share['priorNotice'];assert share['args']['url']==before['refLink']
                    assert share['args']['text']==p.evaluate('L("shareRefText")')
                    p.evaluate("Object.defineProperty(navigator,'share',{configurable:true,value:async()=>{throw Error('fixture failed')}})")
                    p.locator('#shareRefLink').click();p.wait_for_function('!document.getElementById("shareFallback").hidden')
                    assert text in p.locator('#statusRegion').inner_text()
                    # Profile and story/generic manual fallbacks never inherit referral-specific descriptions/status.
                    p.locator('#shareProfile').click();p.wait_for_timeout(50)
                    assert p.locator('#shareFallbackLink').get_attribute('aria-describedby') is None
                    assert text not in p.locator('#statusRegion').inner_text()
                    p.locator('#shareStory').click();p.wait_for_timeout(50)
                    assert p.locator('#shareFallbackLink').input_value()==before['profileLink']
                    assert p.locator('#shareFallbackLink').get_attribute('aria-describedby') is None
                    assert p.locator('#statusRegion').inner_text()==p.evaluate('L("storyUnsupported")')
                    p.evaluate('''() => {Object.defineProperty(navigator,'share',{configurable:true,value:undefined});Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async v=>qaCopies.push(v)}})}''')
                    p.locator('#shareProfile').click();p.wait_for_timeout(50)
                    assert p.locator('#statusRegion').inner_text()==p.evaluate('L("copied")')
                    assert p.evaluate('qaCopies.at(-1)')==before['profileLink']
                    p.locator('#shareStory').click();p.wait_for_timeout(50)
                    assert text not in p.locator('#statusRegion').inner_text()
                    after=p.evaluate('JSON.parse(JSON.stringify(state.profile))')
                    for key in ['refCode','refLink','profileLink','botLink','vkRefLink']:
                        assert before.get(key)==after.get(key),(key,before.get(key),after.get(key))
                    # Real public route and projection, no private notes or own-profile disclosure.
                    public=ctx.request.get(base+'/api/public/'+before['refCode'])
                    assert public.ok,public.text();assert 'PRIVATE-NOTE-7643046' not in public.text()
                    public_ctx=browser.new_context(service_workers='block')
                    try:
                        public_ctx.route('**/*',lambda r:r.continue_() if r.request.url.startswith(base+'/') else r.abort())
                        q=public_ctx.new_page();q.goto(base+'/p/'+before['refCode']);q.wait_for_function('state.publicReadOnly')
                        assert q.locator('#referralPrivacyNotice').is_hidden()
                        assert q.locator('#copyRefLink').is_hidden() and q.locator('#shareRefLink').is_hidden()
                        assert 'PRIVATE-NOTE-7643046' not in q.locator('body').inner_text()
                        assert q.evaluate('storage.get("kopilkaRef")')==before['refCode']
                    finally:public_ctx.close()
                    recipient=ctx.request.post(base+'/api/auth/dev',data={'firstName':'Referred fixture','refCode':before['refCode']}).json()
                    with sqlite3.connect(db) as c:
                        assert c.execute('SELECT ref_code FROM users WHERE id=?',(uid,)).fetchone()[0]==before['refCode']
                        assert c.execute('SELECT referrer_id FROM users WHERE id=?',(recipient['user']['id'],)).fetchone()[0]==uid
                    assert not errors, errors
                    RESULTS.append({'lang':lang,'pass':True,'copy':True,'native':True,'manual':True,'publicPrivacy':True})
                    print(json.dumps(RESULTS[-1]),flush=True)
                finally:ctx.close()
        finally:browser.close()


def main():
    scratch=os.environ.get('TMPDIR',str(Path.home()/'.hermes/cache/scratch'))
    with tempfile.TemporaryDirectory(prefix='referral-privacy-',dir=scratch) as tmp:
        tmp=Path(tmp)
        for name in ['public','migrations']:(tmp/name).symlink_to(ROOT/name,target_is_directory=True)
        with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
        base='http://127.0.0.1:'+str(port);db=tmp/'qa.sqlite'
        env={'PATH':os.environ['PATH'],'HOME':str(Path.home()),'NODE_ENV':'test','PORT':str(port),
             'DB_PATH':str(db),'DEV_AUTH_ENABLED':'true','SCHEDULER_ENABLED':'false',
             'SESSION_SECRET':'referral-privacy-local-fixture','BOT_TOKEN':'','VK_SECURE_KEY':'',
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
    assert len(RESULTS)==2
    print('REFERRAL_PRIVACY_CONNECTED_PASS',len(RESULTS),flush=True)

if __name__=='__main__':main()
