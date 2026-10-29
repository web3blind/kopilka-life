# Копилка жизни / Life Harbor

VK Mini App, Telegram Mini App, сайт и бот на одной учётной записи: vanilla HTML/CSS/JS, Node.js/Express, SQLite и Telegram webhook.
Интерфейс RU/EN содержит шесть вкладок: «Сегодня», «История», «Договор», «Настройки», «Полезное», «Профиль».

Во вкладке «Профиль» доступны обычное распространение публичного профиля и открытие нативного редактора истории: Telegram Mini App использует `WebApp.shareToStory`, VK Mini App — `VKWebAppShowStoryBox`. Серверная PNG-карточка `/api/story-card/:code.png?platform=telegram|vk` строится только из публичной проекции профиля; публикацию всегда отдельно подтверждает пользователь в редакторе платформы. В VK повторное открытие редактора блокируется на время подготовки изображения и ожидания ответа платформы; после успеха, отмены или ошибки кнопка снова доступна. `#ref=CODE` остаётся реферальным запуском, а `#profile=CODE` после signed platform auth показывает публичный профиль владельца, не подменяя identity получателя.

## Выход из аккаунта

Кнопка выхода в профиле сайта отзывает текущий bearer-токен на сервере, затем очищает локальные данные входа и несохранённые черновики. История, способы входа и другие сессии аккаунта сохраняются. Повторное использование отозванного токена для чтения профиля и изменения настроек возвращает401. Если ответ сервера потерян или сервер недоступен, успех не показывается: остаётся предупреждение и возможность явно повторить выход. Данные отзыва хранятся как SHA-256 отпечаток токена с его сроком действия; сам bearer в базе не хранится. Mini App-поведение входа и платформенный аккаунт не меняются.

## Интерфейс и документы

«О сервисе» открывается в том же reader, что и документы. Возврат сохраняет текущую вкладку, несохранённую заметку и настройки, фокус и контекст запуска. VK остаётся мини-приложением с историей VK и VK-напоминаниями; сайт сохраняет свои способы входа и сохранения картинки.

После отмены редактора истории и повторного открытия ссылки на сообщество короткое уведомление исчезает через пять секунд или закрывается кнопкой. Это не подтверждение публикации. Ошибки и длинное предупреждение о неподтверждённой отправке не получили автоматического скрытия.

Когда все быстрые отметки за местный день уже добавлены, поле необязательной заметки недоступно. Черновик не удаляется; поле снова доступно, когда сервер подтверждает доступные действия. Благодарность остаётся отдельным действием. Нижние ссылки следуют выбранному языку, обращение в описании реферальной ссылки — на «ты».

### Проверка пакета восьми отчётов

`npm test` включает регрессии коротких уведомлений и доступности заметки. Дополнительные connected-проверки находятся в `tests/reports8-*-browser-qa.py`; они используют отдельные SQLite и Chromium, не живые аккаунты. Для проверки текущего production-relative дерева задать `REPORTS8_SOURCE` на изолированную копию его исходников с зависимостями, а `REPORTS8_AUDIT` — на приватный каталог результатов. Запускать Python с установленным Playwright. Порты 32771–32773 должны быть свободны. Копию с настоящим `.env` использовать нельзя.

```sh
REPORTS8_SOURCE=/path/to/isolated-source node --test tests/reports8-copy.test.cjs
REPORTS8_SOURCE=/path/to/isolated-source python3 tests/reports8-entry-context-browser-qa.py green
REPORTS8_SOURCE=/path/to/isolated-source python3 tests/reports8-notices-notes-browser-qa.py green
REPORTS8_SOURCE=/path/to/isolated-source python3 tests/reports8-copy-browser-qa.py green
```

Текущий live-renderer About/SEO/партнёров ещё не перенесён целиком в main. Его узкое изменение локализации сохранено отдельно в `patches/20261026-testers8-live-footer.patch`: применять только к соответствующему исходному renderer после `git apply --check`, не переносить заодно остальные live-файлы. Browser-проверки About и footer требуют дерева с этим renderer. Полный maintained test corpus на captured production имеет прежние несовпадения startup-версии; они не исправляются этим пакетом. Проверки на Chromium не заменяют физические VK Android/iOS и TalkBack.

