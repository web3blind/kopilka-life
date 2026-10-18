#!/usr/bin/env python3
"""report7643006: real local app/SQLite and standalone Chromium, no shared CDP.
Run: python3 tests/gratitude-hints-cursor-browser-qa.py
KOPILKA_GRATITUDE_CSS may point to a saved CSS preimage for RED verification.
"""
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def run(base, db):
    results = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                                    args=['--no-sandbox', '--disable-background-networking'])
        try:
            for lang in ['ru', 'en']:
                for touch in [False, True]:
                    ctx = browser.new_context(viewport={'width': 390 if touch else 1280, 'height': 900},
                                              has_touch=touch, is_mobile=touch, service_workers='block')
                    try:
                        response = ctx.request.post(base+'/api/auth/dev', data={
                            'firstName': 'Gratitude cursor fixture', 'locale': lang, 'timezone': 'UTC'})
                        assert response.ok, response.text()
                        auth = response.json()

                        def local_only(route):
                            if not route.request.url.startswith(base+'/'):
                                route.abort()
                            elif '/styles.css' in route.request.url and os.environ.get('KOPILKA_GRATITUDE_CSS'):
                                route.fulfill(content_type='text/css', body=Path(os.environ['KOPILKA_GRATITUDE_CSS']).read_text())
                            else:
                                route.continue_()

                        ctx.route('**/*', local_only)
                        ctx.add_init_script('localStorage.setItem("kopilkaToken",'+json.dumps(auth['token'])+
                                            ');localStorage.setItem("kopilkaLocale",'+json.dumps(lang)+')')
                        page = ctx.new_page()
                        errors = []
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        page.goto(base)
                        page.wait_for_function('state.user && state.summary && state.product && !state.busy')
                        assert page.evaluate('state.user.id') == auth['user']['id']
                        details = page.locator('#gratitudeHints')
                        summary = page.locator('#gratitudeHints > summary')
                        assert summary.inner_text() == ('Подсказки' if lang == 'ru' else 'Hints')
                        assert not details.evaluate('(e) => e.open')
                        summary.hover()
                        cursor = summary.evaluate('(e) => getComputedStyle(e).cursor')
                        assert summary.evaluate('(e) => e.matches(":hover")')
                        prose = page.locator('#gratitudeNoteHint')
                        prose.hover()
                        prose_cursor = prose.evaluate('(e) => getComputedStyle(e).cursor')
                        assert prose_cursor != 'pointer', prose_cursor
                        assert page.locator('body').evaluate('(e) => getComputedStyle(e).cursor') != 'pointer'
                        # Native click/tap toggles in both directions; no scripted details.open changes.
                        activate = summary.tap if touch else summary.click
                        activate()
                        assert details.evaluate('(e) => e.open')
                        assert page.locator('#gratitudeHints button').first.is_visible()
                        activate()
                        assert not details.evaluate('(e) => e.open')
                        assert not page.locator('#gratitudeHints button').first.is_visible()
                        # Reach summary through the actual tab order, retaining native focus indication.
                        page.locator('#gratitudeNote').focus()
                        page.keyboard.press('Tab')
                        assert summary.evaluate('(e) => e === document.activeElement')
                        focus = summary.evaluate('''(e) => ({visible:e.matches(':focus-visible'),
                            style:getComputedStyle(e).outlineStyle, width:getComputedStyle(e).outlineWidth})''')
                        assert focus['visible'] and focus['style'] != 'none' and focus['width'] != '0px', focus
                        for key in ['Enter', 'Space']:
                            page.keyboard.press(key)
                            assert details.evaluate('(e) => e.open'), key
                            assert summary.evaluate('(e) => e === document.activeElement')
                            page.keyboard.press(key)
                            assert not details.evaluate('(e) => e.open'), key
                        with sqlite3.connect('file:'+str(db)+'?mode=ro', uri=True) as conn:
                            assert conn.execute('SELECT COUNT(*) FROM users WHERE id=?', (auth['user']['id'],)).fetchone()[0] == 1
                            assert conn.execute('SELECT COUNT(*) FROM entries WHERE user_id=?', (auth['user']['id'],)).fetchone()[0] == 0
                        assert not errors, errors
                        result = {'lang': lang, 'mode': 'touch' if touch else 'desktop', 'summaryCursor': cursor,
                                  'proseCursor': prose_cursor, 'focus': focus, 'nativeClickOrTap': True,
                                  'enterAndSpace': True, 'pageErrors': errors, 'pass': cursor == 'pointer'}
                        results.append(result)
                        print(json.dumps(result), flush=True)
                    finally:
                        ctx.close()
        finally:
            browser.close()
    assert all(row['pass'] for row in results), 'report7643006: summary computed cursor must be pointer'
    print('GRATITUDE_HINTS_CURSOR_CONNECTED_PASS', len(results), flush=True)


def main():
    # Empty cwd plus allowlisted environment prevents dotenv/provider/real DB access.
    scratch = os.environ.get('TMPDIR', str(Path.home()/'.hermes/cache/scratch'))
    with tempfile.TemporaryDirectory(prefix='gratitude-hints-cursor-', dir=scratch) as tmp:
        tmp = Path(tmp)
        for name in ['public', 'migrations']:
            (tmp/name).symlink_to(ROOT/name, target_is_directory=True)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        base = 'http://127.0.0.1:'+str(port)
        db = tmp/'qa.sqlite'
        env = {'PATH': os.environ['PATH'], 'HOME': str(Path.home()), 'NODE_ENV': 'test', 'PORT': str(port),
               'DB_PATH': str(db), 'DEV_AUTH_ENABLED': 'true', 'SCHEDULER_ENABLED': 'false',
               'SESSION_SECRET': 'gratitude-cursor-local-fixture-only', 'BOT_TOKEN': '', 'VK_SECURE_KEY': '',
               'APP_BASE_URL': base, 'WEBAPP_URL': base, 'GEO_COUNTRY_DB_PATH': str(tmp/'missing.mmdb')}
        with (tmp/'server.log').open('w+') as log:
            proc = subprocess.Popen(['node', str(ROOT/'src/server.js')], cwd=tmp, env=env, stdout=log, stderr=log)
            try:
                deadline = time.monotonic()+30
                while True:
                    try:
                        urllib.request.urlopen(base+'/health', timeout=1).close()
                        break
                    except Exception:
                        if proc.poll() is not None or time.monotonic() > deadline:
                            log.seek(0)
                            raise RuntimeError(log.read())
                        time.sleep(.1)
                run(base, db)
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                assert proc.poll() is not None


if __name__ == '__main__':
    main()
