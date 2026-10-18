"""Actual canvas regression; loopback assets + captured bridge, no VK/native calls.
Run explicitly: python3 tests/vk-story-readability-browser-qa.py
Optional VK_STORY_EVIDENCE_DIR writes actual exports and numerical evidence.
"""
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from io import BytesIO
from playwright.sync_api import sync_playwright
from PIL import Image, ImageChops
import base64
import json
import os

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ['VK_STORY_EVIDENCE_DIR']) if os.environ.get('VK_STORY_EVIDENCE_DIR') else None
if OUT:
    OUT.mkdir(parents=True, exist_ok=True)


def contrast(rgb):
    values = [v / 255 for v in rgb[:3]]
    values = [v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in values]
    return 1.05 / (.2126 * values[0] + .7152 * values[1] + .0722 * values[2] + .05)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / 'public'), **kwargs)

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
thread = Thread(target=server.serve_forever, daemon=True)
thread.start()
metrics = []
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('KOPILKA_QA_CHROMIUM', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
        context = browser.new_context()
        try:
            base = f'http://127.0.0.1:{server.server_port}/'
            context.route('**/*', lambda r: r.continue_() if r.request.url.startswith(base) else r.abort())
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(base + 'day-scene.js')
            page.set_content('<div id="daySceneLayer"></div><p id="daySceneDescription"></p>')
            page.add_script_tag(content=(ROOT / 'public/i18n.js').read_text())
            page.add_script_tag(content=(ROOT / 'public/day-scene.js').read_text())
            page.evaluate("window.vkBridge={send:async(method,args)=>{if(method!=='VKWebAppShowStoryBox')throw Error(method);window.captured=args;return {result:true};}}")
            types = page.evaluate('Object.keys(KopilkaDayScene.positions)')
            assert len(types) == 16
            for locale in ['ru', 'en']:
                for label, selected in [('empty', []), ('all', types)] + [(t, [t]) for t in types]:
                    page.evaluate('([types,locale])=>KopilkaDayScene.render(types,locale)', [selected, locale])
                    before_dom = page.locator('body').inner_html()
                    result = page.evaluate("async locale=>{const result=await KopilkaDayScene.share(locale,locale==='ru'?'7 октября 2026 г.':'October 7, 2026','vk');return {result,...window.captured};}", locale)
                    assert result['result'] == 'story_editor' and result['locked'] is True
                    assert result['background_type'] == 'image'
                    assert result['attachment'] == {'type': 'url', 'text': 'open', 'url': 'https://vk.com/app54723764'}
                    vk_bytes = base64.b64decode(result['blob'].split(',')[1])
                    vk = Image.open(BytesIO(vk_bytes)).convert('RGB')
                    assert vk.size == (1080, 1920)
                    minimum = min(contrast(rgb) for start, end in [(0, 240), (1760, 1920)] for count, rgb in vk.crop((0, start, 1080, end)).getcolors(maxcolors=1080 * 240))
                    assert minimum >= 4.5, f'{locale}/{label}: white overlay backing contrast {minimum}'
                    assert vk.getpixel((0, 239)) == (37, 54, 47)
                    assert vk.getpixel((0, 240)) == (255, 248, 239)
                    assert vk.getpixel((0, 1759)) == (255, 248, 239)
                    assert vk.getpixel((0, 1760)) == (37, 54, 47)
                    telegram = page.evaluate("async locale=>{const blob=await KopilkaDayScene.share(locale,locale==='ru'?'7 октября 2026 г.':'October 7, 2026','telegram');return await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(blob);});}", locale)
                    tg_bytes = base64.b64decode(telegram.split(',')[1])
                    tg = Image.open(BytesIO(tg_bytes)).convert('RGB')
                    assert tg.size == vk.size
                    assert tg.getpixel((0, 0)) == tg.getpixel((0, 1919)) == (255, 248, 239)
                    assert ImageChops.difference(vk.crop((0, 240, 1080, 1760)), tg.crop((0, 240, 1080, 1760))).getbbox() is None, 'title/date/scene unchanged'
                    assert page.locator('body').inner_html() == before_dom, 'export leaves on-screen DOM unchanged'
                    metrics.append({'locale': locale, 'scene': label, 'minimumWhiteBackingContrast': minimum})
                    if OUT:
                        (OUT / f'day-{locale}-{label}-vk-after.png').write_bytes(vk_bytes)
                        if label in ['empty', 'all']:
                            (OUT / f'day-{locale}-{label}-telegram-after.png').write_bytes(tg_bytes)
            # Error/cancel lifecycle remains the existing share contract.
            page.evaluate("() => { window.vkBridge.send=async()=>{throw {error_data:{error_reason:'User denied'}}}; }")
            assert page.evaluate("KopilkaDayScene.share('ru','date','vk')") == 'cancelled'
            page.evaluate('delete window.vkBridge')
            assert page.evaluate("KopilkaDayScene.share('en','date','vk').then(()=>false,e=>e.message==='VK Bridge unavailable')")
            assert not errors, errors
        finally:
            context.close()
            browser.close()
finally:
    server.shutdown()
    server.server_close()
    thread.join()
assert len(metrics) == 36
if OUT:
    (OUT / 'after-day-contrast.json').write_text(json.dumps(metrics, indent=2))
print(f'PASS actual canvas: {len(metrics)} VK + 36 Telegram exports; RU/EN empty/all/individual16; white backing minimum {min(m["minimumWhiteBackingContrast"] for m in metrics):.6f}:1; central pixels/DOM unchanged; cancel/error; no external/native provider calls')
