'use strict';
(() => {
  // Navigation hints only: never carry launch signatures, sessions or return URLs.
  const documents = new Set(['/privacy.html', '/terms.html']);
  const destinations = Object.freeze({
    web: new URL('/', window.location.origin).href,
    vk: 'https://vk.ru/app54723764',
    telegram: 'https://t.me/HarborLifeBot?startapp'
  });
  const isDocument = documents.has(window.location.pathname);
  const requested = new URLSearchParams(window.location.search).getAll('source');
  const documentSurface = requested.length === 1 && Object.hasOwn(destinations, requested[0]) ? requested[0] : 'web';
  const surface = () => isDocument ? documentSurface : (typeof supportSurface === 'function' ? supportSurface() : 'web');

  function refresh() {
    const current = surface();
    document.querySelectorAll('a[href]').forEach((link) => {
      const url = new URL(link.getAttribute('href'), window.location.href);
      if (url.origin !== window.location.origin || !documents.has(url.pathname)) return;
      link.setAttribute('href', `${url.pathname}?source=${current}`);
    });
    const back = document.querySelector('[data-document-return]');
    if (back) {
      back.href = destinations[current];
      // VK and Telegram may display documents in a WebView or iframe. Reopen
      // the canonical Mini App at top level rather than nesting a platform site.
      back.target = current === 'web' ? '_self' : '_top';
    }
  }
  window.KopilkaDocuments = Object.freeze({ refresh });
  refresh();
  // Resolve the current launch on interaction as well (including keyboard,
  // middle-click and context-menu opening), not the user's linked accounts.
  if (!isDocument) {
    for (const event of ['click', 'auxclick', 'contextmenu']) {
      document.addEventListener(event, refresh, true);
    }
  }
})();
