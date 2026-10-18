#!/usr/bin/env python3
"""Isolated connected regressions; simulated bridge, real app API/SQLite."""
import json
import os
import sqlite3
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = os.environ['KOPILKA_QA_BASE_URL']
assert BASE == 'http://127.0.0.1:3321'
assert os.environ['NODE_ENV'] == 'test' and 'qa.sqlite' in os.environ['DB_PATH']
OUT = Path(os.environ['POSTRELEASE_QA_OUT'])
results = []

def record(name, **data):
    results.append(dict(case=name, **data))
    print('PASS', name, flush=True)

def rows(uid):
    with sqlite3.connect('file:' + os.environ['DB_PATH'] + '?mode=ro', uri=True) as db:
        return db.execute('SELECT id,type,note FROM entries WHERE user_id=? ORDER BY id', (uid,)).fetchall()

with sync_playwright() as pw:
    browser = (pw.webkit.launch(headless=True, **({'executable_path': os.environ['KOPILKA_WEBKIT_EXECUTABLE']} if os.environ.get('KOPILKA_WEBKIT_EXECUTABLE') else {})) if os.environ.get('POSTRELEASE_BROWSER') == 'webkit' else pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox']))
    try:
        for language in ['ru', 'en']:
            context = browser.new_context(viewport={'width':1280, 'height':900})
            context.route('**/*', lambda r: r.continue_() if r.request.url.startswith(BASE + '/') else r.abort())
            try:
                auth = context.request.post(BASE+'/api/auth/dev', data={'firstName':'Postrelease QA', 'locale':language, 'timezone':'UTC'}).json()
                p = context.new_page()
                p.add_init_script('localStorage.setItem("kopilkaToken",' + json.dumps(auth['token']) + ')')
                p.goto(BASE)
                p.wait_for_function('state.user && state.history && !state.busy')
                uid = p.evaluate('state.user.id')
                def idle():
                    p.wait_for_function('!state.busy && !state.refreshPending')
                def dismiss():
                    if p.locator('#artifactToast').is_visible():
                        p.locator('#artifactToastClose').click()
                def tab(name):
                    idle(); dismiss(); p.locator('#tab-button-'+name).click()
                # Two independent drafts; Enter/newline and blur do not submit either.
                p.locator('#entryNote').fill('Quick '+language)
                p.locator('#entryNote').press('End'); p.locator('#entryNote').press('Enter'); p.locator('#entryNote').press('Q')
                p.locator('#gratitudeNote').fill('Thanks '+language)
                p.locator('#gratitudeNote').press('End'); p.locator('#gratitudeNote').press('Enter'); p.locator('#gratitudeNote').press('G')
                p.locator('#heading-today').click()
                quick = p.locator('#entryNote').input_value()
                gratitude = p.locator('#gratitudeNote').input_value()
                assert '\n' in quick and '\n' in gratitude and rows(uid) == []
                record(language+' Enter/newline/blur do not submit', quick=quick, gratitude=gratitude)
                p.locator('[data-gratitude-submit]').focus(); p.locator('[data-gratitude-submit]').press('Enter')
                p.wait_for_function('state.summary.todayEntryTypes.includes("gratitude") && !state.busy')
                dismiss()
                assert p.locator('#entryNote').input_value() == quick
                assert p.locator('#gratitudeNote').input_value() == ''
                assert [r[1:] for r in rows(uid)] == [('gratitude', gratitude)]
                record(language+' gratitude submit saves only gratitudeNote', rows=rows(uid))
                p.locator('[data-entry-type="rest"]').click()
                p.wait_for_function('state.summary.todayEntryTypes.includes("rest") && !state.busy')
                dismiss()
                assert p.locator('#entryNote').input_value() == ''
                assert [r[1:] for r in rows(uid)] == [('gratitude', gratitude), ('rest', quick)]
                p.reload(); p.wait_for_function('state.user && state.history && !state.busy')
                assert gratitude in p.locator('#todayEntries').text_content() and quick in p.locator('#todayEntries').text_content()
                tab('week')
                assert gratitude in p.locator('#selectedDayEntries').text_content() and quick in p.locator('#selectedDayEntries').text_content()
                record(language+' separate SQLite notes reload in Today and History', rows=rows(uid))
                entry_id = rows(uid)[1][0]
                p.locator('[data-history-edit="'+str(entry_id)+'"]').click()
                editor = p.locator('#history-note-'+str(entry_id))
                editor.fill('Edited '+language); editor.press('End'); editor.press('Enter'); editor.press('N')
                edited = editor.input_value()
                p.locator('#heading-week').click()
                assert rows(uid)[1][2] == quick
                p.locator('[data-history-edit-form] button[type="submit"]').focus()
                p.locator('[data-history-edit-form] button[type="submit"]').press('Enter')
                p.wait_for_function('!state.busy && !state.historyEditingId')
                assert rows(uid)[1][2] == edited
                p.reload(); p.wait_for_function('state.history && !state.busy'); tab('week')
                assert edited in p.locator('#selectedDayEntries').text_content()
                record(language+' History newline/blur require Save; Enter on Save persists', rows=rows(uid))
                # Local fixture identity only, no provider permission/request is made.
                with sqlite3.connect(os.environ['DB_PATH']) as db:
                    db.execute('UPDATE users SET vk_id=? WHERE id=?', (900000000+uid, uid))
                p.evaluate('''() => {
                    isVkMiniApp = () => true;
                    getPublicConfig = async () => ({vkGroupId:1, vkMessagesEnabled:true});
                    window.qaSettingsWrites=0;
                    const original=window.fetch;
                    window.fetch=(...args)=>{if(String(args[0]).includes('/api/settings/vk-messages') && args[1]?.method==='POST') qaSettingsWrites++; return original(...args)};
                }''')
                cases = [('false','Promise.resolve({result:false})','vkReminderDenied'),
                         ('empty','Promise.resolve({})','vkReminderDenied'),
                         ('error','Promise.reject(new Error("fixture error"))','vkReminderDenied'),
                         ('timeout-lookalike','Promise.reject(new Error(L("vkReminderNoResult")))','vkReminderDenied'),
                         ('no-result','new Promise(resolve => { window.qaLateResolve=resolve })','vkReminderNoResult')]
                for name, expression, key in cases:
                    p.evaluate('window.vkBridge={send:()=>'+expression+'}')
                    start = time.monotonic()
                    error = p.evaluate('async()=>{try { await enableVkReminders(); return "unexpected success" } catch(e){return e.message}}')
                    elapsed = time.monotonic()-start
                    assert error == p.evaluate('(key)=>L(key)',key), (name,error)
                    assert p.evaluate('qaSettingsWrites') == 0 and not p.evaluate('state.busy')
                    if name == 'no-result':
                        assert 7.8 <= elapsed < 9.5, elapsed
                        p.evaluate('qaLateResolve({result:true})'); p.wait_for_timeout(150)
                        assert p.evaluate('qaSettingsWrites') == 0
                    record(language+' bridge '+name, error=error, elapsed=elapsed, writes=0)
                p.evaluate('window.vkBridge={send:()=>Promise.resolve({result:true})}')
                p.evaluate('async()=>{await enableVkReminders()}')
                assert p.evaluate('qaSettingsWrites') == 1 and p.evaluate('state.user.vkMessagesAllowed')
                with sqlite3.connect('file:'+os.environ['DB_PATH']+'?mode=ro',uri=True) as db:
                    saved = db.execute('SELECT vk_messages_allowed,reminders_enabled FROM users WHERE id=?',(uid,)).fetchone()
                assert saved == (1,1), saved
                record(language+' affirmative bridge result alone reaches permission save', settings=list(saved))
            finally:
                context.close()
    finally:
        browser.close()
        OUT.write_text(json.dumps(results, ensure_ascii=False, indent=2))
print(json.dumps({'passed':len(results), 'artifact':str(OUT)}))
