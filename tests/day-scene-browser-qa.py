#!/usr/bin/env python3
"""Day-scene checks on the runner's isolated server and database."""
import json
import base64
import os
import struct
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = os.environ['KOPILKA_QA_BASE_URL']
with sync_playwright() as pw:
    browser = pw.chromium.connect_over_cdp(os.environ.get('KOPILKA_QA_CDP_URL', 'http://127.0.0.1:18800'))
    context = browser.new_context(viewport={'width': 390, 'height': 844}, accept_downloads=True)
    context.route('https://**/*', lambda r: r.fulfill(status=200, body='', content_type='application/javascript'))
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        auth = context.request.post(BASE + '/api/auth/dev', data={'firstName': 'Scene QA', 'locale': 'ru', 'timezone': 'UTC'}).json()
        page.add_init_script('localStorage.setItem("kopilkaToken", ' + json.dumps(auth['token']) + ');')
        page.add_init_script('''(() => {
          const originalFetch = window.fetch.bind(window);
          let delayed = false;
          window.fetch = (...args) => {
            if (!delayed && String(args[0]).includes('/api/summary/today')) {
              delayed = true;
              return new Promise(resolve => { window.__releaseInitialSummary = () => resolve(originalFetch(...args)); });
            }
            return originalFetch(...args);
          };
        })();''')
        page.goto(BASE)
        page.wait_for_function('typeof window.__releaseInitialSummary === "function"')
        assert page.locator('#quickActions button').count() == 0, 'quick actions must not appear before the first authenticated load finishes'
        page.evaluate('window.__releaseInitialSummary()')
        page.wait_for_function('state.summary && !state.busy')
        assert page.locator('#daySceneLayer img').count() == 0
        assert page.evaluate('performance.getEntriesByType("resource").filter(e => e.name.includes("/assets/day-scene/")).length') == 1
        assert page.locator('.day-scene-picture>img').evaluate('e => e.complete && e.naturalWidth === 960')
        assert page.locator('.day-scene-picture>img').evaluate('e => e.naturalHeight === 1280')
        assert page.locator('.day-scene-picture').get_attribute('aria-hidden') == 'true'
        assert page.locator('#quickActions .qa-item').count() == 15
        assert page.locator('#quickActions button .qa-hint, #quickActions button .qa-points').count() == 0
        shots = os.environ.get('KOPILKA_SCENE_SHOTS_DIR')
        for width, font, columns in [(320, 16, 1), (390, 16, 2), (760, 16, 2), (320, 32, 1), (390, 32, 1)]:
            page.set_viewport_size({'width': width, 'height': 844})
            page.evaluate('(size) => document.documentElement.style.fontSize = `${size}px`', font)
            layout = page.evaluate('''() => { const grid = document.querySelector('#quickActions');
              return {columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
                titlesFit: [...grid.querySelectorAll('button .qa-title')].every(e => e.scrollWidth <= e.clientWidth + 1 &&
                  e.getBoundingClientRect().height <= parseFloat(getComputedStyle(e).lineHeight) * 1.15),
                buttonsFit: [...grid.querySelectorAll('button')].every(e => e.scrollWidth <= e.clientWidth + 1),
                offenders: [...grid.querySelectorAll('button')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => [e.dataset.entryType, e.scrollWidth, e.clientWidth]),
                pageFit: document.documentElement.scrollWidth <= innerWidth}; }''')
            assert layout == {'columns': columns, 'titlesFit': True, 'buttonsFit': True, 'offenders': [], 'pageFit': True}, (width, font, layout)
            page.locator('#quickActions button').last.evaluate('e => e.scrollIntoView({block: "center", behavior: "instant"})')
            assert page.locator('#quickActions button').last.evaluate('''e => { const r=e.getBoundingClientRect(); const p=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2); return p===e || e.contains(p); }'''), (width,font,'last action obscured')
            if shots:
                Path(shots).mkdir(parents=True, exist_ok=True)
                page.locator('#quickActions').evaluate('e => e.scrollIntoView({block: "start", behavior: "instant"})')
                page.screenshot(path=str(Path(shots, f'quick-{width}-{font}.png')))
        page.evaluate('''() => { state.user.locale = 'en'; renderQuickActions(); }''')
        for width, font in [(390,16),(320,32)]:
            page.set_viewport_size({'width':width,'height':844})
            page.evaluate('(size) => document.documentElement.style.fontSize = `${size}px`', font)
            assert page.evaluate('''() => [...document.querySelectorAll('#quickActions button')].every(e =>
              e.scrollWidth <= e.clientWidth + 1 && e.querySelector('.qa-title').scrollWidth <= e.querySelector('.qa-title').clientWidth + 1)'''), (width,font,'EN button overflow')
        assert (page.locator('[data-entry-type="social_contact"]').get_attribute('aria-label') or '').startswith('Meet-up or call,')
        page.evaluate('''() => { state.user.locale = 'ru'; renderQuickActions(); document.documentElement.style.fontSize = '16px'; }''')
        page.set_viewport_size({'width': 390, 'height': 844})
        hint = page.locator('.day-scene-card [data-i18n="daySceneHint"]')
        assert hint.inner_text() == 'После отметки найди новую деталь'
        assert hint.evaluate('e => e.parentElement.previousElementSibling.id === "" && e.parentElement.previousElementSibling.classList.contains("day-scene-picture")')
        page.evaluate('''() => { state.user.locale = 'en'; applyStaticI18n(); }''')
        assert hint.inner_text() == 'After adding an entry, find the new detail'
        page.evaluate('''() => { state.user.locale = 'ru'; applyStaticI18n(); }''')
        if shots:
            Path(shots).mkdir(parents=True, exist_ok=True)
            page.locator('.day-scene-card').screenshot(path=str(Path(shots, 'empty.png')))
        page.locator('#entryNote').fill('PRIVATE SCENE NOTE')
        page.locator('[data-entry-type="joy"]').focus()
        page.evaluate('''() => {
          const originalFetch = window.fetch.bind(window);
          let delayed = false;
          window.fetch = (...args) => {
            if (!delayed && String(args[0]).includes('/api/summary/today')) {
              delayed = true;
              return new Promise(resolve => { window.__releaseReturnSummary = () => resolve(originalFetch(...args)); });
            }
            return originalFetch(...args);
          };
          void refreshOnReturn(true);
        }''')
        page.wait_for_function('state.refreshPending && state.busy && typeof window.__releaseReturnSummary === "function"')
        quick_posts = []
        page.on('request', lambda request: quick_posts.append(request.url) if request.method == 'POST' and request.url.endswith('/api/entries') else None)
        page.evaluate('window.__pressedQuickAction = document.querySelector("[data-entry-type=joy]")')
        page.locator('[data-entry-type="joy"]').click()
        page.locator('[data-entry-type="joy"]').click()
        page.evaluate('window.__releaseReturnSummary()')
        page.wait_for_function('!state.refreshPending && !state.busy')
        assert len(quick_posts) == 1, f'queued first tap must create exactly one entry, got {len(quick_posts)}'
        assert page.locator('[data-entry-type="joy"]').get_attribute('data-used-today') == 'true', 'first quick-action tap during return refresh was lost'
        page.wait_for_function('state.summary?.todayEntryTypes?.includes("joy")')
        assert page.evaluate('''() => window.__pressedQuickAction.isConnected &&
          document.activeElement === window.__pressedQuickAction &&
          window.__pressedQuickAction === document.querySelector('[data-entry-type="joy"]') &&
          window.__pressedQuickAction.getAttribute('aria-disabled') === 'true' &&
          document.querySelector('#statusRegion').textContent.includes('Копилка пополнилась.')'''), 'quick-action focus or success announcement lost after saving'
        assert page.locator('#daySceneLayer img').count() == 1
        assert page.locator('#daySceneLayer img').evaluate('e => e.complete && e.naturalWidth > 0')
        assert page.locator('[data-entry-type="joy"] .qa-icon img').count() == 1
        assert (page.locator('[data-entry-type="joy"]').get_attribute('aria-label') or '').startswith('Радость,')
        if shots:
            page.locator('[data-entry-type="joy"]').screenshot(path=str(Path(shots, 'selected-button.png')))
        pos = page.locator('[data-scene-type="joy"]').get_attribute('style')
        assert 'Радость' in page.locator('#daySceneDescription').inner_text()
        assert 'PRIVATE SCENE NOTE' not in page.locator('#daySceneDescription').inner_text()
        page.locator('[data-entry-type="hard_day"]').click()
        page.wait_for_function('state.summary?.todayEntryTypes?.includes("hard_day") && !state.busy')
        assert page.locator('[data-scene-type="joy"]').get_attribute('style') == pos
        assert page.locator('#daySceneLayer img').count() == 2
        if shots:
            page.locator('.day-scene-card').screenshot(path=str(Path(shots, 'two.png')))
        # A real high-density day and a nearby ten-entry variant must still render.
        nine = ['movement', 'sleep', 'food_water', 'important_task', 'rest',
                'family_time', 'hard_day', 'gratitude', 'joy']
        for label, types in [('nine', nine), ('ten', nine + ['savoring'])]:
            page.evaluate('(types) => KopilkaDayScene.render(types, "ru")', types)
            page.wait_for_function('''count => document.querySelectorAll('.day-scene-motif:not([hidden]) img').length === count &&
              Array.from(document.querySelectorAll('.day-scene-motif:not([hidden]) img')).every(e => e.complete && e.naturalWidth > 0)''', arg=len(types))
            assert page.locator('[data-scene-type="joy"]').get_attribute('style') == pos
            for width in (320, 390, 760):
                page.set_viewport_size({'width': width, 'height': 844})
                layout = page.evaluate('''() => {
                  const picture = document.querySelector('.day-scene-picture').getBoundingClientRect();
                  const description = document.querySelector('#daySceneDescription').getBoundingClientRect();
                  const share = document.querySelector('#daySceneShare').getBoundingClientRect();
                  const motifs = [...document.querySelectorAll('.day-scene-motif:not([hidden])')].map(e => e.getBoundingClientRect());
                  return { width: picture.width, viewport: innerWidth, pictureBottom: picture.bottom,
                    descriptionTop: description.top, descriptionBottom: description.bottom, shareTop: share.top,
                    contained: motifs.every(m => m.left >= picture.left - 1 && m.right <= picture.right + 1 &&
                      m.top >= picture.top - 1 && m.bottom <= picture.bottom + 1) };
                }''')
                assert layout['width'] <= layout['viewport'] and layout['contained'], (label, width, layout)
                assert layout['pictureBottom'] <= layout['descriptionTop'] and layout['descriptionBottom'] <= layout['shareTop'], (label, width, layout)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                page.locator('#daySceneShare').evaluate('e => e.scrollIntoView({block: "center", behavior: "instant"})')
                hit = page.evaluate('''() => { const e = document.querySelector('#daySceneShare'); const r = e.getBoundingClientRect();
                  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                  const nav = document.querySelector('.tab-bar').getBoundingClientRect();
                  return {ok: top === e || e.contains(top), hit: top?.outerHTML?.slice(0,120), button: [r.top,r.bottom], nav: [nav.top,nav.bottom], scrollY}; }''')
                assert hit['ok'], (label, width, 'share button obscured', hit)
                if shots:
                    page.screenshot(path=str(Path(shots, f'{label}-{width}-viewport.png')))
                    page.locator('.day-scene-card').screenshot(path=str(Path(shots, f'{label}-{width}.png')))
            page.set_viewport_size({'width': 390, 'height': 844})
            story_size = page.evaluate('''async () => (await KopilkaDayScene.share('ru', '26 сентября 2026 г.', 'telegram')).size''')
            assert 0 < story_size < 4_000_000, (label, story_size)
        page.evaluate('KopilkaDayScene.render(Object.keys(KopilkaDayScene.positions), "ru")')
        page.wait_for_function('Array.from(document.querySelectorAll(".day-scene-motif img")).every(e => e.complete && e.naturalWidth > 0)')
        assert page.locator('.day-scene-motif:visible').count() == 16
        full_story_size = page.evaluate('''async () => (await KopilkaDayScene.share('ru', '26 сентября 2026 г.', 'telegram')).size''')
        assert 0 < full_story_size < 4_000_000, full_story_size
        assert page.locator('#daySceneLayer img').evaluate_all('els => els.every(e => e.currentSrc.includes("scene-") && e.complete && e.naturalWidth > 0)')
        assert 'Благодарность' in page.locator('#daySceneDescription').inner_text()
        page.evaluate('KopilkaDayScene.render(["joy", "gratitude"], "en")')
        assert 'Joy' in page.locator('#daySceneDescription').inner_text()
        assert 'Gratitude' in page.locator('#daySceneDescription').inner_text()
        page.evaluate('KopilkaDayScene.render(Object.keys(KopilkaDayScene.positions), "ru")')
        for width in (320, 390, 760):
            page.set_viewport_size({'width': width, 'height': 844})
            if shots:
                page.locator('.day-scene-card').screenshot(path=str(Path(shots, f'all-{width}.png')))
        page.set_viewport_size({'width': 390, 'height': 844})
        page.evaluate('KopilkaDayScene.render(state.summary.todayEntryTypes, "ru")')
        page.evaluate('''() => {
          window.__sceneTexts = [];
          window.__sceneImages = [];
          const originalDraw = CanvasRenderingContext2D.prototype.drawImage;
          CanvasRenderingContext2D.prototype.drawImage = function(image, ...rest) {
            window.__sceneImages.push(image.currentSrc || image.src); return originalDraw.call(this, image, ...rest);
          };
          const original = CanvasRenderingContext2D.prototype.fillText;
          CanvasRenderingContext2D.prototype.fillText = function(text, ...rest) {
            window.__sceneTexts.push(String(text)); return original.call(this, text, ...rest);
          };
          Object.defineProperty(navigator, 'canShare', {value: () => false, configurable: true});
        }''')
        with page.expect_download() as info:
            page.locator('#daySceneShare').click()
        download = info.value
        data = Path(download.path()).read_bytes()
        assert data[:8] == bytes.fromhex('89504e470d0a1a0a')
        assert struct.unpack('>II', data[16:24]) == (960, 1388)
        assert len(data) < 4_000_000, len(data)
        assert [src.split('/')[-1].split('?')[0] for src in page.evaluate('window.__sceneImages')] == ['tree.webp', 'scene-joy.webp', 'scene-hard_day.webp']
        assert not any('PRIVATE SCENE NOTE' in text for text in page.evaluate('window.__sceneTexts'))
        page.evaluate('''() => {
          history.replaceState(null, '', '?vk_app_id=54723764&sign=qa');
          window.__vkSceneCalls = [];
          window.vkBridge.send = async (method, params) => { window.__vkSceneCalls.push({method, params}); return {result:true}; };
          applyStaticI18n();
        }''')
        assert page.locator('#daySceneShare').inner_text() == 'В историю VK'
        assert page.locator('#daySceneShare').get_attribute('aria-label') == 'Поделиться картиной в истории VK'
        assert not page.locator('#daySceneShare').is_hidden()
        page.locator('#daySceneShare').click()
        page.wait_for_function('window.__vkSceneCalls.length === 1 && document.querySelector("#statusRegion").textContent.includes("Картина передана VK")')
        vk = page.evaluate('''async () => { const {method, params} = window.__vkSceneCalls[0];
          const image = new Image(); image.src = params.blob; await image.decode();
          return {method, type:params.background_type, prefix:params.blob.slice(0,22), length:params.blob.length,
            dimensions:[image.naturalWidth,image.naturalHeight], locked:params.locked, attachment:params.attachment,
            texts:window.__sceneTexts.slice(-2), status:document.querySelector('#statusRegion').textContent}; }''')
        assert vk['method'] == 'VKWebAppShowStoryBox' and vk['type'] == 'image'
        assert vk['prefix'] == 'data:image/png;base64,' and vk['length'] > 10000 and vk['dimensions'] == [1080,1920]
        assert vk['attachment'] == {'type':'url','text':'open','url':'https://vk.com/app54723764'} and vk['locked']
        assert not any('PRIVATE SCENE NOTE' in t for t in vk['texts'])
        assert 'Картина передана VK' in vk['status']
        if shots:
            encoded = page.evaluate('window.__vkSceneCalls[0].params.blob.split(",")[1]')
            Path(shots, 'vk-story.png').write_bytes(base64.b64decode(encoded))
        page.evaluate('''() => { window.vkBridge.send = async () => { throw {error_type:'client_error', error_data:{error_code:4,error_reason:'User denied'}}; }; }''')
        page.locator('#daySceneShare').click()
        page.wait_for_function('document.querySelector("#statusRegion").textContent.includes("закрыт без публикации")')
        assert not page.locator('#daySceneShare').is_disabled()
        page.evaluate('''() => { window.vkBridge.send = async () => { throw new Error('unsupported in fixture'); }; }''')
        page.locator('#daySceneShare').click()
        page.wait_for_function('document.querySelector("#statusRegion").textContent.includes("Не удалось открыть редактор истории VK")')
        assert page.locator('#daySceneShare').is_enabled()
        page.evaluate('''() => { Object.defineProperty(navigator,'platform',{configurable:true,value:'MacIntel'});
          Object.defineProperty(navigator,'maxTouchPoints',{configurable:true,value:5}); applyStaticI18n(); }''')
        assert page.locator('#daySceneShare').is_hidden()
        page.evaluate('''() => { Object.defineProperty(navigator,'platform',{configurable:true,value:'Linux'});
          const bridge = window.vkBridge; window.vkBridge = null; applyStaticI18n(); window.vkBridge = bridge; }''')
        assert page.locator('#daySceneShare').is_hidden()
        page.evaluate('''() => { history.replaceState(null, '', '/');
          window.Telegram = { WebApp: { initData: 'qa-local-only', version: '8.0', platform: 'android',
            isVersionAtLeast: version => version === '7.8',
            showPopup: (params, callback) => { window.__tgScenePopup = params;
              window.__confirmTelegramScene = id => { window.__nativeGesture = true; try { callback(id); } finally { window.__nativeGesture = false; } }; },
            shareToStory: (media, params) => { if (!window.__nativeGesture) throw Error('Native gesture lost'); window.__tgSceneStory = {media, params}; }
          } };
          applyStaticI18n();
        }''')
        assert page.locator('#daySceneShare').inner_text() == 'Подготовить историю Telegram'
        if shots:
            page.set_viewport_size({'width': 320, 'height': 568})
            page.locator('#daySceneShare').screenshot(path=str(Path(shots, 'tg-prepare-button.png')))
        page.locator('#daySceneShare').click()
        page.wait_for_function('document.querySelector("#daySceneShare").textContent === "Открыть историю Telegram" && !document.querySelector("#daySceneShare").disabled')
        if shots:
            page.locator('#daySceneShare').screenshot(path=str(Path(shots, 'tg-open-button.png')))
        page.set_viewport_size({'width': 390, 'height': 844})
        assert page.evaluate('window.__tgScenePopup === undefined && window.__tgSceneStory === undefined')
        page.locator('#daySceneShare').click()
        assert page.evaluate('window.__tgScenePopup.message.includes("не опубликуется автоматически") && window.__tgSceneStory === undefined')
        page.evaluate('window.__confirmTelegramScene("cancel")')
        assert 'не отправлена' in page.locator('#statusRegion').inner_text()
        page.locator('#daySceneShare').click()
        page.evaluate('window.__confirmTelegramScene("share")')
        tg = page.evaluate('window.__tgSceneStory')
        assert tg['media'].startswith(BASE + '/api/day-scene-story/') and tg['media'].endswith('.png')
        assert tg['params']['widget_link'] == {'url':'https://t.me/HarborLifeBot?startapp', 'name':'Открыть Копилку'}
        assert tg['params']['text'] == 'Картина дня'
        page.evaluate('window.__tgSceneStory = null')
        page.locator('#daySceneShare').click()
        page.evaluate('preparedDayStory.expiresAt = Date.now() - 1; window.__confirmTelegramScene("share")')
        assert page.evaluate('window.__tgSceneStory === null')
        assert 'Подготовь её ещё раз' in page.locator('#statusRegion').inner_text()
        assert page.locator('#daySceneShare').inner_text() == 'Подготовить историю Telegram'
        image_response = context.request.get(tg['media'])
        assert image_response.status == 200 and image_response.headers['content-type'].startswith('image/png')
        assert struct.unpack('>II', image_response.body()[16:24]) == (1080, 1920)
        assert not any('PRIVATE SCENE NOTE' in t for t in page.evaluate('window.__sceneTexts'))
        assert context.request.post(BASE + '/api/day-scene-story', data=image_response.body(), headers={'content-type':'image/png'}).status == 401
        page.locator('#daySceneShare').click()
        page.wait_for_function('document.querySelector("#daySceneShare").textContent === "Открыть историю Telegram" && !document.querySelector("#daySceneShare").disabled')
        page.evaluate('''() => { state.summary.todayEntryTypes.push('sleep'); applyStaticI18n(); }''')
        assert page.locator('#daySceneShare').inner_text() == 'Подготовить историю Telegram'
        page.evaluate('''() => { state.summary.todayEntryTypes.pop(); applyStaticI18n(); }''')
        assert page.locator('#daySceneShare').inner_text() == 'Открыть историю Telegram'
        page.evaluate('''() => { window.__originalStoryUserId = state.user.id; state.user.id += 1000; applyStaticI18n(); }''')
        assert page.locator('#daySceneShare').inner_text() == 'Подготовить историю Telegram'
        page.evaluate('''() => { state.user.id = window.__originalStoryUserId; applyStaticI18n(); }''')
        page.evaluate('''() => { window.Telegram.WebApp.isVersionAtLeast = () => false; applyStaticI18n(); }''')
        assert page.locator('#daySceneShare').inner_text() == 'Сохранить или поделиться картиной'
        with page.expect_download(): page.locator('#daySceneShare').click()
        page.evaluate('''() => { window.Telegram = null; applyStaticI18n(); }''')
        for width in (320, 390, 760):
            page.set_viewport_size({'width': width, 'height': 844})
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        page.evaluate('document.documentElement.style.fontSize="32px"')
        page.set_viewport_size({'width': 320, 'height': 568})
        page.locator('#daySceneShare').focus()
        page.locator('#daySceneShare').evaluate('e => e.scrollIntoView({block: "center", behavior: "instant"})')
        assert page.evaluate('''() => { const e = document.querySelector('#daySceneShare'); const r = e.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return top === e || e.contains(top); }''')
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        if shots:
            page.locator('.day-scene-card').screenshot(path=str(Path(shots, 'two-320-large-text.png')))
        page.evaluate('document.documentElement.style.fontSize="16px"')
        page.set_viewport_size({'width': 390, 'height': 844})
        page.locator('#tab-button-week').click()
        page.locator('[data-history-delete]').first.click()
        page.locator('#historyDeleteDialog [data-history-delete-choice="confirm"]').click()
        page.wait_for_function('!document.querySelector("#historyDeleteDialog") && !state.busy')
        page.locator('#tab-button-today').click()
        page.wait_for_function('state.summary?.todayEntryTypes?.length === 1')
        assert page.locator('.day-scene-motif:visible').count() == 1
        page.locator('[data-entry-type="movement"]').press('Enter')
        page.wait_for_function('state.summary?.todayEntryTypes?.includes("movement") && !state.busy')
        assert (page.locator('[data-entry-type="movement"]').get_attribute('aria-label') or '').startswith('Движение, Уже добавлено сегодня')
        page.locator('.qa-item:has([data-entry-type="food_water"]) .qa-hint').click()
        page.wait_for_function('state.summary?.todayEntryTypes?.includes("food_water") && !state.busy')
        assert page.locator('[data-entry-type="food_water"]').get_attribute('data-used-today') == 'true'
        assert not errors, errors
        print('PASS day scene: empty/marked, stable slots, private PNG, responsive, remove, no JS errors')
    finally:
        context.close()
