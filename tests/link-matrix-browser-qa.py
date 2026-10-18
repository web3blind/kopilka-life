#!/usr/bin/env python3
"""Disposable-DB linking matrix through real UI, auth routes, and CDP Chromium.

Only provider delivery/Google verification are local fixtures; no merge/auth route is stubbed.
"""
import base64
import hashlib
import hmac
import json
import os
import sqlite3
import time
import urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = os.environ['KOPILKA_QA_BASE_URL']
DB = Path(os.environ['DB_PATH'])
CODES = Path(os.environ['KOPILKA_LINK_QA_CODES'])
BOT = os.environ['BOT_TOKEN']
VK_KEY = os.environ['VK_SECURE_KEY']
CDP = os.environ.get('KOPILKA_QA_CDP_URL', 'http://127.0.0.1:18800')
serial = 940000

def unique():
    global serial
    serial += 1
    return serial

def rows(sql, *args):
    with sqlite3.connect(DB) as db:
        return db.execute(sql, args).fetchall()

def tg_data(id, start=''):
    values = {'auth_date': str(int(time.time())), 'user': json.dumps({'id': id, 'first_name': 'Link fixture'}, separators=(',', ':'))}
    if start: values['start_param'] = start
    check = '\n'.join(f'{key}={values[key]}' for key in sorted(values))
    secret = hmac.new(b'WebAppData', BOT.encode(), hashlib.sha256).digest()
    values['hash'] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return urllib.parse.urlencode(values)

