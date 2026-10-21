# Копилка жизни / Life Harbor

VK Mini App, Telegram Mini App, сайт и бот на одной учётной записи: vanilla HTML/CSS/JS, Node.js/Express, SQLite и Telegram webhook.
Интерфейс RU/EN содержит шесть вкладок: «Сегодня», «История», «Договор», «Настройки», «Полезное», «Профиль».

Во вкладке «Профиль» доступны обычное распространение публичного профиля и открытие нативного редактора истории: Telegram Mini App использует `WebApp.shareToStory`, VK Mini App — `VKWebAppShowStoryBox`. Серверная PNG-карточка `/api/story-card/:code.png?platform=telegram|vk` строится только из публичной проекции профиля; публикацию всегда отдельно подтверждает пользователь в редакторе платформы. В VK повторное открытие редактора блокируется на время подготовки изображения и ожидания ответа платформы; после успеха, отмены или ошибки кнопка снова доступна. `#ref=CODE` остаётся реферальным запуском, а `#profile=CODE` после signed platform auth показывает публичный профиль владельца, не подменяя identity получателя.

## Интерфейс и документы

При обычном распространении ссылки через `VKWebAppShare` ожидание ответа временно подавляет автоматическое обновление при возврате, но не дольше 30 секунд. Потерянный ответ не останавливает последующие обновления навсегда. Ответ предыдущего запроса не меняет статус более нового запроса. Этот предел не означает успешную отправку и не запускает повторную отправку или другой способ распространения.

Несохранённая заметка в «Истории» защищена решением «Сохранить / Отбросить изменения / Отмена» перед сменой даты или редактора. Отмена сохраняет текст, выделение и фокус; перерисовка и смена языка не сбрасывают редактор. Если заметка сохранена, но последующее обновление не удалось, интерфейс сообщает об этом отдельно и повтор не отправляет заметку снова. Черновик не сохраняется в localStorage: выход, смена аккаунта и объединение очищают приватное состояние; предупреждение браузера перед перезагрузкой зависит от поддержки платформы и не является восстановлением после сбоя.

Поля договора показывают текущую длину и допустимый максимум: название 120, критерий 300, сумма 40, валюта 20, подарок 300 и фонд заботы 300 символов. Счётчики обновляются при вводе, выборе шаблона, сбросе и смене языка; пределы и серверная проверка не изменены. Длина считается так же, как HTML `maxlength` (UTF-16).

У экспортируемых изображений историй VK есть тёмные верхняя и нижняя подложки для белых надписей платформы. Они применяются к картине дня и публичной PNG-карточке; изображение для Telegram и картина внутри приложения не меняются. Положение надписей нативного редактора определяется VK, поэтому подложки не гарантируют контраст произвольно перемещённого текста вне этих зон.

Отклонение JSON больше 64KiB возвращает HTTP 413 с кодом `PAYLOAD_TOO_LARGE` и понятным сообщением RU/EN. Язык берётся из проверенной активной сессии; без неё используется русский. Отклонённый запрос ничего не сохраняет.


Сообщения объявляются через `role=status` без переноса фокуса. У здорового статуса «Готово» и сообщения о неподтверждённой отправке ссылки есть кнопка «Закрыть уведомление». Длинное сообщение о неподтверждённой отправке не исчезает по таймеру; после закрытия поле ручного копирования ссылки остаётся доступным. Ошибки, активное сохранение и предупреждение о неудачном обновлении кнопка не скрывает. Сохранение заметки сохраняет позицию истории; смена языка обновляет подписи открытого редактора, не заменяя черновик. Диалог наград блокирует прокрутку фона и восстанавливает её при закрытии. Отдельное сообщение «Открыт новый артефакт» исчезает через пять секунд, как сообщение об успешном пополнении, в том числе после перехода на другую вкладку. Таймер не закрывает сам диалог награды и не скрывает более новую ошибку или предупреждение. При сокращении окна, в том числе при появлении клавиатуры, активное поле прокручивается в видимую область. В очень низком окне приоритет — не скрывать верх поля; свободного места над нижней навигацией может не хватить для всего поля.