После выбора цели практик подтверждение обновления исчезает через пять секунд. Его также можно закрыть кнопкой; фокус возвращается к доступному элементу. Старый таймер не скрывает более новое уведомление или предупреждение об ошибке.

Быстрые действия передают дневное состояние через `aria-pressed`: оно меняется только после подтверждения записи сервером. Название кнопки остаётся постоянным, подсказка и доступность на сегодня идут в описании. После подтверждения сетки снимается `aria-busy`, но защита от повторного сохранения действует до окончания дополнительных запросов. Сообщение об обновлении практик под выбранную цель исчезает автоматически через пять секунд; более новое сообщение не стирается старым таймером. Кнопки и их порядок сохраняются. Chromium AX и клавиатурные проверки не заменяют проверку речи и свайпов TalkBack на устройстве.

При обычном распространении ссылки через `VKWebAppShare` ожидание ответа временно подавляет автоматическое обновление при возврате, но не дольше 30 секунд. Потерянный ответ не останавливает последующие обновления навсегда. Ответ предыдущего запроса не меняет статус более нового запроса. Этот предел не означает успешную отправку и не запускает повторную отправку или другой способ распространения.

Несохранённая заметка в «Истории» защищена решением «Сохранить / Отбросить изменения / Отмена» перед сменой даты или редактора. Отмена сохраняет текст, выделение и фокус; перерисовка и смена языка не сбрасывают редактор. Если заметка сохранена, но последующее обновление не удалось, интерфейс сообщает об этом отдельно и повтор не отправляет заметку снова. Черновик не сохраняется в localStorage: выход, смена аккаунта и объединение очищают приватное состояние; предупреждение браузера перед перезагрузкой зависит от поддержки платформы и не является восстановлением после сбоя.

Поля договора показывают текущую длину и допустимый максимум: название 120, критерий 300, сумма 40, валюта 20, подарок 300 и фонд заботы 300 символов. Счётчики обновляются при вводе, выборе шаблона, сбросе и смене языка; пределы и серверная проверка не изменены. Длина считается так же, как HTML `maxlength` (UTF-16).

У экспортируемых изображений историй VK есть тёмные верхняя и нижняя подложки для белых надписей платформы. Они применяются к картине дня и публичной PNG-карточке; изображение для Telegram и картина внутри приложения не меняются. Положение надписей нативного редактора определяется VK, поэтому подложки не гарантируют контраст произвольно перемещённого текста вне этих зон.

Отклонение JSON больше 64KiB возвращает HTTP 413 с кодом `PAYLOAD_TOO_LARGE` и понятным сообщением RU/EN. Язык берётся из проверенной активной сессии; без неё используется русский. Отклонённый запрос ничего не сохраняет.


Сообщения объявляются через `role=status` без переноса фокуса. Успешное сохранение языка или настроек напоминаний показывает локализованное уведомление с кнопкой закрытия и защищённым пятисекундным таймером. Выбор уже установленного языка не отправляет запрос и не создаёт уведомление об успехе. Сохранение с последующей ошибкой обновления оставляет предупреждение на экране; таймер не скрывает более новую ошибку. У уведомления о подставленном шаблоне договора есть кнопка «Закрыть уведомление» и пятисекундное автоматическое скрытие. Закрытие сохраняет заполненные поля; при фокусе на кнопке возвращает его к исходному элементу формы. Таймер не убирает более новую ошибку и не действует во время сохранения, восстановления входа или неудачного обновления. У здорового статуса «Готово» и сообщения о неподтверждённой отправке ссылки есть кнопка «Закрыть уведомление». Длинное сообщение о неподтверждённой отправке не исчезает по таймеру; после закрытия поле ручного копирования ссылки остаётся доступным. Ошибки, активное сохранение и предупреждение о неудачном обновлении кнопка не скрывает. Сохранение заметки сохраняет позицию истории; смена языка обновляет подписи открытого редактора, не заменяя черновик. Диалог наград блокирует прокрутку фона и восстанавливает её при закрытии. Отдельное сообщение «Открыт новый артефакт» исчезает через пять секунд, как сообщение об успешном пополнении, в том числе после перехода на другую вкладку. Таймер не закрывает сам диалог награды и не скрывает более новую ошибку или предупреждение. При сокращении окна, в том числе при появлении клавиатуры, активное поле прокручивается в видимую область. В очень низком окне приоритет — не скрывать верх поля; свободного места над нижней навигацией может не хватить для всего поля.

