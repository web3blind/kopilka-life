#!/usr/bin/env python3
"""Trusted held touch, not mouse, with only isolated fixture data."""
import os, sys, json
from pathlib import Path
from importlib.machinery import SourceFileLoader
from playwright.sync_api import sync_playwright
launch = SourceFileLoader('touch_fixture', str(Path(__file__).with_name('vk-native-recovery-browser-qa.py'))).load_module().launch
base = os.environ['KOPILKA_QA_BASE_URL']
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    for lang in ['ru', 'en']:
        ctx = browser.new_context(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True)
        ctx.route('**/*vk-bridge*', lambda r:r.fulfill(content_type='application/javascript',body=''))
        ctx.add_init_script('window.vkBridge={isWebView:()=>true,send:async()=>({result:true})};')
        page = ctx.new_page();page.goto(base+launch(lang,991112,expired=False))
        page.wait_for_function('state.user && state.product && !state.busy')
        cdp = ctx.new_cdp_session(page)
        for tab,selector in [('contract','#contractTemplates button'),('week','#tab-button-contract'),('week','#historyPrevious')]:
            page.evaluate('(t)=>switchTab(t)',tab)
            b=page.locator(selector).first
            b.scroll_into_view_if_needed()
            before=b.evaluate('(b)=>({shadow:getComputedStyle(b).boxShadow,parent:getComputedStyle(b.parentElement).boxShadow,rect:b.getBoundingClientRect().toJSON()})')
            r=b.bounding_box();assert r
            cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':r['x']+r['width']/2,'y':r['y']+r['height']/2,'id':1,'force':1}]})
            try:
                page.wait_for_timeout(220)
                held=b.evaluate('(b)=>({pressed:b.dataset.touchPressed,shadow:getComputedStyle(b).boxShadow,parent:getComputedStyle(b.parentElement).boxShadow,rect:b.getBoundingClientRect().toJSON()})')
                assert held['pressed']=='true',(lang,selector,held)
                assert held['shadow']!=before['shadow'],(lang,selector,before,held)
                assert held['parent']==before['parent'] and held['rect']==before['rect']
            finally:
                cdp.send('Input.dispatchTouchEvent',{'type':'touchCancel','touchPoints':[]})
            assert b.get_attribute('data-touch-pressed') is None
            print('PASS',lang,selector,'trusted touch held shadow, parent/layout unchanged, cancel cleared')
        ctx.close()
    browser.close()
