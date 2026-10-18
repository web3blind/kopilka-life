#!/usr/bin/env python3
"""Private disposable real-HTTP/SQLite email QA; Linux WebKit != real iPhone Safari.

Run: python3 tests/safari-email-isolation-qa.py
If WebKit host libraries are missing, explicit non-Safari UI evidence:
  python3 tests/safari-email-isolation-qa.py --browser chromium-local
Future phone staging: python3 tests/safari-email-isolation-qa.py --serve-seconds 900 --port 3198
No tunnel is created. Requires separately approved access-controlled HTTPS tunnel,
cloud real-iPhone Safari session/privacy agreement and protected registration.
Only fictional qa@safari-qa.test; actual issued OTP is in private 0600 sink.json,
never console/chat. Deliver to the authorized test operator via protected local
access, not a public OTP endpoint. Sink/temp DB/log disappear when run ends.
Provider recordings, session cleanup and tunnel teardown must be verified.

Boundary: only outbound email transport is replaced. App OTP generation, hash,
attempt limits, consumption, auth routes, session and database are unchanged.
GEO_COUNTRY_DB_PATH='' selects existing non-production DEV/global region fixture;
this does NOT validate geographic detection or production RU email eligibility.
Fresh environment, cwd without .env, separate DB, loopback, scheduler/dev-auth off.
Uses installed Python Playwright, same real app as run-browser-qa.py, no new framework.
"""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import signal
import sys
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
EMAIL = 'qa@safari-qa.test'


