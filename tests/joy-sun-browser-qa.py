#!/usr/bin/env python3
"""Saved joy reveals a sun in the sky, also in PNG, without touching other motifs."""
import tempfile
import base64
import io
import json
import os
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright
BASE = os.environ['KOPILKA_QA_BASE_URL']

def sun_change(before, after):
    w,h=before.size
    box=(int(w*.01),int(h*.03),int(w*.12),int(h*.1125))
    a,b=before.crop(box),after.crop(box)
    return sum(sum(abs(x-y) for x,y in zip(old,new))>35 and new[0]>new[2]+25
               for old,new in zip(a.getdata(),b.getdata()))/(a.width*a.height)

with sync_playwright() as p:
    browser=p.chromium.connect_over_cdp(os.environ.get('KOPILKA_QA_CDP_URL','http://127.0.0.1:18800'))
    ctx=browser.new_context(viewport={'width':390,'height':844})
    ctx.route('https://**/*',lambda r:r.fulfill(status=200,body='',content_type='application/javascript'))
    page=ctx.new_page(); errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    try:
        auth=ctx.request.post(BASE+'/api/auth/dev',data={'firstName':'Sun QA','locale':'ru','timezone':'UTC'}).json()
        ctx.set_extra_http_headers({'Authorization':'Bearer '+auth['token']})
        page.add_init_script('localStorage.setItem("kopilkaToken",'+json.dumps(auth['token'])+');')
        page.goto(BASE); page.wait_for_function('state.summary && !state.busy')
        picture=page.locator('.day-scene-picture')
        before=Image.open(io.BytesIO(picture.screenshot())).convert('RGB')
        page.locator('[data-entry-type="joy"]').click()
        page.wait_for_function('state.summary?.todayEntryTypes?.includes("joy") && !state.busy')
        page.wait_for_function('document.querySelector("[data-scene-type=joy] img")?.complete')
        after=Image.open(io.BytesIO(picture.screenshot())).convert('RGB')
        ratio=sun_change(before,after)
        assert ratio>.15, ('sun must be visible in free upper-left sky',ratio)
        assert 'Радость' in page.locator('#daySceneDescription').inner_text()
        export='''async () => { const b=await KopilkaDayScene.share('ru','QA','telegram'); let s=''; for(const n of new Uint8Array(await b.arrayBuffer()))s+=String.fromCharCode(n); return btoa(s); }'''
        marked=Image.open(io.BytesIO(base64.b64decode(page.evaluate(export)))).convert('RGB').crop((60,368,1020,1648))
        page.evaluate('KopilkaDayScene.render([],"ru")')
        empty=Image.open(io.BytesIO(base64.b64decode(page.evaluate(export)))).convert('RGB').crop((60,368,1020,1648))
        assert sun_change(empty,marked)>.15,'sun absent in export'
        page.evaluate('KopilkaDayScene.render(state.summary.todayEntryTypes,"en")')
        assert 'Joy' in page.locator('#daySceneDescription').inner_text()
        out=Path((tempfile.gettempdir() + '/kopilka-qa/joy-sun-qa'));out.mkdir(parents=True,exist_ok=True)
        before.save(out/'before.png');after.save(out/'after.png');marked.save(out/'export.png')
        for width in (320,390,760):
            page.set_viewport_size({'width':width,'height':844})
            page.evaluate('KopilkaDayScene.render(Object.keys(KopilkaDayScene.positions),"ru")')
            page.wait_for_function('Array.from(document.querySelectorAll(".day-scene-motif img")).every(e=>e.complete&&e.naturalWidth>0)')
            assert page.evaluate('''() => {const p=document.querySelector('.day-scene-picture').getBoundingClientRect(); const r=document.querySelector('[data-scene-type=joy]').getBoundingClientRect();return r.left>=p.left-1&&r.right<=p.right+1&&r.top>=p.top-1&&r.bottom<=p.bottom+1&&document.documentElement.scrollWidth<=innerWidth;}''')
            picture.screenshot(path=str(out/f'all-{width}.png'))
        entry=next(e for e in ctx.request.get(BASE+'/api/entries').json()['entries'] if e['type']=='joy')
        assert ctx.request.delete(BASE+'/api/entries/'+str(entry['id']),data={'confirm':True}).status==200
        page.reload();page.wait_for_function('state.summary&&!state.busy')
        assert not page.evaluate('state.summary.todayEntryTypes.includes("joy")')
        assert page.locator('[data-scene-type="joy"]').count()==0
        assert not errors,errors
        print('PASS joy sun: saved action, visible sky sun, RU/EN, PNG export, dense scene 320/390/760, deletion; no JS errors',ratio)
    finally:
        ctx.close()