В английском интерфейсе политика и условия открываются из `/privacy.en.html` и `/terms.en.html`; русские оригиналы сохранены. Reader пересылает только разрешённые параметры языка, не подпись запуска и не произвольный URL возврата.

Часовой пояс выбирается по локализованному названию и текущему смещению UTC; сервер сохраняет точный IANA-идентификатор. Неверное значение отклоняется до изменения настроек и напоминаний. Счётчик «Полезное» показывает оставшиеся действия для зачёта, не непрочитанные карточки.

## Ранний запуск / Startup recovery

`public/startup.js` — канонический исходник защитного скрипта, независимого от основного клиента. Его копия встроена в HTML до вторичных ресурсов: зависший запрос JS или CSS не должен блокировать первоначальный экран восстановления. После изменения исходника выполни `node tests/startup-critical.test.js --sync`; обычный тест проверяет совпадение встроенной копии. CSS загружается без блокировки первого отображения, а экран восстановления имеет минимальные встроенные стили. Статический экран загрузки содержит кнопку повторной загрузки, даже если основной скрипт не загрузился; при появлении интерфейса он скрывается. Ранние события отправляются в существующий `/api/client-log` только как ограниченный набор маркеров: без URL, launch-параметров, токенов, заметок или текста исключений.

Для VK-запуска предусмотрена ограниченная проверка поздно появившегося нативного iOS-обработчика Init, если SDK ранее выбрал ненативный транспорт. Vendor SDK и проверка подписанной личности не заменяются. Это защитный механизм, а не подтверждение устранения отказа на конкретном iPhone. Connected regression: `python3 tests/run-browser-qa.py startup-recovery-browser-qa.py` на временной БД и отдельном QA Chromium.

## Локальный запуск / Local run

```bash
npm install
cp .env.example .env
npm run init-db
npm run dev
```

Открыть: `http://localhost:3000/`.

В development при `DEV_AUTH_ENABLED=true` страница использует fake demo auth, если открыта вне Telegram.

## Многоязычность / i18n

- Язык пользователя определяется по `language_code` из Telegram (initData) и хранится в профиле.
- Переключатель **Русский / English** в экране «Настройки» (сохраняется через `POST /api/settings/locale`).
- Backend-словарь: `src/i18n.js` (категории, подсказки, шаблоны, практики, разбор, ошибки, сообщения бота).
- Frontend-словарь: `public/i18n.js` (статические тексты оболочки и кнопки быстрых действий).
- Бот отправляет `/start` и напоминания на языке пользователя.
- В настройках VK разрешение сообщений от сообщества и сохранённое включение вечерних напоминаний — разные состояния. После выключения и сохранения статус показывает, что напоминания выключены, даже если сообщения от сообщества по-прежнему разрешены. Изменение выключателя применяется кнопкой сохранения.

## Проверки / Checks

```bash
npm test
```

Smoke tests покрывают:

- Telegram `initData` validation;
- dev auth и production-safe выключение через config;
- SQLite persistence;
- entries/balance/contracts;
- продуктовый слой MVP: подсказки дня, шаблоны договоров, недельный разбор, практики под цель, Compass/happy alignment без абстрактной кнопки “Достаточно на сегодня”;
- **i18n RU/EN**: локализованные категории, шаблоны, практики и разбор для EN-пользователя;
- timezone-aware reminders and per-channel/per-browser durable retry and duplicate protection; authenticated Settings opt-in Web Push on HTTPS/localhost (no automatic permission prompt, e-mail delivery not included). Configure stable VAPID keys in protected deployment; each browser enables separately, and merge revokes subscriptions until they opt in again;
- bounded app sessions, одноразовый server-side VK OAuth state/PKCE и browser binding;
- webhook secret, durable `update_id` dedup/retry и `/start`/inline-query dry-run без реальных отправок;
- user-scoped History API, даты/timezone, edit/delete и сохранение уже встреченных персонажей;
- полную RU/EN локализацию открытых и скрытых артефактов;
- demo cleanup cascade;
- базовые DOM/accessibility требования.

## Локальные браузерные проверки

