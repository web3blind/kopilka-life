#!/usr/bin/env python3
"""Open10 connected regressions. Canonical runner, isolated DB and owned Chromium.

NODE_OPTIONS must name the absolute notices-outbound-deny.cjs fixture.
OPEN10_OUT is an external audit directory; OPEN10_MODE=red records all publishers.
No provider, AI generation, story or live account calls.
"""
import json
import os
import sqlite3
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = os.environ['KOPILKA_QA_BASE_URL']
OUT = Path(os.environ['OPEN10_OUT'])
OUT.mkdir(parents=True, exist_ok=True)
MODE = os.environ.get('OPEN10_MODE', 'green')
assert os.environ['NODE_ENV'] == 'test' and os.environ['SCHEDULER_ENABLED'] == 'false'
assert 'qa.sqlite' in os.environ['DB_PATH']
assert str(Path(os.environ['NODE_OPTIONS'].split('--require=')[1])).startswith('/')
results = []


def dump():
    (OUT / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))


def check(p, label, key):
    text = p.locator('#statusRegion').text_content()
    assert p.evaluate('L(' + json.dumps(key) + ')') in text, (label, text)
    visible = p.locator('#dismissStatus').is_visible()
    if MODE == 'red':
        p.wait_for_timeout(5200)
        result = dict(case=label, text=text, dismiss_visible=visible,
                      after=p.locator('#statusRegion').text_content())
        results.append(result)
        dump()
        print(json.dumps(result, ensure_ascii=False), flush=True)
        assert not visible and result['after'] == text, result
        return
    assert visible, (label, text)
    if label.endswith('contract-create') or label.endswith('delete-1'):
        p.locator('#dismissStatus').focus()
        p.wait_for_timeout(5200)
        assert p.locator('#statusRegion').text_content() == '', (label, 'expiry')
        assert p.evaluate('document.activeElement.id') != 'dismissStatus'
        results.append(dict(case=label, expiry=True, close_focus=p.evaluate('document.activeElement.id')))
        return
    prior=p.evaluate('document.activeElement.dataset.historyDelete') if '-delete-' in label else None
    p.locator('#dismissStatus').focus()
    p.keyboard.press('Enter')
    assert not p.locator('#statusRegion').text_content(), label
    assert p.evaluate('document.activeElement.id') != 'dismissStatus'
    if prior:
        assert p.evaluate('document.activeElement.dataset.historyDelete') == prior, 'Deletion notice close must return to surviving enabled neighbour'
    results.append(dict(case=label, close_focus=p.evaluate('document.activeElement.id')))


def settle(p):
    p.wait_for_function('state.history && state.product && !state.busy')
    p.wait_for_timeout(100)


def fail(r):
    r.fulfill(status=503, json={'error': 'Open10 fixture rejected'})


def sql(query, args=()):
    with sqlite3.connect('file:' + os.environ['DB_PATH'] + '?mode=ro', uri=True) as db:
        return db.execute(query, args).fetchall()


