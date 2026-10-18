#!/usr/bin/env python3
"""7612075: actual held-button pixels, parent stability and state preservation.

Run with run-browser-qa.py and the provider-block preload; local fixtures only.
KOPILKA_PRESS_BASELINE_CSS can route an archived stylesheet for the RED gate.
"""
import base64
import hashlib
import hmac
import io
import json
import os
import time
import urllib.parse
from pathlib import Path
from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright

BASE = os.environ['KOPILKA_QA_BASE_URL']
assert os.environ['NODE_ENV'] == 'test' and 'qa.sqlite' in os.environ['DB_PATH']
OUT = Path(os.environ['KOPILKA_PRESS_PROOF_DIR'])
OUT.mkdir(parents=True, exist_ok=True)
STYLE = '''e=>{const s=getComputedStyle(e),p=getComputedStyle(e.parentElement),r=e.getBoundingClientRect();return {
 active:e.matches(':active'),focus:e.matches(':focus-visible'),focused:e===document.activeElement,focusId:document.activeElement.id,disabled:e.disabled,outline:s.outlineWidth,
 shadow:s.boxShadow,bg:s.backgroundImage,color:s.color,border:s.borderColor,
 highlight:s.webkitTapHighlightColor,selected:e.getAttribute('aria-selected'),
 parentShadow:p.boxShadow,parentBg:p.backgroundImage,parentColor:p.backgroundColor,
 width:r.width,height:r.height,x:r.x,y:r.y}}'''
results = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                                 args=['--no-sandbox', '--disable-background-networking'])
    try:
        for lang, uid in [('ru', 819938091), ('en', 819938092)]:
            ctx = browser.new_context(viewport={'width':390,'height':844}, has_touch=True, is_mobile=True)
            def route(r):
                if '/vendor/vk-bridge' in r.request.url:
                    r.fulfill(content_type='application/javascript', body='window.vkBridge={send(){return Promise.resolve({result:false})},subscribe(){},supports(){return true}}')
                elif not r.request.url.startswith(BASE+'/'):
                    r.abort()
                elif '/styles.css' in r.request.url and os.environ.get('KOPILKA_PRESS_BASELINE_CSS'):
                    r.fulfill(content_type='text/css', body=Path(os.environ['KOPILKA_PRESS_BASELINE_CSS']).read_text())
                else:
                    r.continue_()
            ctx.route('**/*', route)
            ctx.add_init_script('localStorage.setItem("kopilkaLocale",'+json.dumps(lang)+')')
            p = ctx.new_page()
            errors = []
            p.on('pageerror', lambda e: errors.append(str(e)))
            params = dict(vk_app_id='54723764',vk_user_id=str(uid),vk_ts=str(int(time.time())),vk_platform='mobile_android')
            params['sign'] = base64.urlsafe_b64encode(hmac.new(os.environ['VK_SECURE_KEY'].encode(),urllib.parse.urlencode(sorted(params.items())).encode(),hashlib.sha256).digest()).decode().rstrip('=')
            try:
                p.goto(BASE+'/?'+urllib.parse.urlencode(params))
                p.wait_for_function('state.user && state.history && !state.busy')
                def measure(label, selector, disabled=None):
                    p.wait_for_function('!state.busy')
                    b = p.locator(selector).first
                    b.scroll_into_view_if_needed()
                    if disabled:
                        b.evaluate('(e,a)=>e.setAttribute(a,a==="disabled"?"":"true")', disabled)
                    p.evaluate('document.activeElement.blur()')
                    p.mouse.move(1,1)
                    p.wait_for_timeout(200)
                    before = b.evaluate(STYLE)
                    clip = dict(x=before['x'],y=before['y'],width=before['width'],height=before['height'])
                    png0 = p.screenshot(clip=clip)
                    p.mouse.move(clip['x']+clip['width']/2,clip['y']+clip['height']/2)
                    p.mouse.down()
                    p.wait_for_timeout(220)
                    held = b.evaluate(STYLE)
                    png1 = p.screenshot(clip=clip)
                    p.mouse.move(1,1)
                    p.mouse.up()
                    p.wait_for_function('!state.busy')
                    p.wait_for_timeout(400)
                    p.wait_for_function('a=>getComputedStyle(document.querySelector(a.selector)).boxShadow===a.shadow',
                                        arg={'selector':selector,'shadow':before['shadow']})
                    released = b.evaluate(STYLE)
                    delta = ImageChops.difference(Image.open(io.BytesIO(png0)).convert('RGB'),Image.open(io.BytesIO(png1)).convert('RGB'))
                    raw = delta.tobytes()
                    pixels = sum(max(raw[i:i+3])>4 for i in range(0,len(raw),3))
                    for suffix, png in [('before',png0),('held',png1)]:
                        (OUT/(lang+'-'+label+'-'+suffix+'.png')).write_bytes(png)
                    parent = ['parentShadow','parentBg','parentColor']
                    semantic = ['bg','color','border','selected','width','height','x','y']
                    assert all(before[k]==held[k] for k in parent+semantic), (label,before,held)
                    assert before['highlight']==held['highlight']=='rgba(0, 0, 0, 0)'
                    assert released['shadow']==before['shadow'], (label,before,released)
                    if disabled:
                        assert held['shadow']==before['shadow'], (label,before,held)
                        if disabled=='aria-disabled':
                            assert pixels==0, (label,pixels)
                        b.evaluate('(e,a)=>e.removeAttribute(a)',disabled)
                        focus = None
                    else:
                        assert held['active'], (label,held)
                        focus = None
                        if not label.startswith('nav-'):
                            b.evaluate('(e)=>e.blur()')
                            p.keyboard.press('Tab')
                            b.focus()
                            focus = b.evaluate(STYLE)
                            assert focus['focus'] and focus['outline']=='3px', (label,focus)
                    results.append(dict(locale=lang,control=label,disabled=disabled,changed_pixels=pixels,before=before,held=held,keyboard=focus,passed=bool(disabled or pixels>0)))
                for tab, selector in [('contract','[data-template-id]'),('week','#historyPrevious')]:
                    p.locator('#tab-button-'+tab).click()
                    measure(tab,selector)
                    for disabled in ['disabled','aria-disabled']:
                        measure(tab+'-'+disabled,selector,disabled)
                for tab in ['today','week','contract','settings','support','profile']:
                    measure('nav-'+tab,'#tab-button-'+tab)
                # Check disabled inactive tab variants without changing real selection.
                for disabled in ['disabled','aria-disabled']:
                    measure('nav-settings-'+disabled,'#tab-button-settings',disabled)
                # Exercise the actual roving-tab keyboard handler, not synthetic
                # focus of an inactive tab (which has tabindex=-1).
                p.locator('#tab-button-contract').click()
                p.wait_for_function('!state.busy')
                p.locator('#tab-button-contract').focus()
                for tab in ['settings','support','profile','today','week','contract']:
                    p.keyboard.press('ArrowRight')
                    p.wait_for_function('!state.busy')
                    b = p.locator('#tab-button-'+tab)
                    keyboard = b.evaluate(STYLE)
                    assert keyboard['focused'] and keyboard['focus'] and keyboard['outline']=='3px' and keyboard['selected']=='true', keyboard
                assert not errors, errors
            finally:
                ctx.close()
    finally:
        browser.close()
(OUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
failed = [r['locale']+'-'+r['control'] for r in results if not r['passed']]
print('PRESSED_FEEDBACK',len(results),'PASS',sum(r['passed'] for r in results),'FAIL',failed,flush=True)
assert not failed, 'no rendered held-button feedback: '+','.join(failed)
