/* Early startup guard: independent of app.js/i18n, never an identity proof. */
(function () {
  'use strict';
  var version = '20261105-startup1';
  // Ephemeral document correlation only; never storage, identity or launch proof.
  var boot = 'unavailable', started = Date.now(), sdk = 'unknown';
  try {
    var random = new Uint32Array(2);
    window.crypto.getRandomValues(random);
    boot = random[0].toString(16) + '-' + random[1].toString(16);
  } catch (_) { /* no identifying fallback */ }
  function rootState(id) {
    var node = document.getElementById(id);
    return !node ? 'absent' : (node.hidden ? 'hidden' : 'unhidden');
  }
  function evidence() {
    var handlers = window.webkit && window.webkit.messageHandlers;
    var init = handlers && handlers.VKWebAppInit;
    var ready = document.readyState;
    return 'boot=' + boot + ';seq=' + count + ';ms=' + Math.min(60000, Math.max(0, Date.now() - started))
      + ';ready=' + (['loading', 'interactive', 'complete'].indexOf(ready) < 0 ? 'unknown' : ready)
      + ';startup=' + rootState('startupScreen') + ';app=' + rootState('appShell') + ';login=' + rootState('loginScreen')
      + ';init=' + (init && typeof init.postMessage === 'function' ? '1' : '0')
      + ';close=' + (handlers && handlers.VKWebAppClose ? '1' : '0') + ';sdk=' + sdk;
  }
  var allowed = ['guard-loaded', 'bridge-loaded', 'app-loaded', 'app-executed', 'i18n-loaded', 'documents-loaded', 'scene-loaded', 'script-failed', 'runtime-error', 'init-native-recovery', 'ui-visible', 'startup-timeout', 'bridge-webview', 'bridge-web', 'init-result', 'init-failed'];
  var seen = {}, count = 0, nativeSent = false, finished = false, failed = false;
  var isVkLaunch = /(?:[?&#])vk_app_id=/.test(window.location.search + window.location.hash);
  function log(event) {
    if (allowed.indexOf(event) < 0 || seen[event] || count >= 16) return;
    seen[event] = true; count++;
    try {
      var payload = JSON.stringify({event: 'startup_' + event, details: evidence(), platform: isVkLaunch ? 'vk' : 'web', version: version});
      if (typeof window.fetch === 'function') window.fetch('/api/client-log', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: payload,
        mode: 'same-origin', credentials: 'omit', referrerPolicy: 'no-referrer',
        cache: 'no-store', keepalive: true
      }).catch(function () {});
    } catch (_) { /* no raw URLs, launch params, user text or exception messages */ }
  }
  function visibleUI() {
    var app = document.getElementById('appShell'), login = document.getElementById('loginScreen');
    return Boolean((app && !app.hidden) || (login && !login.hidden));
  }
  function refresh() {
    var screen = document.getElementById('startupScreen');
    // Localize as soon as parsing creates the shell; DOMContentLoaded can itself
    // be delayed by secondary scripts. Avoid repeated text mutations.
    if (screen && !screen.hidden) {
      var copy = {
        startupHeading: english() ? 'Life Harbor' : 'Копилка жизни',
        startupMessage: failed
          ? (english() ? 'The app could not finish loading. Try loading it again.' : 'Не удалось завершить загрузку. Попробуй загрузить приложение ещё раз.')
          : (english() ? 'Loading the app…' : 'Загружаем приложение…'),
        startupReload: english() ? 'Load again' : 'Загрузить ещё раз'
      };
      Object.keys(copy).forEach(function (id) {
        var node = document.getElementById(id);
        if (node && node.textContent !== copy[id]) node.textContent = copy[id];
      });
      var retry = document.getElementById('startupReload');
      if (retry && retry.hidden !== !failed) retry.hidden = !failed;
    }
    if (screen && !screen.hidden && visibleUI()) { screen.hidden = true; finished = true; log('ui-visible'); }
  }
  function fail() {
    refresh();
    if (finished) return;
    failed = true;
    refresh();
  }
  function initialLocale() {
    var query = new URLSearchParams(window.location.search);
    var explicit = query.get('lang');
    if (explicit === 'ru' || explicit === 'en') return explicit;
    var cached = '';
    try { cached = window.localStorage.getItem('kopilkaLocale'); } catch (_) { /* presentation only */ }
    if (cached === 'ru' || cached === 'en') return cached;
    // Launch language is a presentation hint, never identity or authority to read data.
    return query.get('vk_language') === 'en' ? 'en' : 'ru';
  }
  function english() { return initialLocale() === 'en'; }
  // Document-local ownership: a pending web packet is not a native attempt.
  // Any native invocation may deliver even on throw/rejection/no ACK.
  var initPromise, settleInit, webRequested = false, probePromise, subscribed = false;
  var readinessTimer, expired = false, deadline = started + 30000;
  function stopReadiness() {
    if (readinessTimer != null) clearTimeout(readinessTimer);
    readinessTimer = null;
  }
  function expire() {
    expired = true;
    stopReadiness();
    if (settleInit) settleInit();
  }
  function retain(promise) {
    Promise.resolve(promise).then(settleInit, function () { settleInit(); });
  }
  function liveInit() {
    var handlers = window.webkit && window.webkit.messageHandlers;
    var handler = handlers && handlers.VKWebAppInit;
    return handlers && handlers.VKWebAppClose && handler && typeof handler.postMessage === 'function' ? handler : null;
  }
  function directInit(handler) {
    if (nativeSent || expired || Date.now() > deadline) return;
    nativeSent = true; stopReadiness(); // Reserve BEFORE invoking host code.
    log('init-native-recovery');
    try { handler.postMessage({request_id: 'startup_native_' + boot}); }
    catch (_) { /* ambiguous delivery: never retry */ }
    settleInit();
  }
  function checkInit() {
    if (!isVkLaunch || nativeSent || expired || probePromise || Date.now() > deadline) return;
    var bridge = window.vkBridge;
    if (!bridge || typeof bridge.send !== 'function' || typeof bridge.isWebView !== 'function') return;
    try {
      if (bridge.isWebView() === false) {
        if (!webRequested) {
          webRequested = true;
          try { retain(bridge.send('VKWebAppInit')); }
          catch (_) { settleInit(); }
        }
        var handler = liveInit();
        if (handler) directInit(handler);
        return;
      }
      // Pinned SDK 3.0.2 probes its captured handler map without discovery I/O.
      // Do not send a forever-pending native SDK request for a missing handler.
      if (typeof bridge.supportsAsync !== 'function') return;
      probePromise = Promise.resolve().then(function () {
        return bridge.supportsAsync('VKWebAppInit');
      }).then(function (supported) {
        if (nativeSent || expired || Date.now() > deadline) return;
        if (supported === true) {
          nativeSent = true; stopReadiness();
          try { retain(bridge.send('VKWebAppInit')); }
          catch (_) { settleInit(); }
        } else {
          var handler = liveInit();
          if (handler) directInit(handler);
        }
      }).catch(function () { /* observation failure is not native delivery */ }).then(function () {
        probePromise = null;
      });
    } catch (_) { /* environment observation must not block application auth */ }
  }
  function initVkBridge() {
    if (!initPromise) initPromise = new Promise(function (resolve) { settleInit = resolve; });
    if (!isVkLaunch || expired) settleInit();
    else if (Date.now() > deadline) expire();
    else checkInit();
    return initPromise;
  }
  function readinessTick() {
    readinessTimer = null;
    if (nativeSent || expired || !isVkLaunch) return;
    if (Date.now() > deadline) { expire(); return; }
    initVkBridge();
    if (nativeSent) return;
    // The final task allows already-ready support microtasks, never waits on an
    // unsettled vendor promise beyond the deadline or leaves a polling loop.
    readinessTimer = setTimeout(Date.now() >= deadline ? expire : readinessTick,
      Math.min(250, Math.max(0, deadline - Date.now())));
  }
  function bridgeEvent(event) {
    var type = event && event.detail && event.detail.type;
    if (type === 'VKWebAppInitResult') log('init-result');
    if (type === 'VKWebAppInitFailed') log('init-failed');
  }
  window.addEventListener('VKWebAppEvent', bridgeEvent);
  document.addEventListener('VKWebAppEvent', bridgeEvent);
  window.KopilkaStartup = {
    locale: initialLocale,
    initVkBridge: initVkBridge,
    mark: function (event) {
      log(event);
      if (event === 'bridge-loaded') {
        try {
          var bridge = window.vkBridge;
          sdk = bridge && typeof bridge.isWebView === 'function' ? (bridge.isWebView() ? 'webview' : 'web') : 'unknown';
          log(sdk === 'webview' ? 'bridge-webview' : 'bridge-web');
          if (!subscribed && bridge && typeof bridge.subscribe === 'function') {
            subscribed = true;
            bridge.subscribe(bridgeEvent);
          }
        } catch (_) { /* diagnostics only */ }
        initVkBridge();
      }
      refresh();
    }
  };
  window.addEventListener('error', function (event) {
    var target = event.target;
    var script = target && target.tagName === 'SCRIPT';
    log(script ? 'script-failed' : 'runtime-error');
    fail();
  }, true);
  window.addEventListener('unhandledrejection', function () { log('runtime-error'); fail(); });
  document.addEventListener('DOMContentLoaded', refresh);
  if (typeof MutationObserver === 'function') new MutationObserver(refresh).observe(document.documentElement, {subtree: true, childList: true, attributes: true, attributeFilter: ['hidden']});
  // DOM visibility is not native readiness. Keep bounded checks alive even after
  // the authenticated HTML has appeared; never alter the vendor transport/auth.
  if (isVkLaunch) readinessTimer = setTimeout(readinessTick, 0);
  setTimeout(function () { refresh(); if (!finished) { log('startup-timeout'); fail(); } }, 10000);
  log('guard-loaded');
})();
