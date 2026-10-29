/* Private, manually requested weekly digest. No private data in browser storage. */
(() => {
  'use strict';
  const strings = {
    heading: ['Личный взгляд на записи', 'A personal look at your entries'],
    intro: ['Выбери период и тему. Выжимка записанных фактов будет всегда; дополнительные идеи — только если они тебе нужны.', 'Choose a period and topic. A factual summary is always included; extra ideas are optional.'],
    details: ['Что будет передано и сохранено', 'What is shared and saved'],
    disclosure: ['Только после твоего согласия и нажатия кнопки даты, категории отметок и тексты личных заметок за указанный период будут отправлены через OpenRouter внешнему ИИ-провайдеру вместе с выбранной темой для создания выжимки и, при выборе советов, рекомендаций. Для объёма данных действует ограничение. Имя, контакты и баллы к запросу не добавляются. Если ты записал личные сведения в заметках, они тоже попадут в запрос. До запуска их можно отредактировать в истории.', 'Only after your consent and a button press will entry dates, categories and personal note text for the selected period be sent through OpenRouter to an external AI provider, together with your selected topic, to create a summary and, if requested, recommendations. Input size limits apply. Your name, contact details and points are not added. Personal details you wrote in notes will also be included. You can edit those notes in History before starting.'],
    retention: ['Запрашиваем обработку у поставщиков, заявляющих отказ от хранения и обучения на запросах. OpenRouter проводит обязательные проверки безопасности и хранит технические сведения о запросах; возможны исключения по закону. Полного отсутствия хранения у внешних сервисов не обещаем. Готовая выжимка и факт согласия сохраняются в твоём аккаунте. Текст выжимки можно удалить здесь; техническая отметка останется для недельного лимита, даже после удаления или ошибки.', 'We request providers that declare no request retention or training. OpenRouter performs mandatory safety screening and stores request metadata; legal exceptions may apply. We do not promise that external services retain nothing. The finished digest and consent record are saved in your account. You can delete the digest text here; a technical record remains for the weekly limit, including after deletion or failure.'],
    policy: ['Политика OpenRouter', 'OpenRouter privacy policy'],
    googlePolicy: ['Условия Google Gemini API', 'Google Gemini API terms'],
    googleRetention: ['В бесплатном режиме Google может использовать запросы и ответы для улучшения продуктов; возможна проверка людьми. Условия зависят в том числе от региона. Не передавай конфиденциальные, чувствительные или персональные сведения: проверь заметки и при необходимости отредактируй их в Истории до запуска. Это не полностью анонимные данные. Готовая выжимка и факт согласия сохраняются в аккаунте; удаление текста не сбрасывает недельный лимит.', 'In free mode Google may use prompts and responses to improve products, and human review may occur. Terms can vary by region. Do not submit confidential, sensitive or personal information: review your notes and edit them in History before starting if needed. These data are not fully anonymous. The digest and consent record are saved in your account; deleting text does not reset the weekly limit.'],
    googleConsent: ['Я проверил заметки: в них нет конфиденциальных, чувствительных или персональных сведений. Согласен передать отметки и заметки за этот период напрямую Google Gemini для выжимки и выбранных рекомендаций. Понимаю, что в бесплатном режиме Google может использовать запрос и ответ для улучшения продуктов, включая проверку людьми; действуют условия Google и региональные исключения.', 'I have reviewed my notes: they contain no confidential, sensitive or personal information. I agree to send my entries and notes for this period directly to Google Gemini for a summary and any selected recommendations. I understand that in free mode Google may use the prompt and response to improve products, including human review; Google terms and regional exceptions apply.'],
    selected: ['Поставщик, режим и модель:', 'Provider, mode and model:'],
    freeMode: ['Бесплатный API', 'Free API'],
    paidMode: ['Платный API оператора', 'Operator-paid API'],
    projectFull: ['Общий лимит бесплатного ИИ сейчас исчерпан. Недельный слот не занят этим отказом. Можно позже проверить доступность; повторной отправки или перехода на платный API автоматически не будет.', 'The shared free AI limit is currently exhausted. This rejection did not use your weekly slot. You can check availability later; there is no automatic resend or switch to a paid API.'],
    projectNext: ['Общая квота: можно проверить после', 'Shared quota: check again after'],
    savedProvider: ['Поставщик сохранённой выжимки:', 'Saved digest provider:'],
    privacy: ['Конфиденциальность приложения', 'App privacy policy'],
    consent: ['Согласен передать отметки и личные заметки за этот период через OpenRouter для создания выжимки и, если они запрошены, рекомендаций по выбранной теме.', 'I agree to send my entries and personal notes for this period through OpenRouter to create a summary and, if requested, recommendations for the selected topic.'],
    start: ['Подготовить', 'Prepare'],
    refresh: ['Проверить результат', 'Check result'],
    loading: ['Загружаем сведения о выжимке…', 'Loading digest information…'],
    auth: ['Нужно восстановить вход. Запрос на создание не будет повторён автоматически. После входа проверь период и снова подтверди согласие.', 'Please restore your sign-in. The creation request will not be replayed automatically. After signing in, check the period and confirm consent again.'],
    recover: ['Восстановить вход', 'Restore sign-in'],
    unavailable: ['Создание ИИ-выжимки сейчас недоступно. Обычная история и недельный разбор работают как прежде.', 'AI digest creation is unavailable right now. Your history and regular weekly review work as before.'],
    processing: ['Выжимка готовится. Можно продолжать пользоваться приложением и позже проверить результат. Повторно отправлять заметки не нужно.', 'Your digest is being prepared. You can keep using the app and check the result later. Your notes do not need to be sent again.'],
    ready: ['Выжимка сохранена. При повторном открытии заметки не отправляются.', 'Digest saved. Reopening it does not send your notes again.'],
    failed: ['Выжимка не создана. Сейчас модель недоступна или запрос не соответствует ограничениям. Запрос мог занять недельный слот. Срок следующего запроса показан отдельно.', 'The digest could not be created. The model is unavailable or the request does not meet the configured limits. The request may have used the weekly slot. The next available time is shown separately.'],
    uncertain: ['Ответ не подтверждён. Чтобы не передать заметки повторно, новая отправка автоматически не выполняется. Можно проверить, сохранился ли результат.', 'The response could not be confirmed. Another request is not sent automatically to avoid sending your notes again. You can check whether a result was saved.'],
    deleted: ['Текст выжимки удалён. Удаление не освобождает недельный слот.', 'Digest text deleted. Deletion does not release the weekly slot.'],
    empty: ['За этот период нет отметок. Отправлять нечего. Это ничего не говорит о том, как ты прожил это время.', 'There are no entries for this period. There is nothing to send. This says nothing about how you lived this time.'],
    error: ['Не удалось получить сведения. Проверь результат ещё раз. Повторного запроса к ИИ не будет.', 'Could not load the information. Check the result again. This will not send another AI request.'],
    delete: ['Удалить эту выжимку', 'Delete this digest'],
    deleteConfirm: ['Удалить сохранённый текст? Записи и заметки останутся. Удаление текста не сбрасывает недельный лимит.', 'Delete the saved text? Your entries and notes will remain. Deleting text does not reset the weekly limit.'],
    confirm: ['Да, удалить текст', 'Yes, delete text'],
    cancel: ['Оставить выжимку', 'Keep digest'],
    caveat: ['Это взгляд ИИ на записи, а не оценка тебя или всей твоей жизни. ИИ может ошибаться. Идеи необязательны и не являются медицинскими рекомендациями. Если день не отмечен, это не значит, что в нём ничего не было.', 'This is an AI view of your entries, not a judgment of you or your life. AI can be wrong. Ideas are optional and are not medical advice. An unlogged day does not mean nothing happened.'],
    example: ['Пример на вымышленных данных', 'Example with fictional data'],
    exampleInput: ['Вымышленные записи: прогулка в понедельник; благодарность за помощь в среду; в пятницу — заметка «Устал, взял паузу». Остальные дни не отмечены.', 'Fictional entries: a walk on Monday; gratitude for help on Wednesday; on Friday, “I was tired and took a break.” Other days are not logged.'],
    exampleText: ['В записях есть прогулка, благодарность за помощь и пауза после усталости. В этих моментах нашлось место движению, поддержке и отдыху. Если хочется, на следующей неделе можно оставить один вечер без новых рабочих задач. Про остальные дни данных нет.', 'The entries include a walk, gratitude for help and a break after feeling tired. Those moments made room for movement, support and rest. If you wish, leave one evening next week free of new work tasks. There is no information about the other days.'],
    archive: ['Сохранённые выжимки', 'Saved digests'],
    savedLanguage: ['Язык сохранённого текста:', 'Saved text language:'],
    period: ['Период:', 'Period:'],
    days: ['Период в днях', 'Period in days'], other: ['Другой', 'Other'], customDays: ['Число дней (1–30)', 'Number of days (1–30)'],
    topicLabel: ['Тема', 'Topic'], invalid: ['Укажи целое число от 1 до 30.', 'Enter a whole number from 1 to 30.'],
    limit: ['Один запрос на пользователя за каждые 7 суток, общий для всех тем и периодов. Ошибка или неподтверждённый ответ могут занять этот слот.', 'One request per user every 7 days, shared across all topics and periods. A failed or unconfirmed response may use this slot.'],
    next: ['Следующий запрос доступен:', 'Next request available:'],
    purpose: ['Цель запроса:', 'Request purpose:'],
    summary: ['Только выжимка', 'Summary only'], calm: ['Как меньше нервничать', 'How to feel less stressed'],
    'hard-days': ['Как облегчить сложные дни', 'How to make hard days easier'], rest: ['Как лучше отдыхать', 'How to rest better'],
    kindness: ['Как порадовать другого человека', 'How to brighten someone’s day'], 'self-support': ['Как поддержать себя', 'How to support yourself'], goal: ['Как продвинуть важное дело', 'How to move an important task forward']
  };
  window.KopilkaAiWeekly = { create({ api, locale, identity }) {
    const el = id => document.getElementById(id);
    const tr = key => strings[key][locale() === 'en' ? 1 : 0];
    let data = null, owner = null, generation = 0, readVersion = 0, busy = false, readBusy = false, message = '', confirmation = null, digestSignature = '';
    let days = 7, topic = 'summary';
    const topicIds = ['summary', 'calm', 'hard-days', 'rest', 'kindness', 'self-support', 'goal'];
    const root = el('aiWeekly');
    if (!root) return { sync() {}, reset() {}, load: async () => {} };
    function current(ticket, who) { return ticket === generation && who === identity() && who === owner; }
    function date(value) {
      const parsed = new Date(`${value}T12:00:00Z`);
      return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(parsed) : '';
    }
    function period(p) { return p ? `${date(p.start)} — ${date(p.end)} (${p.timezone})` : ''; }
    function status() {
      if (message) return tr(message);
      if (!data) return tr('loading');
      if (data.projectQuota?.allowed === false && data.quota?.allowed === true) return tr('projectFull');
      if (data.empty) return tr('empty');
      if (data.summary?.errorCode === 'EMPTY_WEEK' && data.summary.status === 'ready') return tr('empty');
      const s = data.summary?.status;
      if (['processing', 'ready', 'failed', 'uncertain', 'deleted', 'empty'].includes(s)) return tr(s);
      return data.available ? '' : tr('unavailable');
    }
    function addDigest(item, container) {
      const article = document.createElement('article'); article.className = 'ai-weekly-saved';
      const h = document.createElement('h4'); h.textContent = period(item.period || { start: item.periodStart, end: item.periodEnd, timezone: item.timezone }); article.append(h);
      const metadata = document.createElement('p'); metadata.textContent = `${tr(item.topic || 'summary')} · ${tr('days')}: ${item.days || 7}`; article.append(metadata);
      const language = document.createElement('p'); language.className = 'soft-note'; language.textContent = `${tr('savedLanguage')} ${item.locale === 'en' ? 'English' : 'Русский'}`; article.append(language);
      if (item.provider) {
        const provider = document.createElement('p'); provider.className = 'soft-note';
        provider.textContent = `${tr('savedProvider')} ${item.provider}${item.model ? ` · ${item.model}` : ''}`; article.append(provider);
      }
      const text = document.createElement('p'); text.className = 'ai-weekly-text'; text.textContent = item.text; article.append(text);
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.id = `ai-weekly-delete-${item.id}`; button.textContent = tr('delete'); button.disabled = busy; button.addEventListener('click', () => askDelete(item.id, button)); article.append(button);
      container.append(article);
    }
    function render() {
      root.hidden = !owner;
      for (const node of root.querySelectorAll('[data-ai-text]')) node.textContent = tr(node.dataset.aiText);
      const google = data?.provider === 'Google Gemini';
      const policy = root.querySelector('[data-ai-text="policy"]');
      policy.href = google ? 'https://ai.google.dev/gemini-api/terms' : 'https://openrouter.ai/privacy';
      policy.textContent = tr(google ? 'googlePolicy' : 'policy');
      el('aiWeeklyRetention').textContent = tr(google ? 'googleRetention' : 'retention');
      root.querySelector('[data-ai-text="consent"]').textContent = tr(google ? 'googleConsent' : 'consent');
      const disclosure = el('aiWeeklyDataDisclosure');
      disclosure.textContent = google ? tr('disclosure').replace(locale() === 'en' ? 'through OpenRouter to an external AI provider' : 'через OpenRouter внешнему ИИ-провайдеру', locale() === 'en' ? 'directly to Google Gemini' : 'напрямую Google Gemini') : tr('disclosure');
      let selected = el('aiWeeklyProvider');
      if (!selected) { selected = document.createElement('p'); selected.id = 'aiWeeklyProvider'; el('aiWeeklyConsentBox').before(selected); }
      selected.textContent = data?.provider ? `${tr('selected')} ${data.provider} · ${tr(data.paidMode ? 'paidMode' : 'freeMode')} · ${data.model}` : '';
      el('aiWeeklyPrivacy').href = locale() === 'en' ? '/privacy.en.html' : '/privacy.html';
      el('aiWeeklyPeriod').textContent = data ? `${tr('period')} ${period(data.period)}` : '';
      el('aiWeeklyStatus').textContent = status();
      el('aiWeeklyStatus').classList.toggle('error', Boolean(message === 'error'));
      const valid = Number.isInteger(days) && days >= 1 && days <= 30;
      const canCreate = valid && data?.available && data?.provider && data?.model && data?.quota?.allowed === true && data?.projectQuota?.allowed !== false && (!message || message === 'empty');
      el('aiWeeklyCustomBox').hidden = el('aiWeeklyDays').value !== 'other';
      el('aiWeeklySelectionError').textContent = valid ? '' : tr('invalid');
      for (const id of topicIds) {
        let option = el('aiWeeklyTopic').querySelector(`[value="${id}"]`);
        if (!option) { option = document.createElement('option'); option.value = id; el('aiWeeklyTopic').append(option); }
        option.textContent = data?.topics?.find(item => item.id === id)?.title || tr(id);
      }
      el('aiWeeklyTopic').value = topic;
      el('aiWeeklyPurpose').textContent = `${tr('purpose')} ${el('aiWeeklyTopic').selectedOptions[0].textContent}`;
      el('aiWeeklyQuota').textContent = '';
      if (data?.quota?.allowed === false && data.quota.nextAvailableAt) {
        const when = new Intl.DateTimeFormat(locale(), { dateStyle: 'long', timeStyle: 'long', timeZone: data.period.timezone }).format(new Date(data.quota.nextAvailableAt));
        el('aiWeeklyQuota').textContent = `${tr('next')} ${when} (${data.period.timezone})`;
      }
      if (data?.projectQuota?.allowed === false && data.projectQuota.nextAvailableAt) {
        const when = new Intl.DateTimeFormat(locale(), { dateStyle: 'long', timeStyle: 'long', timeZone: data.period.timezone }).format(new Date(data.projectQuota.nextAvailableAt));
        el('aiWeeklyQuota').textContent += `${el('aiWeeklyQuota').textContent ? ' · ' : ''}${tr('projectNext')} ${when} (${data.period.timezone})`;
      }
      el('aiWeeklyConsentBox').hidden = !canCreate;
      el('aiWeeklyCreate').disabled = busy || readBusy || !canCreate || !el('aiWeeklyConsent').checked;
      el('aiWeeklyRefresh').disabled = busy || readBusy || !valid;
      el('aiWeeklyCreate').hidden = !canCreate;
      el('aiWeeklyRefresh').hidden = message === 'auth';
      el('aiWeeklyRecover').hidden = message !== 'auth';
      el('aiWeeklyRecover').disabled = busy || readBusy;
      for (const id of ['aiWeeklyDays', 'aiWeeklyCustomDays', 'aiWeeklyTopic']) el(id).disabled = busy;
      if (confirmation) el('aiWeeklyDeleteQuestion').textContent = tr('deleteConfirm');
      const ready = data?.summary?.status === 'ready' && data.summary.errorCode !== 'EMPTY_WEEK' && data.summary.text ? { ...data.summary, period: data.summary.period || data.period } : null;
      const archive = (data?.archive || []).filter(item => item.id !== data.summary?.id && item.text && item.errorCode !== 'EMPTY_WEEK');
      el('aiWeeklyArchive').hidden = !archive.length;
      const signature = JSON.stringify([locale(), ready, archive]);
      if (signature !== digestSignature) {
        const focusedId = document.activeElement?.id;
        const restore = focusedId?.startsWith('ai-weekly-delete-');
        el('aiWeeklyResult').replaceChildren();
        if (ready) addDigest(ready, el('aiWeeklyResult'));
        el('aiWeeklyArchiveItems').replaceChildren();
        for (const item of archive) addDigest(item, el('aiWeeklyArchiveItems'));
        digestSignature = signature;
        if (restore) (el(focusedId) || el('aiWeeklyHeading')).focus({ preventScroll: true });
      }
      for (const button of root.querySelectorAll('.ai-weekly-saved button')) button.disabled = busy;
      el('aiWeeklyResult').setAttribute('aria-busy', String(busy));
    }
    async function load() {
      if (!owner || busy || !Number.isInteger(days) || days < 1 || days > 30) return;
      const ticket = generation, who = owner, read = ++readVersion;
      readBusy = true; render();
      try {
        const next = await api(`/api/ai-weekly-summary?days=${days}&topic=${encodeURIComponent(topic)}`); // Safe GET may use existing sign-in recovery; never replay POST.
        if (!current(ticket, who) || read !== readVersion) return;
        if (data?.period?.key !== next.period.key || ['consentVersion', 'provider', 'model', 'paidMode'].some(key => data?.[key] !== next[key])) el('aiWeeklyConsent').checked = false;
        data = next; message = '';
      } catch (error) { if (current(ticket, who) && read === readVersion) { message = error.status === 401 ? 'auth' : 'error'; el('aiWeeklyConsent').checked = false; } }
      finally { if (current(ticket, who) && read === readVersion) { readBusy = false; render(); } }
    }
    async function start() {
      if (busy || readBusy || !data?.available || !data.provider || !data.model || data?.projectQuota?.allowed === false || data?.quota?.allowed !== true || !el('aiWeeklyConsent').checked) return;
      const ticket = generation, who = owner;
      let projectRejection = null;
      busy = true; message = 'processing'; render();
      try {
        const next = await api('/api/ai-weekly-summary', { method: 'POST', skipSessionRenewal: true, body: JSON.stringify({ consent: true, consentVersion: data.consentVersion, periodKey: data.period.key, days, topic }) });
        if (current(ticket, who)) { data = next; message = ''; }
      } catch (error) {
        if (current(ticket, who)) {
          // Only this exact server code may claim the weekly slot was untouched.
          const projectFull = error.status === 429 && error.data?.code === 'AI_PROJECT_QUOTA_EXCEEDED';
          message = error.status === 401 ? 'auth' : projectFull ? 'projectFull' : error.status ? 'failed' : 'uncertain';
          if (projectFull) {
            projectRejection = { allowed: false, nextAvailableAt: error.data.nextAvailableAt || null };
            data.projectQuota = projectRejection;
          }
        }
      }
      finally {
        if (current(ticket, who)) {
          busy = false; el('aiWeeklyConsent').checked = false; render();
          if (message !== 'auth' && !data?.empty) await load();
          // A metadata-only GET cannot estimate this selection's input budget.
          if (current(ticket, who) && projectRejection && data) { data.projectQuota = projectRejection; message = 'projectFull'; render(); }
        }
      }
    }
    function askDelete(id, button) {
      if (busy || confirmation) return;
      const box = el('aiWeeklyDeleteConfirm'); box.hidden = false;
      el('aiWeeklyDeleteQuestion').textContent = tr('deleteConfirm');
      confirmation = { id, button }; el('aiWeeklyDeleteCancel').focus();
    }
    function cancelDelete() {
      const button = el(`ai-weekly-delete-${confirmation?.id}`); confirmation = null; el('aiWeeklyDeleteConfirm').hidden = true;
      (button || el('aiWeeklyHeading')).focus();
    }
    async function remove() {
      if (!confirmation || busy) return;
      const id = confirmation.id, ticket = generation, who = owner;
      confirmation = null; el('aiWeeklyDeleteConfirm').hidden = true; busy = true; render();
      try {
        await api(`/api/ai-weekly-summary/${encodeURIComponent(id)}`, { method: 'DELETE', skipSessionRenewal: true, body: JSON.stringify({ confirm: true }) });
        if (current(ticket, who)) { data = null; message = 'deleted'; }
      } catch (error) { if (current(ticket, who)) { message = error.status === 401 ? 'auth' : 'error'; el('aiWeeklyConsent').checked = false; } }
      finally { if (current(ticket, who)) { busy = false; render(); el('aiWeeklyHeading').focus(); if (message !== 'auth' && !data?.empty) await load(); } }
    }
    function reset() {
      generation++; readVersion++; owner = null; data = null; busy = false; readBusy = false; message = ''; confirmation = null;
      days = 7; topic = 'summary'; el('aiWeeklyDays').value = '7'; el('aiWeeklyCustomDays').value = '7';
      el('aiWeeklyConsent').checked = false; el('aiWeeklyDeleteConfirm').hidden = true; render();
    }
    function sync() {
      const who = identity();
      if (who !== owner) { reset(); owner = who; }
      render();
    }
    function changeSelection() {
      days = Number(el('aiWeeklyDays').value === 'other' ? el('aiWeeklyCustomDays').value : el('aiWeeklyDays').value);
      topic = el('aiWeeklyTopic').value;
      readVersion++; readBusy = false; data = null; message = ''; el('aiWeeklyConsent').checked = false;
      render(); void load();
    }
    el('aiWeeklyDays').addEventListener('change', changeSelection);
    el('aiWeeklyCustomDays').addEventListener('input', changeSelection);
    el('aiWeeklyTopic').addEventListener('change', changeSelection);
    el('aiWeeklyConsent').addEventListener('change', render);
    el('aiWeeklyCreate').addEventListener('click', start);
    el('aiWeeklyRefresh').addEventListener('click', load);
    el('aiWeeklyRecover').addEventListener('click', load);
    el('aiWeeklyDeleteCancel').addEventListener('click', cancelDelete);
    el('aiWeeklyDeleteYes').addEventListener('click', remove);
    root.addEventListener('keydown', e => { if (e.key === 'Escape' && confirmation) { e.preventDefault(); cancelDelete(); } });
    render();
    return { sync, reset, load };
  } };
})();
