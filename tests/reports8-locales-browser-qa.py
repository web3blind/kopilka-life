#!/usr/bin/env python3
"""Connected RU/EN informational links and DB-IP attribution; local fixtures only."""
import base64
import hashlib
import hmac
import json
import os
import time
import urllib.parse
from playwright.sync_api import sync_playwright

BASE = os.environ['KOPILKA_QA_BASE_URL']

def main():
    failures = []
    checks = 0
    def check(ok, label):
        nonlocal checks
        checks += 1
        if not ok:
            failures.append(label)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        try:
            ctx = browser.new_context(viewport={'width':390,'height':740})
            external = []
            def route(r):
                if urllib.parse.urlsplit(r.request.url).netloc == urllib.parse.urlsplit(BASE).netloc:
                    r.continue_()
                elif r.request.is_navigation_request():
                    external.append(r.request)
                    r.fulfill(status=200, content_type='text/html', body='<h1>Intercepted public destination</h1>')
                else:
                    r.fulfill(status=200, content_type='application/javascript', body='')
            ctx.route('**/*', route)
            page = ctx.new_page()
            errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(BASE+'/?lang=en')
            page.evaluate('localStorage.setItem("kopilkaLocale","en")')
            page.reload()
            page.wait_for_function('document.documentElement.lang==="en"')
            check('IP country data' in page.locator('#loginIpAttribution').inner_text(), 'EN persisted-locale login attribution')
            auth=ctx.request.post(BASE+'/api/auth/dev',data={'firstName':'Locales fixture','locale':'en','timezone':'UTC'}).json()
            page.evaluate('(token)=>localStorage.setItem("kopilkaToken",token)', auth['token'])
            page.reload()
            page.wait_for_function('state.user && state.summary && !state.busy')
            page.locator('#entryNote').fill('Private localization draft\nsecond line')
            for lang in ['en','ru','en']:
                page.locator('#tab-button-settings').click()
                page.locator('#lang-'+lang).click()
                page.wait_for_function('(lang)=>document.documentElement.lang===lang && !state.busy',arg=lang)
                page.locator('#tab-button-today').click()
                expected='IP country data' if lang=='en' else 'Данные определения страны по IP'
                for ident in ['loginIpAttribution','appIpAttribution']:
                    check(expected in page.locator('#'+ident).text_content(), lang+' '+ident)
                    check(page.locator('#'+ident+' a').get_attribute('href')=='https://db-ip.com' and 'CC BY 4.0' in page.locator('#'+ident).text_content(),lang+' license '+ident)
                link=page.locator('.legal-links a[data-i18n="legalPartners"]')
                expected_path='/en/partners' if lang=='en' else '/partners'
                check(link.get_attribute('href')==expected_path,lang+' Today partnership path')
                if link.get_attribute('href')!=expected_path or link.get_attribute('target')!='_blank':
                    check(False,lang+' retained app partnership separate navigation')
                    continue
                link.scroll_into_view_if_needed(); link.focus()
                page.wait_for_timeout(400)
                page.evaluate('window.__before={doc:document,draft:document.querySelector("#entryNote"),user:state.user.id,token:localStorage.kopilkaToken,scroll:scrollY,focus:document.activeElement}')
                with page.expect_popup() as pop:
                    link.press('Enter')
                partner=pop.value
                partner.wait_for_load_state()
                check(urllib.parse.urlsplit(partner.url).path==expected_path,lang+' partnership opened')
                check(partner.locator('html').get_attribute('lang')==lang,lang+' partnership language')
                check(partner.locator('#partnerForm').get_attribute('data-locale')==lang,lang+' actual form locale')
                check(partner.locator('#partnerForm button[type=submit]').is_disabled(),lang+' form fail-closed without providers')
                for doc in ['privacy','terms']:
                    suffix='.en.html' if lang=='en' else '.html'
                    partner.locator('footer a[href="/'+doc+suffix+'"]').click()
                    partner.wait_for_function('Boolean(window.KopilkaDocuments)')
                    check(partner.locator('html').get_attribute('lang')==lang,lang+' nested '+doc)
                    check(partner.locator('[data-document-return]').get_attribute('href')==BASE+('/?lang=en' if lang=='en' else '/'),lang+' return '+doc)
                    partner.go_back()
                partner.close()
                check(page.evaluate('document===__before.doc && document.querySelector("#entryNote")===__before.draft && state.user.id===__before.user && localStorage.kopilkaToken===__before.token && scrollY===__before.scroll && document.activeElement===__before.focus'),lang+' retained identity DOM focus scroll token')
                check(page.locator('#entryNote').input_value()=='Private localization draft\nsecond line',lang+' draft retained')
                # Existing retained legal reader also localizes its public partnerships destination.
                page.locator('.legal-links a[data-i18n="legalPrivacy"]').click()
                dialog=page.get_by_role('dialog');dialog.locator('h1').wait_for()
                check(dialog.locator('section').get_attribute('lang')==lang,lang+' retained reader')
                links=dialog.locator('a[href*="partners"]')
                if links.count(): check(links.first.get_attribute('href')==expected_path,lang+' reader partners')
                page.keyboard.press('Escape');dialog.wait_for(state='hidden')
            page.reload(); page.wait_for_function('state.user && !state.busy')
            check(page.locator('html').get_attribute('lang')=='en','locale persists on reload')
            # Standalone canonical map, old RU paths + lang=en, nested legal links and clean returns.
            extra=ctx.new_page()
            for lang in ['ru','en']:
                for path in ['/about','/partners','/privacy.html','/terms.html']:
                    expected=(('/en'+path) if path in ['/about','/partners'] else path.replace('.html','.en.html')) if lang=='en' else path
                    extra.goto(BASE+path+'?lang='+lang+'&source=web&sign=DO_NOT_FORWARD&access_token=PRIVATE&return=https://invalid.example')
                    extra.wait_for_timeout(150)
                    check(urllib.parse.urlsplit(extra.url).path==expected,lang+' standalone canonical '+path)
                    check(extra.locator('html').get_attribute('lang')==lang,lang+' standalone '+path)
                    if path in ['/about','/partners']:
                        target_lang='ru' if lang=='en' else 'en'
                        extra.locator('a[lang="'+target_lang+'"]').click()
                        extra.wait_for_function('(lang)=>document.documentElement.lang===lang',arg=target_lang)
                        check(extra.locator('html').get_attribute('lang')==target_lang,lang+' explicit public locale switch '+path)
                        extra.go_back()
                    for a in extra.locator('a[href]').all():
                        href=a.get_attribute('href')
                        check(not any(token in href for token in ['DO_NOT_FORWARD','PRIVATE','invalid.example']),lang+' no token propagation '+path)
            # Signed VK iframe: launch/auth query remains in the owner, never in public navigation.
            signed = {'vk_app_id':'54723764','vk_user_id':'81997661510','vk_ts':str(int(time.time()))}
            digest = hmac.new(b'browser-qa-vk-secure-key',urllib.parse.urlencode(sorted(signed.items())).encode(),hashlib.sha256).digest()
            signed['sign']=base64.urlsafe_b64encode(digest).decode().rstrip('=')
            launch=BASE+'/?'+urllib.parse.urlencode(signed)+'&auth_marker=PRIVATE'
            host=ctx.new_page()
            host.goto(BASE+'/health')
            host.set_content('<button id="hostFocus">Host focus</button><iframe id="mini" style="width:390px;height:740px" src="'+launch.replace('&','&amp;')+'"></iframe>')
            frame=host.frames[1]
            frame.wait_for_function('state.user && state.summary && !state.busy')
            frame.locator('#entryNote').fill('Signed native-context draft')
            for lang in ['en','ru']:
                frame.locator('#tab-button-settings').click();frame.locator('#lang-'+lang).click()
                frame.wait_for_function('(lang)=>document.documentElement.lang===lang && !state.busy',arg=lang)
                frame.locator('#tab-button-today').click()
                check(frame.locator('#appIpAttribution').count()==0,lang+' VK attribution policy unchanged')
                href='/en/partners' if lang=='en' else '/partners'
                link=frame.locator('.legal-links a[data-i18n="legalPartners"]')
                link.scroll_into_view_if_needed();link.focus()
                frame.evaluate('window.__native={document,user:state.user.id,token:localStorage.kopilkaToken,scroll:scrollY,focus:document.activeElement}')
                with host.expect_popup() as popped: link.click()
                partner=popped.value;partner.wait_for_load_state()
                check(partner.url==BASE+href,lang+' signed clean partnership URL')
                partner.close()
                frame.locator('.legal-links a[data-i18n="legalPrivacy"]').click()
                dialog=frame.get_by_role('dialog');dialog.locator('h1').wait_for()
                for activation in ['click','enter']:
                    provider=dialog.locator('a[href="https://ai.google.dev/gemini-api/terms"]')
                    with host.expect_popup() as popped:
                        provider.click() if activation=='click' else provider.press('Enter')
                    popup=popped.value;popup.wait_for_load_state();popup.close()
                frame.keyboard.press('Escape') if hasattr(frame,'keyboard') else host.keyboard.press('Escape')
                dialog.wait_for(state='hidden')
                check(frame.url==launch,lang+' signed owner URL retained')
                check(frame.evaluate('document===__native.document && state.user.id===__native.user && localStorage.kopilkaToken===__native.token'),lang+' signed identity retained')
                check(frame.locator('#entryNote').input_value()=='Signed native-context draft',lang+' signed draft retained')
            check(len(external)==4,'four provider popups intercepted locally')
            for req in external:
                check(req.url=='https://ai.google.dev/gemini-api/terms','provider canonical URL without tokens')
                check(not any(k in req.headers for k in ['referer','authorization','cookie']),'provider no private headers')
            host.close()
            check(not errors,'no app JS errors')
            ctx.close()
            print(json.dumps({'checks':checks,'failures':failures},ensure_ascii=False,indent=2))
            assert not failures, failures
        finally:
            browser.close()

if __name__=='__main__': main()
