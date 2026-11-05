#!/usr/bin/env python3
"""Narrow Today correction: signed fixture auth, real HTTP/SQLite, trusted inputs."""
import hashlib, hmac, json, os, sqlite3, time, urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright
BASE = os.environ['KOPILKA_QA_BASE_URL']
OUT = Path(os.environ['OPEN10_OUT']); OUT.mkdir(parents=True, exist_ok=True)
results = []
def signed(uid):
    values = {'auth_date': str(int(time.time())), 'user': json.dumps({'id': uid, 'first_name': 'Today QA'})}
    secret = hmac.new(b'WebAppData', os.environ['BOT_TOKEN'].encode(), hashlib.sha256).digest()
    values['hash'] = hmac.new(secret, '\n'.join(f'{k}={v}' for k,v in sorted(values.items())).encode(), hashlib.sha256).hexdigest()
    return urllib.parse.urlencode(values)
def settle(p):
    p.wait_for_function('state.history && !state.busy && !historyDecision')
def record(lang, name, **data):
    results.append(dict(locale=lang, case=name, **data))
    (OUT/'browser-results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
    print(json.dumps(results[-1], ensure_ascii=False), flush=True)
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox','--disable-background-networking'])
    try:
        for n, lang in enumerate(('ru','en')):
            c = browser.new_context(service_workers='block')
            c.route('**/*', lambda r: r.continue_() if r.request.url.startswith(BASE+'/') else r.abort())
            try:
                init = signed(91337101+n)
                auth = c.request.post(BASE+'/api/auth/telegram', data={'initData':init}).json()
                headers = {'Authorization':'Bearer '+auth['token']}
                assert c.request.post(BASE+'/api/settings/locale', headers=headers, data={'locale':lang}).ok
                c.add_init_script('window.Telegram={WebApp:{initData:'+json.dumps(init)+',ready(){},expand(){},onEvent(){}}};')
                p = c.new_page(); errors=[]; traffic=[]; events=[]
                p.on('pageerror', lambda e: errors.append(str(e)))
                p.on('request', lambda r: traffic.append(dict(path=r.url.removeprefix(BASE), method=r.method, at=time.monotonic())))
                p.goto(BASE); settle(p)
                p.locator('#tab-button-week').click()
                p.evaluate("document.getElementById('historyToday').addEventListener('click',e=>(window.trustedToday??=[]).push(e.isTrusted))")
                def reads(): return [r for r in traffic if r['path'].startswith('/api/history')]
                before=len(reads()); p.locator('#historyToday').click(); settle(p)
                assert len(reads()) == before+1 and reads()[-1]['path']=='/api/history?days=7'
                # Held trusted Enter is bounded but never extends the fixed successful-read window.
                p.locator('#historyToday').focus()
                for _ in range(7): p.keyboard.down('Enter'); p.wait_for_timeout(80)
                p.keyboard.up('Enter'); settle(p)
                burst=reads()[before:]
                assert all(b['at']-a['at'] >= .6 for a,b in zip(burst,burst[1:])), burst
                assert all(p.evaluate('trustedToday'))
                record(lang,'first-current-Today-and-trusted-burst',requests=burst)
                # A separate device's append must become visible on a later intentional refresh.
                note='external append '+lang
                response=c.request.post(BASE+'/api/entries',headers=headers,data={'type':'joy','note':note})
                assert response.ok,response.text()
                p.wait_for_timeout(650); before=len(reads()); p.locator('#historyToday').click(); settle(p)
                assert len(reads())==before+1 and note in p.locator('#selectedDayEntries').text_content()
                with sqlite3.connect('file:'+os.environ['DB_PATH']+'?mode=ro',uri=True) as db:
                    assert db.execute('SELECT count(*) FROM entries WHERE note=?',(note,)).fetchone()==(1,)
                record(lang,'later-refresh-observes-real-external-append')
                # Stale browser date must not be sent as a date query.
                p.wait_for_timeout(650)
                p.evaluate("state.history.todayDate='2000-01-01';state.history.selectedDate='2000-01-01';state.historyDate='2000-01-01'")
                before=len(reads());p.locator('#historyToday').click();settle(p)
                assert len(reads())==before+1 and reads()[-1]['path']=='/api/history?days=7'
                assert p.evaluate('state.historyDate === state.history.todayDate')
                record(lang,'canonical-server-today-not-stale-cache')
                # A failed Previous changes the read generation but not global refreshFailed semantics.
                def fail(r): r.fulfill(status=503,json={'error':'Today fixture failed GET'})
                p.route('**/api/history?*',fail)
                p.locator('#historyPrevious').click();settle(p)
                p.unroute('**/api/history?*',fail)
                before=len(reads());p.locator('#historyToday').click();settle(p)
                assert len(reads())==before+1
                p.wait_for_timeout(650);p.route('**/api/history?*',fail)
                p.locator('#historyToday').click();settle(p);p.unroute('**/api/history?*',fail)
                before=len(reads());p.locator('#historyToday').click();settle(p)
                assert len(reads())==before+1
                record(lang,'failed-Previous-and-failed-Today-immediate-retry')
                # Real dirty editor cancellation preserves draft and issues no read.
                p.locator('[data-history-edit]').first.click()
                draft=p.locator('[data-history-edit-form] textarea');draft.fill('private unsaved '+lang)
                before=len(reads());p.locator('#historyToday').click()
                p.locator('#historyUnsavedDialog [data-history-choice="cancel"]').click();settle(p)
                assert len(reads())==before and draft.input_value()=='private unsaved '+lang
                p.locator('#historyToday').click()
                p.locator('#historyUnsavedDialog [data-history-choice="discard"]').click();settle(p)
                assert len(reads())==before+1
                record(lang,'editor-cancel-draft-and-subsequent-discard')
                # Actual signed owner B; deliver owner A's real HTTP read after the owner boundary.
                other = c.request.post(BASE+'/api/auth/telegram', data={'initData':signed(91337201+n)}).json()
                other_headers = {'Authorization':'Bearer '+other['token']}
                assert note not in c.request.get(BASE+'/api/history?days=7',headers=other_headers).text()
                def retire_owner(r):
                    old_payload = c.request.get(r.request.url,headers=headers).json()
                    p.evaluate('data=>{setVerifiedUser(data.user);state.token=data.token}',other)
                    r.fulfill(json=old_payload)
                p.route('**/api/history?*', retire_owner)
                p.wait_for_timeout(650);p.locator('#historyToday').click()
                p.wait_for_timeout(250);p.unroute('**/api/history?*', retire_owner)
                assert p.evaluate('state.history === null && state.historyDate === ""')
                p.evaluate('setBusy(false)') # New owner's bootstrap normally owns this busy reset.
                before=len(reads());p.locator('#historyToday').click();settle(p)
                assert len(reads())==before+1
                assert p.evaluate('state.user.id')==other['user']['id']
                assert note not in p.locator('#selectedDayEntries').text_content()
                assert not errors,errors
                record(lang,'retired-signed-owner-real-response-does-not-leak',errors=errors)
                (OUT/(lang+'-requests.json')).write_text(json.dumps(traffic,indent=2))
            finally: c.close()
    finally: browser.close()
assert len(results)==12