В английском интерфейсе политика и условия открываются из `/privacy.en.html` и `/terms.en.html`; русские оригиналы сохранены. Reader пересылает только разрешённые параметры языка, не подпись запуска и не произвольный URL возврата.

Часовой пояс выбирается по локализованному названию и текущему смещению UTC; сервер сохраняет точный IANA-идентификатор. Неверное значение отклоняется до изменения настроек и напоминаний. Счётчик «Полезное» показывает оставшиеся действия для зачёта, не непрочитанные карточки.

## ИИ-помощник и отдых

В «Договоре» есть редактируемый шаблон «Вечера для отдыха». Он предлагает до трёх вечеров без новых рабочих задач после 20:00, учитывает оставшиеся дни недели в часовом поясе аккаунта. В воскресенье действующая форма создаёт договор уже на следующую неделю. Баллы и правила закрытия договора не меняются.

Отдельная седьмая вкладка «ИИ-помощник» вынесена из «Истории». Можно выбрать последние 3, 7, 14, 30 или другое целое число дней от 1 до 30; по умолчанию 7. Период включает сегодня по часовому поясу аккаунта, точные даты видны до согласия. Одна тема на запрос: только выжимка, меньше нервничать, облегчить сложные дни, лучше отдыхать, порадовать другого человека, поддержать себя или продвинуть важное дело. Для темы советов результат содержит выжимку и до трёх необязательных рекомендаций. Цели, отношения, эмоции и диагнозы не выдумываются. Обычный недельный разбор остаётся прежним.

Запуск ручной, после отдельного согласия на передачу дат, категорий и личных заметок через OpenRouter. Общий лимит — один запрос за скользящие семь суток (168 часов), независимо от темы, периода, языка или часового пояса. Интерфейс показывает время следующего запроса. Зарезервированная попытка учитывается и при ошибке или неподтверждённом ответе провайдера; автоматических повторов нет. Пустой период, неверные параметры и отсутствие настроенного ключа не расходуют слот. Повторное открытие, выбор периода, чтение архива и проверка результата не вызывают модель. Удаление текста не сбрасывает лимит; объединение аккаунтов учитывает самый поздний запрос обеих сторон.

Настройки сервера: `AI_WEEKLY_ENABLED=true`, выделенный `AI_WEEKLY_OPENROUTER_API_KEY`, `AI_WEEKLY_PAID_ENABLED=false`, необязательный `AI_WEEKLY_MODEL`, `AI_WEEKLY_TIMEOUT_MS` (по умолчанию 30000). Бесплатные модели тоже требуют API-ключ. Само наличие ключа не разрешает платные запросы. Оставь `AI_WEEKLY_MODEL` пустым для выбора по режиму. Без ключа и включения генерация недоступна. Ключи Hermes автоматически не используются. Без явного `AI_WEEKLY_PAID_ENABLED=true` разрешены только `:free`, по умолчанию `xingchen-agi/xing4.0-29b-a4b:free` (доступность меняется). При явном платном режиме по умолчанию используется `mistralai/mistral-nemo`, самый дешёвый из проверенных обычных многоязычных текстовых вариантов с доступным ZDR-маршрутом. У Gemini Flash-Lite подходящего маршрута в текущем ZDR-каталоге не найдено. Среди разрешённых endpoint выбирается самый дешёвый для верхней оценки размера запроса и 700 выходных токенов; это не обещание глобально самой дешёвой модели при любом будущем изменении каталога. Цены проверяются до передачи заметок: не выше $0,10 за миллион входных и $0,40 за миллион выходных токенов, пределы повторяются в маршрутизации. Повышение цен, неизвестная цена или несовместимый endpoint дают отказ, не более дорогую замену. Этот opt-in относится к расходам оператора на API, не вводит оплату для пользователей. Проверка с настоящим платным API в этом этапе не выполнялась. Перед передачей проверяется соответствие цен выбранному режиму и наличие конкретного endpoint в официальном `/endpoints/zdr`; в бесплатном режиме маршрутизация допускает только нулевые цены; в платном режиме действует указанный предел. В обоих режимах запрещены fallback, обучение и хранение у поставщика (`data_collection: deny`, `zdr: true`). Если совместимый бесплатный поставщик недоступен, сервис возвращает отказ, а не ослабляет ограничения. Проверь privacy/observability настройки выделенного аккаунта OpenRouter: разрешённое самим оператором логирование не отменяется параметрами запроса. У OpenRouter есть обязательные проверки безопасности и законные исключения хранения. Бесплатные квоты и доступность не гарантированы.

