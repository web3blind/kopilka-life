#!/usr/bin/env python3
"""Copy notice lifetime regression on real isolated VK auth/HTTP/SQLite."""
import os, time, base64, hashlib, hmac, urllib.parse
from playwright.sync_api import sync_playwright
BASE = os.environ['KOPILKA_QA_BASE_URL']
assert os.environ['NODE_ENV'] == 'test' and 'qa.sqlite' in os.environ['DB_PATH']
v = {'vk_app_id': os.environ['VK_APP_ID'], 'vk_user_id': '81992119', 'vk_platform': 'mobile_android', 'vk_ts': str(int(time.time()))}
v['sign'] = base64.urlsafe_b64encode(hmac.new(os.environ['VK_SECURE_KEY'].encode(), urllib.parse.urlencode(sorted(v.items())).encode(), hashlib.sha256).digest()).decode().rstrip('=')
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    try:
        c = b.new_context(viewport={'width': 393, 'height': 852})
        try:
            c.route('https://**/*', lambda r: r.fulfill(status=200, body=''))
            c.route('**/vendor/vk-bridge*', lambda r: r.fulfill(status=200, content_type='application/javascript', body="window.vkBridge={send:()=>Promise.resolve({result:true}),supports:()=>true,subscribe:()=>{}};"))
            page = c.new_page()
            page.goto(BASE + '/?' + urllib.parse.urlencode(v))
            page.wait_for_function('state.user&&!state.busy', timeout=30000)
            for language in ['ru', 'en']:
                page.evaluate("lang => {state.user.locale=lang;storage.set('kopilkaLocale',lang);renderAll();}", language)
                page.locator('#tab-button-profile').click()
                page.locator('#copyRefLink').click()
                page.wait_for_function("$('statusRegion').textContent===L('copied')")
                page.wait_for_timeout(1100)
                assert page.locator('#statusRegion').inner_text() == page.evaluate("L('copied')")
                page.wait_for_timeout(2100)
                assert not page.locator('#statusRegion').inner_text(), 'copy success must expire in 2–3 seconds'
                print('PASS', language, 'native-copy success expires', flush=True)
            for kind in ['error', 'info']:
                page.locator('#copyRefLink').click()
                page.wait_for_function("$('statusRegion').textContent===L('copied')")
                page.wait_for_timeout(500)
                page.evaluate("kind => setStatus('New durable status',kind)", kind)
                page.wait_for_timeout(2800)
                assert page.locator('#statusRegion').inner_text() == 'New durable status'
            page.evaluate("state.refreshFailed=true;setStatus(L('copied'),'info','copy')")
            page.wait_for_timeout(3200)
            assert page.evaluate("$('statusRegion').textContent.trim()===L('refreshPending')")
            page.evaluate("state.refreshFailed=false;setStatus('Durable error','error')")
            page.locator('#copyRefLink').click()
            page.wait_for_function("$('statusRegion').textContent===L('copied')")
            page.wait_for_timeout(3200)
            assert page.locator('#statusRegion').inner_text() == 'Durable error'
            print('PASS timer fence and durable error/refresh warning preservation', flush=True)
            page.locator('#copyRefLink').click()
            page.wait_for_function("$('statusRegion').textContent===L('copied')")
            page.wait_for_timeout(1600)
            page.locator('#copyRefLink').click()
            page.wait_for_timeout(1200)
            assert page.locator('#statusRegion').inner_text() == page.evaluate("L('copied')"), 'new copy owns its own lifetime'
            page.wait_for_timeout(1800)
            assert page.locator('#statusRegion').inner_text() == 'Durable error', 'repeated copies must retain the prior durable error'
            print('PASS repeated copy timer fence and prior durable error restoration', flush=True)
            import sqlite3
            with sqlite3.connect(os.environ['DB_PATH']) as db:
                before = db.execute('SELECT COUNT(*) FROM entries').fetchone()[0]
            for language, expected in [('ru', 'Не удалось связаться с сервером. Проверь подключение к интернету. Перед повторной отправкой проверь историю: действие могло сохраниться.'), ('en', 'Could not reach the server. Check your internet connection. Before retrying, check History: the action may have been saved.')]:
                page.evaluate("lang => {state.user.locale=lang;storage.set('kopilkaLocale',lang);renderAll();}", language)
                page.locator('#tab-button-today').click()
                attempted = []
                def record_request(request):
                    if '/api/' in request.url:
                        attempted.append(urllib.parse.urlparse(request.url).path)
                page.on('request', record_request)
                c.set_offline(True)
                try:
                    page.locator('[data-entry-type="food_water"]').click()
                    page.wait_for_function("!state.busy && $('statusRegion').classList.contains('error')")
                    assert page.locator('#statusRegion').inner_text() == expected
                    page.wait_for_timeout(3200)
                    assert page.locator('#statusRegion').inner_text() == expected
                    assert attempted == ['/api/entries'], ('no retries or provider auth on transport failure', attempted)
                finally:
                    page.remove_listener('request', record_request)
                    c.set_offline(False)
                # Real API validation errors keep the backend's localized explanation.
                result = page.evaluate("""async () => {
                  const options={method:'POST',body:JSON.stringify({type:'invalid-type'})};
                  const raw=await fetch('/api/entries',{...options,headers:{'content-type':'application/json',authorization:`Bearer ${state.token}`}});
                  const data=await raw.json();
                  try {await api('/api/entries',options);return null;}catch(error){return {status:error.status,message:error.message,server:data.error};}
                }""")
                assert result['status'] == 400 and result['message'] == result['server'], result
                print('PASS', language, 'offline Food/Water localized/durable; backend validation retained', flush=True)
            with sqlite3.connect(os.environ['DB_PATH']) as db:
                assert db.execute('SELECT COUNT(*) FROM entries').fetchone()[0] == before
            print('PASS offline taps created no SQLite entries', flush=True)
        finally:
            c.close()
    finally:
        b.close()
