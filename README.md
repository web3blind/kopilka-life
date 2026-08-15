# Копилка жизни

Telegram Mini App + bot MVP: одна HTML-страница с нижними вкладками, Node.js backend, SQLite и webhook bot API.

## Локальный запуск

```bash
npm install
cp .env.example .env
npm run init-db
npm run dev
```

Открыть: `http://localhost:3000/`.

В development при `DEV_AUTH_ENABLED=true` страница использует fake demo auth, если открыта вне Telegram.

## Проверки

```bash
npm test
```

Smoke tests покрывают:

- Telegram `initData` validation;
- dev auth и production-safe выключение через config;
- SQLite persistence;
- entries/balance/contracts;
- продуктовый слой MVP: подсказки дня, шаблоны договоров, недельный разбор, практики под цель, Compass/happy alignment без абстрактной кнопки “Достаточно на сегодня”;
- timezone-aware reminders и duplicate protection;
- webhook `/start` dry-run;
- demo cleanup cascade;
- базовые DOM/accessibility требования.

## /chro QA

Для локального browser QA используется Chromium через `/chro` skill:

```bash
PORT=3107 APP_BASE_URL=http://127.0.0.1:3107 WEBAPP_URL=http://127.0.0.1:3107 DB_PATH=./data/verify-chro.sqlite NODE_ENV=development DEV_AUTH_ENABLED=true SCHEDULER_ENABLED=false node src/server.js
/home/assistent/.openclaw/workspace/skills/chro/chromium-manager.sh open http://127.0.0.1:3107/
python3 tests/chro-qa.py
```

После QA удалить `data/verify-chro.sqlite*`.

## Production webhook

В `.env` должны быть заданы:

```env
NODE_ENV=production
BOT_TOKEN=...
WEBAPP_URL=https://your-domain.example
APP_BASE_URL=https://your-domain.example
DEV_AUTH_ENABLED=false
```

Команды:

```bash
npm run webhook:set
npm run webhook:info
npm run webhook:clear
```

Скрипт не печатает `BOT_TOKEN`. Для `webhook:set` нужен HTTPS URL.

## Важные ограничения

- Приложение не хранит и не переводит деньги.
- Продуктовые подсказки MVP — статичные мягкие тексты, не медицинские рекомендации и не AI-диагностика.
- Dev auth и demo cleanup должны быть выключены в production.
- Rate limiting in-memory: подходит для одного процесса MVP; для нескольких процессов нужен общий store.
