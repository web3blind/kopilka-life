#!/usr/bin/env python3
"""7612712/7611869: real HTTP/SQLite and RU/EN, fixture VK, no providers."""
import base64, hashlib, hmac, json, os, socket, sqlite3, subprocess, tempfile, time, traceback, urllib.parse, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('KOPILKA_ACTION_QA_OUT', (tempfile.gettempdir() + '/kopilka-qa/kopilka-remaining-action-dialog')))
OUT.mkdir(parents=True, exist_ok=True)
PORT = int(os.environ.get('KOPILKA_ACTION_QA_PORT', '3207'))
BASE = f'http://127.0.0.1:{PORT}'
results = []
def check(name, fn):
    try:
        fn(); results.append({'name': name, 'pass': True})
    except Exception as e:
        traceback.print_exc(); results.append({'name': name, 'pass': False, 'error': str(e)})
    print(json.dumps(results[-1], ensure_ascii=False), flush=True)
    (OUT / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
def launch(uid):
    p = {'vk_app_id': '54723764', 'vk_user_id': str(uid), 'vk_ts': str(int(time.time()))}
    p['sign'] = base64.urlsafe_b64encode(hmac.new(b'action-dialog-qa-key', urllib.parse.urlencode(sorted(p.items())).encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return urllib.parse.urlencode(p)
with socket.socket() as s:
    s.bind(('127.0.0.1', PORT))
with tempfile.TemporaryDirectory(prefix='fixture-', dir=OUT) as tmp:
    DB = Path(tmp) / 'qa.sqlite'
    env = dict(PATH=os.environ['PATH'], HOME=tmp, TMPDIR=tmp, NODE_ENV='test', PORT=str(PORT), DB_PATH=str(DB), SCHEDULER_ENABLED='false', DEV_AUTH_ENABLED='false', SESSION_SECRET='action-dialog-qa-session', BOT_TOKEN='', VK_GROUP_TOKEN='', VK_GROUP_ID='', VK_APP_ID='54723764', VK_SECURE_KEY='action-dialog-qa-key', APP_BASE_URL=BASE, WEBAPP_URL=BASE)
    boot = "require('dotenv').config=()=>({});global.fetch=()=>Promise.reject(Error('QA external blocked'));for(const n of ['http','https']){const m=require(n);m.request=m.get=()=>{throw Error('QA external blocked')}}require('./src/server.js').createApp().listen(Number(process.env.PORT),'127.0.0.1')"
    def sql(query, args=()):
        with sqlite3.connect(DB) as db: return db.execute(query, args).fetchall()
    with (OUT / 'server.log').open('w') as log:
        proc = subprocess.Popen(['node', '-e', boot], cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            for _ in range(150):
                try: urllib.request.urlopen(BASE + '/health', timeout=.5).close(); break
                except Exception:
                    if proc.poll() is not None: raise RuntimeError('server stopped')
                    time.sleep(.1)
            else: raise RuntimeError('health timeout')
            with sync_playwright() as pw:
                browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox', '--disable-background-networking'])
                try:
                    for lang, uid in [('ru',819932071), ('en',819932072)]:
                        ctx = browser.new_context(viewport={'width':390,'height':844})
                        def route(r):
                            if '/vendor/vk-bridge' in r.request.url:
                                r.fulfill(content_type='application/javascript', body="window.vkBridge={send(){return Promise.resolve({result:false})},subscribe(){},supports(){return true},supportsAsync(){return Promise.resolve(true)}}")
                            elif r.request.url.startswith(BASE + '/'): r.continue_()
                            else: r.abort()
                        ctx.route('**/*', route)
                        ctx.add_init_script('localStorage.setItem("kopilkaLocale",'+json.dumps(lang)+');window.open=()=>null;')
                        p = ctx.new_page(); errors=[]; native=[]; writes=[]
                        p.on('pageerror', lambda e: errors.append(str(e)))
                        def dismiss_native(d):
                            native.append(d.type); d.dismiss()
                        p.on('dialog', dismiss_native)
                        p.on('request', lambda r: writes.append((r.method,r.url)) if r.method in ('POST','PATCH','DELETE') else None)
                        try:
                            p.goto(BASE+'/?'+launch(uid)); p.wait_for_function('state.user && state.support && state.history && !state.busy')
                            user = p.evaluate('state.user.id')
                            for kind in ['joy','gratitude']:
                                r=p.evaluate("async kind=>await api('/api/entries',{method:'POST',body:JSON.stringify({type:kind,note:'original-'+kind})})",kind)
                            day=p.evaluate('state.history.todayDate')
                            sql("INSERT INTO entries(user_id,type,title,note,life_points,entry_date) VALUES(?, 'weekly_contract','System','',10,?)",(user,day))
                            p.evaluate('loadData()'); p.wait_for_function('state.history.selectedEntries.length===3 && !state.busy')
                            def support():
                                p.locator('#tab-button-support').click()
                                aid=p.evaluate("state.support.actions.find(a=>a.slug!=='share-kopilka').id")
                                p.locator('[data-support-open="'+str(aid)+'"]').click();p.wait_for_function('!state.busy')
                            def transient():
                                p.evaluate("setStatus('');state.refreshFailed=false")
                                before=len(writes);support()
                                assert p.locator('#statusRegion').inner_text()==p.evaluate("L('supportOpenFailed')")
                                p.locator('#tab-button-contract').click()
                                assert p.locator('#statusRegion').inner_text()==''
                                p.locator('#tab-button-support').click();assert p.locator('#statusRegion').inner_text()==''
                                assert not any('/support/actions/' in url for method,url in writes[before:]) and sql('SELECT COUNT(*) FROM user_support_actions WHERE user_id=?',(user,))==[(0,)]
                            check(lang+'-7612712-action-error-leave-return-no-credit', transient)
                            def copy_failure():
                                p.evaluate("setStatus('');state.refreshFailed=false")
                                p.locator('#tab-button-support').click()
                                aid=p.evaluate("state.support.actions.find(a=>a.slug==='share-kopilka').id")
                                button=p.locator('[data-support-open="'+str(aid)+'"]')
                                before=len(writes)
                                button.click();p.wait_for_function('!state.busy')
                                assert p.locator('#statusRegion').inner_text()==p.evaluate("L('copyRetry')")
                                button.click();p.wait_for_function('!state.busy')
                                p.locator('#tab-button-contract').click();assert p.locator('#statusRegion').inner_text()==''
                                p.evaluate('history.back()');p.wait_for_function("state.activeTab==='support'")
                                assert p.locator('#statusRegion').inner_text()==''
                                # A durable auth warning arrives during an unresolved bridge call.
                                p.evaluate("window.vkBridge.send=()=>new Promise(resolve=>window.resolveCopy=resolve);setStatus('')")
                                button.click();p.wait_for_function('typeof resolveCopy==="function"')
                                p.evaluate("setStatus(L('sessionExpiredLogin'),'error');resolveCopy({result:false})")
                                p.wait_for_function('!state.busy');p.locator('#tab-button-contract').click()
                                assert p.locator('#statusRegion').inner_text()==p.evaluate("L('sessionExpiredLogin')")
                                assert not any('/support/actions/' in url for method,url in writes[before:]) and sql('SELECT COUNT(*) FROM user_support_actions WHERE user_id=?',(user,))==[(0,)]
                                p.evaluate('window.vkBridge.send=()=>Promise.resolve({result:false})')
                            check(lang+'-copy-error-retry-back-new-durable-warning-no-credit',copy_failure)
                            def durable():
                                for key in ['refreshUnavailable','historySavedRefreshFailed','mergeNeedsConfirmation','sessionExpiredLogin']:
                                    p.evaluate("key=>{state.refreshFailed=key==='historySavedRefreshFailed';setStatus(L(key),'error')}",key)
                                    expected=p.locator('#statusRegion').inner_text();support()
                                    p.locator('#tab-button-contract').click()
                                    assert p.locator('#statusRegion').inner_text()==expected,(key,p.locator('#statusRegion').inner_text())
                                    p.locator('#tab-button-support').click();assert p.locator('#statusRegion').inner_text()==expected
                                p.evaluate("state.refreshFailed=false;setStatus('')")
                                p.locator('#tab-button-settings').click();p.locator('#eveningReminderTime').fill('21:37')
                                assert p.evaluate('state.settingsDirty')
                                p.evaluate("setStatus('unsaved warning','error')");support();p.locator('#tab-button-settings').click()
                                assert p.locator('#eveningReminderTime').input_value()=='21:37' and p.evaluate('state.settingsDirty')
                                assert p.locator('#statusRegion').inner_text()=='unsaved warning'
                            check(lang+'-durable-refresh-recovery-merge-unsaved-preserved',durable)
                            def deletion():
                                p.evaluate("state.refreshFailed=false;switchTab('week');setStatus('')")
                                before=sql('SELECT id,note,life_points FROM entries WHERE user_id=? ORDER BY id',(user,));before_writes=len(writes)
                                trigger=p.locator('[data-history-delete]').first; eid=int(trigger.get_attribute('data-history-delete') or '0')
                                assert p.locator('[data-history-delete]').count()==2
                                for mode in ['cancel','escape','back','rerender']:
                                    trigger.click()
                                    d=p.locator('#historyDeleteDialog');d.wait_for(state='visible',timeout=1500)
                                    assert not native,native
                                    assert d.get_attribute('aria-labelledby')=='historyDeleteTitle' and d.get_attribute('aria-describedby')=='historyDeleteText'
                                    assert d.locator('[data-history-delete-choice="cancel"]').evaluate('(e)=>e===document.activeElement')
                                    assert d.locator('#historyDeleteText').inner_text()==p.evaluate("L('historyDeleteConfirm')")
                                    compact=d.evaluate('(e)=>({height:e.clientHeight,content:e.querySelector(".document-content").getBoundingClientRect().height})')
                                    assert compact['height'] <= compact['content'] + 2, ('7617380 deletion dialog must fit content',compact)
                                    if mode=='cancel':
                                        p.evaluate('document.documentElement.style.fontSize="200%"')
                                        geometry=d.evaluate('(e)=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {left:r.left,right:r.right,width:e.clientWidth,scroll:e.scrollWidth,radius:s.borderRadius,background:s.backgroundColor}}')
                                        assert geometry['left']>=0 and geometry['right']<=390 and geometry['scroll']<=geometry['width']+1,geometry
                                        assert geometry['radius']!='0px' and geometry['background']!='rgba(0, 0, 0, 0)',geometry
                                        p.evaluate('document.documentElement.style.fontSize=""')
                                    p.keyboard.press('Shift+Tab');assert d.locator('[data-history-delete-choice="confirm"]').evaluate('(e)=>e===document.activeElement')
                                    p.keyboard.press('Tab');assert d.locator('[data-history-delete-choice="cancel"]').evaluate('(e)=>e===document.activeElement')
                                    if mode=='rerender':
                                        p.evaluate('renderHistory()');d.locator('[data-history-delete-choice="cancel"]').click()
                                    elif mode=='cancel': d.locator('[data-history-delete-choice="cancel"]').click()
                                    elif mode=='escape': p.keyboard.press('Escape')
                                    else: p.evaluate('history.back()')
                                    d.wait_for(state='detached');p.wait_for_function('!historyDeleteDecision')
                                    assert p.evaluate('state.activeTab')=='week'
                                    assert trigger.evaluate('(e)=>e===document.activeElement')
                                    assert sql('SELECT id,note,life_points FROM entries WHERE user_id=? ORDER BY id',(user,))==before and len(writes)==before_writes
                                system=p.evaluate("state.history.selectedEntries.find(e=>!e.editable).id")
                                p.evaluate('(id)=>deleteHistoryEntry(id)',system)
                                assert p.locator('#historyDeleteDialog').count()==0 and len(writes)==before_writes
                                # Cancel must not discard a separate unsaved history note.
                                p.locator('[data-history-edit]').first.click()
                                field=p.locator('[data-history-edit-form] textarea');field.fill('PRIVATE HISTORY DRAFT')
                                p.locator('[data-history-delete]').first.click();p.locator('[data-history-delete-choice="cancel"]').click()
                                p.wait_for_function('!historyDeleteDecision')
                                assert field.input_value()=='PRIVATE HISTORY DRAFT' and len(writes)==before_writes
                                p.locator('[data-history-cancel]').click();p.locator('[data-history-choice="discard"]').click()
                                p.wait_for_function('!historyDecision && !state.historyEditingId')
                                # Confirmation is fenced if the verified identity generation changes.
                                trigger.click();p.evaluate('authEpoch++')
                                p.locator('[data-history-delete-choice="confirm"]').click();p.wait_for_function('!historyDeleteDecision')
                                assert len(writes)==before_writes and sql('SELECT id,note,life_points FROM entries WHERE user_id=? ORDER BY id',(user,))==before
                                p.evaluate('authEpoch--')
                                # Actual DELETE failure must keep the authoritative entry and durable error.
                                def fail_delete(r):
                                    if r.request.method=='DELETE':r.fulfill(status=500,json={'error':'QA delete unavailable'})
                                    else:r.continue_()
                                ctx.route('**/api/entries/*',fail_delete)
                                trigger.click();p.locator('[data-history-delete-choice="confirm"]').click()
                                p.wait_for_function('!state.busy && !historyDeleteDecision');p.wait_for_function("document.querySelector('#statusRegion').textContent==='QA delete unavailable'")
                                assert sql('SELECT id,note,life_points FROM entries WHERE user_id=? ORDER BY id',(user,))==before
                                p.locator('#tab-button-contract').click();assert p.locator('#statusRegion').inner_text()=='QA delete unavailable'
                                p.locator('#tab-button-week').click()
                                ctx.unroute('**/api/entries/*',fail_delete)
                                before_writes=len(writes)
                                trigger.click();p.locator('[data-history-delete-choice="confirm"]').click()
                                p.wait_for_function('!state.busy && !historyDeleteDecision && !document.querySelector("#historyDeleteDialog")')
                                assert sql('SELECT id FROM entries WHERE id=?',(eid,))==[]
                                assert sql('SELECT COUNT(*) FROM entries WHERE user_id=?',(user,))==[(2,)]
                                assert len([w for w in writes[before_writes:] if w[0]=='DELETE'])==1
                                assert p.evaluate('document.activeElement.id')=='heading-week'
                                assert p.evaluate("state.summary.totalLife")==sql('SELECT SUM(life_points) FROM entries WHERE user_id=?',(user,))[0][0]
                                assert not native and not errors,(native,errors)
                            check(lang+'-7611869-styled-dialog-cancel-escape-back-focus-delete-system-guard',deletion)
                        finally: ctx.close()
                finally: browser.close()
        finally:
            proc.terminate()
            try:proc.wait(timeout=10)
            except subprocess.TimeoutExpired:proc.kill();proc.wait()
with socket.socket() as s: assert s.connect_ex(('127.0.0.1',PORT))!=0,'own listener leaked'
print('cleanup: own server stopped, disposable DB removed, native verification=False')
assert all(r['pass'] for r in results),results
print('PASS',len(results),'RU/EN connected regression scenarios')
