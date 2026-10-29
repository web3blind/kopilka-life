#!/usr/bin/env python3
"""Connected public SEO/form QA. Only isolated runner DB + fixture CAPTCHA; no external sends."""
import json
import os
import sqlite3
from playwright.sync_api import sync_playwright

base=os.environ['KOPILKA_QA_BASE_URL']
cdp=os.environ.get('KOPILKA_QA_CDP_URL','http://127.0.0.1:18800')
results=[]
widget="""window.turnstile={render:(selector,opts)=>{window.qaCaptcha=opts.callback;window.qaCaptchaOptions=opts;opts.callback('fixture-ok');return 1},reset:()=>window.qaCaptcha('fixture-ok')};"""
def count():
    with sqlite3.connect(os.environ['DB_PATH']) as db:
        return db.execute('select count(*) from partner_inquiries').fetchone()[0]

def fill(page,locale,tag):
    page.locator('[name=name]').fill('<img src=x onerror=alert(1)> project')
    page.locator('[name=email]').fill(f'{tag}@example.com')
    page.locator('[name=message]').fill('Proposal https://example.com <script>window.xss=true</script>')
    assert not page.locator('[name=consent]').is_checked()
    page.locator('[name=consent]').check()

with sync_playwright() as p:
    browser=p.chromium.connect_over_cdp(cdp)
    for locale,width,scale in [('ru',1280,1),('en',1280,1),('ru',390,2),('en',390,2)]:
        context=browser.new_context(viewport={'width':width,'height':900})
        page=context.new_page()
        errors=[]
        page.on('pageerror',lambda error: errors.append(str(error)))
        context.route('https://challenges.cloudflare.com/**',lambda route:route.fulfill(status=200,content_type='application/javascript',body=widget))
        try:
            prefix='/en' if locale=='en' else ''
            for kind in ['about','partners']:
                page.goto(base+prefix+'/'+kind)
                assert page.locator('h1').count()==1
                assert page.locator('html').get_attribute('lang')==locale
                assert page.locator('link[rel=canonical]').get_attribute('href')==base+prefix+'/'+kind
                schema=json.loads(page.locator('script[type="application/ld+json"]').inner_text())
                assert schema['inLanguage']==locale
            page.wait_for_function('Boolean(window.qaCaptcha)')
            page.evaluate('(s)=>document.documentElement.style.fontSize=(s*100)+"%"',scale)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1'), page.evaluate('Array.from(document.querySelectorAll("body *")).filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>({tag:e.tagName,id:e.id,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right})).slice(0,12)')
            fill(page,locale,f'qa-{locale}-{width}')
            assert page.evaluate('window.qaCaptchaOptions.language')==locale
            assert page.evaluate('window.qaCaptchaOptions.action')=='partner_inquiry'
            if width==1280:
                def status_contains(ru,en):
                    page.wait_for_function('(s)=>document.querySelector("#partnerStatus").textContent.includes(s)',arg=en if locale=='en' else ru)
                for field,bad,ru,en in [('name','','Укажи имя','Enter your name'),('email','bad','корректный e-mail','valid e-mail'),('message','','Опиши предложение','Describe your proposal')]:
                    control=page.locator(f'[name={field}]')
                    original=control.input_value()
                    control.fill(bad)
                    page.locator('button[type=submit]').click()
                    status_contains(ru,en)
                    assert control.evaluate('(el)=>el===document.activeElement')
                    control.fill(original)
                page.locator('[name=consent]').uncheck()
                page.locator('button[type=submit]').click()
                status_contains('Подтверди согласие','Confirm your consent')
                page.locator('[name=consent]').check()
                page.evaluate('window.qaCaptchaOptions["error-callback"]()')
                status_contains('Защита не загрузилась','Verification could not load')
                page.locator('button[type=submit]').click()
                status_contains('Пройди проверку','Complete verification')
                page.evaluate("window.qaCaptcha('fixture-bad')")
                before_bad=count()
                page.locator('button[type=submit]').click()
                status_contains('Проверка защиты не пройдена','Verification failed')
                assert count()==before_bad
                for code,ru,en in [(429,'Слишком много заявок','Too many inquiries'),(503,'Не удалось сохранить','could not be saved')]:
                    page.route('**/api/partners/inquiries',lambda route,request,c=code:route.fulfill(status=c,content_type='application/json',body='{"code":"QA_FAILURE"}'),times=1)
                    page.locator('button[type=submit]').click()
                    status_contains(ru,en)
                    assert page.locator('[name=message]').input_value().startswith('Proposal')
                privacy=context.new_page()
                privacy.goto(base+('/privacy.en.html' if locale=='en' else '/privacy.html'))
                assert privacy.locator('html').get_attribute('lang')==locale
                assert ('Partnership inquiries' if locale=='en' else 'Партнёрские заявки') in privacy.inner_text('body')
                assert 'Turnstile' in privacy.inner_text('body') and 'Resend' in privacy.inner_text('body')
                privacy.close()
            before=count()
            page.locator('button[type=submit]').focus()
            page.keyboard.press('Enter')
            page.wait_for_function("/Inquiry saved|Заявка сохранена/.test(document.querySelector('#partnerStatus').textContent)")
            assert count()==before+1
            assert page.locator('button[type=submit]').is_disabled()
            assert page.locator('[name=message]').input_value().endswith('</script>')
            assert page.evaluate('window.xss') is None
            assert not errors,errors
            results.append({'locale':locale,'width':width,'text_scale':scale,'saved':True,'errors':errors})
        finally:
            context.close()
    # Bad CAPTCHA is a genuine server rejection, not a mocked form result.
    context=browser.new_context()
    page=context.new_page()
    context.route('https://challenges.cloudflare.com/**',lambda route:route.fulfill(status=200,content_type='application/javascript',body=widget))
    try:
        page.goto(base+'/en/partners')
        page.wait_for_function('Boolean(window.qaCaptcha)')
        fill(page,'en','qa-retry')
        page.evaluate("window.qaCaptcha('fixture-bad')")
        before=count()
        page.locator('button[type=submit]').click()
        page.wait_for_function("document.querySelector('#partnerStatus').textContent.includes('Verification failed')")
        assert count()==before
        assert page.locator('[name=message]').input_value().startswith('Proposal')
        # Lose the response AFTER the real server has durably accepted it.
        def lose_response(route):
            response=route.fetch()
            assert response.status==202
            route.abort('failed')
        page.route('**/api/partners/inquiries',lose_response,times=1)
        page.locator('button[type=submit]').click()
        page.wait_for_function("document.querySelector('#partnerStatus').textContent.includes('could not be confirmed')")
        assert count()==before+1
        page.locator('button[type=submit]').click()
        page.wait_for_function("document.querySelector('#partnerStatus').textContent.includes('Inquiry saved')")
        assert count()==before+1
        results.append({'bad_captcha_rejected':True,'network_loss_after_commit_retry_deduplicated':True})
    finally:
        context.close()
    # CDP disconnection only; never close the shared browser process.
print(json.dumps({'passed':len(results),'cases':results},ensure_ascii=False))