Язык выжимки определяется языком аккаунта на момент создания: RU → русский, EN → английский. Смена языка интерфейса не переводит уже сохранённый текст и не создаёт новую генерацию.

API требует действующую сессию: `GET /api/ai-weekly-summary?days=7&topic=summary` читает период, выбор темы, общую квоту, готовность, результат и архив без обращения к ИИ; `POST` принимает `consent: true`, точную `consentVersion`, серверный `periodKey`, `days` и `topic`; `DELETE /api/ai-weekly-summary/:id` удаляет собственный текст. Повторная отправка того же запроса возвращает сохранённое состояние без генерации. Другая тема или период при занятой квоте отклоняются с `429 AI_QUOTA_EXCEEDED`. При неподтверждённом ответе автоматической повторной отправки нет; «Проверить результат» делает только GET. Текст хранится приватно в SQLite, не в localStorage и не в публичном профиле. После удаления остаётся техническая отметка для защиты от повторной отправки. Архив сохраняет первоначальный язык. Объединение аккаунтов должно сохранять выжимки; удаление аккаунта удаляет связанные данные.

Проверки: `node --test tests/rest-contract-template.test.js tests/ai-weekly-summary.test.js tests/ai-assistant.test.js`; connected browser: `python tests/run-browser-qa.py ai-weekly-browser-qa.py` с Playwright и Chromium. Проверки используют временную БД и контролируемого провайдера, не личные заметки. Реальную генерацию проверять отдельно только синтетическими данными. Оплаты и выдача платного доступа в эту часть не входят. Исходники и миграция сами по себе не означают production-выкладку.

