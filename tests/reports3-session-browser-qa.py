#!/usr/bin/env python3
"""Reports 7662267/68/71: real HTTP, temporary SQLite, controlled host only."""
import importlib.util
import json
import os
import sqlite3
from pathlib import Path
from playwright.sync_api import sync_playwright

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).with_name('vk-login-recovery-browser-qa.py'))
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)
BASE = os.environ['KOPILKA_QA_BASE_URL']


def main():
    failures, passed = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/opt/google/chrome/chrome', headless=True, args=['--no-sandbox','--disable-dev-shm-usage']) if os.environ.get('KOPILKA_QA_OWN_BROWSER') == '1' else p.chromium.connect_over_cdp(os.environ.get('KOPILKA_QA_CDP_URL', 'http://127.0.0.1:18800'), timeout=15000)
        for lang in ('ru', 'en'):
            for cached, explicit in (('', True), ('ru', True), ('en', True), ('', False), ('en' if lang=='ru' else 'ru', False)):
                ctx = browser.new_context(has_touch=True, viewport={'width': 412, 'height': 915})
                try:
                    ctx.route('**/*', lambda r: r.continue_() if r.request.url.startswith(BASE+'/') else r.fulfill(content_type='application/javascript', body='/* no external host */') if 'vk-bridge' in r.request.url else r.abort())
                    page = ctx.new_page()
                    page.add_init_script("""(() => {localStorage.clear(); const cached=CACHED;
                      if(cached)localStorage.setItem('kopilkaLocale',cached);
                      window.calls=[]; window.vkBridge={isWebView:()=>true,send:async method=>{calls.push(method);return {result:true};}};
                    })();""".replace('CACHED', json.dumps(cached)))
                    # An invalid launch must not use another user's bearer, and
                    # the requested presentation language is not an identity proof.
                    page.goto(BASE+'/?vk_app_id=54723764&vk_language='+lang+('&lang='+lang if explicit else '')+'&sign=invalid', wait_until='domcontentloaded')
                    page.locator('#loginScreen').wait_for(state='visible')
                    expected = lang if explicit else (cached or lang)
                    assert page.locator('html').get_attribute('lang') == expected, 'cold locale'
                    assert page.locator('#loginRecoveryHint').inner_text().startswith('Your session' if expected=='en' else 'Сессия'), 'recovery locale'
                    assert page.evaluate('state.user') is None
                    link = page.locator('[data-i18n="openVkMiniApp"]')
                    # Execute the original real link too: two trusted activations
                    # must not create two destination pages in an existing host.
                    page.evaluate("() => { window.open=()=>{window.unexpectedOpen=new Error().stack;return null}; }")
                    # Native recovery is explicit, remains in place, and ignores
                    # overlapping trusted touch and keyboard activations.
                    page.locator('#entryNote').evaluate("el=>el.value='retained draft'")
                    auth_attempts=[]
                    def hold_auth(r):
                        auth_attempts.append(r)
                        page.evaluate('window.reentryRequestObserved=true')
                    page.route('**/api/auth/vk', hold_auth)
                    link.tap()
                    link.focus(); page.keyboard.press('Enter')
                    assert len(ctx.pages)==1, f'repeated host reentry created {len(ctx.pages)-1} extra pages'
                    page.wait_for_function('window.reentryRequestObserved===true && vkReentryPending')
                    assert len(auth_attempts)==1, 'overlapping activation repeated auth'
                    auth_attempts[0].continue_()
                    page.wait_for_function('!vkReentryPending')
                    assert link.is_enabled(), 'retry remains usable after settlement'
                    assert not page.evaluate('window.unexpectedOpen || false'), page.evaluate('({url:location.href,vk:isVkMiniApp(),active:document.activeElement.id})')
                    assert page.locator('#entryNote').input_value() == 'retained draft'
                    assert len(ctx.pages) == 1
                    passed.append(f'{lang}/{cached or "cold"}: invalid launch localized + in-place recovery')
                except Exception as e:
                    failures.append(f'{lang}/{cached or "cold"}: {__import__("traceback").format_exc()}')
                finally:
                    ctx.close()
        for lang in ('ru','en'):
            ctx=browser.new_context()
            try:
                ctx.route('**/*', lambda r: r.continue_() if r.request.url.startswith(BASE+'/') else r.fulfill(content_type='application/javascript',body='') if 'vk-bridge' in r.request.url else r.abort())
                user=ctx.request.post(BASE+'/api/auth/dev',data={'firstName':'Reports fixture'}).json()
                token=user['token']
                res=ctx.request.post(BASE+'/api/settings/locale',headers={'Authorization':'Bearer '+token},data={'locale':lang})
                assert res.ok
                page=ctx.new_page()
                page.add_init_script("localStorage.setItem('kopilkaToken',"+json.dumps(token)+");localStorage.setItem('kopilkaLocale',"+json.dumps('ru' if lang=='en' else 'en')+");")
                page.goto(BASE)
                page.wait_for_function('state.user && state.summary && !state.busy')
                assert page.locator('html').get_attribute('lang')==lang
                page.locator('[data-tab="contract"]').click()
                page.locator('#contractTitle').fill('   ')
                page.locator('#contractTarget').fill('   ')
                page.locator('#contractForm button[type="submit"]').click()
                page.wait_for_function("document.querySelector('#statusRegion').classList.contains('error')")
                text=page.locator('#statusRegion').inner_text()
                assert ('Заполни название и критерий договора.' if lang=='ru' else 'Fill in the contract name and criteria.') in text, text
                with sqlite3.connect('file:'+os.environ['DB_PATH']+'?mode=ro',uri=True) as db:
                    assert db.execute('select count(*) from weekly_contracts where user_id=?',(user['user']['id'],)).fetchone()[0]==0
                # Expire only this fixture bearer; the real route must reject it.
                payload=json.loads(__import__('base64').urlsafe_b64decode(token.split('.')[0]+'=='))
                payload['iat']=1000; payload['exp']=2000
                encoded=__import__('base64').urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip('=')
                signature=__import__('base64').urlsafe_b64encode(__import__('hmac').new(b'browser-qa-session-secret',encoded.encode(),__import__('hashlib').sha256).digest()).decode().rstrip('=')
                expired=encoded+'.'+signature
                expired_response=ctx.request.get(BASE+'/api/me',headers={'Authorization':'Bearer '+expired})
                assert expired_response.status==401 and expired_response.json()['code']=='SESSION_EXPIRED'
                page.locator('[data-tab="today"]').click()
                page.locator('#entryNote').fill('expired draft')
                page.evaluate('token=>{state.token=token;localStorage.setItem("kopilkaToken",token)}',expired)
                page.locator('button[data-entry-type="sleep"]').click()
                page.locator('#loginScreen').wait_for(state='visible')
                assert page.locator('#loginRecoveryHint').inner_text().startswith('Your session' if lang=='en' else 'Сессия')
                assert page.locator('#entryNote').input_value()=='expired draft'
                passed.append(lang+': verified locale + whitespace submit/SQLite + actual expired quick action retains draft')
            except Exception as e: failures.append(lang+': '+str(e))
            finally: ctx.close()
        for lang in ('ru','en'):
            for stale in (False,True):
                ctx=browser.new_context(has_touch=True)
                try:
                    uid=93400+(10 if lang=='en' else 0)
                    a=ctx.request.post(BASE+'/api/auth/vk',data={'launchParams':recovery.launch(uid)}).json()
                    b=ctx.request.post(BASE+'/api/auth/vk',data={'launchParams':recovery.launch(uid+1)}).json()
                    assert ctx.request.post(BASE+'/api/settings/locale',headers={'Authorization':'Bearer '+b['token']},data={'locale':lang}).ok
                    proof=recovery.launch(uid+1,5184000 if stale else 0,lang)
                    def iframe_route(r):
                        if r.request.url==BASE+'/reports3-host': r.fulfill(content_type='text/html',body='<iframe title="Mini App" src="/'+proof.replace('&','&amp;')+'"></iframe>')
                        elif r.request.url.startswith(BASE+'/'): r.continue_()
                        elif 'vk-bridge' in r.request.url: r.fulfill(content_type='application/javascript',body='')
                        else: r.abort()
                    ctx.route('**/*',iframe_route)
                    page=ctx.new_page()
                    page.add_init_script('localStorage.setItem("kopilkaToken",'+json.dumps(a['token'])+');localStorage.setItem("kopilkaLocale","ru");window.vkBridge={isWebView:()=>true,send:async()=>({result:true})};')
                    private=[]
                    page.on('request',lambda r: private.append(r.url) if any('/api/'+key in r.url for key in ('me','summary','history')) else None)
                    page.goto(BASE+'/reports3-host')
                    frame=page.frame_locator('iframe')
                    frame.locator('#loginScreen' if stale else '#appShell').wait_for(state='visible')
                    child=page.frames[1]
                    if stale:
                        child.wait_for_function('document.querySelector("#loginRecoveryHint").hidden===false')
                        assert child.evaluate('state.user') is None and not private
                        frame.locator('#entryNote').evaluate("el=>el.value='iframe draft'")
                        frame.locator('[data-i18n="openVkMiniApp"]').tap()
                        assert len(ctx.pages)==1
                        child.wait_for_function('!vkReentryPending')
                        assert frame.locator('#entryNote').input_value()=='iframe draft'
                    else:
                        child.wait_for_function('state.summary && state.user')
                        assert child.evaluate('state.user.id')==b['user']['id']
                        assert child.locator('html').get_attribute('lang')==lang
                    passed.append(lang+': signed iframe '+('stale B rejects cached A without private reads' if stale else 'fresh B overrides cached A identity and locale'))
                except Exception as e: failures.append(lang+' iframe: '+str(e))
                finally: ctx.close()
        for lang in ('ru','en'):
            ctx=browser.new_context(has_touch=True)
            try:
                pending=[]; destinations=[]
                def route(r):
                    if r.request.url==BASE+'/api/config': pending.append(r)
                    elif r.request.url.startswith(BASE+'/'): r.continue_()
                    elif r.request.url=='https://vk.com/app54723764':
                        destinations.append({'url':r.request.url,'headers':r.request.headers})
                        r.fulfill(content_type='text/html',body='<title>Controlled VK destination</title>')
                    elif 'vk-bridge' in r.request.url: r.fulfill(content_type='application/javascript',body='')
                    else: r.abort()
                ctx.route('**/*',route)
                page=ctx.new_page()
                page.add_init_script("localStorage.setItem('kopilkaLocale',"+json.dumps(lang)+");window.vkBridge={isWebView:()=>false,send:async()=>({})};")
                page.goto(BASE+'/?private_fixture=must-not-leak',wait_until='domcontentloaded')
                page.locator('#loginScreen').wait_for(state='visible')
                page.wait_for_function('document.documentElement.lang === '+json.dumps(lang))
                assert page.locator('#vkLoginButton').inner_text()==('Sign in with VK ID' if lang=='en' else 'Войти через VK ID')
                # Config is deliberately unresolved while real static localization is inspected.
                page.wait_for_function('document.querySelector("#loginScreen").hidden===false')
                for r in pending: r.continue_()
                page.locator('#entryNote').evaluate("el=>el.value='website draft'")
                with page.expect_popup() as opened: page.locator('[data-i18n="openVkMiniApp"]').tap()
                popup=opened.value; popup.wait_for_load_state()
                page.locator('[data-i18n="openVkMiniApp"]').focus(); page.keyboard.press('Enter')
                assert len(ctx.pages)==2 and len(destinations)==1
                assert destinations[0]['url']=='https://vk.com/app54723764'
                assert not any(k in destinations[0]['headers'] for k in ('referer','authorization'))
                assert popup.evaluate('window.opener===null')
                assert page.locator('#entryNote').input_value()=='website draft'
                popup.close()
                with page.expect_popup() as reopened: page.locator('[data-i18n="openVkMiniApp"]').click()
                reopened.value.wait_for_load_state()
                assert len(destinations)==2
                passed.append(lang+': delayed config/local cache + touch/Enter reuses window + closed window legitimately reopens + no query/referrer')
            except Exception as e: failures.append(lang+' website: '+str(e))
            finally: ctx.close()
    print(json.dumps({'passed':len(passed),'results':passed,'failures':failures},ensure_ascii=False,indent=2),flush=True)
    assert not failures, failures

if __name__=='__main__': main()
