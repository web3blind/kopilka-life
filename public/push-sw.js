/* Push delivery and network-first page navigation. No offline cache or API interception. */
self.addEventListener('activate', event => {
  // Avoid navigation preload: OAuth /api redirects carry one-time intents and
  // must never receive a speculative duplicate navigation request.
  if (self.registration.navigationPreload) event.waitUntil(self.registration.navigationPreload.disable());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.mode !== 'navigate' || request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    try {
      return await fetch(request);
    } catch (_) {
      return new Response('Нет соединения. Проверьте интернет и обновите страницу.', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }
  })());
});
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch (_) { /* display a generic reminder */ }
  const title = typeof data.title === 'string' ? data.title.slice(0, 100) : 'Копилка жизни';
  const body = typeof data.body === 'string' ? data.body.slice(0, 500) : 'Можно заглянуть в Копилку жизни.';
  event.waitUntil(self.registration.showNotification(title, { body, tag: 'kopilka-evening', data: { url: '/' } }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL('/', self.location.origin).href;
    // Opening the URL is observable even if a site tab is already focused. A
    // bare focus() on that tab looked like a dead notification click.
    let opened;
    try { opened = await self.clients.openWindow(url); } catch (_) { /* use a normal tab instead */ }
    if (opened) {
      try { await opened.focus(); } catch (_) { /* openWindow still succeeded */ }
      return;
    }
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Never focus a VK Mini App iframe as a fallback for a website notification.
    const existing = list.find(client => {
      const location = new URL(client.url);
      return location.origin === self.location.origin && !location.searchParams.has('vk_app_id');
    });
    if (existing) {
      let destination = existing;
      try { destination = await existing.navigate(url) || existing; } catch (_) { /* still focus the tab */ }
      await destination.focus();
    }
  })());
});