Официальные условия: [маршрутизация](https://openrouter.ai/docs/guides/routing/provider-selection), [обработка данных](https://openrouter.ai/docs/guides/privacy/data-collection), [бесплатные квоты](https://openrouter.ai/docs/api/reference/limits).

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

## Локальный browser QA через audited CDP relay

QA не использует production-токены и не открывает VK. Нужен уже запущенный loopback relay `127.0.0.1:18800` и Python Playwright:

```bash
# Check that your configured Chromium CDP endpoint is available.
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

## Партнёрские заявки и публичное SEO

- `/about`, `/partners`, `/en/about`, `/en/partners`: public RU/EN HTML with canonical/meta, Open Graph, JSON-LD and reciprocal hreflang. `/sitemap.xml` and `/robots.txt` list public pages, not private API/profiles. Homepage keeps the existing app/auth shell and links to these pages. No ranking or indexing guarantee.
- Partner terms are agreed individually; no audience claims, payment collection or change to the free app.
- Reuses the configured Kopilka bot and Resend (`BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`). Configure `PARTNER_OWNER_TELEGRAM_ID`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, and the correct public `APP_BASE_URL`. No secrets belong in source. Turnstile must allow the exact public hostname, with action `partner_inquiry`. Missing configuration disables submission server-side, not a fake protection/success state.
- `POST /api/partners/inquiries`: same-origin JSON, 12KB bound, required unchecked consent, honeypot, strict server CAPTCHA, maximum 10 attempts/IP/hour, durable 5 saved inquiries/IP/hour, 3/email/day, 200 globally/day. Trust proxy must match the controlled single proxy. CAPTCHA failure fails closed. Retry an ambiguous form result without changing fields to reuse its submission key; edits represent a new inquiry.
- Migration `022_partner_inquiries.sql` adds only two new tables and indexes; no old data rewrite. A 202 means inquiry plus notification job committed, NOT Telegram/mail delivery. Existing minute scheduler processes bounded jobs; use one process with `SCHEDULER_ENABLED=true`. Test mode never sends. Notifications are plain text with consent evidence.
- Owner: open the bot privately first. Reply with text/URL to the exact original notification. Only configured owner + private chat + persisted notification mapping qualifies. The recipient comes exclusively from the database. Edits, forwards, unknown messages and spoofed identities cannot send mail. Each accepted reply has a durable deduplicated email job. Resend uses a stable Idempotency-Key; a sent status means provider acceptance, not inbox receipt.
- 429/config absence retry with bounded backoff (10 attempts); definitive 4xx fail terminally; transport/5xx/malformed acceptance/crash park as unknown. Never blindly requeue unknown jobs. Reconcile against provider/Telegram evidence first; Telegram has no send idempotency. A safe diagnostic query is `SELECT id,kind,state,attempts,error_code,provider_id FROM partner_outbox ORDER BY due_at DESC LIMIT 30`; do not dump message/email bodies. Normal pending/retry jobs survive restart.
- Working-DB inquiry/reply data expires after 90 days via the running worker. This does not delete provider messages or backups. Updated RU/EN privacy pages describe Telegram, Resend and Turnstile processing.
- Local gates: `node --test tests/partner-inquiries.test.js`; `KOPILKA_QA_PORT=3193 python3 tests/run-browser-qa.py partner-browser-qa.py`; `npm test`. These use disposable SQLite and fake providers, never real deliveries. They do not prove live CAPTCHA/inbox delivery.
- Parent handoff: review feature-only deltas against the dirty live tree, back up SQLite consistently, rehearse migration on its restored copy, and retain existing env/webhook/scheduler invariants. Do not upload whole dirty local files over live. No deploy, push, real messages or credential edits were performed here.

## Важные ограничения

- Приложение не хранит и не переводит деньги.
- Продуктовые подсказки MVP — статичные мягкие тексты, не медицинские рекомендации и не AI-диагностика.
- Dev auth и demo cleanup должны быть выключены в production.
- Rate limiting in-memory: подходит для одного процесса MVP; для нескольких процессов нужен общий store.

#### VK saved-launch recovery

`POST /api/auth/vk` and VK linking still require a fresh valid launch. After an unsuccessful bridge refresh, `POST /api/auth/vk/resume` may continue an existing active bearer only for the same correctly signed, expired VK identity and current session revision. It returns that exact bearer without extending its lifetime or creating/linking/merging accounts. Missing, invalid, expired or revoked bearers and mismatched identities fail closed.

Explicit VK ID starts create the one-use server intent in the initiating page; only its opaque intent crosses the navigation URL. No app bearer or context is passed through `window.name`. A real fallback link remains available even when a native host returns an unusable live WindowProxy. External-browser auth finishes there when no opener exists; external link completion still requires the original authenticated session (never transfer a bearer in a URL). Ordinary Mini App startup retains signed-launch priority over cached accounts.

Local regression: `node --test tests/vk-saved-launch.test.js tests/vk-login-recovery.test.js` and `KOPILKA_QA_PORT=32991 python3 tests/run-browser-qa.py vk-login-recovery-browser-qa.py` (provider port 32992; isolated SQLite, outbound blocker and owned CDP contexts). These checks model native handoff loss; they are not actual VK Android/iOS acceptance.
