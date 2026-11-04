#!/usr/bin/env python3
"""7657429/7661815: real signed app/HTTP/SQLite, controlled native editor only.
Run with run-browser-qa.py and the absolute notices-outbound-deny.cjs preload.
Optional NOTICES_QA_APP selects baseline bytes without checkout; no source slicing.
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
AUDIT = Path(os.environ['NOTICES_QA_AUDIT'])
APP = Path(os.environ.get('NOTICES_QA_APP', ROOT / 'public/app.js'))
assert os.environ['NODE_ENV'] == 'test' and 'qa.sqlite' in os.environ['DB_PATH']
assert os.environ['SCHEDULER_ENABLED'] == 'false'
assert 'notices-outbound-deny.cjs' in os.environ.get('NODE_OPTIONS', '')
AUDIT.mkdir(parents=True, exist_ok=True)
LANGS = tuple(os.environ.get('NOTICES_LANGS', 'ru,en').split(','))
assert LANGS and len(set(LANGS)) == len(LANGS) and set(LANGS) <= {'ru', 'en'}
results = []
telemetry = []
BRIDGE = '''window.qaCalls=[];window.qaStoryMode='cancel';window.vkBridge={
 supports:()=>true,subscribe:()=>{},send:async(method,params)=>{
  qaCalls.push({method,png:params?.blob?.startsWith('data:image/png;base64,'),url:params?.attachment?.url});
  if(method==='VKWebAppShowStoryBox') {
   if(qaStoryMode==='cancel-code')throw {error_type:'client_error',error_data:{error_code:4}};
   if(qaStoryMode==='cancel')throw {error_type:'client_error',error_data:{error_code:4,error_reason:'User denied'}};
   if(qaStoryMode==='code-data')return {code_data:'fixture-native-editor'};
   if(qaStoryMode==='denial')throw {error_type:'client_error',error_data:{error_code:5,error_reason:'Permission denied'}};
   if(qaStoryMode==='failure')throw Error('Native transport failed');
   if(qaStoryMode==='false')return {result:false};
   if(qaStoryMode==='pending')return new Promise(resolve=>window.qaStoryResolve=resolve);
   return {result:true};
  }
  if(method==='VKWebAppShare')return {};
  return {result:true};
 }};'''


def signed(uid):
    values = dict(vk_app_id='54723764', vk_user_id=str(uid), vk_platform='desktop_web', vk_ts=str(int(time.time())))
    check = urllib.parse.urlencode(sorted(values.items())).encode()
    values['sign'] = base64.urlsafe_b64encode(hmac.new(b'browser-qa-vk-secure-key', check, hashlib.sha256).digest()).decode().rstrip('=')
    return urllib.parse.urlencode(values)


def snapshot():
    with sqlite3.connect('file:' + os.environ['DB_PATH'] + '?mode=ro', uri=True) as db:
        return {name: db.execute('SELECT * FROM "' + name + '" ORDER BY rowid').fetchall()
                for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}


with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    try:
        for lang in LANGS:
            index = ('ru', 'en').index(lang)
            context = browser.new_context(viewport={'width':1100, 'height':900}, service_workers='block')
            errors, outbound, posts = [], [], []
            try:
                def route(r):
                    path = urllib.parse.urlparse(r.request.url).path
                    if not r.request.url.startswith(BASE + '/'):
                        outbound.append(r.request.url); r.abort()
                    elif path.startswith('/vendor/vk-bridge'):
                        r.fulfill(content_type='application/javascript', body=BRIDGE)
                    elif path == '/app.js':
                        r.fulfill(content_type='application/javascript', body=APP.read_text())
                    else:
                        r.continue_()
                context.route('**/*', route)
                query = signed(81997657429 + index)
                auth = context.request.post(BASE + '/api/auth/vk', data={'launchParams':query}).json()
                headers = {'Authorization':'Bearer ' + auth['token']}
                assert context.request.post(BASE + '/api/settings/locale', headers=headers, data={'locale':lang}).ok
                with sqlite3.connect(os.environ['DB_PATH']) as db:
                    ids = []
                    for number in range(5):
                        cursor = db.execute('''INSERT INTO support_actions
                          (slug,title,description,button_label,url,platform,kind,reward_points)
                          VALUES (?,?,?,?,?,'vk','open_url',1)''',
                          (f'notice-fixture-{lang}-{number}', f'Notice fixture {lang} {number}', 'Fixture only', 'Open fixture', 'https://vk.com/app54723764'))
                        ids.append(cursor.lastrowid)
                page = context.new_page()
                page.on('pageerror', lambda e: errors.append(str(e)))
                def response_evidence(response):
                    path = urllib.parse.urlparse(response.url).path
                    if '/api/story-card/' not in path:
                        return
                    body = response.body()
                    telemetry.append(dict(locale=lang, event='png-response', path=path,
                        status=response.status, headers=response.all_headers(), bytes=len(body),
                        signature=body[:16].hex(), sha256=hashlib.sha256(body).hexdigest(),
                        body_text=body.decode(errors='replace') if response.status != 200 else None,
                        wall=time.monotonic()))
                context.on('request', lambda r: telemetry.append(dict(locale=lang, event='client-log',
                    payload=r.post_data, wall=time.monotonic())) if urllib.parse.urlparse(r.url).path == '/api/client-log' else None)
                context.on('request', lambda r: posts.append(urllib.parse.urlparse(r.url).path) if r.method == 'POST' else None)
                page.goto(BASE + '/?' + query)
                page.wait_for_function('state.user && state.profile && state.support && !state.busy')
                page.wait_for_load_state('networkidle')
                assert page.evaluate('locale()') == lang
                uid = page.evaluate('state.user.id')
                before = snapshot()
                before_points = page.evaluate('state.support.badge.points')
                posts.clear()

                def check(name, fn):
                    try:
                        fn(); results.append(dict(locale=lang, name=name, passed=True))
                    except Exception:
                        import traceback
                        results.append(dict(locale=lang, name=name, passed=False, error=traceback.format_exc(),
                                            runtime=page.evaluate('({category:statusCategory,text:document.getElementById("statusRegion").textContent,busy:state.busy,calls:qaCalls,tab:state.activeTab})')))
                    print(json.dumps(results[-1], ensure_ascii=False), flush=True)

                def advance(milliseconds):
                    # Expiry is virtual; transport and PNG conversion are real.
                    # Never fast-forward while an editor image is still in flight.
                    assert page.locator('#shareStory').is_enabled()
                    start = page.evaluate('Date.now()')
                    wall = time.monotonic()
                    page.clock.run_for(milliseconds)
                    telemetry.append(dict(locale=lang, event='clock-advance', milliseconds=milliseconds,
                        before=start, after=page.evaluate('Date.now()'), wall_seconds=time.monotonic()-wall))

                def text(): return page.locator('#statusRegion').text_content()
                def dismiss():
                    b = page.get_by_role('button', name=page.evaluate('L("dismissNotification")'), exact=True)
                    assert b.is_visible(), 'Missing accessible explicit dismissal'
                    assert page.locator('#statusRegion').get_attribute('role') == 'status'
                    return b
                def support(number):
                    page.locator('#tab-button-support').click()
                    page.locator(f'[data-support-open="{ids[number]}"]').click()
                    page.wait_for_function('!state.busy && document.getElementById("statusRegion").textContent===L("supportCredited")')
                def story(mode='cancel'):
                    page.locator('#tab-button-profile').click()
                    page.evaluate('(m)=>{qaStoryMode=m;qaCalls=[]}', mode)
                    telemetry.append(dict(locale=lang, event='story-start', mode=mode, wall=time.monotonic(),
                        clock=page.evaluate('Date.now()'), image=page.evaluate('state.profile.vkStoryCardUrl')))
                    response_start = len(telemetry)
                    with page.expect_response(lambda r: '/api/story-card/' in r.url) as image_response:
                        page.locator('#shareStory').click()
                    response_evidence(image_response.value)
                    # Stop at either real outcome: a pre-Bridge image failure must
                    # report its HTTP evidence, not spend 30s waiting for a call
                    # that the completed handler will never make.
                    page.wait_for_function('qaCalls.some(c=>c.method==="VKWebAppShowStoryBox") || !document.getElementById("shareStory").disabled')
                    png = [e for e in telemetry[response_start:] if e['event'] == 'png-response']
                    assert len(png) == 1 and png[0]['status'] == 200 and png[0]['headers'].get('content-type') == 'image/png' and png[0]['signature'].startswith('89504e470d0a1a0a'), png
                    if mode != 'pending':
                        page.wait_for_function('!document.getElementById("shareStory").disabled')
                    calls = page.evaluate('qaCalls.filter(c=>c.method==="VKWebAppShowStoryBox")')
                    assert len(calls) == 1 and calls[0]['png'] and calls[0]['url']
                def support_expiry():
                    support(0)
                    page.locator('#tab-button-today').click()
                    page.wait_for_timeout(5350)
                    assert text() == '', '7657429 support credit persists over 5s across tabs: ' + text()
                    assert page.evaluate('document.activeElement.id') == 'heading-today'
                check('real-support-POST-five-second-tab-expiry', support_expiry)
                def story_expiry():
                    story()
                    assert text() == page.evaluate('L("storyCancelled")')
                    value = page.locator('#shareFallbackLink').input_value()
                    assert value and page.locator('#shareFallbackLink').evaluate('(e)=>document.activeElement===e')
                    page.wait_for_timeout(5350)
                    assert text() == '', '7661815 cancellation persists over 5s: ' + text()
                    assert page.locator('#shareFallback').is_visible()
                    assert page.locator('#shareFallbackLink').input_value() == value
                    assert page.locator('#shareFallbackLink').evaluate('(e)=>document.activeElement===e')
                    page.locator('#tab-button-week').click(); page.locator('#tab-button-profile').click()
                    assert text() == '' and page.locator('#shareFallbackLink').input_value() == value
                check('real-story-cancel-expiry-retains-focused-manual-copy', story_expiry)
                # Virtual time below exercises original timer callbacks, not copied functions.
                page.clock.install()
                def explicit():
                    ready_before = page.evaluate('readyNoticeDismissed')
                    support(1); dismiss().focus(); page.keyboard.press('Enter'); assert text() == ''
                    assert page.evaluate('readyNoticeDismissed') == ready_before
                    story(); value = page.locator('#shareFallbackLink').input_value()
                    dismiss().focus(); page.keyboard.press('Space'); assert text() == ''
                    assert page.locator('#shareFallbackLink').evaluate('(e)=>document.activeElement===e')
                    assert page.locator('#shareFallbackLink').input_value() == value
                    story('cancel-code'); assert text() == page.evaluate('L("storyCancelled")')
                    dismiss().click(); assert text() == ''
                check('localized-explicit-dismiss-and-focus', explicit)
                def generation():
                    support(2); advance(3000)
                    story(); message = text(); old_close = page.evaluate('window.qaOldClose=document.getElementById("dismissStatus").onclick;true')
                    assert old_close
                    advance(2100); assert text() == message, 'Older support timer erased newer cancellation'
                    page.evaluate('setStatus("New durable auth warning","error");qaOldClose()')
                    advance(6000)
                    assert text() == 'New durable auth warning' and page.locator('#dismissStatus').is_hidden()
                    page.locator('#tab-button-today').click(); assert text() == 'New durable auth warning'
                check('generation-fence-and-durable-auth-error', generation)
                def visibility():
                    support(3); page.locator('#tab-button-today').click()
                    page.evaluate('window.qaRegion=document.getElementById("statusRegion");Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"))')
                    advance(5350)
                    page.evaluate('Object.defineProperty(document,"hidden",{configurable:true,value:false});document.dispatchEvent(new Event("visibilitychange"));window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}))')
                    assert text() == '' and page.evaluate('qaRegion===document.getElementById("statusRegion")')
                    story(); page.locator('#tab-button-today').click(); advance(5350)
                    assert text() == ''
                    page.locator('#tab-button-profile').click(); assert page.locator('#shareFallback').is_visible()
                check('retained-DOM-visibility-and-story-tab-expiry', visibility)
                def durable():
                    for mode in ('denial', 'failure', 'false'):
                        story(mode); assert page.locator('#statusRegion').evaluate('(e)=>e.classList.contains("error")'), mode
                        saved = text(); page.locator('#tab-button-today').click(); advance(5500)
                        assert text() == saved and page.locator('#dismissStatus').is_hidden(), mode
                        assert page.locator('#shareStory').is_enabled()
                    story('pending'); assert page.locator('#shareStory').is_disabled()
                    page.locator('#shareStory').dispatch_event('click')
                    assert page.evaluate('qaCalls.filter(c=>c.method==="VKWebAppShowStoryBox").length') == 1
                    page.evaluate('qaStoryResolve({result:true})')
                    page.wait_for_function('!document.getElementById("shareStory").disabled')
                    assert text() == page.evaluate('L("storyEditorOpened")')
                    assert page.locator('#shareFallback').is_hidden()
                    story('code-data'); assert text() == page.evaluate('L("storyEditorOpened")')
                check('denial-transport-false-durable-and-valid-editor-unlock', durable)
                def contrasts():
                    page.wait_for_function('!state.busy && !state.refreshPending')
                    page.wait_for_load_state('networkidle')
                    # This contrast checks notice lifetime, not pointer hit-testing.
                    # Use a trusted keyboard action after the preceding editor flow.
                    page.locator('#shareRefLink').focus()
                    page.locator('#shareRefLink').press('Enter')
                    page.wait_for_function('qaCalls.some(c=>c.method==="VKWebAppShare")')
                    page.wait_for_function('statusCategory==="share-unconfirmed"')
                    value = page.locator('#shareFallbackLink').input_value(); saved = text()
                    advance(5500); assert text() == saved and value
                    dismiss().click(); assert text() == '' and page.locator('#shareFallbackLink').input_value() == value
                    page.locator('#tab-button-week').click()
                    old = page.locator('#practiceGoal').input_value()
                    options = page.locator('#practiceGoal option').evaluate_all('(xs)=>xs.map(x=>x.value)')
                    page.locator('#practiceGoal').select_option(next(x for x in options if x != old))
                    page.wait_for_function('statusCategory==="practices-updated"'); advance(5500); assert text() == ''
                check('older-share-manual-persistence-and-practice-expiry', contrasts)
                def support_repeat_failure():
                    page.locator('#tab-button-support').click()
                    count = len(posts); points = page.evaluate('state.support.badge.points')
                    repeated = page.locator(f'[data-support-open="{ids[0]}"]')
                    assert repeated.is_enabled()  # Existing repeat-open policy, not an extra credit.
                    repeated.click(); page.wait_for_function('!state.busy && statusCategory==="link-opened"')
                    assert len(posts) == count and page.evaluate('state.support.badge.points') == points
                    def reject(r):
                        r.fulfill(status=503, content_type='application/json', body='{"error":"Fixture credit unavailable"}')
                    pattern = f'**/api/support/actions/{ids[4]}/open'
                    page.route(pattern, reject)
                    page.locator(f'[data-support-open="{ids[4]}"]').click()
                    page.wait_for_function('!state.busy && statusCategory==="support-action-error"')
                    saved = text(); advance(5500)
                    assert text() == saved and page.locator('#dismissStatus').is_hidden()
                    assert page.evaluate('state.support.badge.points') == points
                    page.unroute(pattern, reject)
                check('repeat-open-no-duplicate-credit-and-failed-credit-durable', support_repeat_failure)
                def storage():
                    after = snapshot()
                    assert {k:v for k,v in before.items() if k != 'user_support_actions'} == {k:v for k,v in after.items() if k != 'user_support_actions'}, 'Unexpected DB writes outside support credits'
                    added = [row for row in after['user_support_actions'] if row not in before['user_support_actions']]
                    assert len(added) == 4 and {r[1] for r in added} == set(ids[:4]) and all(r[0] == uid for r in added)
                    assert page.evaluate('state.support.badge.points') == before_points + 4
                    assert [p for p in posts if '/api/support/actions/' in p] == [f'/api/support/actions/{i}/open' for i in ids]
                    assert all('/api/support/actions/' in p or p == '/api/client-log' for p in posts), posts
                    assert not errors, errors
                    assert all(u == 'https://telegram.org/js/telegram-web-app.js' for u in outbound), outbound
                check('SQLite-only-four-exact-credits-no-auth-referral-LIFE-or-publish-writes', storage)
            finally:
                context.close()
    finally:
        browser.close()
        (AUDIT / 'telemetry.json').write_text(json.dumps(telemetry, ensure_ascii=False, indent=2))
        report = dict(app_sha256=hashlib.sha256(APP.read_bytes()).hexdigest(), results=results,
                      fixture_story_limits={key:os.environ[key] for key in ('RATE_LIMIT_STORY_MAX', 'RATE_LIMIT_STORY_WINDOW_MS')},
                      passed=sum(r['passed'] for r in results), failed=sum(not r['passed'] for r in results),
                      scope='Local Chromium + controlled Bridge; no live VK publish or native-device claim')
        (AUDIT / 'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
assert len(results) == 9 * len(LANGS) and all(r['passed'] for r in results), report
print(f'NOTICES_PASS {len(results)} connected {LANGS} behavior groups; outbound delivered=0')