with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                                 args=['--no-sandbox', '--disable-background-networking'])
    try:
        for lang in ('ru', 'en'):
            ctx = browser.new_context(service_workers='block', viewport={'width': 1100, 'height': 760})
            traffic = []
            errors = []
            ctx.route('**/*', lambda r: r.continue_() if r.request.url.startswith(BASE + '/') else r.abort())
            try:
                auth = ctx.request.post(BASE + '/api/auth/dev', data={'locale': lang, 'timezone': 'UTC'}).json()
                assert auth.get('token'), auth
                headers = {'Authorization': 'Bearer ' + auth['token']}
                p = ctx.new_page()
                p.on('pageerror', lambda e: errors.append(str(e)))
                p.on('request', lambda r: traffic.append(dict(method=r.method, path=r.url.removeprefix(BASE), body=r.post_data, at=time.monotonic())))
                p.add_init_script('localStorage.setItem("kopilkaToken",' + json.dumps(auth['token']) + ')')
                p.goto(BASE)
                settle(p)
                uid = p.evaluate('state.user.id')
                assert p.evaluate('locale()') == lang
                p.evaluate('setStatus("")')
                if MODE not in ('red','probe','rapid-red'):
                    guide=p.locator('[data-i18n="firstDayGuideTitle"]')
                    assert guide.text_content()==('Как пользоваться копилкой' if lang=='ru' else 'How to use Life Harbor')
                    guide.focus();p.keyboard.press('Enter')
                    assert guide.evaluate('(e)=>e.parentElement.open')
                    assert p.locator('[data-i18n^="firstDayGuideStep"]').count()==3
                    p.keyboard.press('Space');assert not guide.evaluate('(e)=>e.parentElement.open')
                    results.append(dict(case=lang+'-neutral-guide-initial-keyboard-reusable-steps'))
                if MODE == 'guide-red':
                    title=p.locator('[data-i18n="firstDayGuideTitle"]').text_content()
                    assert title == ('Как пользоваться копилкой' if lang=='ru' else 'How to use Life Harbor'), title
                    continue
                if MODE in ('probe', 'rapid-red', 'rapid-green'):
                    # RAF records actual geometry/CSS/disabled states, not simulated handlers.
                    p.locator('#tab-button-week').click()
                    p.evaluate('''() => {
                      window.open10Frames=[];window.open10Events=[];window.open10Stop=false;
                      for(const type of ['click','keydown']) document.addEventListener(type,e=>{
                        if(e.target.closest('#historyToday,#historyPrevious,#historyNext'))
                          open10Events.push({type,trusted:e.isTrusted,key:e.key,target:e.target.id,repeat:e.repeat,t:performance.now()});
                      },true);
                      const sample=()=>{if(open10Stop)return;let b=document.getElementById('historyToday');
                        let l=document.getElementById('selectedDayEntries');let r=l.getBoundingClientRect();
                        open10Frames.push({t:performance.now(),date:state.historyDate,busy:state.busy,
                          disabled:b.disabled,opacity:getComputedStyle(b).opacity,text:l.textContent,
                          status:document.getElementById('statusRegion').textContent,rect:[r.x,r.y,r.width,r.height],
                          read:historyReadGeneration,navigation:historyNavigationGeneration});requestAnimationFrame(sample)};
                      requestAnimationFrame(sample);
                    }''')
                    p.locator('#historyToday').scroll_into_view_if_needed()
                    box = p.locator('#historyToday').bounding_box()
                    burst_start = len(traffic)
                    for _ in range(10):
                        p.mouse.click(box['x'] + box['width']/2, box['y'] + box['height']/2)
                        p.wait_for_timeout(100)
                    p.locator('#historyToday').focus()
                    p.keyboard.down('Enter')
                    for _ in range(8):
                        p.keyboard.down('Enter')
                        p.wait_for_timeout(90)
                    p.keyboard.up('Enter')
                    settle(p)
                    today_burst = [t for t in traffic[burst_start:] if t['path'].startswith('/api/history')]
                    assert today_burst and all(t['path'] == '/api/history?days=7' for t in today_burst)
                    assert all(b['at'] - a['at'] >= .6 for a, b in zip(today_burst, today_burst[1:])), today_burst
                    p.wait_for_timeout(650)
                    before_later = len([t for t in traffic if t['path'].startswith('/api/history')])
                    p.locator('#historyToday').click(); settle(p)
                    assert len([t for t in traffic if t['path'].startswith('/api/history')]) == before_later + 1
                    # Actual Previous transitions retain valid navigation; one delayed read stays locked.
                    p.route('**/api/history?*', lambda r: (time.sleep(.25), r.continue_()))
                    p.locator('#historyPrevious').focus()
                    p.keyboard.press('Enter')
                    settle(p)
                    p.unroute('**/api/history?*')
                    p.evaluate('open10Stop=true')
                    frames = p.evaluate('open10Frames')
                    events = p.evaluate('open10Events')
                    result = dict(case=lang+'-rapid-trusted-controls', frames=frames, events=events,
                                  requests=[t for t in traffic if t['path'].startswith('/api/history')])
                    (OUT / (lang+'-rapid.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2))
                    results.append(dict(case=result['case'], frames=len(frames), events=len(events), history_requests=len(result['requests'])))
                    # Clean and true dirty footer paths. Browser popup is locally fulfilled, never external I/O.
                    p.locator('#tab-button-settings').click()
                    clean = p.evaluate('''() => {let e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return {prevented:e.defaultPrevented,dirty:settingsDraftChanged(),user:state.user.timezone,control:document.getElementById('timezone').value}}''')
                    assert not clean['prevented'], clean
                    footer = p.locator('a').filter(has_text='Партнёрам' if lang=='ru' else 'For partners')
                    # Record actual public links rather than assume a particular translated label.
                    links = p.locator('.legal-links a').evaluate_all('(els)=>els.map(e=>({text:e.textContent,href:e.getAttribute("href"),target:e.target}))')
                    dialogs=[]
                    p.on('dialog',lambda d:(dialogs.append(d.type),d.dismiss()))
                    ctx.route('https://vk.ru/life_harbor_game',lambda r:r.fulfill(content_type='text/html',body='<p>Local intercepted external destination</p>'))
                    for selector in ('a[data-i18n="legalPartners"]','a[data-i18n="reportProblem"]'):
                        link=p.locator('#appShell '+selector)
                        assert link.count()==1,(selector,links)
                        with p.expect_popup() as popup:
                            link.click()
                        popup.value.wait_for_load_state('domcontentloaded');popup.value.close()
                        assert not dialogs,dialogs
                        assert not p.evaluate('settingsDraftChanged()')
                    p.locator('#eveningReminderTime').fill('21:33')
                    p.locator('#tab-button-week').click()
                    dirty = p.evaluate('''() => {let e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return {prevented:e.defaultPrevented,dirty:settingsDraftChanged(),value:document.getElementById('eveningReminderTime').value}}''')
                    assert dirty['prevented'] and dirty['value']=='21:33', dirty
                    results.append(dict(case=lang+'-settings-clean-dirty',clean=clean,dirty=dirty,links=links))
                    if MODE in ('rapid-red','rapid-green'):
                        assert len(result['requests']) == len(today_burst) + 3, 'Initial read, finite Today bursts, later refresh and Previous only'
                        assert all(e['trusted'] for e in events), events
                    p.go_back();p.wait_for_function('state.activeTab==="settings"')
                    assert p.locator('#eveningReminderTime').input_value()=='21:33'
                    # A native new-tab link does not unload even a genuinely dirty app.
                    with p.expect_popup() as popup:
                        p.locator('#appShell a[data-i18n="legalPartners"]').click()
                    popup.value.wait_for_load_state('domcontentloaded');popup.value.close()
                    assert p.evaluate('settingsDraftChanged()') and not dialogs
                    p.locator('#tab-button-week').click()
                    start=len(traffic)
                    p.route('**/api/history?*',lambda r:(time.sleep(.25),r.continue_()))
                    for _ in range(5):
                        p.locator('#historyPrevious').scroll_into_view_if_needed()
                        box=p.locator('#historyPrevious').bounding_box()
                        p.mouse.click(box['x']+box['width']/2,box['y']+box['height']/2)
                        p.wait_for_timeout(100)
                    p.locator('#historyPrevious').focus();p.keyboard.down('Enter')
                    for _ in range(4):
                        p.keyboard.down('Enter');p.wait_for_timeout(80)
                    p.keyboard.up('Enter');settle(p)
                    p.unroute('**/api/history?*')
                    requests=[t for t in traffic[start:] if t['path'].startswith('/api/history')]
                    dates=[t['path'].split('date=')[1].split('&')[0] for t in requests]
                    assert dates and dates==sorted(set(dates),reverse=True),dates
                    results.append(dict(case=lang+'-rapid-Previous-and-held-Enter-delayed-reads',dates=dates,settings_draft_retained=True))
                    continue
                # Actual committed contract creation and cancellation.
                p.locator('#tab-button-contract').click()
                p.locator('#contractTitle').fill('Open10 care goal')
                p.locator('#contractTarget').fill('One small action')
                p.locator('#contractForm button[type=submit]').click()
                p.wait_for_function('state.currentContract && !state.busy')
                cid = p.evaluate('state.currentContract.id')
                assert sql('SELECT status FROM weekly_contracts WHERE id=?', (cid,)) == [('active',)]
                assert ctx.request.get(BASE+'/api/contracts/current', headers=headers).json()['contract']['id']==cid
                check(p,lang+'-contract-create','contractCreated')
                if MODE == 'extended':
                    p.route('**/api/contracts/'+str(cid)+'/close',fail)
                    p.locator('[data-close-status="cancelled"]').click();settle(p)
                    assert p.evaluate('state.currentContract.id')==cid
                    assert sql('SELECT status FROM weekly_contracts WHERE id=?',(cid,))==[('active',)]
                    assert p.locator('#statusRegion').text_content()=='Open10 fixture rejected' and p.locator('#dismissStatus').is_hidden()
                    p.unroute('**/api/contracts/'+str(cid)+'/close',fail)
                p.locator('[data-close-status="cancelled"]').click()
                p.wait_for_function('!state.currentContract && !state.busy')
                assert sql('SELECT status FROM weekly_contracts WHERE id=?', (cid,)) == [('cancelled',)]
                check(p,lang+'-contract-cancel','contractClosed')
                # Seed only the isolated user's real HTTP entries, no direct DB writes.
                for kind in ['sleep','movement','food_water','rest','joy','gratitude']:
                    response=ctx.request.post(BASE+'/api/entries',headers=headers,data={'type':kind,'note':('Open10 long note '+kind+' ')*65})
                    assert response.ok,response.text()
                p.reload();settle(p)
                guide=p.locator('[data-i18n="firstDayGuideTitle"]')
                # Current dictionary key discovered from actual shell below, no invented select/control.
                p.locator('#tab-button-week').click()
                if MODE == 'extended':
                    edit=p.locator('[data-history-edit]').first
                    edit_id=edit.get_attribute('data-history-edit');edit.click()
                    note=p.locator('#history-note-'+edit_id);original=note.input_value()
                    note.fill('Open10 unsaved history draft')
                    p.locator('#tab-button-settings').click()
                    assert p.evaluate('''() => {let e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented}''')
                    p.locator('#tab-button-week').click()
                    assert note.input_value()=='Open10 unsaved history draft'
                    note.fill(original);p.locator('[data-history-cancel]').click()
                    other=ctx.request.post(BASE+'/api/auth/dev',data={'locale':lang,'timezone':'UTC'}).json()
                    victim=p.locator('[data-history-delete]').first.get_attribute('data-history-delete')
                    response=ctx.request.delete(BASE+'/api/entries/'+victim,headers={'Authorization':'Bearer '+other['token']},data={'confirm':True})
                    assert response.status==404,response.text()
                    assert sql('SELECT user_id FROM entries WHERE id=?',(int(victim),))==[(uid,)]
                    results.append(dict(case=lang+'-history-draft-across-tabs-beforeunload-crossowner-DELETE-fenced'))
                    # The draft/Back exercise owns a different scroll-history scenario.
                    # Start deletion geometry from a fresh settled document, as the
                    # released deletion regression does, rather than its old entry.
                    p.reload();settle(p);p.locator('#tab-button-week').click()
                for n in range(2):
                    target=p.locator('[data-history-delete]').nth(2)
                    entry_id=target.get_attribute('data-history-delete')
                    target.evaluate('(e)=>e.scrollIntoView({block:"center",behavior:"instant"})')
                    target.focus();p.wait_for_timeout(120)
                    before=p.evaluate('scrollY')
                    target.press('Enter')
                    p.locator('#historyDeleteDialog').wait_for()
                    if n==0:
                        p.keyboard.press('Escape');p.locator('#historyDeleteDialog').wait_for(state='detached')
                        if MODE == 'extended':
                            # Diagnostic only: known extra Back/cancel scroll issue;
                            # retained verbatim rather than hiding or guessing a fix.
                            p.wait_for_timeout(300)
                            assert abs(p.evaluate('scrollY')-before)<4,('cancel-scroll',before,p.evaluate('scrollY'))
                        assert p.evaluate('document.activeElement.dataset.historyDelete')==entry_id
                        p.locator('[data-history-delete="'+entry_id+'"]').press('Enter')
                    p.locator('[data-history-delete-choice="confirm"]').click()
                    p.wait_for_function('(id)=>!state.busy && !state.history.selectedEntries.some(e=>String(e.id)===id)',arg=entry_id)
                    p.wait_for_timeout(150)
                    assert not sql('SELECT id FROM entries WHERE id=?',(int(entry_id),))
                    assert abs(p.evaluate('scrollY')-before)<4,(before,p.evaluate('scrollY'))
                    assert p.evaluate('!!document.activeElement.dataset.historyDelete && !document.activeElement.disabled')
                    check(p,lang+'-delete-'+str(n),'historyDeleted')
                # Different selected date: actual GET, not the already-current Today no-op.
                p.locator('#historyPrevious').click();settle(p)
                check(p,lang+'-history-previous','historyLoaded')
                p.locator('#historyToday').click();settle(p)
                check(p,lang+'-history-today','historyLoaded')
                if MODE == 'red':
                    continue
                # Expiry on a real selected-date change; preserve current input focus.
                previous=p.evaluate('state.history.previousDate')
                p.locator('#historyDate').fill(previous)
                p.locator('#historyDate').press('Tab');settle(p)
                assert p.locator('#dismissStatus').is_visible()
                p.locator('#dismissStatus').focus();p.wait_for_timeout(5200)
                assert p.locator('#statusRegion').text_content()==''
                assert p.evaluate('document.activeElement.id')!='dismissStatus'
                results.append(dict(case=lang+'-date-GET-five-second-expiry'))
                # Old actual publisher timer/close cannot erase a new error.
                p.locator('#historyToday').click();settle(p)
                p.evaluate('window.staleClose=document.getElementById("dismissStatus").onclick;setStatus("Newer durable warning","error");staleClose()')
                p.wait_for_timeout(5200)
                assert p.locator('#statusRegion').text_content()=='Newer durable warning'
                # Read API failure is not transient success.
                p.route('**/api/history?*',fail)
                p.locator('#historyPrevious').click();settle(p)
                assert p.locator('#statusRegion').text_content()=='Open10 fixture rejected'
                assert p.locator('#dismissStatus').is_hidden()
                p.unroute('**/api/history?*',fail)
                p.wait_for_timeout(5200)
                assert p.locator('#statusRegion').text_content()=='Open10 fixture rejected'
                # Failed DELETE keeps the actual row and error.
                target=p.locator('[data-history-delete]').first
                entry_id=target.get_attribute('data-history-delete')
                p.route('**/api/entries/'+entry_id,fail)
                target.click();p.locator('[data-history-delete-choice="confirm"]').click();settle(p)
                assert sql('SELECT id FROM entries WHERE id=?',(int(entry_id),))
                assert p.locator('#statusRegion').text_content()=='Open10 fixture rejected'
                assert p.locator('#dismissStatus').is_hidden()
                p.unroute('**/api/entries/'+entry_id,fail)
                # Commit succeeds, secondary refresh fails: real DELETE + durable warning.
                p.route('**/api/history?*',fail)
                target.click();p.locator('[data-history-delete-choice="confirm"]').click();settle(p)
                assert not sql('SELECT id FROM entries WHERE id=?',(int(entry_id),))
                assert p.evaluate('state.refreshFailed')
                warning=p.locator('#statusRegion').text_content()
                assert p.evaluate('L("historyDeleted")') in warning and p.evaluate('L("refreshPending")') in warning
                assert p.locator('#dismissStatus').is_hidden()
                p.wait_for_timeout(5200);assert p.locator('#statusRegion').text_content()==warning
                p.unroute('**/api/history?*',fail)
                p.reload();settle(p)
                p.locator('#tab-button-contract').click()
                p.locator('#contractTitle').fill('Second care goal');p.locator('#contractTarget').fill('A small action')
                p.route('**/api/contracts',fail)
                p.locator('#contractForm button[type=submit]').click();settle(p)
                assert not p.evaluate('state.currentContract')
                assert p.locator('#statusRegion').text_content()=='Open10 fixture rejected' and p.locator('#dismissStatus').is_hidden()
                p.unroute('**/api/contracts',fail)
                p.route('**/api/product?*',fail)
                p.locator('#contractForm button[type=submit]').click();p.wait_for_function('state.currentContract && !state.busy')
                assert p.evaluate('state.refreshFailed')
                warning=p.locator('#statusRegion').text_content()
                assert p.evaluate('L("contractCreated")') in warning and p.evaluate('L("refreshPending")') in warning
                p.wait_for_timeout(5200);assert p.locator('#statusRegion').text_content()==warning and p.locator('#dismissStatus').is_hidden()
                p.locator('[data-close-status="cancelled"]').click();p.wait_for_function('!state.currentContract && !state.busy')
                warning=p.locator('#statusRegion').text_content()
                assert p.evaluate('L("contractClosed")') in warning and p.evaluate('L("refreshPending")') in warning
                p.wait_for_timeout(5200);assert p.locator('#statusRegion').text_content()==warning and p.locator('#dismissStatus').is_hidden()
                p.unroute('**/api/product?*',fail)
                results.append(dict(case=lang+'-API-errors-postcommit-refresh-newer-warning-fences'))
                assert not errors,errors
                (OUT/(lang+'-requests.json')).write_text(json.dumps(traffic,ensure_ascii=False,indent=2))
            finally:
                ctx.close()
                dump()
    finally:
        browser.close()
print(json.dumps({'mode':MODE,'results':results},ensure_ascii=False),flush=True)
if MODE=='red':
    raise AssertionError('RED: actual create/cancel/delete/history publishers persist without close in both locales')
