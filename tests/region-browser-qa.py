#!/usr/bin/env python3
"""Country-safe website HTML and email status in the local QA server."""
import os
from playwright.sync_api import sync_playwright

base = os.environ['KOPILKA_QA_BASE_URL']
with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp(os.environ.get('KOPILKA_QA_CDP_URL', 'http://127.0.0.1:18800'))
    ctx = browser.new_context(viewport={'width': 390, 'height': 780})
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    try:
        page.goto(base + '/', wait_until='domcontentloaded')
        page.locator('#emailLoginForm').wait_for(state='visible', timeout=15000)
        assert page.locator('#vkLoginButton').is_visible()
        assert page.locator('#googleLoginButton').count() == 0
        assert page.locator('#telegramLoginButton').count() == 0
        assert page.locator('[data-i18n="loginIntroRegional"]').count() == 1
        assert page.locator('#accountLinksHeading').count() == 1
        assert not page.locator('#accountLinksHeading').is_visible(), 'anonymous profile controls hidden'
        assert page.locator('#tab-settings #accountLinksHeading').count() == 0
        assert page.locator('#tab-profile #accountLinksHeading').count() == 1
        assert page.locator('#tab-profile #linkEmailForm').count() == 1
        assert page.locator('#tab-profile #linkVkAccount').count() == 1
        assert page.locator('#tab-profile #linkGoogleAccount').count() == 0
        assert page.locator('#loginScreen a[href="https://db-ip.com"]').count() == 1
        page.locator('#emailLoginAddress').fill('test@example.org')
        page.locator('#emailLoginSend').click()
        page.wait_for_function("document.querySelector('#emailLoginStatus')?.textContent.includes('Письма пока недоступны')", timeout=10000)
        assert not errors, errors
        demo = page.request.post(base + '/api/auth/dev', data={'firstName': 'QA profile'})
        assert demo.status == 200
        token = demo.json()['token']
        page.evaluate("token => localStorage.setItem('kopilkaToken', token)", token)
        page.reload(wait_until='domcontentloaded')
        page.locator('#tab-button-profile').wait_for(state='visible', timeout=15000)
        page.locator('#tab-button-profile').click()
        page.locator('#accountLinksHeading').wait_for(state='visible', timeout=15000)
        assert page.locator('#tab-profile #linkEmailForm').is_visible()
        assert page.locator('#tab-profile #linkVkAccount').is_visible()
        assert page.locator('#tab-settings #linkEmailForm').count() == 0
        assert page.locator('#tab-profile a[href="https://db-ip.com"]').count() == 0  # attribution is in app shell footer
        assert not errors, errors
        print('PASS regional browser: anonymous hidden, authenticated profile visible; settings no duplicate; no JS errors')
    finally:
        ctx.close()
