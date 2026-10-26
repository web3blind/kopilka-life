#!/usr/bin/env python3
"""Connected regression for the practice-goal success notice."""
import json
import os
from playwright.sync_api import sync_playwright

BASE = os.environ['KOPILKA_QA_BASE_URL']


def run():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        context = browser.new_context(viewport={'width': 390, 'height': 844})
        context.route('https://**/*', lambda route: route.fulfill(status=200, body='', content_type='application/javascript'))
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            auth = context.request.post(BASE + '/api/auth/dev', data={
                'firstName': 'Practice status QA', 'locale': 'ru', 'timezone': 'UTC'
            }).json()
            page.add_init_script('localStorage.setItem("kopilkaToken", ' + json.dumps(auth['token']) + ');')
            page.goto(BASE)
            page.wait_for_function('state.summary && state.history && !state.busy')
            page.locator('#tab-button-week').click()
            goal = page.locator('#practiceGoal')
            options = goal.locator('option').evaluate_all('(items) => items.map(option => option.value)')
            current_goal = goal.input_value()
            next_goal = next(value for value in options if value and value != current_goal)

            goal.select_option(next_goal)
            notice = 'Практики обновлены под выбранную цель.'
            page.get_by_text(notice, exact=True).wait_for()
            assert page.locator('#dismissStatus').is_visible()
            page.locator('#tab-button-today').click()
            page.wait_for_timeout(5500)
            assert notice not in page.locator('#statusRegion').inner_text()

            page.locator('#tab-button-week').click()
            page.locator('#practiceGoal').select_option(current_goal)
            page.get_by_text(notice, exact=True).wait_for()
            page.reload()
            page.wait_for_function('state.summary && state.history && !state.busy')
            assert notice not in page.locator('#statusRegion').inner_text()
            assert not errors, errors
            print('PASS practice-goal notice expires after tab change and is absent after reload')
        finally:
            context.close()
            browser.close()


if __name__ == '__main__':
    run()
