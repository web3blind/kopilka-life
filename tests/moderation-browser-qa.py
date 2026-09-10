#!/usr/bin/env python3
"""Local real-UI moderation regression: isolated DB and VK login fixture, no live VK."""
import base64
import hashlib
import hmac
import json
import os
import subprocess
import tempfile
import time
import urllib.request
import urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = 'http://127.0.0.1:3124'


def launch_query():
    fields = {'vk_app_id': '54723764', 'vk_user_id': '710071', 'vk_language': 'ru', 'vk_ts': str(int(time.time()))}
    check = urllib.parse.urlencode(sorted(fields.items()))
    fields['sign'] = base64.urlsafe_b64encode(hmac.new(b'moderation-fixture', check.encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return urllib.parse.urlencode(fields)


def inspect_footer(frame):
    frame.evaluate("document.documentElement.style.scrollBehavior='auto';window.scrollTo(0,document.documentElement.scrollHeight)")
    frame.wait_for_timeout(150)
    return frame.evaluate("""() => {
      const nav=document.querySelector('.tab-bar').getBoundingClientRect();
      const links=Array.from(document.querySelectorAll('.legal-links a')).map(a=>{
        const rects=Array.from(a.getClientRects());
        return {text:a.textContent,visible:rects.every(r=>r.top>=0 && r.bottom<=nav.top-2),
          clickable:rects.every(r=>a.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)))};
      });
      return {links,navTop:nav.top,footerBottom:document.querySelector('.legal-links').getBoundingClientRect().bottom,
        horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,scrollWidth:document.documentElement.scrollWidth,scrollX:window.scrollX,
        overflowingContent:Array.from(document.querySelectorAll('body *')).filter(e=>e.clientWidth>0 && e.scrollWidth>e.clientWidth+2).slice(0,10).map(e=>({id:e.id,cls:e.className,w:e.clientWidth,sw:e.scrollWidth})),
        overflowElements:Array.from(document.querySelectorAll('body *')).filter(e=>e.getClientRects().length && e.getBoundingClientRect().right>innerWidth+1).slice(0,8).map(e=>({tag:e.tagName,id:e.id,cls:e.className,right:e.getBoundingClientRect().right}))};
    }""")


def main():
    with tempfile.TemporaryDirectory(prefix='kopilka-moderation-') as tmp:
        Path(tmp, 'public').symlink_to(ROOT / 'public', target_is_directory=True)
        Path(tmp, 'migrations').symlink_to(ROOT / 'migrations', target_is_directory=True)
        env = dict(os.environ, NODE_ENV='test', PORT='3124', DB_PATH=str(Path(tmp,'test.sqlite')),
            SESSION_SECRET='moderation-fixture-session', BOT_TOKEN='', VK_GROUP_TOKEN='',
            VK_APP_ID='54723764', VK_SECURE_KEY='moderation-fixture', VK_OAUTH_CLIENT_ID='',
            SCHEDULER_ENABLED='false', DEV_AUTH_ENABLED='false', APP_BASE_URL=BASE, WEBAPP_URL=BASE)
        with open(Path(tmp, 'server.log'), 'w+') as log:
            proc = subprocess.Popen(['node', str(ROOT/'src/server.js')],cwd=tmp,env=env,stdout=log,stderr=log)
            try:
                deadline=time.monotonic()+15
                while True:
                    try:
                        urllib.request.urlopen(BASE+'/health',timeout=1).close()
                        break
                    except Exception:
                        if proc.poll() is not None or time.monotonic()>deadline:
                            log.seek(0)
                            raise RuntimeError(log.read())
                        time.sleep(.1)
                with sync_playwright() as pw:
                    browser=pw.chromium.connect_over_cdp(os.environ.get('KOPILKA_QA_CDP_URL','http://127.0.0.1:18800'))
                    page=browser.contexts[0].new_page()
                    errors=[]
                    page.on('pageerror',lambda error:errors.append(str(error)))
                    page.route('https://**/*',lambda route:route.fulfill(status=200,body='',content_type='application/javascript'))
                    try:
                        page.set_viewport_size({'width':1100,'height':900})
                        url=BASE+'/?'+launch_query()
                        page.set_content(f'<iframe title="VK viewport fixture" style="width:390px;height:700px;border:0" src="{url}"></iframe>')
                        frame=page.frames[1]
                        frame.wait_for_function("document.querySelector('#connectionStatus')?.textContent.includes('Подключено')",timeout=20000)
                        for width,height,scale,dark in [(390,700,1,False),(320,568,1,True),(760,720,1,True),(390,700,2,True),(560,650,1,False),(561,650,1,False)]:
                            page.emulate_media(color_scheme='dark' if dark else 'light',reduced_motion='reduce')
                            page.locator('iframe').evaluate('(el,size)=>{el.style.width=size[0]+"px";el.style.height=size[1]+"px"}',[width,height])
                            frame.evaluate('(scale)=>document.documentElement.style.fontSize=(16*scale)+"px"',scale)
                            for tab in ['settings','profile','today','week','contract','support']:
                                frame.locator('#tab-button-'+tab).click()
                                if tab == 'today':
                                    saved = frame.locator('#totalLife').inner_text()
                                    for amount in ['2', '999', '123456', '123456789']:
                                        frame.locator('#totalLife').evaluate('(e,v)=>e.textContent=v',amount)
                                        geometry = frame.evaluate("""() => {
                                          const root=document.querySelector('.big-number');
                                          const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
                                          const tops=[]; let node;
                                          while(node=walker.nextNode()) {
                                            if(node.parentElement.closest('#totalLife')) continue;
                                            for(let i=0;i<node.length;i++) {
                                              if(!node.textContent[i].trim()) continue;
                                              const r=document.createRange();r.setStart(node,i);r.setEnd(node,i+1);
                                              tops.push(Math.round(r.getBoundingClientRect().top));
                                            }
                                          }
                                          return {labelLines:new Set(tops).size,overflow:document.documentElement.scrollWidth>innerWidth+1};
                                        }""")
                                        assert geometry['labelLines']==1 and not geometry['overflow'],f'Broken balance {width=} {scale=} {amount=}: {geometry}'
                                    frame.locator('#totalLife').evaluate('(e,v)=>e.textContent=v',saved)
                                result=inspect_footer(frame)
                                assert all(l['visible'] and l['clickable'] for l in result['links']),f'Footer overlaps {width=} {scale=} {tab=}: {result}'
                                assert not result['horizontalOverflow'],f'Overflow {width=} {scale=} {tab=}: {result}'
                                assert not frame.locator('#servicePanel').is_visible(),'Service controls shown for real account'
                            colors=frame.evaluate("({text:getComputedStyle(document.body).color,scheme:getComputedStyle(document.documentElement).colorScheme,inputBackground:getComputedStyle(document.querySelector('input')).backgroundColor,inputColor:getComputedStyle(document.querySelector('input')).color})")
                            assert colors['text']=='rgb(35, 22, 15)' and 'light' in colors['scheme'],colors
                            print('PASS viewport',width,height,'font-scale',scale,'dark',dark,json.dumps(result,ensure_ascii=False))
                        # Real clicks through both documents, including browser Back to app.
                        page.locator('iframe').evaluate('el=>{el.style.width="390px";el.style.height="700px"}')
                        frame.evaluate('document.documentElement.style.fontSize="16px"')
                        for href in ['/privacy.html','/terms.html']:
                            frame.locator('#tab-button-settings').click()
                            inspect_footer(frame)
                            frame.locator('.legal-links a[href="'+href+'?source=vk"]').click()
                            frame.wait_for_url('**'+href+'?source=vk')
                            assert frame.locator('h1').inner_text()
                            frame.evaluate('history.back()')
                            frame.wait_for_url('**/?*')
                            frame.wait_for_function("document.querySelector('#connectionStatus')?.textContent.includes('Подключено')",timeout=20000)
                        assert not errors,errors
                        print('PASS document navigation/back and JS errors=0')
                    finally:
                        page.close()
                        browser.close()
            finally:
                proc.terminate()
                proc.wait(timeout=10)


if __name__=='__main__':
    main()