Нужны Python Playwright и отдельный тестовый Chromium с CDP (интерфейсом управления браузером). Используй чистую копию репозитория без рабочего `.env`, реальных учётных данных и пользовательской БД. Для тестов не нужен браузер с выполненным входом в VK или Telegram.

В одном терминале запусти отдельный браузер с временным профилем:

```bash
QA_PROFILE=$(mktemp -d "${TMPDIR:-/tmp}/kopilka-chromium.XXXXXX")
chromium --headless=new --no-sandbox --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 --user-data-dir="$QA_PROFILE"
```

В другом терминале, из корня чистой копии проекта:

```bash
KOPILKA_QA_CDP_URL=http://127.0.0.1:9222 python3 tests/run-browser-qa.py
KOPILKA_QA_CDP_URL=http://127.0.0.1:9222 python3 tests/run-browser-qa.py region-browser-qa.py
KOPILKA_QA_CDP_URL=http://127.0.0.1:9222 python3 tests/run-browser-qa.py link-matrix-browser-qa.py
python3 tests/referral-privacy-browser-qa.py
python3 tests/talkback-quick-feedback-browser-qa.py
python3 tests/gratitude-hints-cursor-browser-qa.py
```

После проверок останови только тестовый Chromium и удали его временный профиль. Runner создаёт временную SQLite и завершает свой сервер при выходе. Проверки выполняй последовательно: часть сценариев использует фиксированные loopback-порты. Нативные SDK, доставка писем, ответы Google/VK, clipboard и системное меню отправки моделируются там, где это предусмотрено конкретным сценарием. Эти проверки не доказывают работу реального TalkBack, конкретного iPhone или живого провайдера входа.

Внутренние планы, снимки карточек VK Testers и временные доказательства не входят в исходники. Обзор изменений для пользователей и технические примечания — в [CHANGELOG.md](CHANGELOG.md).

## Production webhook

В `.env` должны быть заданы:

```env
NODE_ENV=production
BOT_TOKEN=...
TELEGRAM_WEBHOOK_SECRET=<случайная строка A-Z/a-z/0-9/_/-, 1–256 символов>
WEBAPP_URL=https://life.blinddev.xyz
APP_BASE_URL=https://life.blinddev.xyz
SESSION_SECRET=...
SESSION_MAX_AGE_SECONDS=31536000
DEV_AUTH_ENABLED=false
```

Команды (запись webhook выполняет только parent/operator после backup, deploy и health-check):

```bash
npm run webhook:set
npm run webhook:info
npm run webhook:clear
```

