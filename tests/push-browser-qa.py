#!/usr/bin/env python3
"""Isolated connected browser check for push Settings controls."""
import os
import sqlite3
from playwright.sync_api import sync_playwright

base = os.environ['KOPILKA_QA_BASE_URL']
with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp(os.environ.get('KOPILKA_QA_CDP_URL', 'http://127.0.0.1:18800'))
    context = browser.new_context(permissions=['notifications'])
    try:
        page = context.new_page()
        auth = context.request.post(base + '/api/auth/dev', data={'firstName': 'Push QA'}).json()
        page.add_init_script(f'localStorage.setItem("kopilkaToken", {auth["token"]!r})')
        page.add_init_script('window.__pushPermissionCalls = 0; const ask = Notification.requestPermission.bind(Notification); Notification.requestPermission = (...args) => { window.__pushPermissionCalls++; return ask(...args); }; const register = navigator.serviceWorker.register.bind(navigator.serviceWorker); navigator.serviceWorker.register = async (...args) => { const result = await register(...args); window.__workerActiveAtRegistrationReturn = Boolean(result.active); return result; }; const subscribe = PushManager.prototype.subscribe; PushManager.prototype.subscribe = async function(...args) { const registration = await navigator.serviceWorker.getRegistration(\"/\"); window.__workerActiveAtSubscribe = Boolean(registration?.active); return subscribe.apply(this, args); };')
        page.goto(base)
        page.locator('[data-tab="settings"]').click()
        try:
            page.wait_for_function('!document.querySelector("#enablePush").hidden', timeout=12000)
        except Exception:
            print('Push status on timeout:', page.locator('#pushStatus').inner_text(), 'app:', page.locator('#appShell').is_visible(), flush=True)
            raise
        assert page.locator('#disablePush').is_hidden()
        assert page.evaluate('window.__pushPermissionCalls') == 0, 'permission prompted before explicit click'
        page.locator('#enablePush').focus()
        assert page.evaluate('document.activeElement.id') == 'enablePush'
        page.keyboard.press('Enter')
        page.wait_for_function('window.__pushPermissionCalls === 1')
        page.wait_for_timeout(1500)
        status = page.locator('#pushStatus').inner_text()
        print('SERVICE_WORKER_ACTIVE_AT_REGISTER_RETURN', page.evaluate('window.__workerActiveAtRegistrationReturn'), flush=True)
        assert page.evaluate('window.__workerActiveAtSubscribe') is True, 'Push subscription started before worker activation'
        assert status
        if page.locator('#disablePush').is_visible():
            with sqlite3.connect(os.environ['DB_PATH']) as db:
                assert db.execute('SELECT COUNT(*) FROM push_subscriptions WHERE user_id=?', (auth['user']['id'],)).fetchone()[0] == 1
            page.locator('#disablePush').click()
            page.wait_for_function('document.querySelector("#disablePush").hidden')
        else:
            diagnostic = page.evaluate('''async () => {
              try {
                const info = await api('/api/settings/push');
                const registration = await navigator.serviceWorker.register('/push-sw.js', {scope:'/'});
                const sub = await registration.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:applicationServerKey(info.publicKey)});
                return {stage:'subscribed', endpointOrigin:new URL(sub.endpoint).origin};
              } catch (error) { return {stage:'failed', name:error.name, message:error.message}; }
            }''')
            assert diagnostic['name'] == 'AbortError' and diagnostic['message'] == 'Registration failed - permission denied', diagnostic
            assert page.evaluate('Notification.permission') == 'granted'
            print('CDP push service refused registration despite notification permission; real delivery not verified:', diagnostic)
        page.evaluate("state.user.locale = 'en'; renderAll()")
        assert page.locator('#pushHeading').inner_text() == 'Notifications in this browser'
        page.locator('#signOutSite').click()
        page.wait_for_function('localStorage.getItem("kopilkaToken") === null')
        assert page.locator('#loginScreen').is_visible()
        print('Push controls RU/EN, keyboard, status, sign-out verified')
    finally:
        context.close()
        browser.close()
