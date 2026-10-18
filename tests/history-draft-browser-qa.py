#!/usr/bin/env python3
"""History-note regression: real isolated app/API/SQLite, mocked Telegram SDK."""
import hashlib, hmac, json, os, socket, subprocess, tempfile, time, urllib.parse, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('KOPILKA_HISTORY_EVIDENCE_DIR', (tempfile.gettempdir() + '/kopilka-qa/kopilka-critical-20261007/history-draft-fix')))
OUT.mkdir(parents=True, exist_ok=True)
PORT = int(os.environ.get('KOPILKA_QA_PORT', '3196'))
BASE = f'http://127.0.0.1:{PORT}'
KEY = 'history-qa-fixture:telegram'
rows = []

def signed(uid):
    values = {'auth_date': str(int(time.time())), 'user': json.dumps({'id': uid, 'first_name': 'History QA'})}
    secret = hmac.new(b'WebAppData', KEY.encode(), hashlib.sha256).digest()
    values['hash'] = hmac.new(secret, '\n'.join(f'{k}={v}' for k, v in sorted(values.items())).encode(), hashlib.sha256).hexdigest()
    return urllib.parse.urlencode(values)

def record(name, fn):
    try:
        fn(); rows.append({'name': name, 'pass': True})
    except Exception as e:
        import traceback
        traceback.print_exc()
        rows.append({'name': name, 'pass': False, 'error': str(e)})
    (OUT / 'results.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    print(json.dumps(rows[-1], ensure_ascii=False), flush=True)

with socket.socket() as sock:
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(('127.0.0.1', PORT))
with tempfile.TemporaryDirectory(prefix='history-', dir=OUT) as tmp:
    qa = Path(tmp)
    for name in ('public', 'migrations'):
        (qa / name).symlink_to(ROOT / name, target_is_directory=True)
    env = dict(PATH=os.environ['PATH'], HOME=tmp, NODE_ENV='test', PORT=str(PORT), DB_PATH=str(qa / 'qa.sqlite'),
               SCHEDULER_ENABLED='false', DEV_AUTH_ENABLED='false', BOT_TOKEN=KEY, VK_GROUP_TOKEN='', VK_SECURE_KEY='',
               SESSION_SECRET='history-qa-session-fixture', APP_BASE_URL=BASE, WEBAPP_URL=BASE)
    guard = qa / 'block-external.cjs'
    guard.write_text("""const net = require('node:net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const options = net._normalizeArgs(args)[0];
  if (!options.path && !['127.0.0.1', '::1', 'localhost'].includes(options.host || 'localhost')) throw new Error('QA blocks external networking');
  return connect.apply(this, args);
};
""")
    with (OUT / 'server.log').open('w') as log:
        proc = subprocess.Popen(['node', '--require', str(guard), str(ROOT / 'src/server.js')], cwd=qa, env=env, stdout=log, stderr=log)
        try:
            for _ in range(100):
                try:
                    urllib.request.urlopen(BASE + '/health', timeout=1).close(); break
                except Exception:
                    if proc.poll() is not None: raise RuntimeError('server failed')
                    time.sleep(.1)
            with sync_playwright() as pw:
                browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
                def scenario(lang):
                    c = browser.new_context(viewport={'width': 390, 'height': 844})
                    c.route('**/*', lambda r: r.continue_() if r.request.url.startswith(BASE + '/') else r.abort())
                    init = signed(81993196 if lang == 'ru' else 81993197)
                    c.add_init_script('window.Telegram={WebApp:{initData:' + json.dumps(init) + ',ready(){},expand(){},onEvent(){}}};')
                    errors = []
                    try:
                        auth = c.request.post(BASE + '/api/auth/telegram', data={'initData': init}).json()
                        token = auth['token']; headers = {'Authorization': 'Bearer ' + token}
                        for kind in ('gratitude', 'joy'):
                            response = c.request.post(BASE + '/api/entries', headers=headers, data={'type': kind, 'note': 'original-' + kind})
                            assert response.ok, response.text()
                        if lang == 'en':
                            assert c.request.post(BASE + '/api/settings/locale', headers=headers, data={'locale': 'en'}).ok
                        p = c.new_page(); p.on('pageerror', lambda e: errors.append(str(e)))
                        p.goto(BASE); p.wait_for_function('state.history && !state.busy')
                        p.evaluate("switchTab('week')")
                        p.locator('[data-history-edit]').first.click()
                        note = p.locator('[data-history-edit-form] textarea')
                        note.fill('PRIVATE_UNSAVED_HISTORY'); note.evaluate('(e)=>{e.focus();e.setSelectionRange(3,9)}')
                        original_date = p.locator('#historyDate').input_value()
                        checks = []
                        def dirty():
                            field = p.locator('[data-history-edit-form] textarea')
                            field.fill('PRIVATE_UNSAVED_HISTORY')
                            field.evaluate('(e)=>{e.focus();e.setSelectionRange(3,9)}')
                            return field
                        def cancel_transition(action, name):
                            field = dirty(); date = p.locator('#historyDate').input_value()
                            action()
                            d = p.locator('#historyUnsavedDialog'); d.wait_for(state='visible')
                            assert d.get_attribute('aria-labelledby') == 'historyUnsavedTitle'
                            assert d.locator('[data-history-choice="cancel"]').evaluate('(e)=>e===document.activeElement')
                            d.locator('[data-history-choice="cancel"]').press('Enter')
                            assert p.locator('#historyDate').input_value() == date
                            assert field.input_value() == 'PRIVATE_UNSAVED_HISTORY'
                            assert field.evaluate('(e)=>document.activeElement===e && e.selectionStart===3 && e.selectionEnd===9')
                            checks.append(name)
                        cancel_transition(lambda: p.locator('#historyPrevious').click(), 'previous-cancel-focus-selection')
                        cancel_transition(lambda: p.locator('#historyToday').click(), 'today-cancel')
                        target = p.evaluate('state.history.previousDate')
                        cancel_transition(lambda: p.locator('#historyDate').evaluate('(e,date)=>{e.value=date;e.dispatchEvent(new Event("change",{bubbles:true}))}', target), 'date-picker-cancel-restores-date')
                        cancel_transition(lambda: p.locator('[data-history-date]').last.click(), 'day-list-cancel')
                        cancel_transition(lambda: p.locator('[data-history-edit]').first.click(), 'switch-editor-cancel')
                        cancel_transition(lambda: p.locator('[data-history-cancel]').click(), 'editor-cancel-keeps-dirty')
                        dirty(); p.locator('#historyPrevious').click()
                        p.locator('#historyUnsavedDialog').wait_for(state='visible')
                        p.keyboard.press('Shift+Tab')
                        assert p.locator('[data-history-choice="discard"]').evaluate('(e)=>e===document.activeElement')
                        p.keyboard.press('Shift+Tab')
                        assert p.locator('[data-history-choice="save"]').evaluate('(e)=>e===document.activeElement')
                        p.keyboard.press('Escape')
                        assert note.input_value() == 'PRIVATE_UNSAVED_HISTORY'
                        assert note.evaluate('(e)=>e===document.activeElement && e.selectionStart===3 && e.selectionEnd===9')
                        checks.append('native-modal-tab-trap-escape-restores-editor')
                        reload_dialogs = []
                        def stop_reload(d):
                            reload_dialogs.append(d.type); d.dismiss()
                        p.once('dialog', stop_reload)
                        p.evaluate('setTimeout(()=>location.reload(),0)')
                        p.wait_for_timeout(200)
                        assert reload_dialogs == ['beforeunload']
                        assert note.input_value() == 'PRIVATE_UNSAVED_HISTORY'
                        checks.append('browser-reload-warning-cancel-keeps-draft')
                        dirty()
                        p.evaluate('renderAll()'); p.evaluate('loadData()'); p.evaluate('loadHistory(state.historyDate)')
                        assert note.input_value() == 'PRIVATE_UNSAVED_HISTORY'
                        assert note.evaluate('(e)=>document.activeElement===e && e.selectionStart===3 && e.selectionEnd===9')
                        p.evaluate("setLanguage(state.user.locale==='en'?'ru':'en')")
                        assert note.input_value() == 'PRIVATE_UNSAVED_HISTORY'
                        assert note.evaluate('(e)=>e.selectionStart===3 && e.selectionEnd===9')
                        checks.append('refresh-rerender-language-preserves-editor')
                        p.evaluate("setLanguage(" + json.dumps(lang) + ")")
                        # PATCH failure must neither navigate nor remove the draft.
                        patches = []
                        def fail_patch(r):
                            if r.request.method == 'PATCH':
                                patches.append(r.request.url); r.fulfill(status=500, json={'error':'QA PATCH failure'})
                            else: r.continue_()
                        c.route('**/api/entries/*', fail_patch)
                        dirty(); p.locator('#historyPrevious').click()
                        p.locator('[data-history-choice="save"]').click()
                        p.wait_for_function('!state.busy && !historyDecision')
                        assert p.locator('#historyDate').input_value() == original_date
                        assert note.input_value() == 'PRIVATE_UNSAVED_HISTORY'
                        assert len(patches) == 1
                        checks.append('failed-patch-keeps-draft-no-navigation')
                        c.unroute('**/api/entries/*', fail_patch)
                        # Committed PATCH, failed refresh: acknowledge commit, stay put,
                        # remove the draft; retry navigation is read-only, never PATCH.
                        committed = []
                        p.on('request', lambda r: committed.append(r.url) if r.method == 'PATCH' else None)
                        c.route('**/api/history?*', lambda r: r.fulfill(status=500, json={'error':'QA refresh failure'}))
                        note.fill('PRIVATE_COMMITTED_HISTORY')
                        p.locator('#historyPrevious').click(); p.locator('[data-history-choice="save"]').click()
                        p.wait_for_function('!state.busy && !historyDecision')
                        assert p.locator('#historyDate').input_value() == original_date
                        assert p.locator('[data-history-edit-form]').count() == 0
                        assert 'PRIVATE_COMMITTED_HISTORY' in p.locator('#selectedDayEntries').inner_text()
                        assert p.evaluate('state.refreshFailed')
                        assert p.evaluate("L('historySavedRefreshFailed')") in p.locator('body').inner_text()
                        assert len(committed) == 1
                        history = c.request.get(BASE + '/api/history', headers=headers).json()
                        assert any(e['note'] == 'PRIVATE_COMMITTED_HISTORY' for e in history['selectedEntries'])
                        c.unroute('**/api/history?*')
                        p.locator('#historyPrevious').click(); p.wait_for_function('!state.busy')
                        assert p.locator('#historyDate').input_value() != original_date
                        assert len(committed) == 1
                        checks.append('committed-save-failed-refresh-no-duplicate-on-navigation')
                        p.locator('#historyToday').click(); p.wait_for_function('!state.busy')
                        p.locator('[data-history-edit]').first.click(); dirty()
                        p.locator('[data-history-edit]').first.click(); p.locator('[data-history-choice="discard"]').click()
                        assert p.locator('[data-history-edit-form]').count() == 1
                        assert p.locator('[data-history-edit-form] textarea').input_value() != 'PRIVATE_UNSAVED_HISTORY'
                        checks.append('discard-switches-to-new-editor')
                        dirty(); p.locator('#historyPrevious').click(); p.locator('[data-history-choice="discard"]').click()
                        p.wait_for_function('!state.busy')
                        # Next Cancel requires an entry on a historical day. Fixture data
                        # is inserted only into this disposable DB, never the real DB.
                        import sqlite3
                        with sqlite3.connect(qa / 'qa.sqlite') as db:
                            uid = auth['user']['id']
                            prev = p.locator('#historyDate').input_value()
                            db.execute("UPDATE entries SET entry_date=? WHERE user_id=? AND type='joy'", (prev, uid))
                        p.evaluate('loadHistory(state.historyDate)')
                        p.locator('[data-history-edit]').first.click()
                        cancel_transition(lambda: p.locator('#historyNext').click(), 'next-cancel')
                        # Successful Save then navigation: exactly one PATCH; persisted
                        # note belongs to that selected entry/date, not today's entry.
                        selected_id = p.evaluate('state.historyEditingId')
                        p.locator('#historyNext').click(); p.locator('[data-history-choice="save"]').click()
                        p.wait_for_function('!state.busy && !historyDecision')
                        assert p.locator('#historyDate').input_value() == original_date
                        with sqlite3.connect(qa / 'qa.sqlite') as db:
                            assert db.execute('SELECT note FROM entries WHERE id=? AND user_id=?', (selected_id,uid)).fetchone()[0] == 'PRIVATE_UNSAVED_HISTORY'
                            assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
                        checks.append('successful-save-next-persists-exact-entry')
                        # A same-survivor merge must also retire the private editor.
                        seed_code = "const u=require(process.argv[1]+'/src/services/usersService').upsertVkUser(Number(process.argv[4]));"
                        seed_code += "require(process.argv[1]+'/src/services/entriesService').createEntry(u.id,'joy','MERGE_SOURCE');"
                        seed_code += "const crypto=require('crypto');const t=require(process.argv[1]+'/src/auth/mergeToken').createMergeToken({primaryUserId:Number(process.argv[2]),sourceUserId:u.id,vkId:u.vk_id,authenticatedUserId:Number(process.argv[2]),sessionHash:crypto.createHash('sha256').update(process.argv[3]).digest('hex')});console.log(JSON.stringify({mergeToken:t}));"
                        seed = subprocess.check_output(['node','--require',str(guard),'-e',seed_code,str(ROOT),str(uid),p.evaluate('state.token'),str(81993900 + (lang == 'en'))], cwd=qa, env=env, text=True)
                        offer = json.loads(seed.strip().splitlines()[-1])
                        p.locator('[data-history-edit]').first.click()
                        p.locator('[data-history-edit-form] textarea').fill('MERGE_UNSAVED_ONLY')
                        p.evaluate('(offer)=>{state.pendingMerge=offer}', offer)
                        p.evaluate('confirmAccountMerge()')
                        assert p.evaluate('state.user.id') == uid
                        assert p.locator('[data-history-edit-form]').count() == 0
                        assert 'MERGE_UNSAVED_ONLY' not in p.locator('#selectedDayEntries').inner_text()
                        headers['Authorization'] = 'Bearer ' + p.evaluate('state.token')
                        checks.append('same-survivor-real-merge-clears-editor')
                        p.evaluate("switchTab('week')")
                        # Held old-account read cannot restore private editor/history in B.
                        other = c.request.post(BASE + '/api/auth/telegram', data={'initData': signed(81993200 + (lang == 'en'))}).json()
                        assert other['user']['id'] != uid
                        p.locator('[data-history-edit]').first.click(); dirty()
                        held = []
                        old_history = c.request.get(BASE + '/api/history', headers=headers).json()
                        c.route('**/api/history?*', lambda r: held.append(r))
                        p.evaluate('window.oldRead=loadHistory(state.historyDate).catch(()=>false); undefined')
                        p.wait_for_timeout(100)
                        assert held
                        p.locator('[data-history-edit-form] textarea').fill('PRIVATE_STALE_SAVE')
                        p.locator('#historyPrevious').click()
                        p.locator('[data-history-choice="save"]').click()
                        p.wait_for_function('state.busy && !historyEditor')
                        p.wait_for_timeout(100)
                        assert len(held) == 2
                        old_history = c.request.get(BASE + '/api/history', headers=headers).json()
                        c.unroute('**/api/history?*')
                        p.evaluate('(data)=>{state.token=data.token;setVerifiedUser(data.user)}', other)
                        p.evaluate('loadData()')
                        for r in held: r.fulfill(json=old_history)
                        p.wait_for_timeout(100)
                        assert p.evaluate('state.user.id') == other['user']['id']
                        assert p.locator('#historyDate').input_value() == original_date
                        assert p.locator('[data-history-edit-form]').count() == 0
                        assert 'PRIVATE_STALE_SAVE' not in p.locator('#selectedDayEntries').inner_text()
                        assert 'PRIVATE_UNSAVED_HISTORY' not in p.locator('#selectedDayEntries').inner_text()
                        assert p.evaluate('!historyEditor && !historyDecision')
                        checks.append('identity-switch-stale-read-and-save-refresh-cannot-resurrect-or-navigate')
                        # New B editor, then cross-tab website logout clears the live
                        # draft and decision immediately, before a replacement document.
                        b_headers = {'Authorization':'Bearer ' + other['token']}
                        assert c.request.post(BASE + '/api/entries', headers=b_headers, data={'type':'gratitude','note':'B-only'}).ok
                        p.evaluate('loadData()'); p.locator('[data-history-edit]').first.click(); dirty()
                        deleting_id = p.evaluate('state.historyEditingId')
                        p.evaluate('(id)=>{window.qaHistoryDelete=deleteHistoryEntry(id)}', deleting_id)
                        p.locator('#historyDeleteDialog [data-history-delete-choice="confirm"]').click()
                        p.evaluate('window.qaHistoryDelete')
                        assert p.locator('[data-history-edit-form]').count() == 0
                        assert c.request.get(BASE + '/api/history', headers=b_headers).json()['selectedEntries'] == []
                        checks.append('real-deletion-clears-relevant-draft')
                        assert c.request.post(BASE + '/api/entries', headers=b_headers, data={'type':'joy','note':'B new'}).ok
                        p.evaluate('loadData()'); p.locator('[data-history-edit]').first.click(); dirty()
                        renewed = c.request.post(BASE + '/api/auth/telegram', data={'initData': signed(81993300 + (lang == 'en'))}).json()
                        p.evaluate('(proof)=>{window.Telegram.WebApp.initData=proof}', signed(81993300 + (lang == 'en')))
                        retries = []
                        def expired(r):
                            if r.request.method == 'PATCH':
                                retries.append(r.request.url)
                                r.fulfill(status=401, json={'error':'expired fixture','code':'SESSION_EXPIRED'})
                            else: r.continue_()
                        c.route('**/api/entries/*', expired)
                        p.locator('[data-history-edit-form] button[type="submit"]').click()
                        p.wait_for_function('!state.busy')
                        assert len(retries) == 1
                        assert p.evaluate('state.user.id') == renewed['user']['id']
                        assert p.locator('[data-history-edit-form]').count() == 0
                        c.unroute('**/api/entries/*', expired)
                        checks.append('renewal-to-different-identity-never-retries-private-patch')
                        new_headers = {'Authorization':'Bearer ' + p.evaluate('state.token')}
                        assert c.request.post(BASE + '/api/entries', headers=new_headers, data={'type':'gratitude','note':'C only'}).ok
                        p.evaluate('loadData()'); p.locator('[data-history-edit]').first.click(); dirty()
                        p.locator('#historyPrevious').click(); p.locator('#historyUnsavedDialog').wait_for(state='visible')
                        p.evaluate("delete window.Telegram; window.dispatchEvent(new StorageEvent('storage',{key:'kopilkaLogoutEpoch',newValue:'QA-logout'}))")
                        p.wait_for_url('**/?signed_out=1')
                        assert p.locator('#historyUnsavedDialog').count() == 0
                        assert p.locator('[data-history-edit-form]').count() == 0
                        checks.append('logout-clears-editor-and-pending-decision')
                        assert not errors, errors
                        (OUT / ('checks-' + lang + '.json')).write_text(json.dumps(checks, indent=2))
                    finally: c.close()
                def stale_read(lang, writer, fail=False, busy=False):
                    # Hold real HTTP responses, not fabricated history. Each race
                    # has an independent signed identity and disposable SQL fixture.
                    import sqlite3
                    case = f'{writer}-{ "error" if fail else "success"}-{ "busy" if busy else "draft"}-{lang}'
                    identity = 81994000 + (lang == 'en') * 100 + {'loadHistory': 0, 'loadData': 10, 'navigateHistory': 20}[writer] + int(fail) + int(busy) * 2
                    c = browser.new_context(viewport={'width':390, 'height':844})
                    c.route('**/*', lambda r: r.continue_() if r.request.url.startswith(BASE + '/') else r.abort())
                    init = signed(identity)
                    c.add_init_script('window.Telegram={WebApp:{initData:' + json.dumps(init) + ',ready(){},expand(){},onEvent(){}}};')
                    try:
                        auth = c.request.post(BASE + '/api/auth/telegram', data={'initData':init}).json()
                        headers = {'Authorization':'Bearer ' + auth['token']}
                        if lang == 'en': assert c.request.post(BASE + '/api/settings/locale', headers=headers, data={'locale':'en'}).ok
                        for kind in ('gratitude', 'joy'):
                            assert c.request.post(BASE + '/api/entries', headers=headers, data={'type':kind,'note':'race-original-' + kind}).ok
                        p = c.new_page(); p.goto(BASE); p.wait_for_function('state.history && !state.busy')
                        p.evaluate("switchTab('week')")
                        today = p.evaluate('state.historyDate'); previous = p.evaluate('state.history.previousDate')
                        with sqlite3.connect(qa / 'qa.sqlite') as db:
                            db.execute("UPDATE entries SET entry_date=? WHERE user_id=? AND type='joy'", (previous,auth['user']['id']))
                        held = []
                        def hold(r):
                            if not held or busy:
                                held.append((r, r.fetch()))
                            else: r.continue_()
                        c.route('**/api/history?*', hold)
                        old_call = 'loadData()' if writer == 'loadData' else f'{writer}(state.historyDate)'
                        p.evaluate(f'window.raceOld={old_call}.then(()=>{{window.oldDone=true}},e=>{{window.oldError=e.message;window.oldDone=true}}); undefined')
                        for _ in range(100):
                            if len(held) == 1: break
                            p.wait_for_timeout(50)
                        assert len(held) == 1, 'old History HTTP request was not held'
                        p.evaluate('(date)=>{window.raceNew=navigateHistory(date);undefined}', previous)
                        if busy:
                            for _ in range(100):
                                if len(held) == 2: break
                                p.wait_for_timeout(50)
                            assert len(held) == 2, 'new History HTTP request was not held'
                            assert p.evaluate('state.busy')
                            loading_status = p.locator('#statusRegion').inner_text()
                            held[0][0].fulfill(status=503, json={'error':'STALE_HISTORY_ERROR'}) if fail else held[0][0].fulfill(response=held[0][1])
                            p.wait_for_function('window.oldDone')
                            assert p.evaluate('state.busy'), 'stale navigation released newer busy owner'
                            assert p.locator('#statusRegion').inner_text() == loading_status, 'stale navigation changed newer loading status'
                            assert p.locator('body').get_attribute('aria-busy') == 'true'
                            assert p.locator('#historyPrevious').is_disabled()
                            held[1][0].fulfill(response=held[1][1]); p.evaluate('window.raceNew')
                            assert p.evaluate('state.historyDate') == previous
                            assert not p.evaluate('state.busy')
                            for control in ('historyToday', 'historyDate', 'historyPrevious'):
                                assert p.locator('#' + control).is_enabled(), 'latest navigation left ' + control + ' disabled'
                            c.unroute('**/api/history?*', hold)
                            p.locator('#historyToday').click()
                            p.wait_for_function('!state.busy && state.historyDate === state.history.todayDate')
                            assert p.locator('#historyNext').is_disabled(), 'future-day control must remain disabled'
                            p.locator('#historyPrevious').click()
                            p.wait_for_function('(date)=>!state.busy && state.historyDate===date', arg=previous)
                        else:
                            p.evaluate('window.raceNew')
                            if writer != 'navigateHistory':
                                p.locator('[data-history-edit]').first.click()
                                field = p.locator('[data-history-edit-form] textarea')
                                field.fill('EXACT_PRIVATE_STALE_RACE_' + case)
                                field.evaluate('(e)=>{e.focus();e.setSelectionRange(3,11,"backward")}')
                            snapshot = '({date:state.historyDate,id:state.historyEditingId,note:document.querySelector("[data-history-edit-form] textarea")?.value||null,selection:historyEditor?[document.activeElement.selectionStart,document.activeElement.selectionEnd,document.activeElement.selectionDirection]:null,status:document.getElementById("statusRegion").textContent})'
                            before = p.evaluate(snapshot)
                            held[0][0].fulfill(status=503, json={'error':'STALE_HISTORY_ERROR'}) if fail else held[0][0].fulfill(response=held[0][1])
                            p.wait_for_function('window.oldDone'); after = p.evaluate(snapshot)
                            (OUT / ('stale-' + case + '.json')).write_text(json.dumps({'before':before,'after':after}, indent=2))
                            assert after == before, 'stale response changed latest date/editor/exact draft/selection/status'
                            assert not p.evaluate('window.oldError'), 'stale error escaped to status caller'
                            assert not p.evaluate('historyDecision')
                            if writer != 'navigateHistory':
                                saved_id = before['id']; note = before['note']
                                p.locator('[data-history-edit-form] button[type="submit"]').click()
                                p.wait_for_function('!state.busy && !state.historyEditingId')
                                with sqlite3.connect(qa / 'qa.sqlite') as db:
                                    assert db.execute('SELECT note,entry_date FROM entries WHERE id=? AND user_id=?', (saved_id,auth['user']['id'])).fetchone() == (note, previous)
                                    assert db.execute("SELECT note FROM entries WHERE user_id=? AND type='gratitude'", (auth['user']['id'],)).fetchone()[0] == 'race-original-gratitude'
                    finally: c.close()
                for lang in ('ru', 'en'):
                    record('dirty-previous-cancel-' + lang, lambda lang=lang: scenario(lang))
                    for writer in ('loadHistory', 'loadData', 'navigateHistory'):
                        for fail in (False, True):
                            record(f'stale-{writer}-{fail}-{lang}', lambda lang=lang, writer=writer, fail=fail: stale_read(lang, writer, fail))
                    for fail in (False, True):
                        record(f'stale-navigation-busy-{fail}-{lang}', lambda lang=lang, fail=fail: stale_read(lang, 'navigateHistory', fail, True))
                browser.close()
        finally:
            proc.terminate()
            try: proc.wait(timeout=10)
            except subprocess.TimeoutExpired: proc.kill(); proc.wait()
            with socket.socket() as sock:
                port_closed = sock.connect_ex(('127.0.0.1', PORT)) != 0
            (OUT / 'cleanup.json').write_text(json.dumps({'pid': proc.pid, 'alive': Path('/proc/' + str(proc.pid)).exists(), 'port': PORT, 'portClosed': port_closed, 'scheduler': False}))
assert rows and all(r['pass'] for r in rows), 'History regression failures'
print('HISTORY_DRAFT_CONNECTED_PASS', len(rows))
