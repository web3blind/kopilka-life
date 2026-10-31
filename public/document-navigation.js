'use strict';
(() => {
  const paths = Object.freeze({
    '/privacy.html': { ru: '/privacy.html', en: '/privacy.en.html' },
    '/terms.html': { ru: '/terms.html', en: '/terms.en.html' },
    '/about': { ru: '/about', en: '/en/about' },
  });
  const documents = new Set(Object.values(paths).flatMap((locales) => Object.values(locales)));
  const isDocument = documents.has(window.location.pathname);
  const query = new URLSearchParams(window.location.search);
  const language = () => document.documentElement.lang === 'en' || (isDocument && query.getAll('lang').length === 1 && query.get('lang') === 'en') ? 'en' : 'ru';
  const canonicalPath = (path) => Object.keys(paths).find((key) => Object.values(paths[key]).includes(path));
  const localizedPath = (path) => paths[canonicalPath(path)][language()];
  const localeQuery = () => language() === 'en' ? '&lang=en' : '';
  const englishText = { legalClose: 'Close document', legalPrivacy: 'Privacy Policy', legalTerms: 'Terms of Use',
    legalLoading: 'Loading document…', legalReturn: 'Return to the app', legalLoadFailed: 'Could not load the document. Please try again.', legalRetry: 'Retry loading' };
  const text = (key, fallback) => window.KopilkaI18n?.t(language(), key) || (language() === 'en' && englishText[key]) || fallback;
  function documentPath(link) {
    try {
      const url = new URL(link.getAttribute('href'), window.location.href);
      return url.origin === window.location.origin && documents.has(url.pathname) ? url.pathname : null;
    } catch { return null; }
  }

  // Public standalone URLs still work, including old, allowlisted source hints.
  // The embedded reader never forwards a query, launch signature or return URL.
  function refresh() {
    document.querySelectorAll('[data-document-close]').forEach((button) => { button.textContent = text('legalClose', 'Закрыть документ'); });
    const sources = new URLSearchParams(window.location.search).getAll('source');
    const destinations = { web: new URL('/', window.location.origin).href,
      vk: 'https://vk.ru/app54723764', telegram: 'https://t.me/HarborLifeBot?startapp' };
    const source = isDocument && sources.length === 1 && Object.hasOwn(destinations, sources[0]) ? sources[0] : 'web';
    if (isDocument && window.location.pathname !== localizedPath(window.location.pathname)) {
      window.location.replace(`${localizedPath(window.location.pathname)}?source=${source}${localeQuery()}`);
      return;
    }
    document.querySelectorAll('a[href]').forEach((link) => {
      const path = documentPath(link);
      if (path) link.setAttribute('href', isDocument ? `${localizedPath(path)}?source=${source}${localeQuery()}` : path);
    });
    if (isDocument) {
      const back = document.querySelector('[data-document-return]');
      if (back) {
        back.href = destinations[source] + (source === 'web' && language() === 'en' ? '?lang=en' : '');
        back.target = source === 'web' ? '_self' : '_top';
      }
    }
  }
  window.KopilkaDocuments = Object.freeze({ refresh });
  refresh();
  if (isDocument) return;

  let dialog, content, title, opener, request, scrollPosition, scrollRestoration;
  let closing = false;
  const historyKey = 'kopilkaLegalDocument';
  const historyOwner = Math.random().toString(36).slice(2);
  const ownsEntry = (state) => state?.[historyKey]?.owner === historyOwner;

  function createDialog() {
    dialog = document.createElement('dialog');
    dialog.className = 'document-dialog';
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'document-view-title');
    dialog.innerHTML = '<div class="document-toolbar"><span id="document-view-title" tabindex="-1">Документ</span><button type="button" class="secondary" data-document-close>Закрыть документ</button></div><div class="document-content" aria-live="polite"></div>';
    document.body.append(dialog);
    title = dialog.querySelector('#document-view-title');
    content = dialog.querySelector('.document-content');
    dialog.querySelector('[data-document-close]').addEventListener('click', close);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
    dialog.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const stops = [...dialog.querySelectorAll('button:not([disabled]), a[href]')];
      const first = stops[0], last = stops[stops.length - 1];
      if (event.shiftKey && (document.activeElement === first || !stops.includes(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !stops.includes(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    });
  }

  // Only published public destinations belong in the imported reader. Resolve
  // against the origin, not the signed launch URL; never carry query/fragment data.
  function readerLink(link) {
    const raw = link.getAttribute('href');
    if (link.hasAttribute('download') || !raw || /[\u0000-\u0020\u007f]/.test(raw)) return null;
    try {
      const url = new URL(raw, window.location.origin);
      if (url.username || url.password) return null;
      if (url.origin === window.location.origin) {
        if (documents.has(url.pathname)) return url.pathname;
        return ['/partners', '/en/partners', '/gratitude-journal', '/en/gratitude-journal'].includes(url.pathname) ? url.pathname : null;
      }
      if (url.protocol === 'mailto:') {
        return /^mailto:[^\s@?&#]+@[^\s@?&#]+\.[^\s@?&#]+$/.test(raw) ? raw : null;
      }
      const publicOrigins = ['https://ai.google.dev', 'https://openrouter.ai', 'https://db-ip.com',
        'https://vk.ru', 'https://vk.com', 'https://t.me'];
      return url.protocol === 'https:' && publicOrigins.includes(url.origin) ? url.origin + url.pathname : null;
    } catch { return null; }
  }

  async function load(path) {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), 12000);
    const documentLanguage = language();
    const fetchPath = localizedPath(path);
    const about = canonicalPath(path) === '/about';
    title.textContent = about ? (language() === 'en' ? 'About' : 'О сервисе') : canonicalPath(path) === '/privacy.html' ? text('legalPrivacy', 'Политика конфиденциальности') : text('legalTerms', 'Условия использования');
    dialog.querySelector('[data-document-close]').textContent = text('legalClose', 'Закрыть документ');
    content.setAttribute('aria-busy', 'true');
    content.textContent = text('legalLoading', 'Загружаем документ…');
    content.scrollTop = 0;
    title.focus({ preventScroll: true });
    try {
      const response = await fetch(fetchPath + (documentLanguage === 'en' ? '?lang=en' : ''), { signal: controller.signal, credentials: 'omit',
        referrerPolicy: 'no-referrer', redirect: 'error' });
      if (!response.ok) throw new Error('Document unavailable');
      const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
      const section = parsed.querySelector(about ? 'main' : 'main > section');
      if (!section?.querySelector('h1')) throw new Error('Invalid document');
      // Import only public copy, never its scripts, header or page shell.
      section.querySelectorAll('script, style, iframe, object, embed, link, base, form').forEach((node) => node.remove());
      section.querySelectorAll('*').forEach((node) => {
        for (const attr of [...node.attributes]) {
          if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
        }
      });
      section.lang = documentLanguage;
      section.querySelectorAll(about ? 'a[href="/"], a[href="/?lang=en"]' : '[data-document-return]').forEach((back) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.lang = documentLanguage;
        button.textContent = text('legalReturn', back.textContent);
        button.addEventListener('click', close);
        back.replaceWith(button);
      });
      section.querySelectorAll('a[href]').forEach((link) => {
        const href = readerLink(link);
        link.removeAttribute('ping');
        link.removeAttribute('download');
        link.removeAttribute('target');
        if (!href) { link.removeAttribute('href'); return; }
        const path = documents.has(href) && href;
        link.setAttribute('href', path ? localizedPath(path) : href);
        if (!path) {
          // Public destinations must not replace the owning Mini App or receive
          // its launch URL, credentials, or an opener into the private app.
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.referrerPolicy = 'no-referrer';
        }
      });
      if (request !== controller || !dialog.open) return;
      content.replaceChildren(section);
      const heading = content.querySelector('h1');
      heading.tabIndex = -1;
      // Do not steal focus if the reader has moved to the persistent Close button.
      if (document.activeElement === title) heading.focus({ preventScroll: true });
    } catch {
      if (request !== controller || !dialog.open) return;
      const message = document.createElement('p');
      message.setAttribute('role', 'alert');
      message.textContent = text('legalLoadFailed', 'Не удалось загрузить документ. Попробуйте ещё раз.');
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = text('legalRetry', 'Повторить загрузку');
      retry.addEventListener('click', () => load(path));
      content.replaceChildren(message, retry);
    } finally {
      clearTimeout(timeout);
      if (request === controller) content.removeAttribute('aria-busy');
    }
  }

  function open(path, trigger, fromHistory = false) {
    if (closing) return;
    if (!dialog) createDialog();
    if (!dialog.open) {
      opener = trigger || opener || document.activeElement;
      scrollPosition = { left: window.scrollX, top: window.scrollY, behavior: 'instant' };
      scrollRestoration = history.scrollRestoration;
      history.scrollRestoration = 'manual';
      document.documentElement.classList.toggle('document-view-gutter', window.innerWidth > document.documentElement.clientWidth);
      document.documentElement.classList.add('document-view-open');
      dialog.showModal();
      if (!fromHistory) history.pushState({ ...history.state, [historyKey]: { owner: historyOwner, path } }, '');
    } else if (!fromHistory) {
      // One history entry per reader, not per legal page: Back always returns to app.
      history.replaceState({ ...history.state, [historyKey]: { owner: historyOwner, path } }, '');
    }
    load(path);
  }

  function hide() {
    request?.abort();
    request = null;
    dialog.close();
    document.documentElement.classList.remove('document-view-open', 'document-view-gutter');
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    window.scrollTo(scrollPosition);
    history.scrollRestoration = scrollRestoration;
    closing = false;
  }

  function close() {
    if (!dialog?.open || closing) return;
    if (ownsEntry(history.state)) {
      closing = true;
      history.back();
    } else hide();
  }

  window.addEventListener('popstate', (event) => {
    const entry = ownsEntry(event.state) && event.state[historyKey];
    if (entry && documents.has(entry.path)) open(entry.path, null, true);
    else if (dialog?.open) hide();
  });
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href]');
    if (!link) return;
    const path = documentPath(link);
    if (!path) return;
    event.preventDefault();
    open(path, link);
  }, true);
})();