def vk_data(id):
    values = {'vk_app_id': '54723764', 'vk_language': 'ru', 'vk_ts': str(int(time.time())), 'vk_user_id': str(id)}
    check = '&'.join(f'{key}={values[key]}' for key in sorted(values))
    values['sign'] = base64.urlsafe_b64encode(hmac.new(VK_KEY.encode(), check.encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return urllib.parse.urlencode(values)

def post(ctx, path, body, token=None):
    response = ctx.request.post(BASE + path, data=body, headers={'Authorization': 'Bearer ' + token} if token else {})
    assert response.status in (200, 201, 400, 401, 403, 409), (path, response.status, response.text()[:300])
    return response

def email_auth(ctx, address):
    requested = post(ctx, '/api/auth/email/request', {'email': address})
    assert requested.ok, (address, requested.status)
    delivered = json.loads(CODES.read_text())
    assert delivered['email'] == address
    result = post(ctx, '/api/auth/email/verify', {'email': address, 'code': delivered['code']})
    assert result.ok, (address, result.status, result.text()[:300])
    return result.json()

def google_route(route):
    url = urllib.parse.urlparse(route.request.url)
    qs = urllib.parse.parse_qs(url.query)
    sub = route.request.frame.page.context.qa_google_subject
    nonce = qs['nonce'][0]
    data = {'sub': sub, 'nonce': nonce, 'email': f'{sub}@example.invalid', 'email_verified': True, 'given_name': 'Google fixture'}
    code = base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip('=')
    target = qs['redirect_uri'][0] + '?' + urllib.parse.urlencode({'state': qs['state'][0], 'code': code})
    route.fulfill(status=302, headers={'Location': target}, body='')

def complete_google_popup(ctx, subject, page):
    for _ in range(100):
        for candidate in ctx.google_authorizations:
            params = urllib.parse.parse_qs(urllib.parse.urlparse(candidate).query)
            if 'nonce' not in params: continue
            data = {'sub': subject, 'nonce': params['nonce'][0], 'email': f'{subject}@example.invalid', 'email_verified': True, 'given_name': 'Google fixture'}
            code = base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip('=')
            callback = params['redirect_uri'][0] + '?' + urllib.parse.urlencode({'state': params['state'][0], 'code': code})
            popup = next((p for p in ctx.pages if p != page), None)
            if popup is None or not any(c['name'] == 'kopilka_google_browser' for c in ctx.cookies(BASE + '/api/auth/google/callback')): continue
            try: popup.goto(callback, wait_until='commit')
            except Exception:
                if not popup.is_closed(): raise
            return
        page.wait_for_timeout(100)
    raise AssertionError('Google popup did not reach provider authorization URL')

def create_google(ctx, subject):
    # Browser OAuth from login button: real intent, state, browser binding and callback.
    page = ctx.new_page()
    ctx.qa_google_subject = subject
    ctx.google_authorizations = []
    ctx.on('request', lambda r: ctx.google_authorizations.append(r.url) if r.url.startswith('https://accounts.google.com/o/oauth2/v2/auth?') else None)
    ctx.route('https://accounts.google.com/o/oauth2/v2/auth**', google_route)
    page.goto(BASE, wait_until='domcontentloaded')
    page.locator('#googleLoginButton').click()
    complete_google_popup(ctx, subject, page)
    page.wait_for_function("Boolean(localStorage.getItem('kopilkaToken'))", timeout=15000)
    if page.evaluate('state.user === null'):
        page.reload(wait_until='domcontentloaded')
    page.wait_for_function('state.user !== null', timeout=15000)
    result = {'token': page.evaluate("localStorage.getItem('kopilkaToken')"), 'user': {'id': page.evaluate('state.user.id')}}
    page.close()
    return result

def account(ctx, kind):
    n = unique()
    if kind == 'email':
        email = f'matrix-{n}@example.invalid'
        return email_auth(ctx, email) | {'subject': email}
    if kind == 'google':
        sub = f'matrix-google-{n}'
        return create_google(ctx, sub) | {'subject': sub}
    if kind == 'telegram':
        response = post(ctx, '/api/auth/telegram', {'initData': tg_data(n)})
    else:
        response = post(ctx, '/api/auth/vk', {'launchParams': vk_data(n)})
    assert response.ok, (kind, response.status, response.text()[:300])
    return response.json() | {'subject': n}

def seed_records(id, note):
    # Fixture data only; app auth/merge transitions are never bypassed.
    with sqlite3.connect(DB) as db:
        db.execute("INSERT INTO entries(user_id,type,title,note,life_points,entry_date) VALUES (?, 'joy', 'Радость', ?, 1, ?)", (id, note, '2025-01-10' if note.endswith('-a') else '2025-01-11'))
        db.execute("INSERT INTO weekly_contracts(user_id,title,target_value,week_start,week_end,status) VALUES (?,?,'one','2025-01-06','2025-01-12','completed')", (id, note))
        db.execute("INSERT INTO user_artifacts(user_id,artifact_id) VALUES (?,?)", (id, 'artifact-' + note))
        db.commit()

def snapshot(ids):
    return {t: rows(f'SELECT user_id, count(*) FROM {t} WHERE user_id IN (?,?) GROUP BY user_id ORDER BY user_id', *ids) for t in ('entries', 'weekly_contracts', 'user_artifacts', 'login_identities')}

def open_page(ctx, token):
    page = ctx.new_page()
    page.add_init_script(f"localStorage.setItem('kopilkaToken', {json.dumps(token)});")
    page.goto(BASE, wait_until='domcontentloaded')
    page.locator('#appShell').wait_for(state='visible', timeout=30000)
    page.locator('#tab-button-profile').click()
    return page

def accessibility(page, expected_focus='mergeAccountsHeading'):
    box = page.locator('#accountMergePrompt')
    assert box.is_visible() and box.locator('#mergeAccountsHeading').count() == 1
    assert box.locator('#mergeAccountsHeading').get_attribute('tabindex') == '-1'
    assert page.evaluate('(id) => document.activeElement?.id === id', expected_focus)
    for id in ('confirmAccountMerge', 'cancelAccountMerge'):
        button = page.locator('#' + id)
        assert button.is_visible() and button.evaluate("el => el.tagName === 'BUTTON' && el.type === 'button' && !!el.textContent.trim()")

def trigger(ctx, page, target, occupied):
    kind = target['kind']
    if kind == 'email':
        # The same disposable address was just used to create the target account.
        with sqlite3.connect(DB) as db:
            db.execute('UPDATE email_login_codes SET sent_at=sent_at-61 WHERE email=?', (target['subject'],))
            db.commit()
        page.locator('#linkEmailAddress').fill(target['subject'])
        page.locator('#linkEmailForm button').click()
        try: page.locator('#linkEmailCodeForm').wait_for(state='visible', timeout=8000)
        except Exception:
            print('EMAIL REQUEST DIAGNOSTIC', page.evaluate("({email:document.querySelector('#emailLinkStatus').textContent,form:document.querySelector('#linkEmailForm').hidden,linked:document.querySelector('#linkedLoginsStatus').textContent,logged:!!state.user})"), flush=True)
            raise
        delivered = json.loads(CODES.read_text())
        assert delivered['email'] == target['subject']
        page.locator('#linkEmailCode').fill(delivered['code'])
        page.locator('#linkEmailCodeForm button').click()
    elif kind == 'telegram':
        # On a website, the real two-browser intent/claim/finish flow is required.
        page.locator('#linkTelegramAccount').click()
        page.locator('#telegramLinkHandoff').wait_for(state='visible')
        intent = page.evaluate('state.telegramLinkIntent')
        assert page.locator('#telegramLinkOpen').get_attribute('href').endswith('startapp=link_' + intent)
        signed = tg_data(target['subject'], 'link_' + intent)
        claim = post(ctx, '/api/auth/telegram-link-claim', {'initData': signed})
        assert claim.ok, (claim.status, claim.text()[:300])
        page.locator('#telegramLinkFinish').click()
    elif kind == 'vk':
        # Signed VK launch proof is supplied by a local fixture, verified by the app.
        page.evaluate('signed => { history.replaceState({}, "", "/?" + signed); window.vkBridge = {send: async method => method === "VKWebAppGetLaunchParams" ? Object.fromEntries(new URLSearchParams(signed)) : {}}; }', vk_data(target['subject']))
        page.locator('#linkVkAccount').click()
    elif kind == 'google':
        ctx.qa_google_subject = target['subject']
        ctx.route('https://accounts.google.com/o/oauth2/v2/auth**', google_route)
        ctx.google_authorizations = []
        ctx.on('request', lambda r: ctx.google_authorizations.append(r.url) if r.url.startswith('https://accounts.google.com/o/oauth2/v2/auth?') else None)
        page.locator('#linkGoogleAccount').click()
        complete_google_popup(ctx, target['subject'], page)
    if occupied:
        if kind == 'vk':
            page.wait_for_function('Boolean(state.pendingMerge)', timeout=15000)
            # The signed-proof fixture represents a VK surface, where linked
            # accounts are intentionally hidden. Review consent on the website.
            assert page.locator('#accountLinksSection').is_hidden()
            page.goto(BASE, wait_until='domcontentloaded')
            page.wait_for_function('state.user !== null && !state.busy', timeout=15000)
            page.locator('#tab-button-profile').click()
        if kind == 'google':
            for _ in range(100):
                if page.evaluate("Boolean(localStorage.getItem('kopilkaVkMergeToken'))") or page.locator('#accountMergePrompt').is_visible(): break
                page.wait_for_timeout(100)
            if not page.locator('#accountMergePrompt').is_visible():
                page.reload(wait_until='domcontentloaded')
                page.wait_for_function('state.user !== null', timeout=15000)
        try: page.locator('#accountMergePrompt').wait_for(state='visible', timeout=10000)
        except Exception:
            print('OCCUPIED DIAGNOSTIC', kind, page.evaluate("({status:document.querySelector('#statusRegion').textContent,linked:document.querySelector('#linkedLoginsStatus').textContent,email:document.querySelector('#emailLinkStatus').textContent,pending:!!state.pendingMerge,stored:!!localStorage.getItem('kopilkaVkMergeToken')})"), 'PAGES', [(p.url,p.is_closed()) for p in ctx.pages], flush=True)
            raise
    else:
        if kind == 'google':
            for _ in range(100):
                if rows("SELECT user_id FROM login_identities WHERE provider='google' AND subject=?", target['subject']): break
                page.wait_for_timeout(100)
            page.reload(wait_until='domcontentloaded')
            page.wait_for_function('state.user !== null', timeout=15000)
            page.locator('#tab-button-profile').click()
        try:
            page.wait_for_function('(kind) => kind === "vk" ? state.user.vkLinked : kind === "telegram" ? state.user.telegramLinked : kind === "email" ? document.querySelector("#linkedLoginsStatus").textContent.includes("E-mail: привязан") : document.querySelector("#linkedLoginsStatus").textContent.includes("Google: привязан")', arg=kind, timeout=12000)
        except Exception:
            print('FREE DIAGNOSTIC', kind, page.evaluate("({status:document.querySelector('#statusRegion').textContent,linked:document.querySelector('#linkedLoginsStatus').textContent,google:document.querySelector('#linkGoogleAccount')?.disabled,profiles:state.user})"), 'PAGES', [(p.url, p.is_closed()) for p in ctx.pages], 'IDENTITIES', rows('SELECT provider,subject,user_id FROM login_identities WHERE user_id=?', page.evaluate('state.user.id')), flush=True)
            raise

def run():
    matrix = []
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(CDP)
        starts = tuple(s for s in ('email', 'google', 'telegram', 'vk') if not os.environ.get('KOPILKA_MATRIX_START') or s == os.environ['KOPILKA_MATRIX_START'])
        for start in starts:
            for dest in ('email', 'google', 'telegram', 'vk'):
                if start == dest: continue
                for occupied in (False, True):
                    label = f'{start}->{dest} ' + ('occupied' if occupied else 'free')
                    ctx = browser.new_context(extra_http_headers={'X-Forwarded-For': f'2001:db8::{unique()}'})
                    trace = []
                    ctx.on('page', lambda p: (trace.append(('page', p.url)), p.on('response', lambda r: trace.append((r.status, r.url)) if '/api/auth/google/' in r.url else None), p.on('pageerror', lambda e: trace.append(('error', str(e))))))
                    try:
                        current = account(ctx, start)
                        current_id = current['user']['id']
                        if occupied:
                            target = account(ctx, dest)
                            target_id = target['user']['id']
                            seed_records(current_id, label + '-a')
                            seed_records(target_id, label + '-b')
                        else:
                            target = {'kind': dest, 'subject': (f'free-{unique()}@example.invalid' if dest == 'email' else f'free-google-{unique()}' if dest == 'google' else unique())}
                        target['kind'] = dest
                        page = open_page(ctx, current['token'])
                        if occupied:
                            before = snapshot((current_id, target_id))
                            revisions_before = dict(rows('SELECT id,session_revision FROM users WHERE id IN (?,?)', current_id, target_id))
                            records_before = {table: set(rows(f'SELECT {column} FROM {table} WHERE user_id IN (?,?)', current_id, target_id)) for table,column in [('entries','note'),('weekly_contracts','title'),('user_artifacts','artifact_id')]}
                        trigger(ctx, page, target, occupied)
                        if occupied:
                            accessibility(page, 'heading-profile' if dest == 'vk' else 'mergeAccountsHeading')
                            assert snapshot((current_id, target_id)) == before, label + ' mutated before consent'
                            page.locator('#cancelAccountMerge').click()
                            assert page.locator('#accountMergePrompt').is_hidden()
                            assert snapshot((current_id, target_id)) == before, label + ' cancel mutated'
                            # Cancel discards the pending offer; repeat the real provider proof for a new offer.
                            if dest == 'email':
                                with sqlite3.connect(DB) as db:
                                    db.execute('UPDATE email_login_codes SET sent_at=sent_at-61 WHERE email=?', (target['subject'],))
                                    db.commit()
                            trigger(ctx, page, target, True)
                            accessibility(page, 'heading-profile' if dest == 'vk' else 'mergeAccountsHeading')
                            page.locator('#confirmAccountMerge').click()
                            page.wait_for_function('!state.pendingMerge && state.user && localStorage.getItem("kopilkaToken")', timeout=30000)
                            survivor = page.evaluate('state.user.id')
                            assert survivor in (current_id, target_id)
                            for table in ('entries', 'weekly_contracts', 'user_artifacts'):
                                assert rows(f'SELECT count(*) FROM {table} WHERE user_id=?', survivor)[0][0] == 2, (label, table)
                            for table,column in [('entries','note'),('weekly_contracts','title'),('user_artifacts','artifact_id')]:
                                assert set(rows(f'SELECT {column} FROM {table} WHERE user_id=?', survivor)) == records_before[table], (label,table)
                            assert rows('SELECT session_revision FROM users WHERE id=?', survivor)[0][0] > revisions_before[survivor], label + ' revision unchanged'
                            assert rows('SELECT count(*) FROM users WHERE id IN (?,?)', current_id, target_id)[0][0] == 1
                            assert ctx.request.get(BASE + '/api/me', headers={'Authorization': 'Bearer ' + target['token']}).status == 401, label + ' target old session'
                            assert ctx.request.get(BASE + '/api/me', headers={'Authorization': 'Bearer ' + current['token']}).status == 401, label + ' stale session'
                            fresh = page.evaluate('localStorage.getItem("kopilkaToken")')
                            assert fresh != current['token']
                            assert ctx.request.get(BASE + '/api/me', headers={'Authorization': 'Bearer ' + fresh}).json()['user']['id'] == survivor
                            relogin = account_relogin(ctx, target)
                            assert relogin['user']['id'] == survivor, label + ' provider relogin'
                            assert account_relogin(ctx, current | {'kind':start})['user']['id'] == survivor, label + ' original provider relogin'
                        else:
                            assert page.evaluate('state.user.id') == current_id, label + ' changed account'
                            assert account_relogin(ctx, target)['user']['id'] == current_id, label + ' linked relogin'
                        page.close()
                        matrix.append(label)
                        print('PASS', label, flush=True)
                    finally:
                        if len(matrix) == 0: print('TRACE', label, trace, flush=True)
                        ctx.close()
        browser.close()
    assert len(matrix) == 6 * len(starts), len(matrix)
    print('link matrix browser qa passed: ' + str(len(matrix)) + ' directions/states')

def account_relogin(ctx, target):
    kind = target['kind']; subject = target['subject']
    fresh = ctx.browser.new_context()
    try:
        if kind == 'email':
            with sqlite3.connect(DB) as db:
                db.execute('UPDATE email_login_codes SET sent_at=sent_at-61 WHERE email=?', (subject,))
                db.commit()
            result = email_auth(fresh, subject)
        elif kind == 'google': result = create_google(fresh, subject)
        else:
            response = post(fresh, '/api/auth/telegram' if kind == 'telegram' else '/api/auth/vk', {'initData': tg_data(subject)} if kind == 'telegram' else {'launchParams': vk_data(subject)})
            assert response.ok, (kind, response.status)
            result = response.json()
        assert fresh.request.get(BASE + '/api/me', headers={'Authorization': 'Bearer ' + result['token']}).status == 200
        return result
    finally: fresh.close()

if __name__ == '__main__': run()
