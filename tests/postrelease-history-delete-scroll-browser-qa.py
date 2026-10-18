#!/usr/bin/env python3
"""Real deletion in scrolled History, isolated provider-blocked SQLite."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
BASE=os.environ['KOPILKA_QA_BASE_URL']
assert BASE=='http://127.0.0.1:3321' and os.environ['NODE_ENV']=='test'
results=[]
with sync_playwright() as pw:
 browser=(pw.webkit.launch(headless=True, **({'executable_path': os.environ['KOPILKA_WEBKIT_EXECUTABLE']} if os.environ.get('KOPILKA_WEBKIT_EXECUTABLE') else {})) if os.environ.get('POSTRELEASE_BROWSER')=='webkit' else pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox']))
 try:
  for lang in ['ru','en']:
   ctx=browser.new_context(viewport={'width':1000,'height':700})
   ctx.route('**/*',lambda r:r.continue_() if r.request.url.startswith(BASE+'/') else r.abort())
   try:
    auth=ctx.request.post(BASE+'/api/auth/dev',data={'locale':lang,'timezone':'UTC'}).json()
    p=ctx.new_page();p.add_init_script('localStorage.setItem("kopilkaToken",'+json.dumps(auth['token'])+')')
    p.goto(BASE);p.wait_for_function('state.history && !state.busy')
    p.evaluate('''async()=>{for(const type of ['sleep','movement','food_water','rest','joy','gratitude']) await api('/api/entries',{method:'POST',body:JSON.stringify({type,note:('Long QA note '+type+' ').repeat(75)})}); await loadData(); renderAll()}''')
    p.locator('#tab-button-week').click()
    buttons=p.locator('[data-history-delete]');assert buttons.count()>=6
    target=buttons.nth(3);id_=target.get_attribute('data-history-delete')
    target.focus();target.evaluate('(e)=>e.scrollIntoView({block:"center",behavior:"instant"})')
    p.wait_for_timeout(250)
    before=p.evaluate('scrollY');assert before>600,before
    target.press('Enter');p.locator('#historyDeleteDialog').wait_for()
    p.keyboard.press('Escape');p.locator('#historyDeleteDialog').wait_for(state='detached');p.wait_for_timeout(250)
    assert abs(p.evaluate('scrollY')-before)<3,('cancel',before,p.evaluate('scrollY'))
    assert p.evaluate('document.activeElement.dataset.historyDelete')==id_
    target.press('Enter');p.locator('#historyDeleteDialog [data-history-delete-choice="confirm"]').click()
    p.wait_for_function('(id)=>!state.busy && !state.history.selectedEntries.some(e=>String(e.id)===id)',arg=id_)
    p.wait_for_timeout(300)
    after=p.evaluate('scrollY');focus=p.evaluate('({id:document.activeElement.id,entry:document.activeElement.dataset.historyDelete,visible:!!document.activeElement.getClientRects().length,disabled:!!document.activeElement.disabled})')
    assert abs(after-before)<3,('delete scroll',before,after,focus)
    assert focus['visible'] and not focus['disabled'] and (focus['entry'] or focus['id']=='historyDate'),focus
    assert p.locator('#statusRegion').get_attribute('role')=='status' and p.locator('#statusRegion').text_content()
    results.append({'locale':lang,'before':before,'after':after,'focus':focus})
    print('PASS',lang,'scrolled delete/cancel safe focus',results[-1],flush=True)
    # A failed DELETE stays visible, does not erase the entry or restore success.
    remaining=p.locator('[data-history-delete]').nth(2)
    failed_id=remaining.get_attribute('data-history-delete')
    p.route('**/api/entries/'+failed_id,lambda r:r.fulfill(status=503,json={'error':'QA deletion failed'}))
    remaining.click();p.locator('#historyDeleteDialog [data-history-delete-choice="confirm"]').click()
    p.wait_for_function('!state.busy && document.querySelector("#statusRegion").textContent.includes("QA deletion failed")')
    assert p.locator('[data-history-delete="'+failed_id+'"]').count()==1
    assert p.locator('#statusRegion').evaluate('(e)=>e.classList.contains("error")')
    p.unroute('**/api/entries/'+failed_id)
    results.append({'locale':lang,'case':'delete failure visible; entry retained'})
    print('PASS',lang,'delete error remains visible; entry retained',flush=True)
    # Last-entry fallback is enabled and keyboard-accessible, never a dead trigger.
    fresh=ctx.request.post(BASE+'/api/auth/dev',data={'locale':lang,'timezone':'UTC'}).json()
    p.close();p=ctx.new_page()
    p.add_init_script('localStorage.setItem("kopilkaToken",'+json.dumps(fresh['token'])+')')
    p.goto(BASE);p.wait_for_function('state.history && !state.busy')
    p.evaluate('''async()=>{await api('/api/entries',{method:'POST',body:JSON.stringify({type:'rest',note:'Last entry'})});await loadData();renderAll()}''')
    p.locator('#tab-button-week').click();p.locator('[data-history-delete]').click()
    p.locator('#historyDeleteDialog [data-history-delete-choice="confirm"]').focus()
    p.keyboard.press('Enter');p.wait_for_function('!state.busy && state.history.selectedEntries.length===0')
    assert p.evaluate('document.activeElement.id')=='historyDate'
    assert p.locator('#historyDate').is_enabled()
    results.append({'locale':lang,'case':'last entry focuses enabled date control'})
    print('PASS',lang,'last entry focuses enabled date control',flush=True)
   finally:ctx.close()
 finally:
  browser.close();Path(os.environ['DELETE_QA_OUT']).write_text(json.dumps(results,ensure_ascii=False,indent=2))
