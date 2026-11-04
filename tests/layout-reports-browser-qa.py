#!/usr/bin/env python3
"""Connected 7657427/7659998/7661785 geometry and native-input contracts.
Run via run-browser-qa.py with ai-result-actions-preload.cjs. LAYOUT_BASELINE
optionally serves an untouched CSS preimage; all assertions stay identical.
"""
import base64
import hashlib
import hmac
import json
import os
import sqlite3
import time
import urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

BASE = os.environ['KOPILKA_QA_BASE_URL']
DB = os.environ['DB_PATH']
OUT = Path(os.environ['LAYOUT_REPORT'])
assert os.environ['NODE_ENV'] == 'test' and DB.endswith('qa.sqlite')
assert Path(DB).parent.name.startswith('kopilka-browser-suite-')
assert 'ai-result-actions-preload.cjs' in os.environ.get('NODE_OPTIONS', '')
assert urllib.parse.urlsplit(BASE).hostname == '127.0.0.1'
results = []


def signed(uid):
    p = dict(vk_app_id='54723764', vk_user_id=str(uid), vk_platform='mobile_android', vk_ts=str(int(time.time())))
    p['sign'] = base64.urlsafe_b64encode(hmac.new(b'browser-qa-vk-secure-key', urllib.parse.urlencode(sorted(p.items())).encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return urllib.parse.urlencode(p)


def native_wheel(page, field, delta):
    # Smooth document scroll and compositor hit-testing must settle BEFORE input.
    # A wheel API return is dispatch, not evidence that native scrolling finished.
    field.evaluate('''async n=>{
      n.scrollIntoView({block:'center',behavior:'instant'});
      let previous='',stable=0;
      for(let i=0;i<120;i++){
        await new Promise(requestAnimationFrame);
        const r=n.getBoundingClientRect(),nav=document.querySelector('.tab-bar').getBoundingClientRect();
        const current=JSON.stringify([scrollY,r.x,r.y,r.width,r.height,nav.top]);
        stable=current===previous?stable+1:0; previous=current;
        if(stable>=3) return;
      }
      throw Error('Referral geometry did not settle');
    }''')
    field.hover()
    field.evaluate('''async n=>{
      await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
      window.__refWheel={events:[],frames:[]};
      const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
      if(document.elementFromPoint(x,y)!==n)throw Error('Referral wheel point covered');
      window.__refWheel.before={rect:r.toJSON(),nav:document.querySelector('.tab-bar').getBoundingClientRect().toJSON(),scroll:n.scrollLeft};
      const observe=e=>{
        const item={trusted:e.isTrusted,target:e.target.id,x:e.clientX,y:e.clientY,deltaX:e.deltaX,hit:document.elementFromPoint(e.clientX,e.clientY)?.id};
        window.__refWheel.events.push(item);
        queueMicrotask(()=>item.prevented=e.defaultPrevented);
        removeEventListener('wheel',observe);
      };
      addEventListener('wheel',observe,{passive:true});
    }''')
    page.mouse.wheel(delta, 0)
    try:
        page.wait_for_function('''delta=>{
          const n=document.querySelector('#refLink'),d=window.__refWheel;
          d.frames.push({time:performance.now(),scroll:n.scrollLeft});
          const endpoint=delta<0?0:Math.max(0,n.scrollWidth-n.clientWidth);
          const e=d.events[0];
          return e&&e.trusted&&e.target==='refLink'&&!e.prevented&&Math.abs(n.scrollLeft-endpoint)<=1;
        }''', arg=delta, timeout=3000)
    except PlaywrightTimeoutError:
        page.evaluate('window.__refWheel.timedOut=true')
    return page.evaluate('window.__refWheel')


with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    try:
        for lang in os.environ.get('LAYOUT_LANGS', 'ru,en').split(','):
            for width in [int(x) for x in os.environ.get('LAYOUT_WIDTHS', '320,360,390,412,1280').split(',')]:
                for scale in [int(x) for x in os.environ.get('LAYOUT_SCALES', '100,200').split(',')]:
                    ctx = browser.new_context(viewport={'width': width, 'height': 900}, has_touch=width < 500, service_workers='block')
                    try:
                        blocked = []
                        def route(r):
                            if r.request.url.startswith(BASE + '/'):
                                r.continue_()
                            elif r.request.url == 'https://telegram.org/js/telegram-web-app.js':
                                blocked.append(r.request.url)
                                r.fulfill(status=200, content_type='application/javascript', body='/* SDK suppressed in isolated QA */')
                            else:
                                blocked.append(r.request.url)
                                r.abort()
                        ctx.route('**/*', route)
                        q = signed(8399200000 + len(results))
                        auth = ctx.request.post(BASE + '/api/auth/vk', data={'launchParams': q}).json()
                        headers = {'Authorization': 'Bearer ' + auth['token']}
                        assert ctx.request.post(BASE + '/api/settings/locale', headers=headers, data={'locale': lang}).ok
                        meta = ctx.request.get(BASE + '/api/ai-weekly-summary', headers=headers).json()
                        now = int(time.time() * 1000)
                        period = meta['period']
                        with sqlite3.connect(DB) as db:
                            digest = db.execute('''INSERT INTO ai_weekly_summaries(user_id,period_start,period_end,timezone,period_key,locale,status,text,provider,model,consent_version,consent_at,started_at,deadline_at,created_at,topic,days)
                              VALUES(?,?,?,?,?,?,'ready',?,'Google Gemini','fixture-model',?,?,?,?,?,'summary',7)''',
                              (auth['user']['id'], period['start'], period['end'], period['timezone'], period['key'], lang, 'Recorded walk.\n' * 60, meta['consentVersion'], now, now, now + 60000, now)).lastrowid
                        p = ctx.new_page()
                        errors = []
                        traffic = []
                        p.on('pageerror', lambda e: errors.append(str(e)))
                        p.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
                        p.on('request', lambda r: traffic.append((r.method, urllib.parse.urlsplit(r.url).path)))
                        if os.environ.get('LAYOUT_BASELINE'):
                            p.route('**/styles.css*', lambda r: r.fulfill(path=os.environ['LAYOUT_BASELINE']))
                        # Observe the real app copy function without invoking the OS clipboard.
                        p.add_init_script('Object.defineProperty(navigator,"clipboard",{value:{writeText:async value=>{window.__copied=value}}})')
                        p.route('**/vendor/vk-bridge-3.0.2.min.js*', lambda r: r.fulfill(content_type='application/javascript', body='window.vkBridge={send:async(method,args)=>{if(method==="VKWebAppCopyText"){window.__copied=args.text;return {result:true}}return {result:false}},subscribe:()=>{}};'))
                        p.goto(BASE + '/?' + q)
                        p.wait_for_function('state.user && state.history && !state.busy')
                        p.evaluate('(s)=>{document.documentElement.style.fontSize=s+"%";document.body.style.fontSize=(16*s/100)+"px"}', scale)
                        if p.locator('#dismissStatus').is_visible():
                            p.locator('#dismissStatus').click()
                        failures = []
                        note = p.locator('#entryNote')
                        note.click()
                        note.press('Tab')
                        p.keyboard.press('Shift+Tab')
                        assert note.evaluate('(n)=>document.activeElement===n && n.matches(":focus-visible")')
                        note.scroll_into_view_if_needed()
                        focus = note.evaluate('''n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n),o=parseFloat(s.outlineWidth)+parseFloat(s.outlineOffset);let clips=[];for(let a=n.parentElement;a;a=a.parentElement){const c=getComputedStyle(a),b=a.getBoundingClientRect();if(/hidden|clip|auto|scroll/.test(c.overflowX)&& (r.left-o<b.left||r.right+o>b.right))clips.push(a.id||a.tagName)}return {left:r.left-o,right:r.right+o,viewport:innerWidth,width:s.outlineWidth,color:s.outlineColor,style:s.outlineStyle,clips}}''')
                        if focus['left'] < 8 or focus['right'] > width - 8 or focus['clips']:
                            failures.append('7659998-focus-ring-edge-clearance')
                        assert float(focus['width'].replace('px', '')) >= 2 and focus['style'] == 'solid'
                        assert focus['color'] not in ['transparent', 'rgba(0, 0, 0, 0)']
                        p.locator('#tab-button-profile').click()
                        ref = p.locator('#refLink')
                        ref.wait_for(state='visible')
                        source = ref.input_value()
                        assert source.startswith('http') and '...' not in source and ref.get_attribute('readonly') is not None
                        # Real API-derived URL must stay byte-for-byte unchanged.
                        ref.evaluate('(n)=>n.scrollIntoView({block:"center",behavior:"instant"})')
                        ref.click()
                        p.wait_for_timeout(400)
                        ref.press('Home')
                        home_wheel = native_wheel(p, ref, -4000)
                        home = ref.evaluate('(n)=>({scroll:n.scrollLeft,start:n.selectionStart})')
                        ref.press('End')
                        end_wheel = native_wheel(p, ref, 4000)
                        if any(w.get('timedOut') for w in (home_wheel, end_wheel)):
                            failures.append('7661785-native-wheel-target-or-settlement')
                        end = ref.evaluate('(n)=>({scroll:n.scrollLeft,end:n.selectionEnd,width:n.clientWidth,full:n.scrollWidth,overflow:getComputedStyle(n).textOverflow,value:n.value})')
                        if width == 320 and scale == 100:
                            ref.screenshot(path=str(OUT.with_name(OUT.stem + '-referral-end.png')))
                        if end['overflow'] != 'clip':
                            failures.append('7661785-referral-ending-ellipsized')
                        assert home['scroll'] == 0 and end['value'] == source, (home, end, source)
                        if abs(end['scroll'] - max(0, end['full'] - end['width'])) > 1:
                            failures.append('7661785-native-scroll-cannot-reach-ending')
                        ref.press('x')
                        assert ref.input_value() == source
                        p.locator('#copyRefLink').scroll_into_view_if_needed()
                        p.wait_for_timeout(400)
                        p.locator('#copyRefLink').click()
                        try:
                            p.wait_for_function('window.__copied !== undefined', timeout=3000)
                        except Exception:
                            print('COPY DEBUG', p.evaluate('({bridge:!!window.vkBridge,value:document.getElementById("refLink").value,busy:state.busy,status:document.getElementById("statusRegion").textContent,active:document.activeElement.id})'), errors, flush=True)
                            raise
                        assert p.evaluate('window.__copied') == source
                        p.locator('#tab-button-assistant').click()
                        button = p.locator(f'#ai-weekly-delete-{digest}')
                        button.click()
                        confirm = p.locator('#aiWeeklyDeleteConfirm')
                        geo = confirm.evaluate('''n=>{const r=n.getBoundingClientRect(),b=n.previousElementSibling.getBoundingClientRect();return {gap:r.top-b.bottom,adjacent:n.previousElementSibling.id.startsWith("ai-weekly-delete-"),top:r.top,bottom:r.bottom,nav:document.querySelector(".tab-bar").getBoundingClientRect().top}}''')
                        if geo['gap'] < 8:
                            failures.append('7657427-confirmation-gap')
                        assert geo['adjacent']
                        for selector in ['#aiWeeklyDeleteCancel', '#aiWeeklyDeleteYes']:
                            b = p.locator(selector).bounding_box()
                            if b['y'] < 0 or b['y'] + b['height'] > geo['nav']:
                                failures.append('7657427-confirmation-action-obscured')
                        assert confirm.locator('p').inner_text()
                        p.locator('#aiWeeklyDeleteCancel').press('Escape')
                        assert confirm.is_hidden() and button.evaluate('(n)=>document.activeElement===n')
                        assert not errors, errors
                        assert not any(m == 'POST' and path == '/api/ai-weekly-summary' for m, path in traffic)
                        with sqlite3.connect('file:' + DB + '?mode=ro', uri=True) as db:
                            assert db.execute('SELECT status FROM ai_weekly_summaries WHERE id=?', (digest,)).fetchone() == ('ready',)
                            assert db.execute('SELECT COUNT(*) FROM entries WHERE user_id=?', (auth['user']['id'],)).fetchone() == (0,)
                        case = {'case': f'{lang}-{width}-{scale}', 'failures': failures, 'focus': focus, 'referral': {'home': home, 'end': end, 'nativeWheel': {'home': home_wheel, 'end': end_wheel}, 'copyExact': True, 'readonly': True}, 'confirm': geo, 'consoleErrors': errors, 'blockedExternalRequests': len(blocked)}
                        results.append(case)
                        OUT.parent.mkdir(parents=True, exist_ok=True)
                        OUT.write_text(json.dumps({'cases': results, 'count': len(results), 'failures': sum(len(r['failures']) for r in results)}, ensure_ascii=False, indent=2))
                        print(case['case'], failures, flush=True)
                    finally:
                        ctx.close()
    finally:
        browser.close()
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps({'cases': results, 'count': len(results), 'failures': sum(len(r['failures']) for r in results)}, ensure_ascii=False, indent=2))
assert len(results) == len(os.environ.get('LAYOUT_WIDTHS', '320,360,390,412,1280').split(',')) * len(os.environ.get('LAYOUT_SCALES', '100,200').split(',')) * len(os.environ.get('LAYOUT_LANGS', 'ru,en').split(',')) and not any(r['failures'] for r in results), 'Layout contracts failed; see report'