def request(base, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(base + path, data=data, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)


def rows(db, sql):
    with sqlite3.connect(db) as conn:
        return conn.execute(sql).fetchall()


def baseline(base, db, sink, secret, engine, webkit_executable=None):
    from playwright.sync_api import sync_playwright
    errors = []
    with sync_playwright() as p:
        try:
            browser = (p.webkit.launch(headless=True, executable_path=webkit_executable) if engine == 'webkit' else
                       p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox']))
        except Exception:
            print(f'BLOCKED {engine} runtime launch; check installed browser/host dependencies. No Safari acceptance claimed.', flush=True)
            raise
        ctx = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        # Privacy firewall: no third-party SDK/provider request leaves this context.
        ctx.route('**/*', lambda route: route.continue_() if route.request.url.startswith(base + '/') else route.abort())
        page = ctx.new_page()
        page.on('pageerror', lambda _: errors.append('pageerror'))
        try:
            page.goto(base, wait_until='domcontentloaded')
            page.locator('#emailLoginAddress').fill(EMAIL)
            with page.expect_response(lambda r: '/api/auth/email/request' in r.url) as issued:
                page.locator('#emailLoginSend').click()
            assert issued.value.status == 200, 'request failed'
            page.locator('#emailCodeForm').wait_for(state='visible')
            delivered = json.loads(sink.read_text())
            assert delivered['email'] == EMAIL
            code = delivered['code']
            assert sink.stat().st_mode & 0o777 == 0o600
            challenge = rows(db, 'SELECT code_hash,attempts,window_count FROM email_login_codes')[0]
            salt, digest = challenge[0].split('.')
            actual = hmac.new(secret.encode(), f'{EMAIL}\0{code}\0{salt}'.encode(), hashlib.sha256).hexdigest()
            assert hmac.compare_digest(actual, digest) and challenge[1:] == (0, 1)
            print('PASS actual random OTP stored as salted HMAC; sink permissions 0600', flush=True)
            before = sink.read_bytes()
            assert request(base, '/api/auth/email/request', {'email': EMAIL})[0] == 200
            assert sink.read_bytes() == before and rows(db, 'SELECT window_count FROM email_login_codes') == [(1,)]
            print('PASS resend cooldown retained (no extra delivery)', flush=True)
            wrong = '000000' if code != '000000' else '000001'
            page.locator('#emailLoginCode').fill(wrong)
            with page.expect_response(lambda r: '/api/auth/email/verify' in r.url) as rejected:
                page.locator('#emailCodeForm button').click()
            assert rejected.value.status == 401, 'wrong code accepted'
            assert rows(db, 'SELECT attempts FROM email_login_codes') == [(1,)]
            assert rows(db, 'SELECT count(*) FROM users') == [(0,)]
            assert not page.evaluate("Boolean(localStorage.getItem('kopilkaToken'))")
            assert page.locator('#emailLoginStatus').inner_text().strip()
            print('PASS wrong code rejected by real HTTP/backend; attempts increment; no account/session', flush=True)
            page.locator('#emailLoginCode').fill(code)
            with page.expect_response(lambda r: '/api/auth/email/verify' in r.url) as verified:
                page.locator('#emailCodeForm button').click()
            assert verified.value.status == 200, 'generated OTP rejected'
            issued_token = verified.value.json()['token']
            page.locator('#appShell').wait_for(state='visible', timeout=30000)
            page.wait_for_function('state.user !== null')
            user_id = page.evaluate('state.user.id')
            assert rows(db, "SELECT provider,subject,user_id FROM login_identities") == [('email', EMAIL, user_id)]
            assert rows(db, 'SELECT code_hash,attempts,expires_at FROM email_login_codes') == [('consumed', 5, 0)]
            print('PASS generated OTP login creates real SQLite identity and consumes code', flush=True)
            page.reload(wait_until='domcontentloaded')
            page.locator('#appShell').wait_for(state='visible', timeout=30000)
            page.wait_for_function('state.user !== null')
            assert page.evaluate('state.user.id') == user_id
            assert page.evaluate("Boolean(localStorage.getItem('kopilkaToken'))")
            assert request(base, '/api/auth/email/verify', {'email': EMAIL, 'code': code})[0] == 401
            assert request(base, '/api/me')[0] == 401
            assert not errors, 'browser page errors'
            print('PASS reload preserves same authenticated user; replay/anonymous private API rejected; pageerrors=0', flush=True)
            page.close()
            page = ctx.new_page()
            page.on('pageerror', lambda _: errors.append('pageerror'))
            page.goto(base, wait_until='domcontentloaded')
            page.locator('#appShell').wait_for(state='visible', timeout=30000)
            page.wait_for_function('state.user !== null')
            assert page.evaluate('state.user.id') == user_id and not errors
            print('PASS close/reopen restores the same fictional user and visible app shell', flush=True)
            limit_email = 'limits@safari-qa.test'
            assert request(base, '/api/auth/email/request', {'email': limit_email})[0] == 200
            limit_code = json.loads(sink.read_text())['code']
            limit_wrong = '000000' if limit_code != '000000' else '000001'
            for _ in range(5):
                assert request(base, '/api/auth/email/verify', {'email': limit_email, 'code': limit_wrong})[0] == 401
            assert request(base, '/api/auth/email/verify', {'email': limit_email, 'code': limit_code})[0] == 401
            assert rows(db, 'SELECT count(*) FROM users') == [(1,)]
            server_log = (sink.parent / 'server.log').read_text()
            assert all(value not in server_log for value in (code, limit_code, secret, issued_token))
            print('PASS actual five-attempt lockout rejects issued OTP; no OTP/session secret/token in server log', flush=True)
        finally:
            ctx.close()
            browser.close()
    print(f'PASS Linux {engine} mobile baseline ONLY; real iPhone Safari acceptance NOT performed', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--browser', choices=('webkit', 'chromium-local'), default='webkit', help='explicit Chromium fallback is NOT Safari evidence')
    parser.add_argument('--webkit-executable', help='explicit task-local WebKit launcher; never changes the shared installation')
    parser.add_argument('--serve-seconds', type=int, default=0, help='bounded private staging, 1..1800 seconds; no browser baseline')
    parser.add_argument('--port', type=int, default=0, help='0 selects an available ephemeral loopback port')
    args = parser.parse_args()
    def stop(_signum, _frame):
        raise RuntimeError('QA interrupted or lifetime exceeded')
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGALRM, stop)
    if not 0 <= args.serve_seconds <= 1800 or not 0 <= args.port <= 65535:
        parser.error('invalid lifetime/port')
    signal.alarm((args.serve_seconds or 120) + 30)
    scratch = Path(os.environ.get('TMPDIR', (tempfile.gettempdir() + '/kopilka-qa'))).resolve()
    scratch.mkdir(parents=True, exist_ok=True)
    proc = None
    tmp = Path(tempfile.mkdtemp(prefix='kopilka-safari-email-', dir=scratch))
    os.chmod(tmp, 0o700)
    port = args.port
    if not port:
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            port = s.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    secret = secrets.token_hex(32)
    db, sink = tmp / 'qa.sqlite', tmp / 'sink.json'
    try:
        for name in ('public', 'migrations'):
            (tmp / name).symlink_to(ROOT / name, target_is_directory=True)
        assert not (tmp / '.env').exists()
        # Allowlist rather than copying os.environ: cannot inherit live credentials.
        env = {k: os.environ[k] for k in ('PATH', 'HOME', 'TMPDIR', 'LD_LIBRARY_PATH') if k in os.environ}
        env.update(NODE_ENV='test', DB_PATH=str(db), SCHEDULER_ENABLED='false', DEV_AUTH_ENABLED='false',
                   SESSION_SECRET=secret, GEO_COUNTRY_DB_PATH='', RESEND_API_KEY='fixture-only',
                   EMAIL_FROM='sender@safari-qa.test', EMAIL_REPLY_TO='reply@safari-qa.test',
                   APP_BASE_URL=base, WEBAPP_URL=base, PORT=str(port), KOPILKA_SAFARI_QA_CODES=str(sink))
        # createApp is canonical entry, explicit loopback; scheduler is not started.
        entry = f"const {{createApp}}=require({json.dumps(str(ROOT / 'src/server.js'))});const s=createApp().listen({port},'127.0.0.1');setTimeout(()=>s.close(()=>process.exit(0)),{(args.serve_seconds or 180)+60}*1000).unref();"
        with (tmp / 'server.log').open('w') as log:
            proc = subprocess.Popen(['node', '--require', str(ROOT / 'tests/fixtures/safari-email-provider-preload.cjs'), '-e', entry], cwd=tmp, env=env, stdout=log, stderr=log)
            deadline = time.monotonic() + 30
            while True:
                try:
                    assert request(base, '/health')[0] == 200
                    break
                except (OSError, AssertionError):
                    if proc.poll() is not None or time.monotonic() >= deadline:
                        raise RuntimeError('isolated app startup failed; logs suppressed for privacy')
                    time.sleep(.1)
            assert rows(db, 'SELECT count(*) FROM users') == [(0,)]
            assert request(base, '/api/auth/dev', {})[0] in (403, 404)
            listeners = [line.split()[1] for line in Path('/proc/net/tcp').read_text().splitlines()[1:]
                         if line.split()[3] == '0A' and line.split()[1].endswith(f':{port:04X}')]
            assert listeners == [f'0100007F:{port:04X}'], 'listener not loopback-only'
            print('PASS isolated empty SQLite, cwd without .env, credential allowlist, scheduler/dev-auth OFF, loopback only', flush=True)
            if args.serve_seconds:
                print(f'PRIVATE staging {base}; lifetime={args.serve_seconds}s; local-only sink directory: {tmp}; no tunnel created', flush=True)
                until = time.monotonic() + args.serve_seconds
                while time.monotonic() < until:
                    if proc.poll() is not None:
                        raise RuntimeError('staging process exited early')
                    time.sleep(min(.2, max(0, until - time.monotonic())))
            else:
                baseline(base, db, sink, secret, args.browser, args.webkit_executable)
    finally:
        if proc is not None:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
            assert proc.poll() is not None
        shutil.rmtree(tmp)
        assert not tmp.exists()
        with socket.socket() as s:
            assert s.connect_ex(('127.0.0.1', port)) != 0, 'owned listener still present'
        signal.alarm(0)
        print('PASS cleanup: own server stopped, loopback port closed, disposable DB/WAL/sink/log directory removed', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Playwright exception/call logs may contain field values: never dump them.
        print(f'FAIL {type(error).__name__}; diagnostic payload suppressed for OTP/session privacy', file=sys.stderr)
        sys.exit(1)
