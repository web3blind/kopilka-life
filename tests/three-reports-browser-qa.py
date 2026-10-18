#!/usr/bin/env python3
"""7639521/7639542 connected regression: fixture VK, real local HTTP/SQLite.
Run via run-browser-qa.py with fixtures/three-reports-preload.cjs in NODE_OPTIONS.
Chromium + suppressed native confirm is a capability regression, NOT native iOS.
"""
import base64, hashlib, hmac, json, os, sqlite3, time, urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright
BASE = os.environ['KOPILKA_QA_BASE_URL']
ROOT = Path(__file__).resolve().parents[1]
RESULTS = []
def record(name, fn):
    try:
        fn()
        RESULTS.append({'name': name, 'pass': True})
    except Exception as error:
        RESULTS.append({'name': name, 'pass': False, 'error': str(error)[:800]})
    print(json.dumps(RESULTS[-1], ensure_ascii=False), flush=True)
def launch(uid):
    p = {'vk_app_id': '54723764', 'vk_user_id': str(uid), 'vk_ts': str(int(time.time()))}
    p['sign'] = base64.urlsafe_b64encode(hmac.new(b'browser-qa-vk-secure-key', urllib.parse.urlencode(sorted(p.items())).encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return BASE + '/?' + urllib.parse.urlencode(p)
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox', '--disable-background-networking'])
    try:
        for lang, uid, width in [('ru',819976395,390),('en',819976396,390),('ru',819976397,1280),('en',819976398,1280)]:
            label=lang+'-'+str(width)
            ctx = browser.new_context(viewport={'width':width,'height':900})
            def route(r):
                if not r.request.url.startswith(BASE + '/'):
                    r.abort()
                elif '/vendor/vk-bridge' in r.request.url:
                    r.fulfill(content_type='application/javascript', body='window.vkBridge={send(){return Promise.resolve({result:false})},subscribe(){}}')
                elif os.environ.get('KOPILKA_THREE_PUBLIC') and urllib.parse.urlsplit(r.request.url).path in ('/','/index.html','/app.js','/styles.css','/i18n.js'):
                    path=urllib.parse.urlsplit(r.request.url).path
                    name='index.html' if path in ('/','/index.html') else path[1:]
                    file=Path(os.environ['KOPILKA_THREE_PUBLIC'])/name
                    if not file.exists():r.continue_()
                    else:r.fulfill(content_type={'html':'text/html','js':'application/javascript','css':'text/css'}[name.rsplit('.',1)[1]],body=file.read_text())
                elif '/app.js' in r.request.url and os.environ.get('KOPILKA_THREE_CLIENT'):
                    r.fulfill(content_type='application/javascript', body=Path(os.environ['KOPILKA_THREE_CLIENT']).read_text())
                else: r.continue_()
            ctx.route('**/*', route)
            ctx.add_init_script('localStorage.setItem("kopilkaLocale",'+json.dumps(lang)+');if(!sessionStorage.getItem("qaMergeInjected")){localStorage.setItem("kopilkaVkMergeToken","stale-fixture");sessionStorage.setItem("qaMergeInjected","1")}window.nativeConfirms=0;window.confirm=()=>{window.nativeConfirms++;return false}')
            held=[]
            ctx.route('**/api/account/merge-vk/preview', lambda r: held.append(r))
            p=ctx.new_page(); errors=[]; writes=[]
            p.on('pageerror',lambda e: errors.append(str(e)))
            p.on('request',lambda r: writes.append((r.method,urllib.parse.urlsplit(r.url).path)) if r.method in ('POST','PATCH','DELETE') else None)
            try:
                p.goto(launch(uid));p.wait_for_function('state.user && state.product && !state.busy')
                def ready():
                    deadline=time.monotonic()+10
                    while not held and time.monotonic()<deadline:p.wait_for_timeout(20)
                    assert len(held)==1
                    early=p.locator('#statusRegion').inner_text()
                    if early:p.locator('#dismissStatus').click()
                    r=held.pop();response=r.fetch();assert response.status>=400;r.fulfill(response=response)
                    p.wait_for_function('!localStorage.getItem("kopilkaVkMergeToken")')
                    p.wait_for_timeout(100)
                    assert not early, 'Ready prematurely published during pending merge'
                    assert p.locator('#statusRegion').inner_text()==p.evaluate('L("ready")')
                    p.locator('#dismissStatus').click();p.wait_for_timeout(330)
                    assert p.locator('#statusRegion').inner_text()=='' and p.locator('#dismissStatus').is_hidden()
                    # A late Ready publisher must not resurrect the same account's
                    # already-dismissed notice. This reproduces the app-level
                    # duplicate publication, NOT the native host's callback timing.
                    p.evaluate('setStatus(L("ready"),"info","ready")')
                    assert p.locator('#statusRegion').inner_text()=='' and p.locator('#dismissStatus').is_hidden(), '7639521: duplicate Ready resurrects dismissed notice'
                    p.evaluate('setStatus("durable fixture", "error")');p.wait_for_timeout(5000)
                    assert p.locator('#statusRegion').inner_text()=='durable fixture'
                record(label+'-7639521-single-dismiss-delayed-merge-warning',ready)
                def heart():
                    p.locator('#tab-button-profile').click()
                    badge=p.locator('.badge-heart')
                    out=os.environ.get('KOPILKA_THREE_BADGE_OUT')
                    if out:badge.screenshot(path=str(Path(out)/('badge-'+lang+'.png')))
                    before=badge.evaluate('(e)=>({background:getComputedStyle(e).backgroundImage,label:e.getAttribute("aria-label"),count:e.textContent,heart:getComputedStyle(e,"::before").content})')
                    assert 'radial-gradient' not in before['background'], '7639700: opaque white radial spot overlaps left heart lobe'
                    assert 'linear-gradient' in before['background'] and before['label'] and before['count'].strip()=='0'
                    assert '❤' in before['heart']
                    for size in ['large','xlarge']:
                        badge.evaluate('(e,size)=>e.dataset.size=size',size)
                        assert badge.evaluate('(e)=>e.getBoundingClientRect().width>0')
                    badge.evaluate('(e)=>delete e.dataset.size')
                record(label+'-7639700-no-white-disc-count-label-glyph-retained',heart)
                p.locator('#tab-button-contract').click()
                buttons=p.locator('[data-template-id]');assert buttons.count()>=2
                first=buttons.nth(0);second=buttons.nth(1)
                fields=['contractTitle','contractTarget','stakeAmount','stakeCurrency','rewardDescription','fundDescription']
                user_id=p.evaluate('state.user.id')
                def persisted_contracts():
                    with sqlite3.connect('file:'+os.environ['DB_PATH']+'?mode=ro',uri=True) as db:
                        return db.execute('SELECT title FROM weekly_contracts WHERE user_id=?',(user_id,)).fetchall()
                def values(): return p.evaluate('(ids)=>Object.fromEntries(ids.map(id=>[id,document.getElementById(id).value]))',fields)
                def replacement():
                    first.click();original=values();before=len(writes)
                    assert original['contractTitle']==first.inner_text()
                    second.click()
                    d=p.locator('#templateReplaceDialog');d.wait_for(state='visible',timeout=1500)
                    assert p.evaluate('nativeConfirms')==0,'window.confirm still used'
                    assert values()==original and len(writes)==before and persisted_contracts()==[]
                    cancel=d.locator('[data-template-choice="cancel"]');confirm=d.locator('[data-template-choice="confirm"]')
                    assert cancel.evaluate('(e)=>e===document.activeElement')
                    assert d.get_attribute('aria-labelledby')=='templateReplaceTitle'
                    p.keyboard.press('Tab');assert confirm.evaluate('(e)=>e===document.activeElement')
                    p.keyboard.press('Shift+Tab');assert cancel.evaluate('(e)=>e===document.activeElement')
                    cancel.click();d.wait_for(state='detached');p.wait_for_function('!templateReplaceDecision')
                    assert values()==original and len(writes)==before and persisted_contracts()==[]
                    assert second.evaluate('(e)=>e===document.activeElement')
                    for mode in ['escape','back']:
                        second.click();d.wait_for(state='visible')
                        if mode=='escape':p.keyboard.press('Escape')
                        else:p.evaluate('history.back()')
                        d.wait_for(state='detached');p.wait_for_function('!templateReplaceDecision')
                        assert values()==original and p.evaluate('state.activeTab')=='contract'
                    # A failed modal open must leave every field intact and retire its history entry.
                    p.evaluate('(()=>{window.qaShowModal=HTMLDialogElement.prototype.showModal;HTMLDialogElement.prototype.showModal=function(){throw Error("fixture modal unavailable")}})()')
                    second.click();p.wait_for_function('!templateReplaceDecision')
                    assert values()==original and p.locator('#templateReplaceDialog').count()==0
                    p.evaluate('(()=>{HTMLDialogElement.prototype.showModal=window.qaShowModal})()')
                    # A changed draft while confirmation waits is never overwritten.
                    second.click();d.wait_for(state='visible')
                    p.evaluate('document.getElementById("contractTitle").value="Newer draft"')
                    confirm.click();d.wait_for(state='detached');p.wait_for_function('!templateReplaceDecision')
                    assert values()['contractTitle']=='Newer draft'
                    p.evaluate('(v)=>{for(const [id,value]of Object.entries(v))document.getElementById(id).value=value}',original)
                    # 200% text, no horizontal overflow; no background interactions.
                    second.click();d.wait_for(state='visible');p.evaluate('document.documentElement.style.fontSize="200%"')
                    assert d.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
                    p.evaluate('document.documentElement.style.fontSize=""')
                    confirm.click();d.wait_for(state='detached');p.wait_for_function('!templateReplaceDecision')
                    selected=p.evaluate('state.product.contractTemplates[1]')
                    expected_fields=dict(zip(fields,[selected['title'],selected['targetValue'],selected.get('stakeAmount') or '',selected.get('stakeCurrency') or 'RUB',selected.get('rewardDescription') or '',selected.get('fundDescription') or '']))
                    assert values()==expected_fields and len(writes)==before and persisted_contracts()==[]
                    assert p.locator('#statusRegion').inner_text()==p.evaluate('L("templateApplied",{title:document.querySelectorAll("[data-template-id]")[1].textContent})')
                    # Template selection is only a draft. A failed write keeps it for retry.
                    expected=values()['contractTitle'];draft=values()
                    def reject_contract(r):r.fulfill(status=503,content_type='application/json',body='{"error":"fixture contract unavailable"}')
                    ctx.route('**/api/contracts',reject_contract)
                    p.locator('#contractForm button[type="submit"]').click();p.wait_for_function('!state.busy')
                    assert values()==draft and not p.evaluate('state.currentContract') and persisted_contracts()==[]
                    ctx.unroute('**/api/contracts',reject_contract)
                    # Explicit retry reaches the real local API/SQLite exactly once.
                    before_commit=len(writes)
                    p.locator('#contractForm button[type="submit"]').click()
                    p.wait_for_function('state.currentContract && !state.busy')
                    data=p.evaluate('api("/api/contracts/current")')
                    assert data['contract']['title']==expected
                    assert sum(method=='POST' and path=='/api/contracts' for method,path in writes[before_commit:])==1
                    p.reload();p.wait_for_function('state.currentContract && !state.busy')
                    assert p.evaluate('state.currentContract.title')==expected and persisted_contracts()==[(expected,)]
                record(label+'-7639542-replace-cancel-escape-back-confirm-create-reload',replacement)
                assert not errors,errors
            finally:ctx.close()
    finally:browser.close()
out=os.environ.get('KOPILKA_THREE_RESULTS')
if out:Path(out).write_text(json.dumps(RESULTS,ensure_ascii=False,indent=2))
assert RESULTS and all(r['pass'] for r in RESULTS), 'connected regressions failed'
print('THREE_REPORTS_CONNECTED_PASS',len(RESULTS),flush=True)
