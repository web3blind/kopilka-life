/* Early startup guard: independent of app.js/i18n, never an identity proof. */
(function () {
  'use strict';
  var version = '20261007-startup3';
  var allowed = ['guard-loaded', 'bridge-loaded', 'app-loaded', 'app-executed', 'i18n-loaded', 'documents-loaded', 'scene-loaded', 'script-failed', 'runtime-error', 'init-native-recovery', 'ui-visible', 'startup-timeout', 'bridge-webview', 'bridge-web', 'init-result', 'init-failed'];
  var seen = {}, count = 0, nativeSent = false, finished = false, failed = false;
  var isVkLaunch = /(?:[?&#])vk_app_id=/.test(window.location.search + window.location.hash);
  function log(event) {
    if (allowed.indexOf(event) < 0 || seen[event] || count >= 16) return;
    seen[event] = true; count++;
    try {
      var payload = JSON.stringify({event: 'startup_' + event, details: '', platform: isVkLaunch ? 'vk' : 'web', version: version});
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
  function english() {
    try { return /(?:[?&])lang=en(?:&|$)/.test(window.location.search) || window.localStorage.getItem('kopilkaLocale') === 'en'; }
    catch (_) { return false; }
  }
  function nativeRecovery() {
    if (!isVkLaunch || nativeSent) return;
    try {
      var bridge = window.vkBridge;
      // If the SDK saw the native environment initially, leave it in charge.
      if (!bridge || typeof bridge.isWebView !== 'function' || bridge.isWebView() !== false) return;
      var handlers = window.webkit && window.webkit.messageHandlers;
      var handler = handlers && handlers.VKWebAppInit;
      if (!handlers || !handlers.VKWebAppClose || !handler || typeof handler.postMessage !== 'function') return;
      handler.postMessage({request_id: 'startup_native_' + Date.now()});
      nativeSent = true; log('init-native-recovery');
    } catch (_) { /* bounded retries, no vendor/global handler replacement */ }
  }
  function bridgeEvent(event) {
    var type = event && event.detail && event.detail.type;
    if (type === 'VKWebAppInitResult') log('init-result');
    if (type === 'VKWebAppInitFailed') log('init-failed');
  }
  window.addEventListener('VKWebAppEvent', bridgeEvent);
  document.addEventListener('VKWebAppEvent', bridgeEvent);
  window.KopilkaStartup = {
    mark: function (event) {
      log(event);
      if (event === 'bridge-loaded') {
        try {
          var bridge = window.vkBridge;
          log(bridge && typeof bridge.isWebView === 'function' && bridge.isWebView() ? 'bridge-webview' : 'bridge-web');
          if (bridge && typeof bridge.subscribe === 'function') bridge.subscribe(bridgeEvent);
        } catch (_) { /* diagnostics only */ }
        nativeRecovery();
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
  [0, 100, 300, 750, 1500, 2500, 4000, 8000].forEach(function (delay) { setTimeout(nativeRecovery, delay); });
  setTimeout(function () { refresh(); if (!finished) { log('startup-timeout'); fail(); } }, 10000);
  log('guard-loaded');
})();
