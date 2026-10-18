#!/usr/bin/env python3
"""Actual RU/EN canvas PNG -> isolated upload/download routes; no native publish."""
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.request
from io import BytesIO
from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

def request(base, route, data=None, token=None, content_type='application/json'):
    headers = {'Content-Type': content_type}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    with urllib.request.urlopen(urllib.request.Request(base + route, data=data, headers=headers), timeout=30) as response:
        return response.status, response.read(), response.headers

with tempfile.TemporaryDirectory(prefix='day-locale-', dir=os.environ.get('TMPDIR', (tempfile.gettempdir() + '/kopilka-qa'))) as tmp:
    # An allow-list environment plus a blocked dotenv prevents inherited secrets.
    env = {key: os.environ[key] for key in ['PATH', 'HOME', 'TMPDIR'] if key in os.environ}
    env.update(NODE_ENV='test', DB_PATH=str(Path(tmp, 'fixture.sqlite')), DEV_AUTH_ENABLED='true',
               SCHEDULER_ENABLED='false', SESSION_SECRET='isolated-day-locale-fixture-secret',
               APP_BASE_URL='http://127.0.0.1:1', WEBAPP_URL='http://127.0.0.1:1')
    bootstrap = """
const dotenvPath=require.resolve('dotenv');
require.cache[dotenvPath]={id:dotenvPath,filename:dotenvPath,loaded:true,exports:{config(){}}};
const config=require('./src/config');
const server=require('./src/server').createApp().listen(0,'127.0.0.1',()=>{
  config.webappUrl='http://127.0.0.1:'+server.address().port;
  console.log(config.webappUrl);
});
"""
    with Path(tmp, 'server-errors.log').open('w+') as errors:
        process = subprocess.Popen(['node', '-e', bootstrap], cwd=ROOT, env=env,
                                   stdout=subprocess.PIPE, stderr=errors, text=True)
        try:
            base = process.stdout.readline().strip()
            assert base.startswith('http://127.0.0.1:'), base
            status, data, _ = request(base, '/api/auth/dev', json.dumps({'firstName': 'Лада', 'locale': 'en'}).encode())
            assert status == 200
            token = json.loads(data)['token']
            with sync_playwright() as pw:
                browser = pw.chromium.launch(executable_path=os.environ.get('KOPILKA_QA_CHROMIUM', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
                try:
                    context = browser.new_context()
                    context.route('**/*', lambda r: r.continue_() if r.request.url.startswith(base + '/') else r.abort())
                    page = context.new_page()
                    page.goto(base + '/day-scene.js')
                    page.set_content('<div id="daySceneLayer"></div><p id="daySceneDescription"></p>')
                    page.add_script_tag(url=base + '/i18n.js')
                    page.add_script_tag(url=base + '/day-scene.js')
                    page.evaluate('''() => {
                      const original=CanvasRenderingContext2D.prototype.fillText;
                      window.drawnTexts=[];
                      CanvasRenderingContext2D.prototype.fillText=function(...args){
                        drawnTexts.push(args[0]);return original.apply(this,args);
                      };
                    }''')
                    pictures = {}
                    for locale in ['en', 'ru']:
                        status, _, _ = request(base, '/api/settings/locale', json.dumps({'locale': locale}).encode(), token)
                        assert status == 200
                        result = page.evaluate('''async locale => {
                          KopilkaDayScene.render(['joy','gratitude'],locale);
                          window.drawnTexts=[];
                          const blob=await KopilkaDayScene.share(locale,'Личная дата','telegram');
                          const uri=await new Promise(resolve=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.readAsDataURL(blob);});
                          return {uri,texts:drawnTexts};
                        }''', locale)
                        expected = page.evaluate("locale=>KopilkaI18n.t(locale,'daySceneTitle')", locale)
                        assert result['texts'] == [expected, 'Личная дата'], result['texts']
                        if locale == 'en':
                            assert not any('\u0400' <= ch <= '\u04ff' for ch in expected), expected
                        else:
                            assert any('\u0400' <= ch <= '\u04ff' for ch in expected), expected
                        png = base64.b64decode(result['uri'].split(',')[1])
                        source = Image.open(BytesIO(png)).convert('RGBA')
                        assert source.size == (1080, 1920)
                        status, data, _ = request(base, '/api/day-scene-story', png, token, 'image/png')
                        assert status == 201
                        url = json.loads(data)['url']
                        assert url.startswith(base + '/api/day-scene-story/')
                        with urllib.request.urlopen(url, timeout=30) as response:
                            assert response.status == 200
                            assert response.headers['Content-Type'].startswith('image/png')
                            assert 'no-store' in response.headers['Cache-Control']
                            served = Image.open(BytesIO(response.read())).convert('RGBA')
                        assert served.size == source.size
                        assert ImageChops.difference(source, served).getbbox() is None, 'backend must not alter localized canvas pixels'
                        pictures[locale] = source
                        print('PASS', locale, 'real day canvas title/date -> PNG upload/download; personal Cyrillic preserved; identical pixels')
                    assert ImageChops.difference(pictures['en'].convert('RGB'), pictures['ru'].convert('RGB')).getbbox() is not None
                    context.close()
                finally:
                    browser.close()
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait()
        assert process.poll() is not None
