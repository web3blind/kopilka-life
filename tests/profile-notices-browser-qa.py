#!/usr/bin/env python3
"""7663830/7664148: actual Profile controls, signed iframe, real PNG/SQLite.
Only provider outbound receipts are controlled. No live story publication.
Run with the absolute notices-outbound-deny preload via run-browser-qa.py.
PROFILE_NOTICES_APP optionally selects a read-only baseline for RED evidence.
"""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import sqlite3
import time
import urllib.parse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ['KOPILKA_QA_BASE_URL']
APP = Path(os.environ.get('PROFILE_NOTICES_APP', ROOT / 'public/app.js'))
AUDIT = Path(os.environ['PROFILE_NOTICES_AUDIT'])
assert os.environ['NODE_ENV'] == 'test' and 'qa.sqlite' in os.environ['DB_PATH']
assert os.environ['SCHEDULER_ENABLED'] == 'false'
assert 'notices-outbound-deny.cjs' in os.environ.get('NODE_OPTIONS', '')
AUDIT.mkdir(parents=True, exist_ok=True)
results, pngs = [], []
BRIDGE = '''window.qaMode='success';window.qaCopy=true;window.qaCalls=[];
window.vkBridge={supports:()=>true,subscribe:()=>{},send:async(method,params)=>{
 if(method==='VKWebAppCopyText'){qaCalls.push({method,text:params.text});return {result:qaCopy};}
 if(method==='VKWebAppShare')return {};
 if(method!=='VKWebAppShowStoryBox')return {result:true};
 qaCalls.push({method,png:params.blob,link:params.attachment.url});
 if(qaMode==='cancel')throw {error_type:'client_error',error_data:{error_code:4}};
 if(qaMode==='error')throw Error('fixture transport error');
 if(qaMode==='false')return {result:false};
 if(qaMode==='missing')return {};
 if(qaMode==='pending')return new Promise(r=>window.qaResolve=r);
 if(qaMode==='code-data')return {code_data:'fixture-editor'};
 return {result:true};
}};'''


