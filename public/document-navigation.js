'use strict';
(() => {
  const documents = new Set(['/privacy.html', '/terms.html']);
  const isDocument = documents.has(window.location.pathname);
  function documentPath(link) {
    try {
      const url = new URL(link.getAttribute('href'), window.location.href);
      return url.origin === window.location.origin && documents.has(url.pathname) ? url.pathname : null;
    } catch { return null; }
  }

  // Public standalone URLs still work, including old, allowlisted source hints.
  // The embedded reader never forwards a query, launch signature or return URL.
  function refresh() {
    const sources = new URLSearchParams(window.location.search).getAll('source');
    const destinations = { web: new URL('/', window.location.origin).href,
      vk: 'https://vk.ru/app54723764', telegram: 'https://t.me/HarborLifeBot?startapp' };
    const source = isDocument && sources.length === 1 && Object.hasOwn(destinations, sources[0]) ? sources[0] : 'web';
    document.querySelectorAll('a[href]').forEach((link) => {
      const path = documentPath(link);
      if (path) link.setAttribute('href', isDocument ? `${path}?source=${source}` : path);
    });
    if (isDocument) {
      const back = document.querySelector('[data-document-return]');
      if (back) {
        back.href = destinations[source];
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

  async function load(path) {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), 12000);
    title.textContent = path === '/privacy.html' ? 'Политика конфиденциальности' : 'Условия использования';
    content.setAttribute('aria-busy', 'true');
    content.textContent = 'Загружаем документ…';
    content.scrollTop = 0;
    title.focus({ preventScroll: true });
    try {
      const response = await fetch(path, { signal: controller.signal, credentials: 'omit',
        referrerPolicy: 'no-referrer', redirect: 'error' });
      if (!response.ok) throw new Error('Document unavailable');
      const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
      const section = parsed.querySelector('main > section');
      if (!section?.querySelector('h1')) throw new Error('Invalid document');
      // Only the canonical legal copy is imported, never its scripts or page shell.
      section.querySelectorAll('script, style, iframe, object, embed, link, base, form').forEach((node) => node.remove());
      section.querySelectorAll('*').forEach((node) => {
        for (const attr of [...node.attributes]) {
          if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
        }
      });
      const back = section.querySelector('[data-document-return]');
      if (back) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.textContent = back.textContent;
        button.addEventListener('click', close);
        back.replaceWith(button);
      }
      section.querySelectorAll('a[href]').forEach((link) => {
        const path = documentPath(link);
        // Legal documents currently contain only cross-document links. Do not
        // silently turn a future arbitrary link into an app exit or URL forwarder.
        if (path) link.setAttribute('href', path);
        else link.removeAttribute('href');
        link.removeAttribute('target');
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
      message.textContent = 'Не удалось загрузить документ. Попробуйте ещё раз.';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Повторить загрузку';
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
