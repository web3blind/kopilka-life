#!/usr/bin/env python3
"""7644834: real signed local HTTP/SQLite + isolated shared-CDP contexts.
Run through run-browser-qa.py with three-reports-preload.cjs in NODE_OPTIONS.
Provider responses are controlled fixtures, NOT native VK/Yandex acceptance.
"""
import ast, asyncio, base64, hashlib, hmac, json, os, threading, time, urllib.parse, urllib.request
from contextlib import contextmanager
from pathlib import Path
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
# Reuse the proven worker filter without executing the original suite's top level.
source=ast.parse((ROOT/'tests/report7644800-ios-safe-placement-qa.py').read_text())
namespace=dict(globals())
exec(compile(ast.Module(body=[n for n in source.body if isinstance(n,ast.FunctionDef) and n.name=='filtered_cdp'],type_ignores=[]),'filtered-cdp','exec'),namespace)
filtered_cdp=namespace['filtered_cdp']
BASE=os.environ['KOPILKA_QA_BASE_URL']
OUT=Path(os.environ['REPORT7644834_OUT']);OUT.mkdir(parents=True,exist_ok=True)
results=[]
def launch(uid, platform):
    p=dict(vk_app_id='54723764',vk_user_id=str(uid),vk_platform=platform,vk_ts=str(int(time.time())))
    p['sign']=base64.urlsafe_b64encode(hmac.new(b'browser-qa-vk-secure-key',urllib.parse.urlencode(sorted(p.items())).encode(),hashlib.sha256).digest()).decode().rstrip('=')
    return urllib.parse.urlencode(p)
with filtered_cdp(os.environ.get('KOPILKA_QA_CDP_URL','http://127.0.0.1:18800')) as endpoint,sync_playwright() as pw:
    browser=pw.chromium.connect_over_cdp(endpoint)
    for i,(host,lang,scale) in enumerate((host,lang,scale) for host in ('desktop','iphone') for lang,scale in [('ru',1),('en',1),('ru',2),('en',2)]):
        viewport={'width':1280,'height':900} if host=='desktop' else {'width':414,'height':896}
        ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36' if host=='desktop' else 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
        context=browser.new_context(viewport=viewport,service_workers='block',user_agent=ua)
        try:
            def route(r):
                if not r.request.url.startswith(BASE+'/'):r.abort()
                elif '/app.js' in r.request.url and os.environ.get('REPORT7644834_APP'):r.fulfill(content_type='application/javascript',body=Path(os.environ['REPORT7644834_APP']).read_text())
                else:r.continue_()
            context.route('**/*',route)
            query=launch(81997644834+i,'desktop_web' if host=='desktop' else 'mobile_web')
            auth=context.request.post(BASE+'/api/auth/vk',data={'launchParams':query}).json();assert auth.get('token'),auth
            assert context.request.post(BASE+'/api/settings/locale',headers={'Authorization':'Bearer '+auth['token']},data={'locale':lang}).ok
            p=context.new_page();errors=[];p.on('pageerror',lambda e:errors.append(str(e)))
            p.goto(BASE+'/?'+query);p.wait_for_function('state.user && state.profile && !state.busy')
            p.evaluate('''scale=>{document.documentElement.style.fontSize=scale*100+'%';setStatus('');readyNoticeDismissed=false;
              window.qaShares=[];window.vkBridge={send:async(method,args)=>{qaShares.push({method,args});return {items:[]}}};}''',scale)
            p.locator('#tab-button-profile').click()
            p.locator('#shareRefLink').click()
            p.wait_for_function('document.getElementById("shareFallback").hidden===false')
            assert p.evaluate('qaShares.length')==1
            url=p.evaluate('qaShares[0].args.link');assert url==p.evaluate('state.profile.vkRefLink || state.profile.refLink')
            notice=p.locator('#statusRegion').text_content()
            assert p.evaluate('L("shareUnconfirmed")') in notice and p.evaluate('L("referralPrivacyNotice")') in notice, repr((notice,p.evaluate('statusCategory'),p.evaluate('qaShares')))
            assert p.locator('#shareFallbackLink').input_value()==url
            assert p.locator('#shareFallbackLink').get_attribute('aria-describedby')=='shareFallbackHint referralPrivacyNotice'
            button=p.get_by_role('button',name='Закрыть уведомление' if lang=='ru' else 'Dismiss notification',exact=True)
            assert button.is_visible(),'7644834: no accessible explicit dismiss control'
            # No timer: the long screen-reader notice must survive the Ready timeout.
            p.locator('#tab-button-profile').click();p.keyboard.press('Escape')
            p.wait_for_timeout(5250);assert p.locator('#statusRegion').text_content()==notice
            p.screenshot(path=str(OUT/f'{host}-{lang}-{scale*100}-notice.png'))
            ax=context.new_cdp_session(p).send('Accessibility.getFullAXTree')['nodes']
            assert any(n.get('role',{}).get('value')=='button' and n.get('name',{}).get('value')==p.evaluate('L("dismissNotification")') for n in ax)
            box=button.bounding_box();assert box and box['y']>=(96 if host=='iphone' else 8) and box['y']+box['height']<=viewport['height'],box
            assert button.evaluate('(e)=>{let r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e}')
            button.focus();p.keyboard.press('Enter')
            assert p.locator('#statusRegion').text_content()=='' and button.is_hidden()
            assert p.locator('#shareFallback').is_visible() and p.locator('#shareFallbackLink').input_value()==url
            assert p.evaluate('document.activeElement.id')=='shareFallbackLink'
            p.keyboard.press('Control+a')
            assert p.locator('#shareFallbackLink').evaluate('(e)=>e.selectionEnd-e.selectionStart===e.value.length')
            assert p.evaluate('readyNoticeDismissed') is False
            p.evaluate('setStatus(L("ready"),"info","ready")');assert button.is_visible()
            p.locator('#shareRefLink').click();p.wait_for_function('statusCategory==="share-unconfirmed"')
            p.evaluate('window.staleDismiss=document.getElementById("dismissStatus").onclick;setStatus("new durable warning","error");staleDismiss()')
            assert p.locator('#statusRegion').text_content()=='new durable warning' and button.is_hidden()
            # Detached fallback uses the selected tab rather than a hidden/removed node.
            p.locator('#shareRefLink').click();p.wait_for_function('statusCategory==="share-unconfirmed"')
            p.evaluate('document.getElementById("shareFallbackLink").hidden=true')
            button.focus();p.keyboard.press('Space');assert p.evaluate('document.activeElement.id')=='tab-button-profile'
            assert not errors,errors
            results.append(dict(name=f'{host}-{lang}-{scale*100}',passed=True,share_url=url,geometry=box,checks=['actual-referral-button','controlled-unconfirmed-provider','manual-link-retained','no-timer','AX-label','host-offset','keyboard-focus','ready-not-suppressed','stale-close-fence','hidden-focus-fallback']))
        except Exception as error:
            import traceback
            results.append(dict(name=f'{host}-{lang}-{scale*100}',passed=False,error=traceback.format_exc()))
        finally:
            context.close();(OUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2));print(json.dumps(results[-1],ensure_ascii=False),flush=True)
assert len(results)==8 and all(r['passed'] for r in results),results
