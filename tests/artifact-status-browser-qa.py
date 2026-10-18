#!/usr/bin/env python3
"""7624318: actual entry -> SQLite award -> modal -> tab -> status expiry.
Isolated SQLite, scheduler off, server and browser outbound blocked.
KOPILKA_ARTIFACT_RED=1 replaces only the one-line fix with its preimage.
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
PORT = 3338
BASE = f'http://127.0.0.1:{PORT}'
NEW = "setStatus(L('artifactUnlockedStatus', { title: first.title }), 'info', 'entry-success');"
OLD = "setStatus(L('artifactUnlockedStatus', { title: first.title }));"
results = []
with tempfile.TemporaryDirectory(prefix='kopilka-artifact-qa-') as tmp:
    db_path = str(Path(tmp, 'qa.sqlite'))
    env = {'PATH': os.environ['PATH'], 'HOME': tmp, 'TMPDIR': tmp,
           'NODE_ENV': 'test', 'PORT': str(PORT), 'APP_BASE_URL': BASE,
           'WEBAPP_URL': BASE, 'DB_PATH': db_path, 'SCHEDULER_ENABLED': 'false',
           'DEV_AUTH_ENABLED': 'true', 'SESSION_SECRET': 'artifact-fixture-only',
           'BOT_TOKEN': '', 'BOT_USERNAME': '', 'VK_GROUP_TOKEN': '',
           'VK_SECURE_KEY': '', 'VK_APP_ID': '', 'VK_GROUP_ID': '',
           'VK_OAUTH_CLIENT_ID': '', 'VK_OAUTH_CLIENT_SECRET': '',
           'RESEND_API_KEY': '', 'GOOGLE_CLIENT_ID': '', 'GOOGLE_CLIENT_SECRET': '',
           'VAPID_PUBLIC_KEY': '', 'VAPID_PRIVATE_KEY': ''}
    boot = """require('dotenv').config=()=>({});global.fetch=()=>Promise.reject(Error('QA outbound blocked'));for(const n of ['http','https']){const m=require(n);m.request=m.get=()=>{throw Error('QA outbound blocked')}}require('./src/server.js').createApp().listen(3338,'127.0.0.1')"""
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(('127.0.0.1', PORT))
    with Path(tmp, 'server.log').open('w+') as log:
        proc = subprocess.Popen(['node', '-e', boot], cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 30
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
                browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox', '--disable-background-networking'])
                try:
                    for language in ['ru', 'en']:
                        ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
                        def route(r):
                            if not r.request.url.startswith(BASE + '/'):
                                r.abort()
                            elif os.environ.get('KOPILKA_ARTIFACT_RED') == '1' and '/app.js' in r.request.url:
                                response = r.fetch()
                                source = response.text()
                                assert source.count(NEW) == 1
                                r.fulfill(response=response, body=source.replace(NEW, OLD))
                            elif os.environ.get('KOPILKA_ARTIFACT_CLIENT') and '/app.js' in r.request.url:
                                r.fulfill(status=200, body=Path(os.environ['KOPILKA_ARTIFACT_CLIENT']).read_text(), content_type='application/javascript')
                            else:
                                r.continue_()
                        ctx.route('**/*', route)
                        page = ctx.new_page()
                        errors = []
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        auth = ctx.request.post(BASE + '/api/auth/dev', data={'firstName': 'Artifact fixture', 'locale': language, 'timezone': 'UTC'}).json()
                        page.add_init_script('localStorage.setItem("kopilkaToken",' + json.dumps(auth['token']) + ');localStorage.setItem("kopilkaLocale",' + json.dumps(language) + ')')
                        page.goto(BASE)
                        page.wait_for_function('state.user && state.summary && !state.busy')
                        uid = page.evaluate('state.user.id')
                        for kind in ['sleep', 'movement', 'important_task', 'dream_step', 'kind_trace', 'food_water']:
                            page.locator('[data-entry-type="' + kind + '"]').click()
                            page.wait_for_function('!state.busy && !state.refreshPending')
                        page.locator('#artifactToast').wait_for(state='visible')
                        assert page.evaluate('state.artifactQueue[0].id') == 'cat_life_warmer'
                        region = page.locator('#statusRegion')
                        assert region.inner_text() == page.evaluate('L("artifactUnlockedStatus", {title:state.artifactQueue[0].title})')
                        page.locator('#artifactToastClose').click()
                        page.locator('#artifactToast').wait_for(state='hidden')
                        page.locator('#tab-button-week').click()
                        page.wait_for_function('document.querySelector("#statusRegion").textContent === ""', timeout=7000)
                        with sqlite3.connect('file:' + db_path + '?mode=ro', uri=True) as db:
                            assert db.execute('SELECT COUNT(*) FROM entries WHERE user_id=?', (uid,)).fetchone()[0] == 6
                            assert db.execute('SELECT artifact_id FROM user_artifacts WHERE user_id=?', (uid,)).fetchall() == [('cat_life_warmer',)]
                        # Replay the real persisted artifact through the same dialog function.
                        # Its modal must stay available even after its separate status expires.
                        page.evaluate('showArtifactToast([state.artifacts.find(a=>a.id==="cat_life_warmer")])')
                        page.locator('#artifactToast').wait_for(state='visible')
                        page.wait_for_function('document.querySelector("#statusRegion").textContent === ""', timeout=7000)
                        assert page.locator('#artifactToastClose').is_visible()
                        assert page.evaluate('state.artifactQueue.length') == 1
                        page.locator('#artifactToastClose').click()
                        page.locator('#artifactToast').wait_for(state='hidden')
                        # A later warning owns the live region; the old artifact timer is stale.
                        page.evaluate('showArtifactToast([state.artifacts.find(a=>a.id==="cat_life_warmer")]);setStatus("New failure", "error")')
                        page.wait_for_timeout(5300)
                        assert region.inner_text() == 'New failure'
                        page.locator('#artifactToastClose').click()
                        assert not errors, errors
                        results.append({'language': language, 'connected_unlock_expiry': True, 'modal_preserved': True, 'later_error_preserved': True, 'sqlite_award': True, 'page_errors': errors})
                        ctx.close()
                finally:
                    browser.close()
            print(json.dumps({'passed': results}, ensure_ascii=False))
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
