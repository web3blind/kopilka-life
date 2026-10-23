#!/usr/bin/env python3
"""7647439: exact shipped shell + selected JS, real signed fixture HTTP/SQLite.
Use canonical run-browser-qa.py and three-reports-preload.cjs; no live providers.
"""
import ast, asyncio, base64, hashlib, hmac, json, os, threading, time, urllib.parse, urllib.request
from contextlib import contextmanager
from pathlib import Path
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
source=ast.parse((ROOT/'tests/report7644800-ios-safe-placement-qa.py').read_text());namespace=dict(globals())
exec(compile(ast.Module(body=[n for n in source.body if isinstance(n,ast.FunctionDef) and n.name=='filtered_cdp'],type_ignores=[]),'filtered-cdp','exec'),namespace)
filtered_cdp=namespace['filtered_cdp'];BASE=os.environ['KOPILKA_QA_BASE_URL']
OUT=Path(os.environ['REPORT7647439_OUT']);OUT.mkdir(parents=True,exist_ok=True)
APP=Path(os.environ.get('REPORT7647439_APP',ROOT/'public/app.js'));SHELL=Path(os.environ.get('REPORT7647439_SHELL',ROOT/'public/index.html'))
results=[]
def launch(uid,platform):
    p=dict(vk_app_id='54723764',vk_user_id=str(uid),vk_platform=platform,vk_ts=str(int(time.time())))
    p['sign']=base64.urlsafe_b64encode(hmac.new(b'browser-qa-vk-secure-key',urllib.parse.urlencode(sorted(p.items())).encode(),hashlib.sha256).digest()).decode().rstrip('=')
    return urllib.parse.urlencode(p)
def counters(p,lang):
    for field,maximum in [('contractTitle',120),('contractTarget',300),('stakeAmount',40),('stakeCurrency',20),('rewardDescription',300),('fundDescription',300)]:
        value=p.locator('#'+field).input_value();n=len(value.encode('utf-16-le'))//2
        assert p.locator('#'+field+'Counter').inner_text()==(f'{n} из {maximum} символов' if lang=='ru' else f'{n} of {maximum} characters')
