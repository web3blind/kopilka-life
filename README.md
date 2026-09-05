# Копилка жизни / Life Harbor

VK Mini App, Telegram Mini App, сайт и бот на одной учётной записи: vanilla HTML/CSS/JS, Node.js/Express, SQLite и Telegram webhook.
Интерфейс RU/EN содержит шесть вкладок: «Сегодня», «История», «Договор», «Настройки», «Полезное», «Профиль».

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
- timezone-aware reminders и duplicate protection;
- bounded app sessions, одноразовый server-side VK OAuth state/PKCE и browser binding;
- webhook secret, durable `update_id` dedup/retry и `/start`/inline-query dry-run без реальных отправок;
- user-scoped History API, даты/timezone, edit/delete и сохранение уже встреченных персонажей;
- полную RU/EN локализацию открытых и скрытых артефактов;
- demo cleanup cascade;
- базовые DOM/accessibility требования.

## Локальный browser QA через audited CDP relay

QA не использует production-токены и не открывает VK. Нужен уже запущенный loopback relay `127.0.0.1:18800` и Python Playwright:

```bash
/home/assistent/.hermes/scripts/chip-relay-default.sh health
rm -f /tmp/kopilka-life-browser-qa.sqlite*
PORT=3119 APP_BASE_URL=http://127.0.0.1:3119 WEBAPP_URL=http://127.0.0.1:3119 \
  DB_PATH=/tmp/kopilka-life-browser-qa.sqlite NODE_ENV=test DEV_AUTH_ENABLED=true \
  SCHEDULER_ENABLED=false BOT_TOKEN=test-bot-token BOT_USERNAME=HarborLifeBot \
  SESSION_SECRET=browser-qa-session-secret SESSION_MAX_AGE_SECONDS=3600 \
  VK_APP_ID=54723764 VK_SECURE_KEY=browser-qa-vk-secure-key \
  VK_OAUTH_CLIENT_ID=54723764 VK_OAUTH_CLIENT_SECRET=browser-qa-oauth-secret \
  VK_OAUTH_AUTHORIZE_URL=http://localhost:4119/authorize VK_OAUTH_TOKEN_URL=http://localhost:4119/token \
  TELEGRAM_WEBHOOK_SECRET=browser_qa_webhook_secret_123456 node src/server.js

# В другом терминале:
KOPILKA_QA_BASE_URL=http://127.0.0.1:3119 KOPILKA_QA_CDP_URL=http://127.0.0.1:18800 \
  KOPILKA_QA_OAUTH_PROVIDER_URL=http://localhost:4119 \
  DB_PATH=/tmp/kopilka-life-browser-qa.sqlite BOT_TOKEN=test-bot-token \
  SESSION_SECRET=browser-qa-session-secret VK_SECURE_KEY=browser-qa-vk-secure-key \
  python3 tests/browser-audit-qa.py
```

После остановки локального сервера удалить только `/tmp/kopilka-life-browser-qa.sqlite*`. Скрипт поднимает локальный provider stand-in на указанном loopback-порту, включает через CDP блокировку third-party cookies и закрывает только task-origin/provider вкладки. Signed Telegram/VK fixtures и OAuth stand-in проверяют локальную механику и identity, но не считаются live platform auth.

## Production webhook

В `.env` должны быть заданы:

```env
NODE_ENV=production
BOT_TOKEN=...
TELEGRAM_WEBHOOK_SECRET=<случайная строка A-Z/a-z/0-9/_/-, 1–256 символов>
WEBAPP_URL=https://life.blinddev.xyz
APP_BASE_URL=https://life.blinddev.xyz
SESSION_SECRET=...
SESSION_MAX_AGE_SECONDS=604800
DEV_AUTH_ENABLED=false
```

Команды (запись webhook выполняет только parent/operator после backup, deploy и health-check):

```bash
npm run webhook:set
npm run webhook:info
npm run webhook:clear
```

`npm run webhook:info` — read-only. Скрипт не печатает `BOT_TOKEN` даже частично. `webhook:set` передаёт `secret_token` и `allowed_updates: message, edited_message, inline_query`; нужен HTTPS URL. Живая processing lease отвечает `503` с `Retry-After`, завершённый дубль — `200`; номер attempt защищает состояние от опоздавшего worker, а Telegram outbound timeout короче lease. Branded inline-кнопка принимает только configured app origin, точного configured Telegram bot или точного VK app; остальные URL ведут на canonical app. Официальные контракты: [Telegram setWebhook](https://core.telegram.org/bots/api#setwebhook), [InlineKeyboardButton](https://core.telegram.org/bots/api#inlinekeyboardbutton).

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

3. Подготовить отдельный clean release без `.env`, `data/`, `tmp/`, затем добавить в production `.env` `TELEGRAM_WEBHOOK_SECRET` и `SESSION_MAX_AGE_SECONDS=604800`. До этого новый production process не запускать.
4. Запустить только read-only gate:

```bash
KOPILKA_SITE=/www/wwwroot/life.blinddev.xyz \
KOPILKA_DB_BACKUP="$BACKUP/kopilka-life.sqlite" KOPILKA_ENV_BACKUP="$BACKUP/app.env" \
KOPILKA_RELEASE_DIR="$RELEASE" scripts/deploy-life.sh --preflight
```

5. После `PRECHECK_OK` parent копирует только code surfaces (`public/`, `src/`, `migrations/`, `scripts/`, `package.json`, `package-lock.json`) в site; `.env` и `data/` не удаляются и не синхронизируются. Затем: `npm ci --no-audit`, `node scripts/init-db.js`, controlled `pm2 reload kopilka-life --update-env`.
6. Проверить `/health`, неизменность `DB_PATH`, `PRAGMA integrity_check`, прежние counts/ключевые записи и вход на сайт. Затем выполнить `npm run webhook:set` и `npm run webhook:info`.
7. Live gate родителя: открыть `https://vk.ru/app54723764` из технического VK-аккаунта Lada и подтвердить немедленный signed launch login, expired-session renewal, повторное открытие, прежнюю identity/данные и History. Отдельно в реальном cross-site VK iframe воспроизвести exceptional fallback: невалидный/отсутствующий proof → явная VK ID кнопка → first-party popup → возврат в то же приложение и ту же VK identity. Затем открыть `@HarborLifeBot`, проверить немедленный вход существующего Telegram-пользователя, expired-session renewal, referral/profile share и отсутствие дублей webhook. Mock QA не заменяет этот gate.

Rollback: вернуть предыдущий code release целиком и reload вместе с совместимым env/webhook состоянием; текущая миграция только добавляет таблицы. Не восстанавливать старую БД поверх живой без отдельного решения. Незавершённый OAuth state можно отбросить и начать вход заново.

## Важные ограничения

- Приложение не хранит и не переводит деньги.
- Продуктовые подсказки MVP — статичные мягкие тексты, не медицинские рекомендации и не AI-диагностика.
- Dev auth и demo cleanup должны быть выключены в production.
- Rate limiting in-memory: подходит для одного процесса MVP; для нескольких процессов нужен общий store.
