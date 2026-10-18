#!/usr/bin/env python3
"""Wave 2 connected checks, isolated server/DB and no provider traffic."""
import os
from playwright.sync_api import sync_playwright
BASE=os.environ['KOPILKA_QA_BASE_URL']
assert os.environ['NODE_ENV']=='test' and 'qa.sqlite' in os.environ['DB_PATH']
CASE=os.environ.get('WAVE2_CASE','all')
with sync_playwright() as pw:
    browser=(pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox']) if os.environ.get('WAVE2_ISOLATED_BROWSER') else pw.chromium.connect_over_cdp(os.environ.get('KOPILKA_QA_CDP_URL','http://127.0.0.1:18800')))
    context=browser.new_context(viewport={'width':390,'height':800})
    try:
        context.route('https://**/*',lambda r:r.fulfill(status=200,body=''))
        page=context.new_page()
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(BASE+'/?dev_user_id=81992006')
        # Canonical dev login, without a provider proof.
        if page.locator('#appShell').is_hidden():
            page.evaluate("async()=>{const r=await fetch('/api/auth/dev',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:81992006})});const d=await r.json();localStorage.setItem('kopilkaToken',d.token)}")
            page.reload()
        page.wait_for_function('state.user && state.history && !state.busy',timeout=20000)
        if CASE in ('all','viewport'):
            page.locator('#tab-button-contract').click()
            field=page.locator('#stakeAmount')
            field.focus()
            page.evaluate("window.scrollBy({top:document.querySelector('#stakeAmount').getBoundingClientRect().top-260,behavior:'instant'})")
            # Keyboard can change visual viewport without layout viewport/nav resizing.
            page.evaluate("window.qaNativeViewport=visualViewport;window.qaViewport=new EventTarget();qaViewport.height=280;qaViewport.offsetTop=0;Object.defineProperty(window,'visualViewport',{value:qaViewport,configurable:true});qaNativeViewport.dispatchEvent(new Event('resize'))")
            assert field.evaluate('(e)=>e.getBoundingClientRect().bottom')<=272
            assert page.evaluate('document.activeElement.id')=='stakeAmount'
            page.evaluate("delete window.visualViewport")
            print('PASS active field visible after keyboard visualViewport/window resize',flush=True)
        if CASE in ('all','status'):
            page.locator('#tab-button-contract').click()
            page.locator('#stakeAmount').focus()
            page.evaluate("window.scrollTo({top:200,behavior:'instant'});window.beforeScroll=scrollY;setStatus('Visible result')")
            result=page.evaluate("(()=>{const r=document.querySelector('#statusRegion').getBoundingClientRect();return {top:r.top,bottom:r.bottom,scroll:scrollY,focus:document.activeElement.id}})()")
            assert result['top']>=0 and result['bottom']<=800, result
            assert result['scroll']==page.evaluate('beforeScroll') and result['focus']=='stakeAmount',result
            print('PASS visible live status, no focus/scroll stealing',flush=True)
        if CASE in ('all','layout'):
            for size in [16,32]:
                page.evaluate('(size)=>document.documentElement.style.fontSize=size+"px"',size)
                skip=page.locator('.skip-link')
                box=skip.bounding_box()
                assert not box or box['height']<=1,box
                skip.focus()
                assert skip.bounding_box()['height']>20
                page.locator('#tab-button-today').click()
                page.locator('#gratitudePractice details').evaluate('(e)=>e.open=true')
                gaps=page.evaluate("(()=>{const row=document.querySelector('.hint-button-row'),b=[...row.children],submit=document.querySelector('[data-gratitude-submit]');return {gap:parseFloat(getComputedStyle(row).gap),next:submit.getBoundingClientRect().top-row.getBoundingClientRect().bottom}})()")
                assert gaps['gap']>=8 and gaps['next']>=8,gaps
                page.locator('#tab-button-profile').click()
                assert page.locator('.artifact-mystery').count()>0
                assert page.locator('.artifact-mystery').first.evaluate('(e)=>{const card=e.closest(".artifact-card");return e.getBoundingClientRect().width<=parseFloat(getComputedStyle(card).gridTemplateColumns)}')
            page.evaluate("document.documentElement.style.fontSize='16px'")
            print('PASS skiplink clipping/focus, gratitude gaps, locked art mobile/200%',flush=True)
        if CASE in ('all','gratitude'):
            page.locator('#tab-button-today').click()
            page.locator('#gratitudePractice details').evaluate('(e)=>e.open=true')
            page.locator('[data-gratitude-hint]').first.click()
            page.locator('[data-gratitude-submit]').click()
            page.wait_for_function("state.summary.todayEntryTypes.includes('gratitude') && !state.busy")
            assert page.locator('[data-gratitude-hint]').first.is_disabled()
            print('PASS real gratitude save disables hint controls',flush=True)
        if CASE in ('all','artifact'):
            page.locator('#tab-button-today').click()
            page.evaluate("window.scrollTo({top:300,behavior:'instant'});window.artifactScroll=scrollY;showArtifactToast([state.artifacts[0]])")
            page.mouse.move(10,200);page.mouse.wheel(0,500);page.wait_for_timeout(200)
            assert page.evaluate('scrollY')==0 and page.evaluate('getComputedStyle(document.body).position')=='fixed'
            page.keyboard.press('Escape');page.wait_for_timeout(200)
            assert page.evaluate('scrollY')==page.evaluate('artifactScroll')
            page.evaluate("showArtifactToast([state.artifacts[0],state.artifacts[1]])")
            page.locator('#artifactToastClose').click()
            assert page.evaluate('state.artifactQueue.length')==1
            assert page.evaluate('getComputedStyle(document.body).position')=='fixed'
            page.go_back();page.wait_for_timeout(200)
            assert page.locator('#artifactToast').is_hidden()
            assert page.evaluate('scrollY')==page.evaluate('artifactScroll')
            page.go_forward();page.wait_for_timeout(200)
            assert page.locator('#artifactToast').is_visible()
            assert page.evaluate('getComputedStyle(document.body).position')=='fixed'
            page.keyboard.press('Escape');page.wait_for_timeout(200)
            print('PASS artifact background scroll lock/Escape/queue/Back/Forward restore',flush=True)
        if CASE in ('all','history'):
            page.evaluate("async()=>{await api('/api/entries',{method:'POST',body:JSON.stringify({type:'rest',note:'original'})});await loadData();renderAll()}")
            page.locator('#tab-button-week').click()
            assert '..' not in page.locator('#selectedDaySummary').inner_text()
            edit=page.locator('[data-history-edit]').first
            entry_id=edit.get_attribute('data-history-edit')
            assert entry_id is not None
            edit.click()
            note=page.locator('#history-note-'+entry_id)
            note.fill('draft unchanged')
            note.evaluate('(e)=>{e.focus();e.setSelectionRange(2,7);state.user.locale="en";renderAll()}')
            assert note.input_value()=='draft unchanged'
            assert note.evaluate('(e)=>[e.selectionStart,e.selectionEnd]')==[2,7]
            form=page.locator('[data-history-edit-form]')
            assert form.locator('button[type=submit]').inner_text()=='Save note'
            form.locator('button[type=submit]').focus()
            page.route('**/api/entries/'+entry_id,lambda r:r.fulfill(status=503,json={'error':'QA save unavailable'}))
            form.locator('button[type=submit]').press('Enter')
            page.wait_for_function('!state.busy')
            assert note.input_value()=='draft unchanged'
            assert page.locator('[data-history-edit-form]').count()==1
            assert page.locator('#statusRegion').inner_text()=='QA save unavailable'
            page.unroute('**/api/entries/'+entry_id)
            form.locator('button[type=submit]').focus()
            page.evaluate('window.historyScroll=scrollY')
            form.locator('button[type=submit]').press('Enter')
            page.wait_for_function('!state.busy && !state.historyEditingId')
            assert page.evaluate('document.activeElement.dataset.historyEdit')==entry_id
            assert abs(page.evaluate('scrollY-historyScroll'))<3,page.evaluate('({now:scrollY,before:historyScroll,max:document.documentElement.scrollHeight-innerHeight})')
            page.reload();page.wait_for_function('state.history && !state.busy')
            page.locator('#tab-button-week').click()
            assert 'draft unchanged' in page.locator('#selectedDayEntries').inner_text()
            print('PASS date punctuation, live editor localization preserves selection, save focus/scroll/persistence',flush=True)
        assert not errors,errors
        print('WAVE2_ALL_PASS errors=0',flush=True)
    finally:
        context.unroute_all(behavior='ignoreErrors')
        context.close()
        browser.close()
        print('WAVE2_OWN_BROWSER_CLOSED',flush=True)
