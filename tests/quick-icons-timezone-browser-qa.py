#!/usr/bin/env python3
"""7624380/7624529 connected isolated UI: icon identity, native timezone select.
No real provider calls or physical-device claim. Optional exact supported assets.
"""
import tempfile
import base64,hashlib,hmac,json,os,time,urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright
BASE=os.environ['KOPILKA_QA_BASE_URL']
assert os.environ['NODE_ENV']=='test' and 'qa.sqlite' in os.environ['DB_PATH']
OUT=Path(os.environ.get('KOPILKA_NEW_UI_OUT',(tempfile.gettempdir() + '/kopilka-qa/kopilka-oct12-ui-qa')))
OUT.mkdir(parents=True,exist_ok=True)
results=[]
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-background-networking'])
 try:
  for lang in ['ru','en']:
   for width,font,mobile in [(1280,100,False),(390,100,True),(320,100,True),(320,200,True)]:
    ctx=browser.new_context(viewport={'width':width,'height':900},is_mobile=mobile,has_touch=mobile)
    def route(r):
     u=r.request.url
     if not u.startswith(BASE+'/'):r.abort()
     elif '/vendor/vk-bridge' in u:r.fulfill(content_type='application/javascript',body='window.vkBridge={send(){return Promise.resolve({result:false})},subscribe(){},supports(){return true}}')
     elif '/app.js' in u and os.environ.get('KOPILKA_UI_APP'):r.fulfill(content_type='application/javascript',body=Path(os.environ['KOPILKA_UI_APP']).read_text())
     elif '/styles.css' in u and os.environ.get('KOPILKA_UI_CSS'):r.fulfill(content_type='text/css',body=Path(os.environ['KOPILKA_UI_CSS']).read_text())
     elif urllib.parse.urlsplit(u).path=='/' and os.environ.get('KOPILKA_UI_INDEX'):r.fulfill(content_type='text/html',body=Path(os.environ['KOPILKA_UI_INDEX']).read_text())
     else:r.continue_()
    ctx.route('**/*',route)
    ctx.add_init_script('localStorage.setItem("kopilkaLocale",'+json.dumps(lang)+')')
    p=ctx.new_page();errors=[];p.on('pageerror',lambda e:errors.append(str(e)))
    params=dict(vk_app_id='54723764',vk_user_id=str(811997300+len(results)),vk_ts=str(int(time.time())),vk_platform='mobile_android' if mobile else 'desktop_web')
    params['sign']=base64.urlsafe_b64encode(hmac.new(os.environ['VK_SECURE_KEY'].encode(),urllib.parse.urlencode(sorted(params.items())).encode(),hashlib.sha256).digest()).decode().rstrip('=')
    try:
     p.goto(BASE+'/?'+urllib.parse.urlencode(params));p.wait_for_function('state.user && state.summary && !state.busy')
     p.locator('[data-entry-type="sleep"]').click();p.wait_for_function('state.summary.todayEntryTypes.includes("sleep") && !state.busy')
     p.locator('[data-entry-type="sleep"] .qa-icon img').evaluate('(e)=>e.decode()')
     p.evaluate('''window.qaSleepImage=$('quickActions').querySelector('[data-entry-type="sleep"] img');window.qaHonestIcon=$('quickActions').querySelector('[data-entry-type="honest_step"] svg');window.qaButtons=[...$('quickActions').querySelectorAll('button')];window.qaIconChanges=[];window.qaIconObserver=new MutationObserver(ms=>ms.forEach(m=>{const icon=m.target.nodeType===1?m.target.closest('.qa-icon'):m.target.parentElement?.closest('.qa-icon');if(icon)qaIconChanges.push(icon.closest('button').dataset.entryType)}));qaIconObserver.observe($('quickActions'),{subtree:true,childList:true});''')
     p.locator('[data-entry-type="rest"]').click();p.wait_for_function('state.summary.todayEntryTypes.includes("rest") && !state.busy')
     p.wait_for_timeout(100)
     identity=p.evaluate('''({sleep:qaSleepImage===$('quickActions').querySelector('[data-entry-type="sleep"] img'),honest:qaHonestIcon===$('quickActions').querySelector('[data-entry-type="honest_step"] svg'),buttons:qaButtons.every((b,i)=>b===$('quickActions').querySelectorAll('button')[i]),changes:[...new Set(qaIconChanges)]})''')
     results.append({'locale':lang,'width':width,'font':font,'icons':identity})
     assert identity['sleep'] and identity['honest'] and identity['buttons'],identity
     assert identity['changes']==['rest'],identity
     p.evaluate('qaIconChanges.length=0;renderQuickActions();renderQuickActions()');p.wait_for_timeout(50)
     assert p.evaluate('qaIconChanges.length')==0,'unchanged rerender mutates icons'
     before=p.evaluate('state.summary.todayLife')
     p.locator('[data-entry-type="rest"]').focus();p.keyboard.press('Enter');p.wait_for_timeout(100)
     assert p.evaluate('state.summary.todayLife')==before,'used keyboard action duplicated points'
     p.evaluate("window.qaRestImage=$('quickActions').querySelector('[data-entry-type=rest] img');qaIconChanges.length=0")
     p.evaluate("async()=>{const e=state.summary.todayEntries.find(e=>e.type==='sleep');await api('/api/entries/'+e.id,{method:'DELETE',body:JSON.stringify({confirm:true})});await loadData()}")
     assert p.evaluate("!state.summary.todayEntryTypes.includes('sleep')")
     assert p.locator('[data-entry-type=sleep]').get_attribute('aria-disabled') is None
     assert p.locator('[data-entry-type=sleep] img').count()==0
     assert p.evaluate("qaRestImage===$('quickActions').querySelector('[data-entry-type=rest] img')")
     assert p.evaluate("[...new Set(qaIconChanges)].every(t=>t==='sleep')")
     p.evaluate('qaIconObserver.disconnect()')
     p.locator('#tab-button-settings').click()
     p.add_style_tag(content='html{font-size:'+str(font)+'%!important}')
     p.evaluate("state.user.timezone='UTC';renderSettings()")
     control=p.get_by_role('combobox',name='Часовой пояс' if lang=='ru' else 'Time zone')
     assert control.input_value()=='UTC'
     style=control.evaluate('e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect(),c=document.createElement("canvas").getContext("2d");c.font=s.font;return {appearance:s.appearance,overflow:s.textOverflow,width:r.width,right:r.right,viewport:innerWidth,label:e.selectedOptions[0].textContent,textRoom:r.width-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)-2,minText:c.measureText(e.selectedOptions[0].textContent[0]+"…").width}}')
     results[-1]['timezone']=style
     control.screenshot(path=str(OUT/f'{lang}-{width}-{font}-timezone.png'))
     assert style['appearance']=='none' and style['overflow']=='ellipsis',style
     assert 'UTC+00:00' in style['label'] and style['label'].endswith(')'),style
     assert style['right']<=style['viewport'] and style['width']>40,style
     assert style['textRoom']>=style['minText'],'padding hides even first character and ellipsis: '+str(style)
     control.focus();p.keyboard.press('ArrowDown');assert p.evaluate('document.activeElement.id')=='timezone'
     control.select_option('Europe/Moscow');p.locator('#eveningReminderTime').fill('07:31')
     p.evaluate('renderAll()');assert control.input_value()=='Europe/Moscow';assert p.locator('#eveningReminderTime').input_value()=='07:31'
     p.locator('#settingsForm button[type=submit]').click();p.wait_for_function("!state.busy && !state.settingsDirty && state.user.timezone==='Europe/Moscow'")
     assert p.evaluate('state.user.eveningReminderTime')=='07:31'
     p.reload();p.wait_for_function("state.user?.timezone==='Europe/Moscow' && state.summary && state.profile && state.history && !state.busy")
     p.locator('#tab-button-settings').click();assert control.input_value()=='Europe/Moscow',p.evaluate("({saved:state.user.timezone,input:document.querySelector('#timezone').value,dirty:state.settingsDirty})")
     assert not errors,errors
    finally:ctx.close()
 finally:browser.close()
(OUT/'results.json').write_text(json.dumps({'cases':len(results),'results':results},ensure_ascii=False,indent=2))
print('NEW_UI_CONNECTED_QA',len(results),'cases PASS')