with filtered_cdp(os.environ.get('KOPILKA_QA_CDP_URL','http://127.0.0.1:18800')) as endpoint,sync_playwright() as pw:
    browser=pw.chromium.connect_over_cdp(endpoint)
    for i,(host,lang,scale) in enumerate((host,lang,scale) for host in ('desktop','iphone') for lang,scale in [('ru',1),('en',1),('ru',2),('en',2)]):
        viewport={'width':1280,'height':900} if host=='desktop' else {'width':414,'height':896}
        ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36' if host=='desktop' else 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
        context=browser.new_context(viewport=viewport,service_workers='block',user_agent=ua)
        try:
            def route(r):
                if not r.request.url.startswith(BASE+'/'):r.abort()
                elif '/app.js' in r.request.url:r.fulfill(content_type='application/javascript',body=APP.read_text())
                elif urllib.parse.urlparse(r.request.url).path=='/':r.fulfill(content_type='text/html',body=SHELL.read_text())
                else:r.continue_()
            context.route('**/*',route)
            query=launch(81997647439+i,'desktop_web' if host=='desktop' else 'mobile_web')
            auth=context.request.post(BASE+'/api/auth/vk',data={'launchParams':query}).json();assert auth.get('token'),auth
            headers={'Authorization':'Bearer '+auth['token']}
            assert context.request.post(BASE+'/api/settings/locale',headers=headers,data={'locale':lang}).ok
            p=context.new_page();errors=[];p.on('pageerror',lambda e:errors.append(str(e)))
            p.goto(BASE+'/?'+query);p.wait_for_function('state.user && state.product && !state.busy')
            p.evaluate("scale=>{document.documentElement.style.fontSize=scale*100+'%';setStatus('');readyNoticeDismissed=false}",scale)
            p.locator('#tab-button-contract').click()
            templates=p.evaluate('state.product.contractTemplates');dream=next(t for t in templates if '3' in t['targetValue'] and '7' in t['targetValue'])
            trigger=p.locator('[data-template-id="'+dream['id']+'"]');trigger.click()
            p.wait_for_function("document.getElementById('statusRegion').textContent.includes(L('templateApplied',{title:document.getElementById('contractTitle').value}))")
            notice=p.locator('#statusRegion').text_content();counters(p,lang)
            assert p.locator('#contractTitle').input_value()==dream['title']
            p.screenshot(path=str(OUT/f'{host}-{lang}-{scale*100}-notice.png'))
            button=p.get_by_role('button',name='Закрыть уведомление' if lang=='ru' else 'Dismiss notification',exact=True)
            # RED must come from real template click, and independently record persistence.
            if not button.is_visible():
                p.wait_for_timeout(5300)
                assert p.locator('#statusRegion').text_content()==notice
                # Lack of dismissal is proven; do not infer complete form blockage.
                p.locator('#contractTitle').fill('Original remains editable '+lang)
                p.locator('#contractTarget').fill('Original 3 of 7 editable');counters(p,lang)
                assert p.locator('#statusRegion').text_content()==notice
                with p.expect_response(lambda r:r.url.endswith('/api/contracts') and r.request.method=='POST') as response:
                    p.locator('#contractForm button[type=submit]').click()
                assert response.value.ok,response.value.text()
                persisted=context.request.get(BASE+'/api/contracts/current',headers=headers)
                assert persisted.ok and 'Original remains editable' in persisted.text()
                raise AssertionError('7647439 reproduced: real Dream3of7 button produces non-dismissible notice surviving 5.3s; original field editing and real contract save still succeeded in this fixture')
            ax=context.new_cdp_session(p).send('Accessibility.getFullAXTree')['nodes']
            assert any(n.get('role',{}).get('value')=='button' and n.get('name',{}).get('value')==p.evaluate('L("dismissNotification")') for n in ax)
            box=button.bounding_box();assert box and box['y']>=(96 if host=='iphone' else 8) and box['y']+box['height']<=viewport['height'],box
            assert button.evaluate('(e)=>{let r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e}')
            button.focus();p.keyboard.press('Enter');assert p.locator('#statusRegion').text_content()==''
            assert p.evaluate('document.activeElement.dataset.templateId')==dream['id']
            assert p.evaluate('readyNoticeDismissed') is False;counters(p,lang)
            # Same template is non-destructive; focused automatic dismissal restores trigger.
            trigger.click();button.focus();p.wait_for_timeout(5300)
            assert p.locator('#statusRegion').text_content()=='' and p.evaluate('document.activeElement.dataset.templateId')==dream['id']
            p.locator('#contractTitle').fill('Edited 🌱 '+lang);counters(p,lang)
            trigger.click();p.locator('#templateReplaceDialog').wait_for(state='visible');p.locator('[data-template-choice="cancel"]').click()
            assert p.locator('#contractTitle').input_value()=='Edited 🌱 '+lang
            trigger.click();p.locator('[data-template-choice="confirm"]').click();p.wait_for_function('!templateReplaceDecision');counters(p,lang)
            button.focus();p.keyboard.press('Space');assert p.locator('#statusRegion').text_content()==''
            # Fence a real template timer and its explicit handler against a later error.
            trigger.click();p.evaluate('window.staleClose=document.getElementById("dismissStatus").onclick;setStatus("durable-error","error");staleClose()')
            p.wait_for_timeout(5300);assert p.locator('#statusRegion').text_content()=='durable-error' and button.is_hidden()
            # Nonfatal template does not globally suppress Ready; long share remains durable.
            p.evaluate('setStatus(L("ready"),"info","ready")');assert button.is_visible()
            p.evaluate('setStatus(L("shareUnconfirmed"),"info","share-unconfirmed")');notice=p.locator('#statusRegion').text_content()
            p.locator('#tab-button-contract').click();p.keyboard.press('Escape');p.wait_for_timeout(5300)
            assert p.locator('#statusRegion').text_content()==notice
            button.focus();p.keyboard.press('Enter');assert p.evaluate('readyNoticeDismissed') is False
            p.evaluate('setStatus(L("ready"),"info","ready")');button.focus();p.keyboard.press('Enter')
            p.evaluate('setStatus(L("ready"),"info","ready")');assert p.locator('#statusRegion').text_content()==''
            # Edit and submit actual contract; verify persisted backend record, not just client rendering.
            p.locator('#contractTitle').fill('Saved template '+host+' '+lang);p.locator('#contractTarget').fill('3 of 7 edited');counters(p,lang)
            with p.expect_response(lambda r:r.url.endswith('/api/contracts') and r.request.method=='POST') as response:
                p.locator('#contractForm button[type=submit]').click()
            assert response.value.ok,response.value.text()
            payload=response.value.json();assert 'Saved template' in json.dumps(payload)
            p.wait_for_function('!state.busy && !!state.currentContract');assert p.locator('#contractCurrent').inner_text().find('Saved template')>=0
            persisted=context.request.get(BASE+'/api/contracts/current',headers=headers)
            assert persisted.ok and 'Saved template' in persisted.text(),(persisted.status,persisted.text())
            assert not errors,errors
            results.append(dict(name=f'{host}-{lang}-{scale*100}',passed=True,app_sha256=hashlib.sha256(APP.read_bytes()).hexdigest(),template=dream,geometry=box,persisted= persisted.json(),checks=['actual-Dream3of7-template-button','localized-AX-close','iOS-offset-hit-test','keyboard-Enter-Space-focus','automatic-5s-focus','six-field-counters','draft-cancel-confirm','stale-timer-and-handler-error','long-share-no-timer-outside-Escape','separate-Ready-suppression','real-edited-contract-POST-and-GET']))
        except Exception:
            import traceback
            results.append(dict(name=f'{host}-{lang}-{scale*100}',passed=False,error=traceback.format_exc()))
        finally:
            context.close();(OUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2));print(json.dumps(results[-1],ensure_ascii=False),flush=True)
assert len(results)==8 and all(r['passed'] for r in results),results
