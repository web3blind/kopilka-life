#!/usr/bin/env python3
"""Connected regression for quality audit; only the runner's temporary server/DB."""
import json
from datetime import datetime
from zoneinfo import ZoneInfo
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = os.environ['KOPILKA_QA_BASE_URL']

def run():
    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp(os.environ.get('KOPILKA_QA_CDP_URL', 'http://127.0.0.1:18800'))
        context = browser.new_context(viewport={'width': 390, 'height': 844})
        context.route('https://**/*', lambda r: r.fulfill(status=200, body='', content_type='application/javascript'))
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        try:
            auth = context.request.post(BASE+'/api/auth/dev', data={'firstName':'Quality owner','locale':'ru','timezone':'UTC'}).json()
            page.add_init_script('localStorage.setItem("kopilkaToken", '+json.dumps(auth['token'])+');')
            page.goto(BASE)
            page.wait_for_function('state.summary && state.history && !state.busy')
            def idle():
                page.wait_for_function('!state.busy && !state.refreshPending')
            def tab(name):
                idle(); page.locator('#tab-button-'+name).click()
            tab('settings')
            page.locator('#eveningReminderTime').fill('17:31')
            tab('today')
            page.locator('#entryNote').fill('Keep independent draft')
            page.locator('#gratitudeNote').fill('Thanks for today')
            # A real successful POST followed by a failed secondary GET.
            page.route('**/api/product?*', lambda r: r.fulfill(status=503, content_type='application/json', body='{"error":"fixture unavailable"}'))
            page.locator('[data-gratitude-submit]').click()
            idle()
            assert page.locator('#entryNote').input_value() == 'Keep independent draft'
            assert page.locator('#gratitudeNote').input_value() == ''
            assert 'сохран' in page.locator('#statusRegion').inner_text() or 'записана' in page.locator('#statusRegion').inner_text()
            assert page.evaluate('state.summary.todayLife') > 0
            page.unroute('**/api/product?*')
            tab('settings')
            assert page.locator('#eveningReminderTime').input_value() == '17:31'
            page.locator('#timezone').fill('Pacific/Kiritimati')
            page.locator('#settingsForm').evaluate('form=>form.requestSubmit()'); idle()
            assert page.evaluate('state.user.timezone') == 'Pacific/Kiritimati'
            assert page.evaluate('state.history.todayDate') == datetime.now(ZoneInfo('Pacific/Kiritimati')).date().isoformat()
            assert page.locator('#entryNote').input_value() == 'Keep independent draft'
            print('PASS independent drafts, committed POST + failed refresh, timezone-dependent reload')

            tab('today')
            page.locator('[data-entry-type="joy"]').click(); idle()
            if page.locator('#artifactToast').is_visible():
                page.locator('#artifactToastClose').click()
            tab('week'); page.locator('#historyPrevious').click(); idle(); tab('today')
            assert page.locator('[data-entry-type="joy"]').evaluate('e=>!e.disabled && e.tabIndex >= 0')
            assert page.locator('[data-entry-type="joy"]').get_attribute('aria-disabled') == 'true'
            page.locator('#tab-button-today').focus(); page.keyboard.press('ArrowRight')
            assert page.locator('#tab-week').is_visible()
            assert page.evaluate('document.activeElement.id') == 'tab-button-week'
            page.keyboard.press('End')
            assert page.locator('#tab-profile').is_visible()
            page.go_back(); assert page.locator('#tab-week').is_visible()
            print('PASS focusable used actions, Arrow/End tabs, browser Back')

            tab('settings'); page.locator('#lang-en').click(); idle()
            assert page.locator('.tab-bar').get_attribute('aria-label') == 'Life Harbor sections'
            assert page.locator('#entryNote').get_attribute('placeholder') == 'Optional'
            assert not any('\u0400' <= ch <= '\u04ff' for ch in page.locator('#practiceGoal').inner_text())
            page.locator('.legal-links a[href="/privacy.html"]').click()
            page.get_by_role('button', name='Close document', exact=True).wait_for()
            assert page.locator('.document-content [lang="ru"]').count() > 0
            page.get_by_role('button', name='Close document', exact=True).click()
            print('PASS locale controls, practice options, legal reader language')

            # Public profile must never mix the owner's stats and visitor controls.
            import hashlib, hmac, time, urllib.parse
            fields={'auth_date':str(int(time.time())), 'user':json.dumps({'id':990777,'first_name':'Other owner','language_code':'en'})}
            check='\n'.join(f'{key}={fields[key]}' for key in sorted(fields))
            secret=hmac.new(b'WebAppData',os.environ['BOT_TOKEN'].encode(),hashlib.sha256).digest()
            fields['hash']=hmac.new(secret,check.encode(),hashlib.sha256).hexdigest()
            other = context.request.post(BASE+'/api/auth/telegram', data={'initData':urllib.parse.urlencode(fields),'timezone':'UTC'}).json()
            headers={'authorization':'Bearer '+other['token']}
            profile=context.request.get(BASE+'/api/profile',headers=headers).json()['profile']
            page.goto(BASE+'/p/'+profile['refCode'])
            page.locator('#publicLoginCta').wait_for()
            assert page.locator('#profileNameHeading').inner_text() == 'Other owner'
            assert page.locator('.tab-bar').is_hidden()
            page.locator('#publicLoginCta').click(); idle()
            assert page.locator('#publicStats').count()==0
            assert page.locator('#tab-today').is_visible()
            tab('profile'); assert page.locator('#profileNameHeading').inner_text() == 'Quality owner'
            print('PASS public/private profile separation and return')

            # Inject an already awarded canonical artifact only to expose the modal.
            artifact=page.evaluate('state.artifacts[0]')
            page.set_viewport_size({'width':760,'height':360})
            page.evaluate('document.documentElement.style.fontSize="32px"')
            page.evaluate('(a)=>showArtifactToast([a])',artifact)
            page.locator('#artifactToastClose').scroll_into_view_if_needed()
            rect=page.locator('#artifactToastClose').bounding_box()
            assert rect and rect['y'] >= 0 and rect['y']+rect['height'] <= 360
            page.go_back()
            assert page.locator('#artifactToast').is_hidden()
            assert not page.locator('#main').evaluate('e=>e.inert')
            print('PASS 760x360 / 200% text modal close and Back')

            # Return refresh follows a new local day without touching draft fields.
            page.evaluate('document.documentElement.style.fontSize="16px"')
            page.set_viewport_size({'width':390,'height':844})
            tab('today')
            page.evaluate('state.historyDate=state.history.todayDate; state.summary.todayLife=-999; state.lastRefresh=0')
            page.locator('#heading-today').focus()
            page.evaluate('refreshOnReturn(true)'); idle()
            assert page.evaluate('state.summary.todayLife !== -999 && state.history.selectedDate === state.history.todayDate')
            print('PASS foreground refresh synchronizes day')

            tab('support')
            action=page.evaluate('state.support.actions.find(a=>a.url && a.status === "available")')
            assert action
            before=page.evaluate('state.support.badge.points')
            page.evaluate('window.open=()=>null')
            page.locator('[data-support-open="'+str(action['id'])+'"]').click(); idle()
            assert page.evaluate('state.support.badge.points') == before
            assert page.locator('#statusRegion').evaluate('e=>e.classList.contains("error")')
            page.evaluate('window.open=()=>({opener:null,location:{replace(url){window.__opened=url}},close(){}})')
            page.locator('[data-support-open="'+str(action['id'])+'"]').click(); idle()
            opened=page.evaluate('window.__opened')
            expected=page.evaluate('(url)=>new URL(url).href', action['url'])
            assert opened == expected, {'opened':opened,'expected':expected,'status':page.locator('#statusRegion').inner_text()}
            credited=page.evaluate('state.support.badge.points')
            page.locator('[data-support-open="'+str(action['id'])+'"]').click(); idle()
            assert page.evaluate('state.support.badge.points') == credited
            print('PASS blocked support link, retry, repeat without duplicate credit')
            focus_issues=[]
            for name in ['today','week','contract','settings','support','profile']:
                tab(name)
                issues=page.evaluate("""()=>{
                  document.documentElement.style.scrollBehavior='auto';window.scrollTo(0,0);
                  const issues=[];
                  for(const e of document.querySelectorAll('[role=tabpanel]:not([hidden]) button,[role=tabpanel]:not([hidden]) input,[role=tabpanel]:not([hidden]) textarea,[role=tabpanel]:not([hidden]) select')) {
                    if(e.disabled||!e.getClientRects().length)continue;
                    e.focus();if(document.activeElement!==e)continue;
                    const r=e.getBoundingClientRect(),n=document.querySelector('.tab-bar').getBoundingClientRect();
                    if(r.bottom>n.top&&r.top<n.bottom)issues.push(e.id||e.textContent.trim().slice(0,45));
                  } return issues;
                }""")
                focus_issues.extend((name,issue) for issue in issues)
            assert not focus_issues, focus_issues
            print('PASS focused controls stay above fixed navigation across six panels')
            if os.environ.get('KOPILKA_SCREENSHOT_DIR'):
                out=Path(os.environ['KOPILKA_SCREENSHOT_DIR']); out.mkdir(parents=True,exist_ok=True)
                tab('settings'); page.locator('#lang-ru').click(); idle()
                for width,height in [(390,844),(760,720)]:
                    page.set_viewport_size({'width':width,'height':height})
                    for name in ['today','week','contract','settings','support','profile']:
                        tab(name)
                        page.evaluate('window.scrollTo(0,0)')
                        page.screenshot(path=str(out/f'{width}-{name}.png'),full_page=True)
                print('SCREENSHOTS',str(out))
            assert not errors, errors
            print('QUALITY BROWSER PASS; uncaught JS errors=0')
        finally:
            context.close(); browser.close()

if __name__ == '__main__':
    run()
