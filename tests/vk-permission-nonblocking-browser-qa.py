#!/usr/bin/env python3
"""Connected isolated app/API/SQLite; controlled bridge, no provider delivery."""
import json, os, sqlite3
from pathlib import Path
from playwright.sync_api import sync_playwright
BASE=os.environ['KOPILKA_QA_BASE_URL']
assert BASE.startswith('http://127.0.0.1:') and os.environ['NODE_ENV']=='test'
assert 'qa.sqlite' in os.environ['DB_PATH']
results=[]
def record(name):
    results.append(name); print('PASS',name,flush=True)
with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    try:
        for lang in ['ru','en']:
            ctx=browser.new_context(viewport={'width':1280,'height':900})
            ctx.route('**/*',lambda r:r.continue_() if r.request.url.startswith(BASE+'/') else r.abort())
            try:
                auth=ctx.request.post(BASE+'/api/auth/dev',data={'firstName':'Permission QA','locale':lang,'timezone':'UTC'}).json()
                uid=auth['user']['id'] if 'user' in auth else None
                p=ctx.new_page(); p.add_init_script('localStorage.setItem("kopilkaToken",'+json.dumps(auth['token'])+')')
                p.goto(BASE); p.wait_for_function('state.user && state.history && !state.busy');uid=p.evaluate('state.user.id')
                with sqlite3.connect(os.environ['DB_PATH']) as db:db.execute('UPDATE users SET vk_id=? WHERE id=?',(910000000+uid,uid))
                p.evaluate('''() => {
                    isVkMiniApp=()=>true; getPublicConfig=async()=>({vkGroupId:1,vkMessagesEnabled:true});
                    state.user.vkLinked=true;state.user.vkMessagesAllowed=false;renderAll();
                    window.qaSends=0;window.qaWrites=0;
                    const fetch0=window.fetch;window.fetch=(...a)=>{if(String(a[0]).includes('/api/settings/vk-messages')&&a[1]?.method==='POST')qaWrites++;return fetch0(...a)};
                    window.qaSetup=()=>{window.vkBridge={send:()=>{qaSends++;return new Promise((resolve,reject)=>{window.qaResolve=resolve;window.qaReject=reject})}}};qaSetup();
                }''')
                def tab(t):
                    if p.locator('#artifactToast').is_visible():p.locator('#artifactToastClose').click()
                    p.locator('#tab-button-'+t).click()
                def begin():
                    tab('settings');p.locator('#enableVkReminders').click();p.wait_for_function('qaSends>0')
                begin()
                assert not p.evaluate('state.busy'), 'permission wait still globally busy'
                assert p.locator('#enableVkReminders').is_disabled()
                assert p.locator('#enableVkReminders').get_attribute('aria-busy')=='true'
                p.evaluate("renderVkReminderOffer(); document.querySelector('#enableVkReminders').dispatchEvent(new MouseEvent('click',{bubbles:true}))")
                p.wait_for_timeout(100);assert p.evaluate('qaSends')==1
                record(lang+' local busy and duplicate/rerender guard')
                tab('today');p.locator('[data-entry-type="rest"]').click()
                p.wait_for_function('state.summary.todayEntryTypes.includes("rest") && !state.busy')
                with sqlite3.connect(os.environ['DB_PATH']) as db:assert db.execute('SELECT count(*) FROM entries WHERE user_id=? AND type=?',(uid,'rest')).fetchone()[0]==1
                record(lang+' navigation and real action persistence while waiting')
                p.evaluate('setStatus("Newer foreground result")')
                p.wait_for_function("!document.querySelector('#enableVkReminders').disabled",timeout=10000)
                assert p.locator('#statusRegion').inner_text()=='Newer foreground result'
                assert p.evaluate('qaWrites')==0
                assert p.locator('#vkReminderStatus').inner_text()==p.evaluate('L("vkReminderNoResult")')
                p.evaluate('qaResolve({result:true})');p.wait_for_timeout(150);assert p.evaluate('qaWrites')==0
                record(lang+' watchdog preserves newer status; late success ignored')
                p.evaluate('qaSends=0;qaSetup()');begin()
                tab('settings');p.locator('#eveningReminderTime').fill('21:30')
                p.locator('#settingsForm button[type=submit]').click();p.wait_for_function('!state.busy && !state.settingsDirty')
                assert p.locator('[data-enable-vk-reminders]').first.is_disabled()
                sends=p.evaluate('qaSends');p.evaluate('enableVkReminders()')
                assert p.evaluate('qaSends')==sends
                p.evaluate('qaResolve({result:true})');p.wait_for_timeout(250);assert p.evaluate('qaWrites')==0
                assert p.evaluate('state.user.eveningReminderTime')=='21:30'
                record(lang+' newer settings intent prevents permission save')
                p.evaluate('qaSends=0;qaSetup()');begin()
                p.evaluate('qaReject({error_type:"client_error",error_data:{error_code:4}})')
                p.wait_for_function("!document.querySelector('#enableVkReminders').disabled")
                assert p.evaluate('qaWrites')==0 and not p.evaluate('state.busy')
                record(lang+' denial unlocks without persistence')
                p.evaluate('qaSends=0;qaSetup()');begin()
                p.locator('#eveningReminderTime').fill('22:15')
                p.evaluate('''() => {
                    const original=window.fetch;
                    window.fetch=(...a)=>String(a[0])==='/api/entries'&&a[1]?.method==='POST'
                        ? new Promise((resolve,reject)=>{window.qaReleaseEntry=()=>original(...a).then(resolve,reject)}) : original(...a);
                }''')
                tab('today');p.locator('[data-entry-type="sleep"]').click()
                p.wait_for_function('Boolean(state.busy && window.qaReleaseEntry)')
                p.evaluate('qaResolve({result:true})');p.wait_for_timeout(100)
                assert p.evaluate('qaWrites')==0, 'permission save overlapped foreground mutation'
                p.evaluate('qaReleaseEntry()')
                p.wait_for_function('state.user.vkMessagesAllowed && !state.busy')
                tab('settings')
                assert p.evaluate('qaWrites')==1 and p.locator('#eveningReminderTime').input_value()=='22:15'
                with sqlite3.connect(os.environ['DB_PATH']) as db:assert db.execute('SELECT vk_messages_allowed,reminders_enabled,evening_reminder_time FROM users WHERE id=?',(uid,)).fetchone()==(1,1,'21:30')
                record(lang+' affirmative persistence serialized after foreground save; preserves unsaved draft')
                p.evaluate('qaSends=0;qaSetup();state.user.vkMessagesAllowed=false;renderVkReminderOffer()');begin()
                p.evaluate('authEpoch++;state.token="changed-session";qaResolve({result:true})')
                p.wait_for_timeout(250);assert p.evaluate('qaWrites')==1
                record(lang+' stale session cannot save permission')
            finally:ctx.close()
    finally:browser.close()
Path(os.environ['VK_PERMISSION_QA_OUT']).write_text(json.dumps(results,ensure_ascii=False,indent=2))
print(json.dumps({'passed':len(results)}))
