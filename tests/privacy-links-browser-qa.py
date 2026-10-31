#!/usr/bin/env python3
"""Bug 7656290: trusted reader links, isolated signed VK iframe, no outbound I/O.

KOPILKA_LINK_QA_PREIMAGE=06fd6ed selects the original asset without a checkout.
Uses the same temporary-server/signed-launch rail as document-navigation-qa.py.
"""
import base64
import hashlib
import hmac
import html
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PORT = int(os.environ.get('KOPILKA_QA_PORT', '3197'))
BASE = f'http://127.0.0.1:{PORT}'
PREIMAGE = os.environ.get('KOPILKA_LINK_QA_PREIMAGE')
ASSET = subprocess.check_output(['git', 'show', f'{PREIMAGE}:public/document-navigation.js'], cwd=ROOT) if PREIMAGE else (ROOT / 'public/document-navigation.js').read_bytes()


def launch_query():
    fields = {'vk_app_id': '54723764', 'vk_user_id': '710076', 'vk_ts': str(int(time.time()))}
    check = urllib.parse.urlencode(sorted(fields.items()))
    fields['sign'] = base64.urlsafe_b64encode(hmac.new(b'privacy-link-fixture', check.encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return urllib.parse.urlencode(fields)


def main():
    with tempfile.TemporaryDirectory(prefix='privacy-link-qa-') as tmp:
        tmp = Path(tmp)
        for name in ('public', 'migrations'):
            (tmp / name).symlink_to(ROOT / name, target_is_directory=True)
        preload = tmp / 'deny-outbound.cjs'
        preload.write_text("for(const n of ['http','https']){const m=require('node:'+n);for(const k of ['request','get'])m[k]=()=>{throw Error('QA outbound blocked');};}global.fetch=()=>Promise.reject(Error('QA outbound blocked')); ")
        env = dict(PATH=os.environ['PATH'], HOME=str(tmp), NODE_ENV='test', PORT=str(PORT),
                   DB_PATH=str(tmp / 'qa.sqlite'), SESSION_SECRET='privacy-link-test',
                   BOT_TOKEN='fixture:privacy-links', BOT_USERNAME='HarborLifeBot',
                   VK_APP_ID='54723764', VK_SECURE_KEY='privacy-link-fixture', VK_GROUP_TOKEN='',
                   SCHEDULER_ENABLED='false', DEV_AUTH_ENABLED='false',
                   NODE_OPTIONS='--require=' + str(preload), APP_BASE_URL=BASE, WEBAPP_URL=BASE)
        with (tmp / 'server.log').open('w+') as log:
            proc = subprocess.Popen(['node', str(ROOT / 'src/server.js')], cwd=tmp, env=env, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 25
                while True:
                    try:
                        urllib.request.urlopen(BASE + '/health', timeout=1).close()
                        break
                    except Exception:
                        if proc.poll() is not None or time.monotonic() > deadline:
                            log.seek(0)
                            raise RuntimeError(log.read())
                        time.sleep(.1)
                with sync_playwright() as pw:
                    endpoint = os.environ.get('KOPILKA_QA_CDP_URL')
                    browser = pw.chromium.connect_over_cdp(endpoint) if endpoint else pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
                    try:
                        for locale in ('ru', 'en'):
                            exercise(browser, locale)
                    finally:
                        browser.close()
            finally:
                proc.terminate()
                proc.wait(timeout=10)
    print('PASS privacy links; asset SHA256=' + hashlib.sha256(ASSET).hexdigest(), flush=True)


def exercise(browser, locale):
    ctx = browser.new_context(viewport={'width': 1000, 'height': 760})
    errors, attempts, doc_requests = [], [], []
    ctx.on('page', lambda p: p.on('pageerror', lambda e: errors.append(str(e))))
    launch = BASE + '/?' + launch_query()
    def route(r):
        url = urllib.parse.urlsplit(r.request.url)
        if url.path == '/__privacy_host' and r.request.url.startswith(BASE):
            r.fulfill(content_type='text/html', body='<iframe title="VK fixture" style="width:900px;height:700px" src="' + html.escape(launch, quote=True) + '"></iframe>')
        elif url.path == '/document-navigation.js' and r.request.url.startswith(BASE):
            r.fulfill(content_type='application/javascript', body=ASSET)
        elif r.request.is_navigation_request() and r.request.url not in (launch, BASE + '/__privacy_host'):
            # Context routing catches even the FIRST popup request, before page events.
            attempts.append({'url': r.request.url, 'headers': r.request.headers})
            r.fulfill(content_type='text/html', body='<title>Intercepted destination</title>')
        elif not r.request.url.startswith(BASE + '/'):
            # Third-party platform scripts are inert; no provider request leaves QA.
            r.fulfill(content_type='application/javascript', body='')
        else:
            if url.path.startswith(('/privacy', '/terms')):
                doc_requests.append({'url': r.request.url, 'headers': r.request.headers})
            r.continue_()
    ctx.route('**/*', route)
    ctx.add_init_script('try{localStorage.setItem("kopilkaLocale",' + json.dumps(locale) + ')}catch{}')
    page = ctx.new_page()
    try:
        page.goto(BASE + '/__privacy_host')
        frame = page.frames[1]
        frame.wait_for_function('state.user && state.summary && !state.busy')
        frame.locator('#entryNote').fill('privacy-link-unsaved-draft')
        frame.locator('#tab-button-settings').click()
        frame.locator('#lang-' + locale).click()
        frame.wait_for_function('(locale)=>document.documentElement.lang===locale', arg=locale)
        frame.evaluate('window.__doc=document;window.__draft=document.querySelector("#entryNote");window.__user=state.user;window.__storage=JSON.stringify({...localStorage});window.__session=JSON.stringify({...sessionStorage})')
        suffix = '.en.html' if locale == 'en' else '.html'
        close = 'Close document' if locale == 'en' else 'Закрыть документ'
        opener = frame.locator('.legal-links a[href="/privacy.html"]')
        opener.scroll_into_view_if_needed()
        before = frame.evaluate('({x:scrollX,y:scrollY,tab:document.querySelector("[aria-selected=true]")?.id})')
        opener.click()
        dialog = frame.get_by_role('dialog')
        dialog.locator('h1').wait_for()
        for href, keyboard in [('https://openrouter.ai/privacy', False), ('https://ai.google.dev/gemini-api/terms', True), ('https://db-ip.com', True)]:
            link = dialog.locator('a').filter(has_text='OpenRouter') if 'openrouter' in href else dialog.locator('a[href^="' + href + '"]')
            assert link.count() == 1, ('missing accessible link', locale, href)
            assert link.get_attribute('href') is not None, ('7656290 href removed', locale, href)
            assert link.get_attribute('target') == '_blank'
            assert link.get_attribute('rel') == 'noopener noreferrer'
            assert link.get_attribute('referrerpolicy') == 'no-referrer'
            with page.expect_popup() as opened:
                if keyboard:
                    link.focus()
                    link.press('Enter')
                else:
                    link.click()
            popup = opened.value
            popup.wait_for_load_state()
            assert popup.url.rstrip('/') == href.rstrip('/'), popup.url
            assert popup.evaluate('window.opener===null')
            popup.close()
            assert frame.url == launch and dialog.is_visible()
        dialog.locator('a[href="/terms' + suffix + '"]').click()
        dialog.locator('a[href="/privacy' + suffix + '"]').wait_for()
        page.keyboard.press('Escape')
        dialog.wait_for(state='hidden')
        assert opener.evaluate('(link)=>document.activeElement===link')
        assert frame.evaluate('({x:scrollX,y:scrollY,tab:document.querySelector("[aria-selected=true]")?.id})') == before
        # About uses the same reader and retains its scripted public partner destination.
        frame.locator('a[href="/about"]').first.click()
        dialog.locator('h1').wait_for()
        partner = '/en/partners' if locale == 'en' else '/partners'
        with page.expect_popup() as opened:
            dialog.locator('a[href="' + partner + '"]').press('Enter')
        popup = opened.value
        popup.wait_for_load_state()
        assert popup.url == BASE + partner
        popup.close()
        dialog.get_by_role('button', name=close, exact=True).click()
        dialog.wait_for(state='hidden')
        # Hostile markup exercises the actual import sanitizer, not a replica.
        good = {'mail': 'mailto:contact@example.org', 'social': 'https://vk.ru/lifeharbor', 'info': '/gratitude-journal', 'doc': '/terms.html?sign=DO_NOT_FORWARD', 'query': 'https://openrouter.ai/privacy?sign=DO_NOT_FORWARD#secret'}
        bad = ['javascript:alert(1)', 'data:text/html,evil', 'blob:https://openrouter.ai/id', 'http://openrouter.ai/privacy', 'https://user:pass@openrouter.ai/privacy', 'https://evil.example/privacy', '//evil.example/privacy', '/api/session', 'mailto:a@example.org?body=secret', 'java\nscript:alert(1)', 'https://user:pass@127.0.0.1:' + str(PORT) + '/terms.html']
        markup = '<main><section><h1>Sanitizer</h1><script>window.__injected=true</script><iframe src="https://evil.example"></iframe><p onclick="alert(1)">copy</p>'
        markup += ''.join('<a id="' + k + '" href="' + html.escape(v, quote=True) + '">' + k + '</a>' for k, v in good.items())
        markup += ''.join('<a id="bad' + str(i) + '" href="' + html.escape(v, quote=True) + '" target="_top" ping="https://evil.example">bad</a>' for i, v in enumerate(bad))
        markup += '<a id="download" href="https://openrouter.ai/privacy" download>download</a></section></main>'
        frame.page.route('**/privacy' + suffix + '*', lambda r: r.fulfill(content_type='text/html', body=markup))
        opener.click()
        dialog.locator('#mail').wait_for()
        for i in range(len(bad)):
            assert dialog.locator('#bad' + str(i)).get_attribute('href') is None, bad[i]
        assert dialog.locator('#download').get_attribute('href') is None
        assert dialog.locator('script,iframe,[onclick],[ping],[download]').count() == 0
        assert dialog.locator('#doc').get_attribute('href') == '/terms' + suffix
        assert dialog.locator('#query').get_attribute('href') == 'https://openrouter.ai/privacy'
        for key in ('mail', 'social', 'info'):
            assert dialog.locator('#' + key).get_attribute('href') == good[key]
            assert dialog.locator('#' + key).get_attribute('target') == '_blank'
        dialog.get_by_role('button', name=close, exact=True).click()
        dialog.wait_for(state='hidden')
        assert frame.url == launch
        assert frame.evaluate('document===window.__doc && document.querySelector("#entryNote")===window.__draft && state.user===window.__user && JSON.stringify({...localStorage})===window.__storage && JSON.stringify({...sessionStorage})===window.__session')
        assert frame.locator('#entryNote').input_value() == 'privacy-link-unsaved-draft'
        assert doc_requests and all(not any(k in r['headers'] for k in ('referer', 'authorization', 'cookie')) for r in doc_requests)
        assert all(urllib.parse.urlsplit(r['url']).query in ('', 'lang=en') for r in doc_requests)
        assert attempts and all(not any(k in r['headers'] for k in ('referer', 'authorization', 'cookie')) for r in attempts)
        assert all(not urllib.parse.urlsplit(r['url']).query for r in attempts)
        assert not errors, errors
        print(json.dumps({'locale': locale, 'popup_destinations': [r['url'] for r in attempts], 'document_fetches': [r['url'] for r in doc_requests], 'credential_headers_absent': True, 'outbound_transport': 'server denied; browser intercepted before popup first request'}), flush=True)
        print('PASS', locale, 'VK iframe trusted click/Enter popup destinations, modal/context/draft/focus/scroll/storage, privacy/terms/about, malicious links and credential isolation', flush=True)
        # Standalone asset returns before reader sanitization: original public link retained.
        standalone = ctx.new_page()
        ctx.unroute('**/*', route)
        ctx.route('**/*', lambda r: r.continue_() if r.request.url.startswith(BASE + '/') else r.fulfill(body=''))
        standalone.goto(BASE + '/privacy' + suffix)
        assert standalone.locator('a[href="https://openrouter.ai/privacy"]').count() == 1
        assert standalone.locator('dialog').count() == 0
        standalone.close()
    finally:
        ctx.close()


if __name__ == '__main__':
    main()
