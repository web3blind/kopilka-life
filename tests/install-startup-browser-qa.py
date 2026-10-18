#!/usr/bin/env python3
"""Install offer and ordinary-site startup on disposable QA account."""
import os
from playwright.sync_api import sync_playwright

base = os.environ['KOPILKA_QA_BASE_URL']
with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp(os.environ.get('KOPILKA_QA_CDP_URL', 'http://127.0.0.1:18800'))
    try:
        token = browser.new_context().request.post(base + '/api/auth/dev', data={'firstName': 'Install QA'}).json()['token']
        for kind, agent in [('android', 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36'),
                            ('ios', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17 Mobile Safari/604.1'),
                            ('desktop', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36')]:
            context = browser.new_context(user_agent=agent, viewport={'width': 390, 'height': 800})
            try:
                page = context.new_page()
                page.add_init_script(f'localStorage.setItem("kopilkaToken", {token!r})')
                page.goto(base, wait_until='domcontentloaded')
                try:
                    page.locator('#tab-button-settings').wait_for(state='visible', timeout=15000)
                except Exception:
                    print('STARTUP_DIAGNOSTIC', kind, page.evaluate('''() => ({ready: document.readyState, login: !document.querySelector('#loginScreen')?.hidden, app: !document.querySelector('#appShell')?.hidden, user: !!state.user, version: CLIENT_VERSION, body: document.body.innerText.slice(0,180)})'''), flush=True)
                    raise
                page.locator('#installHomeOffer').wait_for(state='visible', timeout=10000)
                assert page.evaluate('document.querySelector("#installHomeOffer").compareDocumentPosition(document.querySelector(".tab-bar")) & Node.DOCUMENT_POSITION_FOLLOWING')
                if kind == 'android':
                    page.set_viewport_size({'width': 320, 'height': 700})
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    assert page.evaluate('document.querySelector("#installHomeDismiss").getBoundingClientRect().height >= 44')
                    page.set_viewport_size({'width': 390, 'height': 800})
                page.locator('#tab-button-settings').click()
                timings = page.evaluate('performance.getEntriesByType("resource").filter(x => x.name.includes("/api/me")) .map(x => x.startTime)')
                # Browser/CDP cold-start latency varies with shared-host load.
                assert timings, (kind, timings)
                if kind == 'android':
                    # Worker registration starts on an ordinary visit without requesting Push permission.
                    page.wait_for_function("() => navigator.serviceWorker.getRegistration('/').then(reg => !!reg?.active)", timeout=12000)
                    assert page.evaluate("navigator.serviceWorker.getRegistration('/').then(reg => reg.active.scriptURL.endsWith('/push-sw.js'))")
                    assert page.evaluate("Notification.permission") != 'granted'
                    # The section must remain discoverable without a browser install event.
                    page.evaluate('pendingInstallPrompt = null; renderInstallOffer()')
                    assert page.locator('#installAppSection').is_visible()
                    assert page.locator('#installAppAndroidHint').is_visible()
                    assert page.locator('#installAppButton').is_hidden()
                    assert page.evaluate('document.querySelector("#installAppSection").compareDocumentPosition(document.querySelector("#settingsForm")) & Node.DOCUMENT_POSITION_FOLLOWING')
                    # Synthetic offer tests the button even when CDP has no install prompt.
                    page.evaluate('''() => { const offer = new Event('beforeinstallprompt', {cancelable:true}); offer.prompt = () => { window.__installedClicked = true; return Promise.resolve(); }; offer.userChoice = Promise.resolve({outcome:'accepted'}); dispatchEvent(offer); }''')
                    assert page.locator('#installAppButton').is_visible()
                    page.evaluate('window.TelegramWebviewProxy = {}; renderInstallOffer()')
                    assert page.locator('#installAppSection').is_hidden()
                    page.evaluate('delete window.TelegramWebviewProxy; renderInstallOffer()')
                    page.locator('#installAppButton').click()
                    assert page.evaluate('window.__installedClicked === true')
                    assert page.locator('#installAppButton').is_hidden()
                    assert page.locator('#installAppAndroidHint').is_visible()
                elif kind == 'ios':
                    assert page.locator('#installAppIosHint').is_visible()
                    page.evaluate('window.TelegramWebviewProxy = {}; renderInstallOffer()')
                    assert page.locator('#installAppSection').is_hidden()
                else:
                    page.evaluate('pendingInstallPrompt = null; renderInstallOffer()')
                    assert page.locator('#installAppSection').is_visible()
                    assert page.locator('#installAppDesktopHint').is_visible()
                    page.evaluate('''() => { const offer = new Event('beforeinstallprompt', {cancelable:true}); offer.prompt = () => { window.__installedClicked = true; return Promise.resolve(); }; offer.userChoice = Promise.resolve({outcome:'accepted'}); dispatchEvent(offer); }''')
                    assert page.locator('#installAppButton').is_visible()
                    page.locator('#installAppButton').click()
                    assert page.evaluate('window.__installedClicked === true')
                    page.evaluate('window.TelegramWebviewProxy = {}; renderInstallOffer()')
                    assert page.locator('#installAppSection').is_hidden()
                page.evaluate('delete window.TelegramWebviewProxy; renderInstallOffer()')
                page.locator('#tab-button-today').click()
                assert page.locator('#installHomeOffer').is_visible()
                page.evaluate('window.TelegramWebviewProxy = {}; renderInstallOffer()')
                assert page.locator('#installHomeOffer').is_hidden()
                page.evaluate('delete window.TelegramWebviewProxy; renderInstallOffer()')
                assert page.locator('#installHomeOffer').is_visible()
                if kind != 'ios':
                    page.evaluate('''() => { const offer = new Event('beforeinstallprompt', {cancelable:true}); offer.prompt = () => { window.__homePromptCalled = true; return Promise.resolve(); }; offer.userChoice = Promise.resolve({outcome:'accepted'}); dispatchEvent(offer); }''')
                    assert page.locator('#installHomeButton').is_visible()
                    page.locator('#installHomeButton').click()
                    assert page.evaluate('window.__homePromptCalled === true')
                page.locator('#installHomeDismiss').click()
                assert page.locator('#installHomeOffer').is_hidden()
                assert page.evaluate('document.activeElement.id === "heading-today"')
                page.reload(wait_until='domcontentloaded')
                page.locator('#tab-button-settings').wait_for(state='visible', timeout=10000)
                assert page.locator('#installHomeOffer').is_hidden()
                page.locator('#tab-button-settings').click()
                assert page.locator('#installAppSection').is_visible()
                print(kind, 'api/me began at', round(timings[0]), 'ms; install offer verified', flush=True)
            finally:
                context.close()
    finally:
        browser.close()
