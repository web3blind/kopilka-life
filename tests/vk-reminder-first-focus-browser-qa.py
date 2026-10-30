#!/usr/bin/env python3
"""Connected first-iframe-focus regression, adapted from report7653813 focus-probe.py.

Run directly (owns server/SQLite/browser), not inside run-browser-qa.py:
  python tests/vk-reminder-first-focus-browser-qa.py --output /path/to/evidence
Default runs the original HEAD=3c7e798 RED witness then working-tree GREEN.
No fast mode: all matrix cases always run. No live provider transport is allowed.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASELINE = '3c7e79825b82c40855c4964ada7289e561281d01'
BRIDGE = """window.qaCalls=0;window.vkBridge={send(method){
 if(method==='VKWebAppAllowMessagesFromGroup') {qaCalls++;return new Promise(r=>window.qaResolve=r)}
 if(method==='VKWebAppGetLaunchParams')return Promise.resolve({});
 return Promise.resolve({result:true})},subscribe(){},supports(){return true}};"""
SNAPSHOT = """({calls:window.qaCalls||0,events:window.qaEvents||[],
 status:document.querySelector('#statusRegion').textContent,busy:state.busy,
 pending:state.refreshPending,day:refreshedDay,localDay:localDay(),last:state.lastRefresh,
 user:state.user.id,locale:state.user.locale,timezone:state.user.timezone,
 allowed:state.user.vkMessagesAllowed,reminders:state.user.remindersEnabled})"""


def signed_launch(uid):
    params = dict(vk_app_id='54723764', vk_user_id=str(uid),
                  vk_ts=str(int(time.time())), vk_platform='mobile_web')
    params['sign'] = base64.urlsafe_b64encode(hmac.new(
        b'fixture-key', urllib.parse.urlencode(sorted(params.items())).encode(),
        hashlib.sha256).digest()).decode().rstrip('=')
    return urllib.parse.urlencode(params)


def database_user(db, uid):
    with sqlite3.connect(f'file:{db}?mode=ro', uri=True) as conn:
        conn.row_factory = sqlite3.Row
        return dict(conn.execute('SELECT id,vk_messages_allowed,reminders_enabled,locale,timezone '
                                 'FROM users WHERE vk_id=?', (str(uid),)).fetchone())


def run_case(browser, base, db, name, uid, language='ru', tab='today',
             entry='touch', baseline=None, red=False, throttle=False, output=None):
    ctx = browser.new_context(viewport={'width': 402, 'height': 874},
                              has_touch=True, is_mobile=True, service_workers='block')
    launch = signed_launch(uid)
    auth = ctx.request.post(base + '/api/auth/vk', data={
        'launchParams': launch, 'locale': language, 'timezone': 'UTC'}).json()
    assert auth.get('token'), auth
    control = {'delay': False, 'fail': False}
    telemetry = {'name': name, 'reads': [], 'writes': [], 'blocked': []}

    def route(r):
        url = r.request.url
        path = urllib.parse.urlparse(url).path
        if not url.startswith(base + '/'):
            telemetry['blocked'].append(url)
            r.abort()
        elif '/vendor/vk-bridge' in path:
            r.fulfill(content_type='application/javascript', body=BRIDGE)
        elif path == '/qa-parent':
            r.fulfill(content_type='text/html', body=(
                '<html><meta name="viewport" content="width=device-width,initial-scale=1">'
                '<body style="margin:0"><button id="outside">Host focus</button>'
                '<iframe id="app" style="border:0;width:100%;height:820px" src="' +
                base + '/?' + launch + '"></iframe></body></html>'))
        elif path == '/app.js' and baseline is not None:
            r.fulfill(content_type='application/javascript', body=baseline)
        else:
            if path.startswith('/api/'):
                telemetry['reads' if r.request.method == 'GET' else 'writes'].append(path)
            if path == '/api/me':
                if control['delay']:
                    time.sleep(.5)
                if control['fail']:
                    r.fulfill(status=503, content_type='application/json', body='{"error":"fixture read failed"}')
                    return
            r.continue_()

    ctx.route('**/*', route)
    page = ctx.new_page()
    try:
        page.goto(base + '/qa-parent')
        child = next(f for f in page.frames if f != page.main_frame)
        child.wait_for_function("typeof state!=='undefined' && state.user && state.product && !state.busy")
        child.wait_for_function("document.querySelector('#statusRegion').textContent===L('ready')")
        assert child.evaluate('state.activeTab') == 'today'
        assert child.evaluate('state.user.locale') == language
        child.evaluate("""window.qaEvents=[];for(const name of ['focus','blur','pointerdown','pointerup','click','keydown'])
 window.addEventListener(name,e=>qaEvents.push({type:e.type,trusted:e.isTrusted,
 target:e.target.id||e.target.tagName,busy:state.busy,pending:state.refreshPending,
 day:refreshedDay,last:state.lastRefresh}),true)""")
        telemetry['startup'] = child.evaluate(SNAPSHOT)
        assert telemetry['startup']['calls'] == 0
        if not red:
            assert telemetry['startup']['day'] == telemetry['startup']['localDay']
        if throttle:
            exercise_throttle(page, child, ctx, base, control, telemetry)
            return telemetry
        if tab == 'settings':
            child.locator('[data-tab="settings"]').click()
        selector = ('#vkReminderPrompt' if tab == 'today' else '#vkReminderBox') + ' [data-enable-vk-reminders]'
        button = child.locator(selector)
        button.scroll_into_view_if_needed()
        page.locator('#outside').focus()
        assert not child.evaluate('document.hasFocus()')
        control['delay'] = True
        before = telemetry['reads'].count('/api/me')
        box = button.bounding_box()
        assert box
        telemetry['hit'] = child.evaluate("""s=>{let b=document.querySelector(s),r=b.getBoundingClientRect();
 return {target:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML,
 rect:{x:r.x,y:r.y,width:r.width,height:r.height},disabled:b.disabled}}""", selector)
        assert not telemetry['hit']['disabled']
        if entry == 'touch':
            page.touchscreen.tap(box['x'] + box['width']/2, box['y'] + box['height']/2)
        else:
            # Tab from host into the real iframe; no DOM click/handler invocation.
            for _ in range(100):
                page.keyboard.press('Tab')
                if child.evaluate('s=>document.hasFocus() && document.activeElement===document.querySelector(s)', selector):
                    break
            else:
                raise AssertionError('Keyboard traversal never reached CTA')
            page.keyboard.press('Enter')
        page.wait_for_timeout(900)
        telemetry['first'] = child.evaluate(SNAPSHOT)
        if red:
            assert telemetry['first']['calls'] == 0, 'Original must reproduce swallowed first touch'
            assert telemetry['first']['status'] == telemetry['startup']['status']
            assert telemetry['reads'].count('/api/me') == before + 1
            box = button.bounding_box()
            page.touchscreen.tap(box['x'] + box['width']/2, box['y'] + box['height']/2)
            child.wait_for_function('qaCalls===1')
            telemetry['second'] = child.evaluate(SNAPSHOT)
            return telemetry
        assert telemetry['first']['calls'] == 1, telemetry['first']
        assert telemetry['first']['status'] == child.evaluate("L('vkReminderRequesting')")
        assert telemetry['reads'].count('/api/me') == before, 'Fresh focus must not reload'
        assert any(e['trusted'] and e['type'] == 'focus' for e in telemetry['first']['events'])
        assert any(e['trusted'] and e['type'] == 'click' for e in telemetry['first']['events'])
        # Real duplicate input during unresolved permission is ignored.
        if entry == 'touch':
            page.touchscreen.tap(box['x'] + box['width']/2, box['y'] + box['height']/2)
        else:
            page.keyboard.press('Enter')
        page.wait_for_timeout(100)
        assert child.evaluate('qaCalls') == 1
        child.evaluate('qaResolve({result:false})')
        child.wait_for_function('vkReminderRequest===null')
        assert child.evaluate('qaCalls') == 1
        assert '/api/settings/vk-messages' not in telemetry['writes']
        denied = database_user(db, uid)
        assert not denied['vk_messages_allowed'] and not denied['reminders_enabled'], denied
        telemetry['denied'] = child.evaluate(SNAPSHOT)
        # Retry is explicit and invokes the same real event handler.
        button.click()
        child.wait_for_function('qaCalls===2')
        child.evaluate('qaResolve({result:true})')
        child.wait_for_function('vkReminderRequest===null && !state.busy && state.user.vkMessagesAllowed')
        assert telemetry['writes'].count('/api/settings/vk-messages') == 1
        saved = database_user(db, uid)
        assert saved['vk_messages_allowed'] == 1 and saved['reminders_enabled'] == 1, saved
        telemetry['saved'] = saved
        child.goto(child.url)
        child.wait_for_function("typeof state!=='undefined' && state.user && state.product && !state.busy")
        assert child.evaluate('state.user.vkMessagesAllowed && state.user.remindersEnabled')
        telemetry['reloaded'] = child.evaluate(SNAPSHOT)
        return telemetry
    finally:
        telemetry['finalDb'] = database_user(db, uid)
        ctx.close()
        telemetry['contextClosed'] = True
        if output:
            (output / (name + '.json')).write_text(json.dumps(telemetry, ensure_ascii=False, indent=2))


def exercise_throttle(page, child, ctx, base, control, telemetry):
    def returned():
        page.locator('#outside').focus()
        # Focus is real, while marker mutations below model elapsed time/day.
        child.locator('[data-tab="today"]').focus()
        child.wait_for_function('!state.busy && !state.refreshPending')
        page.wait_for_timeout(150)

    def reads():
        return telemetry['reads'].count('/api/me')

    count = reads()
    returned()
    assert reads() == count, 'Within 60s must preserve throttle'
    telemetry['fresh'] = child.evaluate(SNAPSHOT)
    child.evaluate('state.lastRefresh=Date.now()-61000')
    returned()
    assert reads() == count + 1
    telemetry['stale'] = child.evaluate(SNAPSHOT)
    assert telemetry['stale']['day'] == telemetry['stale']['localDay']
    child.evaluate("refreshedDay='1900-01-01';state.lastRefresh=Date.now()")
    returned()
    assert reads() == count + 2, 'Recent timestamp must not suppress new day'
    telemetry['dayMismatch'] = child.evaluate(SNAPSHOT)
    child.evaluate("refreshedDay='failed-read-sentinel';state.lastRefresh=Date.now()-61000")
    control['fail'] = True
    returned()
    assert reads() == count + 3
    assert child.evaluate('refreshedDay') == 'failed-read-sentinel'
    telemetry['failedRead'] = child.evaluate(SNAPSHOT)
    control['fail'] = False
    returned()
    assert reads() == count + 4, 'Failed read must not suppress day-mismatch retry'
    assert child.evaluate('refreshedDay===localDay()')
    # A real timezone-local date mismatch also overrides a recent timestamp.
    child.evaluate("""() => { const original=refreshedDay;
      for (const timezone of ['Pacific/Kiritimati','Etc/GMT+12']) {
        state.user.timezone=timezone;if(localDay()!==original)break;
      }
      if(localDay()===original)throw Error('No timezone day mismatch');
      state.lastRefresh=Date.now();
    }""")
    count_before_timezone = reads()
    returned()
    assert reads() == count_before_timezone + 1
    assert child.evaluate('refreshedDay===localDay()')
    telemetry['recentTimezoneMismatch'] = child.evaluate(SNAPSHOT)
    # Use real settings mutation + existing loadData, not hand-written response data.
    other = 'en' if child.evaluate('state.user.locale') == 'ru' else 'ru'
    child.locator('[data-tab="settings"]').click()
    child.evaluate("refreshedDay='locale-load-sentinel'")
    child.locator(f'[data-lang="{other}"]:visible').click()
    child.wait_for_function('(l)=>!state.busy && state.user.locale===l', arg=other)
    assert child.evaluate('refreshedDay===localDay()')
    telemetry['localeLoad'] = child.evaluate(SNAPSHOT)
    response = ctx.request.post(base + '/api/settings/reminders', headers={
        'Authorization': 'Bearer ' + child.evaluate('state.token')}, data={
            'timezone': 'Pacific/Kiritimati', 'remindersEnabled': False,
            'reminderHour': 20, 'reminderMinute': 0})
    assert response.ok, response.text()
    child.evaluate('state.lastRefresh=Date.now()-61000')
    returned()
    assert child.evaluate("state.user.timezone==='Pacific/Kiritimati' && refreshedDay===localDay()")
    telemetry['timezoneLoad'] = child.evaluate(SNAPSHOT)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--chromium', default=os.environ.get('KOPILKA_QA_CHROMIUM', '/usr/bin/chromium'))
    parser.add_argument('--engine', choices=('chromium', 'webkit'), default='chromium')
    parser.add_argument('--webkit-executable', help='Optional private WPE launcher (no global install)')
    parser.add_argument('--baseline', default=BASELINE, help='Frozen original commit, never implicit HEAD')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    baseline = subprocess.check_output(['git', 'show', args.baseline + ':public/app.js'], cwd=ROOT).decode()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    # TMPDIR is honored; all fixture writes are outside the repository.
    with tempfile.TemporaryDirectory(prefix='vk-first-focus-') as td:
        tmp = Path(td)
        for name in ('public', 'migrations'):
            (tmp / name).symlink_to(ROOT / name, target_is_directory=True)
        guard = tmp / 'guard.cjs'
        guard.write_text("const fs=require('fs');const deny=()=>{fs.appendFileSync(" +
                         json.dumps(str(tmp / 'outbound.log')) + ", 'blocked\\n');throw Error('outbound blocked')};"
                         "global.fetch=deny;for(const n of ['http','https']){const m=require(n);m.get=m.request=deny;}"
                         "require(" + json.dumps(str(ROOT / 'src/server')) +
                         ").createApp().listen(" + str(port) + ",'127.0.0.1');")
        env = dict(PATH=os.environ['PATH'], HOME=td, NODE_ENV='test', PORT=str(port),
                   DB_PATH=str(tmp / 'qa.sqlite'), SCHEDULER_ENABLED='false', DEV_AUTH_ENABLED='false',
                   VK_APP_ID='54723764', VK_SECURE_KEY='fixture-key', SESSION_SECRET='fixture-session-secret',
                   APP_BASE_URL=base, WEBAPP_URL=base, VK_GROUP_ID='240966481', VK_GROUP_TOKEN='fixture-token',
                   RATE_LIMIT_API_MAX='10000', RATE_LIMIT_AUTH_MAX='10000')
        results = []
        expected_users = {}
        with (args.output / 'server.log').open('w') as log:
            server = subprocess.Popen(['node', str(guard)], cwd=tmp, env=env, stdout=log, stderr=log)
            try:
                for _ in range(100):
                    try:
                        urllib.request.urlopen(base + '/health', timeout=.5).close()
                        break
                    except Exception:
                        if server.poll() is not None:
                            raise RuntimeError('Fixture startup failed; see server.log')
                        time.sleep(.1)
                else:
                    raise RuntimeError('Fixture startup timeout')
                with sync_playwright() as pw:
                    if args.engine == 'chromium':
                        browser = pw.chromium.launch(executable_path=args.chromium, headless=True,
                                                     args=['--no-sandbox', '--disable-background-networking'])
                    else:
                        options = {'headless': True}
                        if args.webkit_executable:
                            options['executable_path'] = args.webkit_executable
                        browser = pw.webkit.launch(**options)
                    try:
                        cases = [('original-red', 'ru', 'today', 'touch', True, False)]
                        cases += [(f'{lang}-{tab}-{entry}', lang, tab, entry, False, False)
                                  for lang in ('ru', 'en') for tab in ('today', 'settings')
                                  for entry in ('touch', 'keyboard')]
                        cases += [('refresh-contract', 'ru', 'today', 'touch', False, True)]
                        for i, (name, lang, tab, entry, red, throttle) in enumerate(cases):
                            result = run_case(browser, base, tmp / 'qa.sqlite', name, 98971000+i,
                                              lang, tab, entry, baseline if red else None, red, throttle,
                                              output=args.output)
                            assert result['startup']['user'] == result['finalDb']['id']
                            expected_users[98971000+i] = result['finalDb']
                            for account, expected in expected_users.items():
                                assert database_user(tmp / 'qa.sqlite', account) == expected, 'Cross-account fixture mutation'
                            results.append(name)
                            print('PASS', name, flush=True)
                    finally:
                        browser.close()
                # Provider attempts are blocked by the preload before transport;
                # the cleanup receipt retains their count/log, not provider replies.
                with sqlite3.connect(f'file:{tmp / "qa.sqlite"}?mode=ro', uri=True) as conn:
                    assert conn.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
                    assert conn.execute('PRAGMA foreign_key_check').fetchall() == []
                    assert conn.execute('SELECT COUNT(*) FROM users').fetchone()[0] == len(results)
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)
                cleanup = {'serverExited': server.poll() is not None, 'pid': server.pid,
                           'fixture': td, 'cases': results, 'accountFencing': len(expected_users),
                           'outboundBlockedBeforeTransport': True, 'outboundAttempts':
                           (tmp / 'outbound.log').read_text() if (tmp / 'outbound.log').exists() else ''}
    cleanup['fixtureRemoved'] = not Path(td).exists()
    (args.output / 'cleanup.json').write_text(json.dumps(cleanup, indent=2))
    assert cleanup['serverExited'] and cleanup['fixtureRemoved']
    print(f'PASS {len(results)} cases: original RED witness + candidate GREEN; cleanup verified')


if __name__ == '__main__':
    main()
