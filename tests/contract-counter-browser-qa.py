#!/usr/bin/env python3
"""High7612046: isolated connected contract counters, not live provider acceptance."""
import base64, hashlib, hmac, json, os, socket, sqlite3, subprocess, tempfile, time
import urllib.parse, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('KOPILKA_COUNTER_EVIDENCE_DIR', (tempfile.gettempdir() + '/kopilka-qa/kopilka-critical-20261007/contract-counter-fix/green')))
OUT.mkdir(parents=True, exist_ok=True)
BASE = 'http://127.0.0.1:3199'
FIELDS = {'contractTitle': ('title', 120), 'contractTarget': ('targetValue', 300), 'stakeAmount': ('stakeAmount', 40), 'stakeCurrency': ('stakeCurrency', 20), 'rewardDescription': ('rewardDescription', 300), 'fundDescription': ('fundDescription', 300)}
rows = []

def launch(actor):
    values = {'vk_app_id': '54723764', 'vk_user_id': str(actor), 'vk_ts': str(int(time.time()))}
    values['sign'] = base64.urlsafe_b64encode(hmac.new(b'counter-fixture-signing-key', urllib.parse.urlencode(sorted(values.items())).encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return urllib.parse.urlencode(values)

def counters(page, lang):
    for field, (_, maximum) in FIELDS.items():
        value = page.locator('#' + field).input_value()
        length = len(value.encode('utf-16-le')) // 2
        counter = page.locator('#' + field + 'Counter')
        assert counter.count() == 1, f'{field}: missing current/max counter'
        expected = f'{length} из {maximum} символов' if lang == 'ru' else f'{length} of {maximum} characters'
        assert counter.inner_text() == expected, (field, counter.inner_text(), expected)
        assert field + 'Counter' in page.locator('#' + field).get_attribute('aria-describedby').split()
        assert page.locator(f'label[for="{field}"]').count() == 1
        assert counter.evaluate('(e)=>!e.closest("[aria-live=polite],[aria-live=assertive],[role=status],[role=alert]")')
        assert page.locator('#' + field).get_attribute('maxlength') == str(maximum)

with socket.socket() as sock:
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(('127.0.0.1', 3199))
with tempfile.TemporaryDirectory(prefix='contract-counter-', dir=OUT) as tmp:
    qa = Path(tmp)
    for name in ('public', 'migrations'):
        (qa / name).symlink_to(ROOT / name, target_is_directory=True)
    env = dict(PATH=os.environ['PATH'], HOME=tmp, NODE_ENV='test', PORT='3199', DB_PATH=str(qa / 'qa.sqlite'), SCHEDULER_ENABLED='false', DEV_AUTH_ENABLED='false', VK_APP_ID='54723764', VK_SECURE_KEY='counter-fixture-signing-key', SESSION_SECRET='counter-fixture-session-key', APP_BASE_URL=BASE, WEBAPP_URL=BASE, RATE_LIMIT_API_MAX='10000', RATE_LIMIT_AUTH_MAX='10000')
    for key in ('BOT_TOKEN','BOT_USERNAME','VK_GROUP_TOKEN','VK_GROUP_ID','VK_OAUTH_CLIENT_SECRET','VK_OAUTH_CLIENT_ID','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','RESEND_API_KEY','VAPID_PRIVATE_KEY','VAPID_PUBLIC_KEY'):
        env[key] = ''
    guard = qa / 'server.cjs'
    guard.write_text("const deny=()=>{throw Error('Counter QA blocks outbound')};global.fetch=deny;for(const n of ['http','https']){const m=require(n);m.request=deny;m.get=deny;}require(" + json.dumps(str(ROOT / 'src/server')) + ").createApp().listen(3199,'127.0.0.1');")
    with (OUT / 'server.log').open('w') as log:
        proc = subprocess.Popen(['node', str(guard)], cwd=qa, env=env, stdout=log, stderr=log)
        try:
            for _ in range(100):
                try:
                    urllib.request.urlopen(BASE + '/health', timeout=.5).close(); break
                except Exception:
                    if proc.poll() is not None: raise RuntimeError('server failed')
                    time.sleep(.1)
            else: raise RuntimeError('server unavailable')
            with sync_playwright() as pw:
                browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
                try:
                    for index, lang in enumerate(('ru', 'en')):
                        ctx = browser.new_context(service_workers='block', viewport={'width': 390, 'height': 844})
                        bridge = 'window.vkBridge={send(){return Promise.resolve({result:true})},subscribe(){},supports(){return true}}'
                        def route(r):
                            if '/vendor/vk-bridge' in r.request.url: r.fulfill(status=200, body=bridge, content_type='application/javascript')
                            elif r.request.url.startswith(BASE + '/'): r.continue_()
                            else: r.abort()
                        ctx.route('**/*', route)
                        try:
                            params = launch(9900319901 + index)
                            auth = ctx.request.post(BASE + '/api/auth/vk', data={'launchParams': params, 'locale': lang, 'timezone': 'UTC'}).json()
                            headers = {'Authorization': 'Bearer ' + auth['token']}
                            page = ctx.new_page(); errors = []
                            page.on('pageerror', lambda e: errors.append(str(e)))
                            page.goto(BASE + '/?' + params); page.wait_for_function('state.user && state.product && !state.busy')
                            page.locator('#tab-button-contract').click()
                            counters(page, lang)
                            checks = ['initial-localized-accessible-six-counters']
                            # Preserve the history worker's real draft guard and cancel focus.
                            assert ctx.request.post(BASE + '/api/entries', headers=headers, data={'type':'joy','note':'counter-history-saved'}).ok
                            page.evaluate('loadData().then(()=>renderAll())')
                            page.locator('#tab-button-week').click()
                            page.locator('[data-history-edit]').first.click()
                            note = page.locator('[data-history-edit-form] textarea')
                            note.fill('counter-history-unsaved')
                            note.evaluate('(e)=>{e.focus();e.setSelectionRange(2,5)}')
                            page.locator('#historyPrevious').click()
                            page.locator('#historyUnsavedDialog').wait_for(state='visible')
                            page.locator('[data-history-choice="cancel"]').press('Enter')
                            assert note.input_value() == 'counter-history-unsaved'
                            assert note.evaluate('(e)=>document.activeElement===e && e.selectionStart===2 && e.selectionEnd===5')
                            page.locator('[data-history-cancel]').click()
                            page.locator('[data-history-choice="discard"]').click()
                            history = ctx.request.get(BASE + '/api/history', headers=headers).json()
                            assert any(e.get('note') == 'counter-history-saved' for e in history['selectedEntries'])
                            page.locator('#tab-button-contract').click()
                            checks.append('history-dirty-navigation-cancel-focus-saved-note-unchanged')
                            # User input, UTF16 emoji, paste-like insertText, native max enforcement.
                            page.locator('#contractTitle').fill('🌱'); counters(page, lang)
                            page.locator('#contractTitle').press('End'); page.keyboard.insert_text('Paste'); counters(page, lang)
                            page.locator('#contractTitle').fill('x' * 130)
                            assert len(page.locator('#contractTitle').input_value()) == 120
                            counters(page, lang); checks.append('input-paste-native-max-utf16')
                            page.locator('#contractTitle').fill('draft 🌱')
                            page.locator('#contractTitle').evaluate('(e)=>{e.focus();e.setSelectionRange(2,5)}')
                            page.evaluate('renderContract()'); counters(page, lang)
                            assert page.locator('#contractTitle').evaluate('(e)=>e===document.activeElement && e.selectionStart===2 && e.selectionEnd===5')
                            assert page.locator('#contractTitle').input_value() == 'draft 🌱'
                            other = 'en' if lang == 'ru' else 'ru'
                            page.evaluate('(lang)=>setLanguage(lang)', other)
                            counters(page, other)
                            assert page.locator('#contractTitle').input_value() == 'draft 🌱'
                            # Existing withBusy disables the focused input during the real
                            # language API operation; counters must not move focus elsewhere.
                            assert page.locator('#contractTitle').evaluate('(e)=>e.selectionStart===2 && e.selectionEnd===5')
                            assert page.evaluate('!document.activeElement.matches("[data-contract-counter]")')
                            page.evaluate('(lang)=>setLanguage(lang)', lang)
                            counters(page, lang); checks.append('render-preserves-focus-language-api-preserves-draft-selection')
                            page.locator('#contractTemplates button').first.click()
                            page.locator('#templateReplaceDialog').wait_for(state='visible')
                            page.locator('[data-template-choice="cancel"]').click()
                            page.locator('#templateReplaceDialog').wait_for(state='detached')
                            assert page.locator('#contractTitle').input_value() == 'draft 🌱'
                            counters(page, lang)
                            page.locator('#contractTemplates button').first.click()
                            page.locator('#templateReplaceDialog').wait_for(state='visible')
                            page.locator('[data-template-choice="confirm"]').click()
                            page.locator('#templateReplaceDialog').wait_for(state='detached')
                            page.wait_for_function('!templateReplaceDecision')
                            counters(page, lang)
                            checks.append('template-cancel-confirm-counts')
                            page.locator('#contractTitle').fill(''); counters(page, lang)
                            page.evaluate('document.querySelector("#contractForm").reset()')
                            counters(page, lang); checks.append('clear-reset-counts')
                            # Friendly real API validation, overlength programmatic UI draft retained.
                            response = ctx.request.post(BASE + '/api/contracts', headers=headers, data={'title': 'x' * 121, 'targetValue': 'valid'})
                            assert response.status == 400 and '120' in response.json()['error']
                            page.locator('#contractTarget').fill('valid')
                            page.locator('#contractTitle').evaluate('(e)=>{e.value="x".repeat(121);e.dispatchEvent(new Event("input",{bubbles:true}))}')
                            counters(page, lang)
                            with page.expect_response(lambda r: r.url.endswith('/api/contracts') and r.request.method == 'POST') as sent:
                                page.locator('#contractForm button[type=submit]').click()
                            assert sent.value.status == 400
                            page.wait_for_function('!state.busy')
                            assert page.locator('#contractTitle').input_value() == 'x' * 121
                            assert '120' in page.locator('#statusRegion').inner_text()
                            counters(page, lang); checks.append('above-max-400-friendly-draft-retained')
                            # Real 413 response and current frontend mapping; no transport mock.
                            page.locator('#contractTitle').evaluate('(e)=>{e.value="x".repeat(70000);e.dispatchEvent(new Event("input",{bubbles:true}))}')
                            with page.expect_response(lambda r: r.url.endswith('/api/contracts') and r.request.method == 'POST') as oversized:
                                page.locator('#contractForm button[type=submit]').click()
                            assert oversized.value.status == 413
                            body = oversized.value.json()
                            assert body['code'] == 'PAYLOAD_TOO_LARGE'
                            page.wait_for_function('!state.busy')
                            expected = page.evaluate('L("inputTooLarge")')
                            assert body['error'] == expected
                            assert page.locator('#statusRegion').inner_text() == expected
                            assert len(page.locator('#contractTitle').input_value()) == 70000
                            checks.append('real-localized-backend-413-integrated-draft-retained')
                            values = {field: ('1' if field == 'stakeAmount' else 'Ж') * maximum for field, (_, maximum) in FIELDS.items()}
                            for field, value in values.items(): page.locator('#' + field).fill(value)
                            counters(page, lang)
                            # Narrow viewport, 200% text; counters remain in normal flow and do not overlap.
                            page.add_style_tag(content='html{font-size:200%}body{font-size:32px}')
                            page.set_viewport_size({'width': 320, 'height': 844})
                            geometry = page.locator('[data-contract-counter]').evaluate_all('(xs)=>xs.map(e=>{const r=e.getBoundingClientRect(),p=e.previousElementSibling.getBoundingClientRect(),n=e.nextElementSibling.getBoundingClientRect();return {id:e.id,left:r.left,right:r.right,top:r.top,bottom:r.bottom,previousBottom:p.bottom,nextTop:n.top}})')
                            for g in geometry:
                                assert g['left'] >= 0 and g['right'] <= 320, g
                                assert g['top'] >= g['previousBottom'] and g['bottom'] <= g['nextTop'], g
                            for field in FIELDS:
                                reach = page.locator('#' + field + 'Counter').evaluate('(e)=>{e.scrollIntoView({block:"center",behavior:"instant"});const r=e.getBoundingClientRect(),n=document.querySelector(".tab-bar").getBoundingClientRect();return {top:r.top,bottom:r.bottom,navTop:n.top}}')
                                assert reach['top'] >= 0 and reach['bottom'] < reach['navTop'], (field, reach)
                            page.locator('#contractTitle').focus(); page.keyboard.press('Tab')
                            assert page.locator('#contractTarget').evaluate('(e)=>document.activeElement===e')
                            checks.append('320px-200percent-no-counter-overlap-keyboard-order')
                            with page.expect_response(lambda r: r.url.endswith('/api/contracts') and r.request.method == 'POST') as created:
                                page.locator('#contractForm button[type=submit]').click()
                            assert created.value.status == 201, created.value.text()
                            page.wait_for_function('state.currentContract && !state.busy')
                            current = ctx.request.get(BASE + '/api/contracts/current', headers=headers).json()['contract']
                            columns = {'contractTitle':'title','contractTarget':'target_value','stakeAmount':'stake_amount','stakeCurrency':'stake_currency','rewardDescription':'reward_description','fundDescription':'fund_description'}
                            with sqlite3.connect(qa / 'qa.sqlite') as db:
                                saved = db.execute('SELECT ' + ','.join(columns.values()) + ' FROM weekly_contracts WHERE id=?', (current['id'],)).fetchone()
                            for (field, column), stored in zip(columns.items(), saved):
                                assert current[column] == values[field] == stored
                            checks.append('all-exact-maxima-201-real-sqlite-no-truncation')
                            assert not errors, errors
                            rows.append({'locale':lang, 'pass':True, 'checks':checks, 'geometry':geometry, 'pageErrors':errors, 'maxima': {f:m for f,(_,m) in FIELDS.items()}, 'api413':body})
                            print('PASS', lang, checks, flush=True)
                        finally: ctx.close()
                finally: browser.close()
        except Exception as e:
            rows.append({'pass':False,'error':str(e)})
            raise
        finally:
            proc.terminate(); proc.wait(timeout=10)
            (OUT / 'results.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2))
            with socket.socket() as sock: status = sock.connect_ex(('127.0.0.1',3199))
            (OUT / 'cleanup.json').write_text(json.dumps({'serverReturncode':proc.returncode,'port3199_connect_ex':status,'temporarySqliteRemovedOnExit':True,'fast_mode':False}))
            print('CLEANUP', proc.returncode, status, flush=True)