`npm run webhook:info` — read-only. Скрипт не печатает `BOT_TOKEN` даже частично. `webhook:set` передаёт `secret_token` и `allowed_updates: message, edited_message, inline_query`; нужен HTTPS URL. Живая processing lease отвечает `503` с `Retry-After`, завершённый дубль — `200`; номер attempt защищает состояние от опоздавшего worker, а Telegram outbound timeout короче lease. Branded inline-кнопка принимает только configured app origin, точного configured Telegram bot или точного VK app; остальные URL ведут на canonical app. Официальные контракты: [Telegram setWebhook](https://core.telegram.org/bots/api#setwebhook), [InlineKeyboardButton](https://core.telegram.org/bots/api#inlinekeyboardbutton).

## Договор заботы / Care contract

Шаблон заполняет пустую форму сразу. Перед заменой заполненных полей запрашивается подтверждение; отказ сохраняет черновик. Лимиты: название 120, критерий 300, подарок и назначение фонда по 300, сумма 40, валюта 20 символов. API отклоняет превышение, не обрезая текст. Сумма необязательна: неотрицательное число с точкой или запятой. Валюта остаётся текстовым обозначением; переводов денег нет.

Полезное в VK открывает Mini Apps через VKWebAppOpenApp, остальные разрешённые VK-ссылки — в отдельном окне. Неудачное открытие не начисляет награду и показывает локализованный статус.

Connected регрессия на временной БД: `python3 tests/run-browser-qa.py vk-testers-fixes-browser-qa.py`. Native bridge в ней контролируется; это не проверка реального iOS VK.

## Auth и History API

Обычная заметка при создании и редактировании имеет единый лимит 2000 символов. API отклоняет превышение с локализованной ошибкой и никогда не сохраняет молча обрезанную версию; существующие заметки длиннее старого лимита 500 символов можно открыть и сохранить целиком в пределах нового лимита.

- App-session содержит `iat`/`exp`, но cached token не определяет пользователя текущего Mini App launch. Frontend сначала ограниченно ждёт Telegram SDK/VK Bridge, отправляет signed proof на сервер без cached bearer и только после ответа делает private reads/render. Поэтому cached account A + валидный Telegram/VK launch B открывает B; уже объединённые Telegram/VK identities по-прежнему возвращают один server-side account. Для сайта без platform context используется отдельная cached website session или повторный вход.
- Окно проверки старых VK launch params остаётся отдельным (`VK_AUTH_MAX_AGE_SECONDS`, по умолчанию 7 дней) для сохранённых Android-запусков. Валидные Telegram `initData` и VK signed launch params/Bridge входят сразу и прозрачно обновляют expired app-session; login form или OAuth в нормальном platform launch не показываются. Наличие `tgWebAppData`/Bridge служит только сигналом bounded readiness: identity всё равно устанавливает сервер после криптографической проверки proof.
- Если VK proof отсутствует или не прошёл проверку, OAuth не запускается автоматически. Пользователь явно нажимает VK ID: приложение синхронно открывает first-party popup, затем создаёт одноразовый server-side intent. Popup устанавливает HttpOnly `SameSite=Lax` binding на app origin и только потом переходит в VK ID. При блокировке popup показывается доступная first-party ссылка без скрытого retry-loop.
- VK OAuth intent/state — короткие одноразовые случайные строки. PKCE verifier, handoff channel и link context хранятся только в SQLite с expiry; link target берётся из проверенной app-session, а не client `userId`. Для `action=link` callback ничего не привязывает и не создаёт merge offer: он возвращает только короткоживущий opaque verified-VK proof. Отдельный `POST /api/auth/vk-oauth/finalize-link` требует исходную bearer app-session, сверяет неизменный target, одноразово потребляет proof и только тогда выполняет link либо выдаёт merge token для явного согласия. Переданный другому браузеру launch URL, foreign/expired/logout session и replay не меняют аккаунт. Callback использует точный configured app origin и ожидаемое popup-окно, без wildcard `postMessage`, bearer в URL или open redirect. Официальный flow: [VK ID server OAuth](https://id.vk.com/about/business/go/docs/ru/vkid/latest/oauth-ok/server).
- `GET /api/history?date=YYYY-MM-DD&days=7` возвращает ограниченное user-scoped окно и все записи выбранного дня. `PATCH /api/entries/:id` меняет только note обычной daily entry. `DELETE /api/entries/:id` требует `{ "confirm": true }`; системные/referral/contract записи защищены, уже встреченные персонажи сохраняются.

## Safe production transition (parent-owned)

`scripts/deploy-life.sh` больше не деплоит: он только fail-closed проверяет заранее созданные backup/release. Старые root cleanup, `checkout/reset --hard`, перезапись `.env`, `init-db || true` и `pm2 delete` удалены.

1. Read-only inventory: подтвердить реальный app cwd, `DB_PATH`, PM2 unit, `.env`, наличие `DB_PATH-wal`/`DB_PATH-shm`, текущий commit и counts `users/entries/weekly_contracts/user_artifacts`. Значения секретов не печатать.
2. Создать backup вне site/release и проверить его:

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP=/root/backups/kopilka-life/$TS
install -d -m 700 "$BACKUP"
node -e 'const Database=require("better-sqlite3"); const db=new Database(process.argv[1],{readonly:true,fileMustExist:true}); db.backup(process.argv[2]).then(()=>db.close())' "$DB_PATH" "$BACKUP/kopilka-life.sqlite"
install -m 600 .env "$BACKUP/app.env"
node -e 'const Database=require("better-sqlite3"); const db=new Database(process.argv[1],{readonly:true,fileMustExist:true}); console.log(db.pragma("integrity_check",{simple:true})); for(const t of ["users","entries","weekly_contracts","user_artifacts"]) console.log(t,db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n); db.close()' "$BACKUP/kopilka-life.sqlite"
```

3. Подготовить отдельный clean release без `.env`, `data/`, `tmp/`, затем добавить в production `.env` `TELEGRAM_WEBHOOK_SECRET` и `SESSION_MAX_AGE_SECONDS=31536000`. До этого новый production process не запускать.
4. Запустить только read-only gate:

```bash
KOPILKA_SITE=/www/wwwroot/life.blinddev.xyz \
KOPILKA_DB_BACKUP="$BACKUP/kopilka-life.sqlite" KOPILKA_ENV_BACKUP="$BACKUP/app.env" \
KOPILKA_RELEASE_DIR="$RELEASE" scripts/deploy-life.sh --preflight
```

5. После `PRECHECK_OK` parent копирует только code surfaces (`public/`, `src/`, `migrations/`, `scripts/`, `package.json`, `package-lock.json`) в site; `.env` и `data/` не удаляются и не синхронизируются. Затем: `npm ci --no-audit`, `node scripts/init-db.js`, controlled `pm2 reload kopilka-life --update-env`.
6. Проверить `/health`, неизменность `DB_PATH`, `PRAGMA integrity_check`, прежние counts/ключевые записи и вход на сайт. Затем выполнить `npm run webhook:set` и `npm run webhook:info`.
7. Live gate родителя: открыть `https://vk.ru/app54723764` из технического VK-аккаунта Lada и подтвердить немедленный signed launch login, expired-session renewal, повторное открытие, прежнюю identity/данные и History. Отдельно в реальном cross-site VK iframe воспроизвести exceptional fallback: невалидный/отсутствующий proof → явная VK ID кнопка → first-party popup → возврат в то же приложение и ту же VK identity. Затем открыть `@HarborLifeBot`, проверить немедленный вход существующего Telegram-пользователя, expired-session renewal, referral/profile share и отсутствие дублей webhook. Mock QA не заменяет этот gate.

Rollback: вернуть предыдущий code release целиком и reload вместе с совместимым env/webhook состоянием. Миграции 018–020 добавляют таблицы/колонки, но 020 также удаляет уникальный индекс дневных записей: прежний код после миграции не получит DB-ограничение на повторную запись; rollback до миграции требует отдельной проверки данных, не запускать прежний код вслепую. Не восстанавливать старую БД поверх живой без отдельного решения. Незавершённый OAuth state можно отбросить и начать вход заново.

## Важные ограничения

- Приложение не хранит и не переводит деньги.
- Продуктовые подсказки MVP — статичные мягкие тексты, не медицинские рекомендации и не AI-диагностика.
- Dev auth и demo cleanup должны быть выключены в production.
- Rate limiting in-memory: подходит для одного процесса MVP; для нескольких процессов нужен общий store.

#### VK saved-launch recovery

`POST /api/auth/vk` and VK linking still require a fresh valid launch. After an unsuccessful bridge refresh, `POST /api/auth/vk/resume` may continue an existing active bearer only for the same correctly signed, expired VK identity and current session revision. It returns that exact bearer without extending its lifetime or creating/linking/merging accounts. Missing, invalid, expired or revoked bearers and mismatched identities fail closed.

Explicit VK ID starts create the one-use server intent in the initiating page; only its opaque intent crosses the navigation URL. No app bearer or context is passed through `window.name`. A real fallback link remains available even when a native host returns an unusable live WindowProxy. External-browser auth finishes there when no opener exists; external link completion still requires the original authenticated session (never transfer a bearer in a URL). Ordinary Mini App startup retains signed-launch priority over cached accounts.

Local regression: `node --test tests/vk-saved-launch.test.js tests/vk-login-recovery.test.js` and `KOPILKA_QA_PORT=32991 python3 tests/run-browser-qa.py vk-login-recovery-browser-qa.py` (provider port 32992; isolated SQLite, outbound blocker and owned CDP contexts). These checks model native handoff loss; they are not actual VK Android/iOS acceptance.