def snapshot():
    with sqlite3.connect('file:' + os.environ['DB_PATH'] + '?mode=ro', uri=True) as db:
        return {n: db.execute('SELECT * FROM "' + n + '" ORDER BY rowid').fetchall()
                for (n,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}


with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    try:
        for index, lang in enumerate(('ru', 'en')):
            context = browser.new_context(viewport={'width':800, 'height':950}, service_workers='block')
            errors, outbound = [], []
            try:
                values = dict(vk_app_id='54723764', vk_user_id=str(81997663830 + index), vk_platform='mobile_android', vk_ts=str(int(time.time())))
                values['sign'] = base64.urlsafe_b64encode(hmac.new(b'browser-qa-vk-secure-key', urllib.parse.urlencode(sorted(values.items())).encode(), hashlib.sha256).digest()).decode().rstrip('=')
                query = urllib.parse.urlencode(values)
                auth = context.request.post(BASE + '/api/auth/vk', data={'launchParams':query}).json()
                headers = {'Authorization':'Bearer ' + auth['token']}
                assert context.request.post(BASE + '/api/settings/locale', headers=headers, data={'locale':lang}).ok
                def route(r):
                    path = urllib.parse.urlparse(r.request.url).path
                    if not r.request.url.startswith(BASE + '/'):
                        outbound.append(r.request.url); r.abort()
                    elif path == '/qa-host':
                        r.fulfill(content_type='text/html', body='<iframe title="Signed app" style="border:0;width:100%;height:920px" src="/?' + query.replace('&', '&amp;') + '"></iframe>')
                    elif path.startswith('/vendor/vk-bridge'):
                        r.fulfill(content_type='application/javascript', body=BRIDGE)
                    elif path == '/app.js':
                        r.fulfill(content_type='application/javascript', body=APP.read_bytes())
                    else:
                        r.continue_()
                context.route('**/*', route)
                page = context.new_page()
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.goto(BASE + '/qa-host')
                frame = page.frames[1]
                frame.wait_for_function('state.user && state.profile && !state.busy')
                page.wait_for_load_state('networkidle')
                assert frame.evaluate('locale()') == lang
                before = snapshot()
                page.clock.install()
                page.clock.pause_at(page.evaluate('(Date.now()+100)/1000'))
                region, close = frame.locator('#statusRegion'), frame.locator('#dismissStatus')
                def text(): return region.text_content()
                def advance(ms): page.clock.run_for(ms)
                def check(name, fn):
                    try:
                        fn(); result = dict(locale=lang, name=name, passed=True)
                    except Exception:
                        import traceback
                        result = dict(locale=lang, name=name, passed=False, error=traceback.format_exc(), text=text(), category=frame.evaluate('statusCategory'))
                    results.append(result); print(json.dumps(result, ensure_ascii=False), flush=True)
                def story(mode='success'):
                    frame.locator('#tab-button-profile').click()
                    frame.evaluate('(m)=>{qaMode=m;qaCalls=[]}', mode)
                    with page.expect_response(lambda r: '/api/story-card/' in r.url) as response:
                        frame.locator('#shareStory').click()
                    response = response.value
                    body = response.body()
                    assert response.status == 200 and response.header_value('content-type') == 'image/png'
                    assert body[:8] == bytes.fromhex('89504e470d0a1a0a')
                    pngs.append(dict(locale=lang, bytes=len(body), sha256=hashlib.sha256(body).hexdigest()))
                    frame.wait_for_function('qaCalls.some(c=>c.method==="VKWebAppShowStoryBox")')
                    if mode != 'pending': frame.wait_for_function('!document.getElementById("shareStory").disabled')
                    call = frame.evaluate('qaCalls.find(c=>c.method==="VKWebAppShowStoryBox")')
                    assert base64.b64decode(call['png'].split(',')[1]) == body and call['link']
                def copy():
                    frame.locator('#tab-button-profile').click()
                    frame.locator('#copyRefLink').click()
                    frame.wait_for_function('document.getElementById("statusRegion").textContent.startsWith(L("copied"))')
                def handoff():
                    story()
                    assert text() == frame.evaluate('L("storyEditorOpened")')
                    assert region.get_attribute('role') == 'status'
                    assert close.is_visible() and close.is_enabled(), '7663830 Profile handoff lacks Close'
                    advance(4999); assert text()
                    advance(1); assert text() == '', '7663830 handoff persists'
                check('affirmative-real-PNG-handoff-five-seconds-close', handoff)
                def copy_reading():
                    frame.evaluate('qaCopy=true')
                    copy()
                    advance(2500); assert text(), '7664148 copy disappears at old 2.5s'
                    advance(2499); assert text()
                    advance(1); assert text() == ''
                    assert frame.locator('#referralPrivacyNotice').is_visible()
                    assert frame.evaluate('qaCalls.filter(c=>c.method==="VKWebAppCopyText").at(-1).text') == frame.locator('#refLink').input_value()
                check('copy-receipt-readable-five-seconds-privacy-retained', copy_reading)
                def copy_short():
                    copy()
                    assert text() == frame.evaluate('L("copied")'), '7664148 redundant privacy paragraph in transient copy receipt'
                    assert close.is_visible() and close.is_enabled()
                check('copy-short-receipt-explicit-close', copy_short)
                def keyboard():
                    story('code-data'); close.focus(); page.keyboard.press('Enter')
                    assert text() == '' and frame.evaluate('document.activeElement.id') == 'shareStory'
                    copy(); close.focus(); page.keyboard.press('Space')
                    assert text() == '' and frame.evaluate('document.activeElement.id') == 'copyRefLink'
                check('localized-keyboard-dismiss-restores-own-trigger', keyboard)
                def generations():
                    story(); advance(3000); copy(); saved = text()
                    advance(2100); assert text() == saved
                    frame.evaluate('window.qaOldClose=document.getElementById("dismissStatus").onclick;setStatus("New session warning","error");qaOldClose?.()')
                    advance(6000); assert text() == 'New session warning' and close.is_hidden()
                    copy(); advance(5000); assert text() == 'New session warning', 'copy erased earlier durable warning'
                check('old-timer-close-cannot-clear-new-warning-copy-restores-warning', generations)
                def contrasts():
                    for mode in ('missing', 'false', 'error'):
                        story(mode); saved = text()
                        assert saved and region.evaluate('(e)=>e.classList.contains("error")') and close.is_hidden()
                        value = frame.locator('#shareFallbackLink').input_value()
                        advance(6000); assert text() == saved and frame.locator('#shareFallbackLink').input_value() == value
                    story('cancel'); value = frame.locator('#shareFallbackLink').input_value()
                    advance(5000); assert text() == '' and frame.locator('#shareFallback').is_visible()
                    assert frame.locator('#shareFallbackLink').input_value() == value
                    frame.locator('#shareRefLink').click(); frame.wait_for_function('statusCategory==="share-unconfirmed"')
                    saved = text(); advance(6000); assert text() == saved
                    story('pending'); advance(6000)
                    assert frame.locator('#shareStory').is_disabled()
                    frame.evaluate('qaResolve({result:false})')
                    frame.wait_for_function('!document.getElementById("shareStory").disabled')
                    assert region.evaluate('(e)=>e.classList.contains("error")')
                    frame.evaluate('qaCopy=false'); frame.locator('#copyRefLink').click()
                    frame.wait_for_function('document.getElementById("statusRegion").textContent.startsWith(L("copyFailed"))')
                    saved = text(); advance(6000); assert text() == saved
                    assert frame.locator('#shareFallbackLink').input_value() == frame.locator('#refLink').input_value()
                check('false-missing-error-pending-cancel-unconfirmed-and-manual-copy-distinct', contrasts)
                def return_and_scale():
                    story(); frame.locator('#tab-button-week').click()
                    frame.evaluate('Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"))')
                    advance(5000)
                    frame.evaluate('Object.defineProperty(document,"hidden",{configurable:true,value:false});document.dispatchEvent(new Event("visibilitychange"));window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}))')
                    assert text() == ''
                    frame.locator('#tab-button-profile').click()
                    frame.evaluate('const rootSize=parseFloat(getComputedStyle(document.documentElement).fontSize), bodySize=parseFloat(getComputedStyle(document.body).fontSize);document.documentElement.style.fontSize=`${rootSize*2}px`;document.body.style.fontSize=`${bodySize*2}px`')
                    story(); assert close.is_visible() and close.is_enabled()
                    close.scroll_into_view_if_needed()
                    box = close.bounding_box(); assert box and box['width'] > 44 and box['height'] >= 44
                    page.screenshot(path=str(AUDIT / (lang + '-200-percent.png')))
                    close.focus(); page.keyboard.press('Enter'); assert text() == ''
                check('retained-hide-return-and-200-percent-accessible-close', return_and_scale)
                def guarded_copy():
                    for marker in ('refreshFailed', 'pendingMerge', 'sessionRenewalBlocked'):
                        frame.evaluate('(m)=>{qaCopy=true;state[m]=true}', marker)
                        copy(); assert close.is_hidden()
                        advance(5000)
                        if marker == 'refreshFailed': assert text() == frame.evaluate('L("refreshPending")')
                        frame.evaluate('(m)=>state[m]=false', marker)
                    story(); frame.evaluate('setStatus("Session expired","error");state.sessionRenewalBlocked=true')
                    advance(6000); assert text() == 'Session expired'
                    frame.evaluate('state.sessionRenewalBlocked=false')
                check('refresh-merge-session-warning-guards', guarded_copy)
                check('SQLite-all-tables-unchanged', lambda: (_ for _ in ()).throw(AssertionError('DB changed')) if before != snapshot() else None)
                def website_clipboard():
                    website = context.new_page()
                    try:
                        website.add_init_script('window.qaClipboard=[];Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async text=>{qaClipboard.push(text)}}})')
                        website.goto(BASE + '/')
                        website.wait_for_function('state.user && state.profile && !state.busy')
                        assert not website.evaluate('isVkMiniApp()')
                        website.locator('#tab-button-profile').click()
                        website.locator('#copyRefLink').click()
                        website.wait_for_function('qaClipboard.length===1')
                        assert website.evaluate('qaClipboard[0]') == website.locator('#refLink').input_value()
                        assert website.locator('#statusRegion').text_content() == website.evaluate('L("copied")')
                        assert website.locator('#dismissStatus').is_visible()
                        website.locator('#dismissStatus').focus(); website.keyboard.press('Enter')
                        assert website.locator('#statusRegion').text_content() == ''
                    finally:
                        website.close()
                check('website-actual-clipboard-API-handler-confirmed-receipt', website_clipboard)
                assert not errors, errors
                assert all(u == 'https://telegram.org/js/telegram-web-app.js' for u in outbound), outbound
            finally:
                context.close()
    finally:
        browser.close()
        report = dict(app_sha256=hashlib.sha256(APP.read_bytes()).hexdigest(), results=results, pngs=pngs,
                      passed=sum(r['passed'] for r in results), failed=sum(not r['passed'] for r in results),
                      scope='Signed local Chromium iframe, controlled outbound Bridge, no native-device/publication proof')
        (AUDIT / 'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
assert results and all(r['passed'] for r in results), report
print('PROFILE_NOTICES_PASS', len(results))
