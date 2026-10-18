#!/usr/bin/env python3
"""Connected movement regression: saved action reveals original footprints without changing the river."""
import tempfile
import base64
import io
import json
import os
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright

BASE = os.environ['KOPILKA_QA_BASE_URL']

def scene_difference(before, after, river=False):
    # Separate footprint changes from the stream that must remain untouched.
    w, h = before.size
    box = (int(w*.58), int(h*.83), w, h) if river else (int(w*.20), int(h*.82), int(w*.56), int(h*.985))
    a, b = before.crop(box).convert('RGB'), after.crop(box).convert('RGB')
    changed = 0
    for old, new in zip(a.getdata(), b.getdata()):
        if sum(abs(x-y) for x,y in zip(old,new)) > 35:
            changed += 1
    return changed / (a.width * a.height)

with sync_playwright() as pw:
    browser = pw.chromium.connect_over_cdp(os.environ.get('KOPILKA_QA_CDP_URL', 'http://127.0.0.1:18800'))
    context = browser.new_context(viewport={'width': 390, 'height': 844})
    context.route('https://**/*', lambda r: r.fulfill(status=200, body='', content_type='application/javascript'))
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    try:
        auth = context.request.post(BASE + '/api/auth/dev', data={'firstName':'Movement QA', 'locale':'ru', 'timezone':'UTC'}).json()
        context.set_extra_http_headers({'Authorization': 'Bearer ' + auth['token']})
        page.add_init_script('localStorage.setItem("kopilkaToken", '+json.dumps(auth['token'])+');')
        page.goto(BASE)
        page.wait_for_function('state.summary && !state.busy')
        picture = page.locator('.day-scene-picture')
        before = Image.open(io.BytesIO(picture.screenshot())).convert('RGB')
        page.locator('[data-entry-type="movement"]').click()
        page.wait_for_function('state.summary?.todayEntryTypes?.includes("movement") && !state.busy')
        page.wait_for_function('document.querySelector("[data-scene-type=movement] img")?.complete')
        after = Image.open(io.BytesIO(picture.screenshot())).convert('RGB')
        ratio = scene_difference(before, after)
        assert ratio > .03, ('movement footprints missing', ratio)
        assert scene_difference(before, after, river=True) < .005, 'movement must not change river'
        assert 'Движение' in page.locator('#daySceneDescription').inner_text()
        assert page.locator('[data-entry-type="movement"]').get_attribute('data-used-today') == 'true'
        assert page.locator('[data-entry-type="movement"]').get_attribute('aria-disabled') == 'true'
        async_export = '''async () => { const b=await KopilkaDayScene.share('ru','QA','telegram'); const bytes=new Uint8Array(await b.arrayBuffer()); let s=''; for(const n of bytes)s+=String.fromCharCode(n); return btoa(s); }'''
        marked_export = Image.open(io.BytesIO(base64.b64decode(page.evaluate(async_export)))).convert('RGB').crop((60, 368, 1020, 1648))
        page.evaluate('KopilkaDayScene.render([], "ru")')
        empty_export = Image.open(io.BytesIO(base64.b64decode(page.evaluate(async_export)))).convert('RGB').crop((60, 368, 1020, 1648))
        assert scene_difference(empty_export, marked_export) > .03, 'footprints missing from exported PNG'
        assert scene_difference(empty_export, marked_export, river=True) == 0, 'export river changed'
        page.evaluate('KopilkaDayScene.render(state.summary.todayEntryTypes, "en")')
        assert 'Movement' in page.locator('#daySceneDescription').inner_text()
        assert page.locator('[data-scene-type="movement"]').is_visible()
        entry = next(e for e in context.request.get(BASE+'/api/entries').json()['entries'] if e['type']=='movement')
        assert context.request.delete(BASE+'/api/entries/'+str(entry['id']), data={'confirm': True}).status == 200
        page.reload()
        page.wait_for_function('state.summary && !state.busy')
        assert not page.evaluate('state.summary.todayEntryTypes.includes("movement")')
        assert page.locator('[data-scene-type="movement"]').count() == 0
        removed = Image.open(io.BytesIO(picture.screenshot())).convert('RGB')
        assert scene_difference(before, removed) < .005, 'deleted movement should remove footprints'
        out = Path(os.environ.get('KOPILKA_SCENE_SHOTS_DIR', (tempfile.gettempdir() + '/kopilka-qa/movement-qa')))
        out.mkdir(parents=True, exist_ok=True)
        before.save(out/'before.png'); after.save(out/'after.png'); marked_export.save(out/'export.png')
        assert not errors, errors
        print('PASS movement: saved action, original footprints, unchanged river, RU/EN description, exported PNG, deletion; no JS errors. Changed footprint fraction:', ratio)
    finally:
        context.close()
