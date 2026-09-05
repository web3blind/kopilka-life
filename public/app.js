const I18N = window.KopilkaI18n;
const CLIENT_VERSION = '20260905-platform-auth-link-proof';
const storage = {
  get(key) { try { return window.localStorage?.getItem(key) || ''; } catch (_) { return ''; } },
  set(key, value) { try { window.localStorage?.setItem(key, value); } catch (_) { /* storage may be unavailable in some WebViews */ } },
  remove(key) { try { window.localStorage?.removeItem(key); } catch (_) { /* storage may be unavailable in some WebViews */ } }
};
const locale = () => I18N.normalizeLocale(state.user?.locale || storage.get('kopilkaLocale') || 'ru');
const L = (key, params) => I18N.t(locale(), key, params);

const state = { token: storage.get('kopilkaToken') || '', user: null, summary: null, week: null, history: null, historyDate: '', historyEditingId: null, currentContract: null, product: null, profile: null, artifacts: [], artifactQueue: [], support: null, activeTab: 'today', busy: false, publicReadOnly: false, publicStatus: '', pendingMerge: null, recoveryNotice: null, artifactReturnFocus: null, quickActionReturnType: '', sessionRenewalPromise: null, sessionRenewalBlocked: false, vkBridgeLaunchParams: '', vkOAuthWindow: null, vkOAuthChannel: '', vkOAuthAction: '', vkOAuthMonitor: null, vkLinkRequiresOAuth: false };
function fireVkBridgeInit() {
  try {
    if (!vkLaunchParams()) return;
    window.parent?.postMessage?.({ handler: 'VKWebAppInit', params: { request_id: `init_${Date.now()}` }, type: 'vk-connect', connectVersion: '3.0.2' }, '*');
    window.vkBridge?.send?.('VKWebAppInit').catch?.(() => {});
  } catch (_) { /* best-effort VK wrapper initialization */ }
}
function clientLogDetails(details = '') {
  const redact = (key, value) => (/token|secret|sign|hash|auth|key/i.test(key) ? '[REDACTED]' : value);
  const clip = (value, limit = 120) => String(value == null ? '' : value).slice(0, limit);
  try {
    if (details == null) return '';
    if (typeof details === 'string') return details.slice(0, 240);
    if (details instanceof Error) return JSON.stringify({ name: details.name, message: details.message }).slice(0, 240);
    const seen = new WeakSet();
    const safe = JSON.stringify(details, (key, value) => {
      if (/token|secret|sign|hash|auth|key/i.test(key)) return '[REDACTED]';
      if (typeof value === 'bigint') return String(value);
      if (typeof value === 'function') return '[Function]';
      if (typeof value === 'string') return value.slice(0, 120);
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
    return (safe || String(details)).slice(0, 240);
  } catch (_) {
    try {
      const out = {};
      ['name', 'message', 'type', 'code', 'error_type', 'error_data', 'error_reason', 'detail', 'description'].forEach((key) => {
        if (details && details[key] != null) out[key] = redact(key, clip(details[key]));
      });
      if (!Object.keys(out).length && details && typeof details === 'object') {
        Object.keys(details).slice(0, 8).forEach((key) => { out[key] = redact(key, clip(details[key])); });
      }
      out.objectType = Object.prototype.toString.call(details);
      return JSON.stringify(out).slice(0, 240);
    } catch (__) {
      return String(details || '').slice(0, 240);
    }
  }
}
function clientLog(event, details = '') {
  try {
    const payload = JSON.stringify({ event, details: clientLogDetails(details), platform: new URLSearchParams(window.location.search || '').get('vk_platform') || '', version: CLIENT_VERSION });
    if (navigator.sendBeacon) {
      const ok = navigator.sendBeacon('/api/client-log', new Blob([payload], { type: 'application/json' }));
      if (ok) return;
    }
    fetch('/api/client-log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, keepalive: true }).catch(() => {});
  } catch (_) { /* diagnostics only */ }
}
const $ = (id) => document.getElementById(id);
// Detect the user's timezone from their device clock (IANA zone), fallback UTC.
function detectTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; }
}
// Capture a referral code from ?ref=, /p/CODE, or Telegram start_param, and
// remember it until signup.
function captureRefCode() {
  try {
    const sp = window.Telegram?.WebApp?.initDataUnsafe?.start_param;
    const tgRef = referralLikeCode(sp);
    if (tgRef) { storage.set('kopilkaRef', tgRef); return tgRef; }
    const url = new URL(window.location.href);
    const qRef = referralLikeCode(url.searchParams.get('ref'));
    if (qRef) { storage.set('kopilkaRef', qRef); return qRef; }
    const vkHash = parseHashParams(vkLaunchHash() || window.location.hash);
    const vkRef = referralLikeCode(vkHash.get('ref') || vkHash.get('profile'));
    if (vkRef) { storage.set('kopilkaRef', vkRef); return vkRef; }
    const p = /^\/p\/([A-Za-z0-9]+)/.exec(url.pathname);
    const pathRef = referralLikeCode(p ? p[1] : '');
    if (pathRef) { storage.set('kopilkaRef', pathRef); return pathRef; }
  } catch (_) { /* ignore */ }
  return storage.get('kopilkaRef') || '';
}
function publicProfileCode() {
  try {
    const url = new URL(window.location.href);
    const p = /^\/p\/([A-Za-z0-9]+)/.exec(url.pathname);
    const pathCode = referralLikeCode(p ? p[1] : '');
    if (pathCode) return pathCode;
    const hash = parseHashParams(vkLaunchHash() || window.location.hash);
    return referralLikeCode(hash.get('profile') || '');
  } catch (_) { return ''; }
}
function vkLaunchParams() {
  const candidates = [window.location.search || '', window.location.hash || ''];
  const raw = candidates.find((value) => value.includes('vk_app_id') && value.includes('sign=')) || '';
  if (!raw) return state.vkBridgeLaunchParams || '';
  if (raw.startsWith('#') && raw.includes('?')) return raw.slice(raw.indexOf('?'));
  return raw;
}
function normalizeVkLaunchParams(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.includes('vk_app_id') && value.includes('sign=') ? value : '';
  const nested = value.launchParams || value.launch_params || value.params || value.data;
  if (nested && nested !== value) {
    const normalized = normalizeVkLaunchParams(nested);
    if (normalized) return normalized;
  }
  try {
    const params = new URLSearchParams();
    Object.entries(value).forEach(([key, val]) => {
      if (val == null) return;
      if (key === 'sign' || key.startsWith('vk_')) params.set(key, String(val));
    });
    const text = params.toString();
    return text.includes('vk_app_id') && text.includes('sign=') ? `?${text}` : '';
  } catch (_) { return ''; }
}
async function freshVkBridgeLaunchParams() {
  if (!window.vkBridge?.send) return '';
  try {
    const result = await withTimeout(window.vkBridge.send('VKWebAppGetLaunchParams'), 2500, 'VK launch params timeout');
    const normalized = normalizeVkLaunchParams(result);
    clientLog('vk_bridge_launch_params', `ok=${Boolean(normalized)} len=${normalized.length}`);
    return normalized;
  } catch (error) {
    clientLog('vk_bridge_launch_params_error', userSafeErrorMessage(error));
    return '';
  }
}
function vkLaunchHash() {
  try {
    const raw = vkLaunchParams();
    if (raw) return new URLSearchParams(raw.replace(/^[?#]/, '')).get('hash') || '';
    return '';
  } catch (_) { return ''; }
}
function parseHashParams(value) {
  const raw = String(value || '').replace(/^#/, '').replace(/^\/?/, '');
  if (!raw) return new URLSearchParams();
  return new URLSearchParams(raw);
}
function referralLikeCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9]{4,24}$/.test(code) ? code : '';
}
function isVkMiniApp() { return Boolean(vkLaunchParams()); }
function supportSurface() {
  if (isVkMiniApp()) return 'vk';
  if (window.Telegram?.WebApp?.initData) return 'telegram';
  return 'web';
}
async function initVkBridge() {
  fireVkBridgeInit();
  try {
    if (!window.vkBridge?.send) return;
    await Promise.race([
      window.vkBridge.send('VKWebAppInit'),
      new Promise((resolve) => setTimeout(resolve, 1500))
    ]);
  } catch (_) { /* VK Bridge init is best-effort */ }
}
function safeFirstPartyOAuthUrl(value) {
  const url = new URL(String(value || ''), window.location.origin);
  if (url.origin !== window.location.origin || url.pathname !== '/api/auth/vk-oauth/start' || url.username || url.password) throw new Error(L('vkOauthStartFailed'));
  return url.toString();
}
function showVkOAuthFallbackLink(statusEl, launchUrl) {
  if (!statusEl) return;
  statusEl.textContent = `${L('vkOauthRedirectFallback')} `;
  const link = document.createElement('a');
  link.href = launchUrl;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = L('vkOauthOpenLink');
  statusEl.appendChild(link);
}
function restoreVkOAuthAction(action, message = '') {
  const button = action === 'link' ? $('linkVkAccount') : $('vkLoginButton');
  const statusEl = action === 'link' ? $('vkLinkStatus') : $('loginStatus');
  if (button) {
    button.disabled = false;
    button.textContent = action === 'link' && state.vkLinkRequiresOAuth ? L('vkOauthOpenLink') : L(action === 'link' ? 'linkVkAccount' : 'loginVkButton');
  }
  if (message && statusEl) {
    statusEl.textContent = message;
    statusEl.classList.add('error');
  }
}
function clearVkOAuthPending() {
  if (state.vkOAuthMonitor) window.clearInterval(state.vkOAuthMonitor);
  state.vkOAuthMonitor = null;
  state.vkOAuthWindow = null;
  state.vkOAuthChannel = '';
  state.vkOAuthAction = '';
}
async function getVkOAuthIntent(action = 'auth') {
  const cfg = await getPublicConfig();
  if (!cfg.vkOAuthEnabled) throw new Error(L('vkOauthNotConfigured'));
  const data = await api('/api/auth/vk-oauth/intent', {
    method: 'POST',
    body: JSON.stringify({ action, refCode: captureRefCode(), timezone: detectTimezone(), locale: locale() })
  });
  if (!data.launchUrl || !data.channel) throw new Error(L('vkOauthStartFailed'));
  return { launchUrl: safeFirstPartyOAuthUrl(data.launchUrl), channel: String(data.channel) };
}
async function startVkOAuth(action = 'auth', statusEl = null) {
  let popup = null;
  try { popup = window.open('/api/auth/vk-oauth/window', '_blank', 'popup,width=520,height=720'); } catch (_) { popup = null; }
  if (popup) state.vkOAuthWindow = popup;
  try {
    const intent = await getVkOAuthIntent(action);
    state.vkOAuthChannel = intent.channel;
    state.vkOAuthAction = action === 'link' ? 'link' : 'auth';
    if (popup && !popup.closed) {
      popup.location.replace(intent.launchUrl);
      if (statusEl) statusEl.textContent = L('loginVkSoon');
      state.vkOAuthMonitor = window.setInterval(() => {
        if (state.vkOAuthWindow !== popup) return window.clearInterval(state.vkOAuthMonitor);
        if (!popup.closed) return;
        const pendingAction = state.vkOAuthAction;
        clearVkOAuthPending();
        restoreVkOAuthAction(pendingAction, L('vkOauthCancelled'));
      }, 500);
    } else {
      state.vkOAuthWindow = null;
      showVkOAuthFallbackLink(statusEl, intent.launchUrl);
      restoreVkOAuthAction(state.vkOAuthAction);
    }
  } catch (error) {
    if (popup && !popup.closed) popup.close();
    const pendingAction = state.vkOAuthAction || action;
    clearVkOAuthPending();
    restoreVkOAuthAction(pendingAction);
    throw error;
  }
}
function setPublicReadOnlyMode(enabled) {
  state.publicReadOnly = Boolean(enabled);
  const nav = document.querySelector('.tab-bar');
  if (nav) nav.hidden = state.publicReadOnly;
  ['copyRefLink', 'shareRefLink'].forEach((id) => { const el = $(id); if (el) el.hidden = state.publicReadOnly; });
  const shareProfile = $('shareProfile');
  if (shareProfile) shareProfile.hidden = false;
  const artifactsSection = $('artifactsSection');
  if (artifactsSection) artifactsSection.hidden = state.publicReadOnly;
  const linkLabel = document.querySelector('label[for="refLink"]');
  if (linkLabel) linkLabel.textContent = state.publicReadOnly ? L('profileLinkLabel') : L('refLinkLabel');
  const hint = $('refLinkHint');
  if (hint) hint.textContent = state.publicReadOnly ? L('profileLinkHint') : L('refLinkHint');
}
function setStatus(text, type = 'info') { const region = $('statusRegion'); region.textContent = text; region.classList.toggle('error', type === 'error'); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function userSafeErrorMessage(error, fallbackKey = 'actionFailed') {
  const raw = error?.message || String(error || '');
  const firstLine = String(raw || '').split(/\n|\s+at\s+/)[0].trim();
  const cleaned = firstLine.replace(/^(Error|TypeError|ReferenceError|SyntaxError):\s*/i, '').trim();
  return (cleaned || L(fallbackKey)).slice(0, 180);
}
function setBusy(isBusy, message = '') {
  state.busy = isBusy;
  document.querySelectorAll('button,input,textarea,select').forEach((el) => {
    if (el.id === 'cleanupDemo' && state.user && !state.user.isDemo) return;
    if (!isBusy && el.getAttribute('aria-disabled') === 'true') return;
    el.disabled = isBusy;
  });
  document.body.setAttribute('aria-busy', isBusy ? 'true' : 'false');
  if (message) setStatus(message);
}
async function withBusy(message, fn) { setBusy(true, message); try { return await fn(); } finally { setBusy(false); } }
async function requestJson(path, options = {}, token = state.token) {
  const headers = { 'content-type': 'application/json', 'x-kopilka-surface': supportSurface(), ...(options.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}
async function renewSurfaceSession() {
  if (state.sessionRenewalBlocked) return false;
  if (state.sessionRenewalPromise) return state.sessionRenewalPromise;
  state.sessionRenewalPromise = (async () => {
    storage.remove('kopilkaToken');
    state.token = '';
    const refCode = captureRefCode();
    let result = null;
    if (window.Telegram?.WebApp?.initData) {
      result = await requestJson('/api/auth/telegram', { method: 'POST', body: JSON.stringify({ initData: window.Telegram.WebApp.initData, refCode, timezone: detectTimezone() }) }, '');
    } else if (isVkMiniApp()) {
      let launchParams = vkLaunchParams();
      result = await requestJson('/api/auth/vk', { method: 'POST', body: JSON.stringify({ launchParams, refCode, timezone: detectTimezone(), locale: locale() }) }, '');
      if (!result.res.ok) {
        const fresh = await freshVkBridgeLaunchParams();
        if (fresh && fresh !== launchParams) {
          launchParams = fresh;
          result = await requestJson('/api/auth/vk', { method: 'POST', body: JSON.stringify({ launchParams, refCode, timezone: detectTimezone(), locale: locale() }) }, '');
        }
      }
    }
    if (!result?.res.ok || !result.data?.token) {
      state.sessionRenewalBlocked = true;
      return false;
    }
    state.token = result.data.token;
    state.user = result.data.user || state.user;
    state.sessionRenewalBlocked = false;
    storage.set('kopilkaToken', state.token);
    if (state.user?.locale) storage.set('kopilkaLocale', state.user.locale);
    setStatus(L('sessionRenewed'));
    return true;
  })().catch((error) => {
    state.sessionRenewalBlocked = true;
    clientLog('session_renewal_failed', userSafeErrorMessage(error));
    return false;
  }).finally(() => { state.sessionRenewalPromise = null; });
  return state.sessionRenewalPromise;
}
async function api(path, options = {}) {
  const { authToken = state.token, skipSessionRenewal = false, ...requestOptions } = options;
  let result = await requestJson(path, requestOptions, authToken);
  const canRenew = !state.sessionRenewalBlocked && !skipSessionRenewal && !path.startsWith('/api/auth/') && result.res.status === 401 && ['SESSION_EXPIRED', 'SESSION_INVALID'].includes(result.data?.code);
  if (canRenew) {
    if (await renewSurfaceSession()) result = await requestJson(path, requestOptions);
    else await showSessionRecovery();
  }
  if (!result.res.ok) {
    const error = new Error(result.data.error || L('actionFailed'));
    error.data = result.data;
    error.status = result.res.status;
    throw error;
  }
  return result.data;
}
let publicConfigCache = null;
async function getPublicConfig() { if (!publicConfigCache) publicConfigCache = await api('/api/config'); return publicConfigCache; }
function applyVkOAuthPayload(payload) {
  if (!payload || payload.type !== 'kopilka:vk-oauth') return false;
  if (payload.token) {
    state.token = String(payload.token);
    state.sessionRenewalBlocked = false;
    storage.set('kopilkaToken', state.token);
  }
  if (payload.error) storage.set('kopilkaLastAuthError', String(payload.error).slice(0, 180));
  return Boolean(payload.token || payload.error);
}
async function finalizeVkOAuthLink(proof) {
  if (!state.token) throw new Error(L('sessionExpiredLogin'));
  try {
    const data = await api('/api/auth/vk-oauth/finalize-link', { method: 'POST', body: JSON.stringify({ proof: String(proof || '') }), skipSessionRenewal: true });
    state.token = String(data.token || state.token);
    state.user = data.user || state.user;
    state.sessionRenewalBlocked = false;
    storage.set('kopilkaToken', state.token);
    return { linked: true, merge: false };
  } catch (error) {
    if (error.status === 409 && error.data?.mergeToken) {
      storage.set('kopilkaVkMergeToken', String(error.data.mergeToken));
      return { linked: false, merge: true };
    }
    throw error;
  }
}
async function consumeVkOAuthResult() {
  let payload = null;
  try {
    payload = JSON.parse(sessionStorage.getItem('kopilkaVkOAuthHandoff') || 'null');
    sessionStorage.removeItem('kopilkaVkOAuthHandoff');
  } catch (_) { sessionStorage.removeItem('kopilkaVkOAuthHandoff'); }
  if (payload?.type === 'kopilka:vk-oauth' && payload.action === 'link' && payload.linkProof) {
    try {
      const finalized = await finalizeVkOAuthLink(payload.linkProof);
      if (finalized.merge) await loadPendingMerge();
    } catch (error) {
      storage.set('kopilkaLastAuthError', userSafeErrorMessage(error));
      return false;
    }
  } else if (!applyVkOAuthPayload(payload)) return false;
  if (new URLSearchParams(window.location.search).has('vk_oauth_return')) window.history.replaceState({}, document.title, window.location.pathname || '/');
  return Boolean(payload.token || payload.linkProof);
}
async function receiveVkOAuthHandoff(event) {
  const payload = event.data;
  if (event.origin !== window.location.origin || event.source !== state.vkOAuthWindow || !payload || payload.type !== 'kopilka:vk-oauth' || payload.channel !== state.vkOAuthChannel) return;
  event.source.postMessage({ type: 'kopilka:vk-oauth-ack', channel: payload.channel }, event.origin);
  const pendingAction = state.vkOAuthAction;
  clearVkOAuthPending();
  if (payload.action === 'link' && payload.linkProof) {
    try {
      const finalized = await finalizeVkOAuthLink(payload.linkProof);
      if (finalized.merge) {
        await loadPendingMerge();
        renderSettings();
        switchTab('settings');
        setStatus(L('mergeNeedsConfirmation'));
        return;
      }
      await loadData();
      renderSettings();
      switchTab('settings');
      setStatus(L('vkLinked'));
    } catch (error) {
      restoreVkOAuthAction(pendingAction, userSafeErrorMessage(error));
    }
    return;
  }
  if (!applyVkOAuthPayload(payload)) return;
  if (payload.error) {
    restoreVkOAuthAction(pendingAction, String(payload.error));
    return;
  }
  if (payload.token) {
    if ($('loginScreen')) $('loginScreen').hidden = true;
    if ($('appShell')) $('appShell').hidden = false;
    await start();
    return;
  }
}

// Translate all [data-i18n] static nodes and set document lang.
// Never clobber child elements: only text-bearing [data-i18n] nodes are
// replaced wholesale; a node that contains child elements is skipped so that
// id-bearing descendants (e.g. <strong id="todayLife">) are never destroyed.
function applyStaticI18n() {
  const lang = locale();
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    if (el.querySelector('*')) return; // has element children -> leave for dynamic render
    const key = el.getAttribute('data-i18n');
    el.textContent = L(key);
  });
  const status = $('connectionStatus');
  if (status) status.textContent = state.publicStatus || (state.user ? L('connected') : L('connecting'));
}

// Re-render quick actions using current locale from the local dictionary.
function renderQuickActions() {
  const types = I18N.entryTypes(locale());
  const usedToday = new Set(state.summary?.todayEntryTypes || []);
  $('quickActions').innerHTML = types.map((it) => {
    const used = usedToday.has(it.type);
    const aria = used ? `${it.title}, ${L('alreadyAddedToday')}` : `${it.title}, ${it.hint}, ${L('addLife', { points: it.points })}`;
    return `<button type="button" data-entry-type="${it.type}" data-last-quick-entry-type="${it.type}" data-used-today="${used ? 'true' : 'false'}" ${used ? 'aria-disabled="true"' : ''} aria-label="${escapeHtml(aria)}"><span class="qa-head"><span class="qa-icon" aria-hidden="true">${escapeHtml(it.icon || '✦')}</span><span class="qa-title">${escapeHtml(it.title)}</span></span><span class="qa-hint">${escapeHtml(used ? L('alreadyAddedToday') : it.hint)}</span><span class="qa-points">${used ? escapeHtml(L('availableTomorrow')) : `+${it.points} ЖИЗНЬ`}</span></button>`;
  }).join('');
}
function renderSummary() {
  const s = state.summary || { totalLife: 0, todayLife: 0, todayEntries: [] };
  $('totalLife').textContent = s.totalLife;
  $('todayLife').textContent = s.todayLife;
  $('todayEntries').innerHTML = s.todayEntries.length ? s.todayEntries.map((e) => `<li>${escapeHtml(e.title)}: +${Number(e.life_points) || 0}. ${escapeHtml(e.note || '')}</li>`).join('') : `<li>${escapeHtml(L('noEntriesToday'))}</li>`;
  renderDailyHint();
  renderGratitudePractice();
}
function renderDailyHint() { const hint = state.product?.dailyHint; if (!hint) return; $('dailyHintTitle').textContent = hint.title; $('dailyHintText').textContent = hint.text; $('dailyHintAction').textContent = hint.action; }
function renderGratitudePractice() {
  const box = $('gratitudePractice');
  if (!box) return;
  const used = new Set(state.summary?.todayEntryTypes || []).has('gratitude');
  const note = $('gratitudeNote');
  const btn = box.querySelector('[data-gratitude-submit]');
  const hintKeys = ['gratitudeHintParents', 'gratitudeHintDay', 'gratitudeHintPerson', 'gratitudeHintBody', 'gratitudeHintSelf'];
  const hintBox = box.querySelector('.hint-button-row');
  if (hintBox) {
    hintBox.innerHTML = hintKeys.map((key) => {
      const text = L(key);
      return `<button type="button" class="secondary" data-gratitude-hint="${escapeHtml(text)}">${escapeHtml(text)}</button>`;
    }).join('');
  }
  if (note) {
    note.placeholder = L('gratitudeNotePlaceholder');
    note.disabled = used;
    note.setAttribute('aria-disabled', String(used));
  }
  if (btn) {
    btn.textContent = used ? L('gratitudeSavedToday') : L('gratitudeSubmit');
    btn.disabled = used;
    btn.setAttribute('aria-disabled', String(used));
  }
}
function appendGratitudeHint(text) {
  const note = $('gratitudeNote');
  const value = String(text || '').trim();
  if (!note || !value || note.disabled) return;
  const parts = note.value.split(',').map((part) => part.trim()).filter(Boolean);
  if (!parts.includes(value)) parts.push(value);
  note.value = parts.join(', ');
  note.focus();
}
function formatHistoryDate(value) {
  try {
    return new Intl.DateTimeFormat(locale() === 'en' ? 'en-US' : 'ru-RU', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00.000Z`));
  } catch (_) { return value; }
}
function renderHistory() {
  const history = state.history;
  if (!history) return;
  state.historyDate = history.selectedDate;
  const dateInput = $('historyDate');
  if (dateInput) { dateInput.value = history.selectedDate; dateInput.max = history.todayDate || history.selectedDate; }
  if ($('historyNext')) { $('historyNext').disabled = !history.nextDate; $('historyNext').setAttribute('aria-disabled', String(!history.nextDate)); }
  const life = history.selectedEntries.reduce((sum, entry) => sum + Number(entry.life_points || 0), 0);
  if ($('selectedDaySummary')) $('selectedDaySummary').textContent = L('historyDaySummary', { date: formatHistoryDate(history.selectedDate), count: history.selectedEntries.length, life });
  const list = $('selectedDayEntries');
  if (list) {
    list.innerHTML = history.selectedEntries.length ? history.selectedEntries.map((entry) => {
      const note = entry.note ? `<p>${escapeHtml(entry.note)}</p>` : '';
      if (state.historyEditingId === entry.id && entry.editable) {
        return `<li><form data-history-edit-form="${entry.id}"><p><strong>${escapeHtml(entry.title)}</strong> · +${Number(entry.life_points) || 0} ${escapeHtml(L('life'))}</p><label for="history-note-${entry.id}">${escapeHtml(L('historyEditLabel', { title: entry.title }))}</label><textarea id="history-note-${entry.id}" name="note" rows="3" maxlength="2000">${escapeHtml(entry.note || '')}</textarea><div class="history-entry-actions"><button type="submit">${escapeHtml(L('historySave'))}</button><button type="button" class="secondary" data-history-cancel>${escapeHtml(L('historyCancel'))}</button></div></form></li>`;
      }
      const actions = entry.editable ? `<div class="history-entry-actions"><button type="button" class="secondary" data-history-edit="${entry.id}">${escapeHtml(L('historyEdit'))}</button><button type="button" class="secondary" data-history-delete="${entry.id}">${escapeHtml(L('historyDelete'))}</button></div>` : `<p class="field-hint">${escapeHtml(L('historyProtected'))}</p>`;
      return `<li><article><h3>${escapeHtml(entry.title)}</h3><p>+${Number(entry.life_points) || 0} ${escapeHtml(L('life'))}</p>${note}${actions}</article></li>`;
    }).join('') : `<li>${escapeHtml(L('historyEmptyDay'))}</li>`;
  }
  if ($('historyDays')) $('historyDays').innerHTML = history.days.map((day) => `<li><button type="button" class="history-day-button secondary" data-history-date="${escapeHtml(day.date)}" ${day.date === history.selectedDate ? 'aria-current="date"' : ''}><span>${escapeHtml(formatHistoryDate(day.date))}</span><span>${Number(day.life) || 0} ${escapeHtml(L('life'))} · ${Number(day.entryCount) || 0}</span></button></li>`).join('');
}
function renderWeek() {
  const w = state.week || { weekLife: 0, activeDays: 0, days: [], topCategories: [] };
  $('weekLife').textContent = w.weekLife;
  $('activeDays').textContent = w.activeDays;
  $('weekDays').innerHTML = w.days.length ? w.days.map((d) => `<li>${escapeHtml(d.date)}: ${Number(d.life) || 0} ${escapeHtml(L('life'))}. ${d.titles.slice(0, 3).map(escapeHtml).join(', ')}</li>`).join('') : `<li>${escapeHtml(L('noWeek'))}</li>`;
  $('topCategories').innerHTML = w.topCategories.length ? w.topCategories.map((i) => `<li>${escapeHtml(i.title)}: ${Number(i.count) || 0}</li>`).join('') : `<li>${escapeHtml(L('noCategories'))}</li>`;
  renderHistory();
  renderWeeklyReview(); renderPractices();
}
function renderContract() {
  const box = $('contractCurrent'); const form = $('contractForm');
  renderContractTemplates();
  if (!state.currentContract) { box.innerHTML = `<section class="contract-box" aria-label="${escapeHtml(L('currentContract'))}"><p>${escapeHtml(L('noActiveContract'))}</p></section>`; form.hidden = false; return; }
  form.hidden = true; const c = state.currentContract;
  const closeButtons = (c.isLastDay)
    ? `<button type="button" data-close-status="completed">${escapeHtml(L('closeCompleted'))}</button><button type="button" data-close-status="not_completed_donated" class="secondary">${escapeHtml(L('closeNotCompletedDonated'))}</button><button type="button" data-close-status="too_hard" class="secondary">${escapeHtml(L('closeTooHard'))}</button>`
    : '';
  const lastDayReminder = c.isLastDay ? `<p class="soft-note contract-reminder">${escapeHtml(L('contractLastDayReminder'))}</p>` : '';
  box.innerHTML = `<section class="contract-box" aria-labelledby="currentContractHeading"><h2 id="currentContractHeading">${escapeHtml(L('currentContract'))}</h2><p><strong>${escapeHtml(c.title)}</strong></p><p>${escapeHtml(L('period'))}: ${escapeHtml(c.week_start)} — ${escapeHtml(c.week_end)}</p><p>${escapeHtml(L('criteria'))}: ${escapeHtml(c.target_value)}</p><p>${escapeHtml(L('careFund'))}: ${escapeHtml(c.stake_amount || L('notSpecified'))} ${escapeHtml(c.stake_currency || '')}</p><p>${escapeHtml(L('giftSelf'))}: ${escapeHtml(c.reward_description || L('canChooseLater'))}</p>${lastDayReminder}<div class="close-actions">${closeButtons}<button type="button" data-close-status="cancelled" class="secondary">${escapeHtml(L('closeCancelled'))}</button></div></section>`;
}
function renderContractTemplates() { const templates = state.product?.contractTemplates || []; const box = $('contractTemplates'); if (!box) return; box.innerHTML = templates.length ? templates.map((t) => `<button type="button" class="secondary" data-template-id="${escapeHtml(t.id)}">${escapeHtml(t.title)}</button>`).join('') : `<p class="soft-note">${escapeHtml(L('templatesLoading'))}</p>`; }
function renderWeeklyReview() { const review = state.product?.weeklyReview; if (!review) return; $('weeklyReviewText').textContent = review.summaryText; $('weeklyReviewQuestions').innerHTML = review.questions.map((q) => `<li>${escapeHtml(q)}</li>`).join(''); }
function renderPractices() { const data = state.product?.practices; if (!data) return; const select = $('practiceGoal'); if (select.options.length === 0) { select.innerHTML = data.goals.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.title)}</option>`).join(''); } select.value = data.goal; $('goalPractices').innerHTML = data.practices.map((p) => `<li>${escapeHtml(p)}</li>`).join(''); }
function applyTemplate(templateId) { const t = (state.product?.contractTemplates || []).find((item) => item.id === templateId); if (!t) return; $('contractTitle').value = t.title; $('contractTarget').value = t.targetValue; $('stakeAmount').value = t.stakeAmount || ''; $('stakeCurrency').value = t.stakeCurrency || 'RUB'; $('rewardDescription').value = t.rewardDescription || ''; $('fundDescription').value = t.fundDescription || ''; setStatus(L('templateApplied', { title: t.title })); }
function renderMergePrompt() {
  const container = $('accountMergePrompt') || (() => {
    const parent = $('accountLinksHeading')?.closest('.summary-card');
    if (!parent) return null;
    const box = document.createElement('div');
    box.id = 'accountMergePrompt';
    box.className = 'contract-box';
    parent.appendChild(box);
    return box;
  })();
  if (!container) return;
  const pending = state.pendingMerge;
  if (!pending) { container.hidden = true; container.innerHTML = ''; return; }
  const p = pending.preview || {};
  const r = p.result || {};
  const blocking = p.blocking || [];
  container.hidden = false;
  container.innerHTML = `<h3>${escapeHtml(L('mergeAccountsTitle'))}</h3><p>${escapeHtml(L('mergeAccountsIntro'))}</p><ul class="compact-list"><li>${escapeHtml(L('mergeMovedEntries', { count: r.movedEntries || 0 }))}</li><li>${escapeHtml(L('mergeDedupedEntries', { count: r.dedupedQuickEntries || 0 }))}</li><li>${escapeHtml(L('mergeNotes', { count: r.mergedNotes || 0 }))}</li><li>${escapeHtml(L('mergeContracts', { count: r.movedContracts || 0 }))}</li><li>${escapeHtml(L('mergeRemindersDropped', { count: r.scheduledRemindersDropped || 0 }))}</li></ul>${blocking.length ? `<p class="soft-note">${escapeHtml(L('mergeBlockedActiveContract'))}</p>` : `<button type="button" id="confirmAccountMerge">${escapeHtml(L('mergeConfirm'))}</button>`}<button type="button" id="cancelAccountMerge" class="secondary">${escapeHtml(L('mergeCancel'))}</button>`;
}
function renderSettings() {
  if (!state.user) return;
  $('timezone').value = state.user.timezone || 'Asia/Novosibirsk';
  $('remindersEnabled').checked = Boolean(state.user.remindersEnabled);
  $('eveningReminderTime').value = state.user.eveningReminderTime || '20:00';
  const servicePanel = $('servicePanel');
  if (servicePanel) servicePanel.hidden = !state.user.isDemo;
  if ($('userDebug')) $('userDebug').textContent = `ID: ${state.user.id}. Demo: ${state.user.isDemo ? L('yes') : L('no')}.`;
  const vkStatus = $('vkLinkStatus'); const vkBtn = $('linkVkAccount');
  if (vkStatus) vkStatus.textContent = state.user.vkLinked ? L('vkLinked') : L('vkNotLinked');
  if (vkBtn) { vkBtn.hidden = Boolean(state.user.vkLinked); vkBtn.disabled = false; }
  renderVkReminderOffer();
  if ($('cleanupDemo')) $('cleanupDemo').disabled = !state.user.isDemo;
  const lang = locale(); $('lang-ru').setAttribute('aria-pressed', String(lang === 'ru')); $('lang-en').setAttribute('aria-pressed', String(lang === 'en'));
  renderMergePrompt();
}
function badgeSize(n) { if (n === 0) return 'small'; if (n >= 50) return 'xlarge'; if (n >= 10) return 'large'; return 'small'; }
function renderVkReminderOffer() {
  const showVkReminders = Boolean(state.user) && isVkMiniApp() && Boolean(state.user.vkLinked);
  const needsPermission = showVkReminders && !state.user.vkMessagesAllowed;
  const vkReminderPrompt = $('vkReminderPrompt');
  const vkReminderBox = $('vkReminderBox');
  const vkReminderStatus = $('vkReminderStatus');
  if (vkReminderPrompt) vkReminderPrompt.hidden = !needsPermission;
  if (vkReminderBox) vkReminderBox.hidden = !showVkReminders;
  if (vkReminderStatus) vkReminderStatus.textContent = state.user?.vkMessagesAllowed ? L('vkReminderStatusOn') : (showVkReminders ? L('vkReminderStatusUnknown') : L('vkReminderStatusNeedVk'));
  document.querySelectorAll('[data-enable-vk-reminders]').forEach((btn) => {
    btn.textContent = state.user?.vkMessagesAllowed ? L('vkReminderEnableAgain') : L('vkReminderEnable');
    btn.disabled = false;
  });
}
function renderProfile() {
  const p = state.profile; const name = $('profileNameHeading'); const heart = document.querySelector('.badge-heart'); const count = document.querySelector('.badge-heart-count');
  if (!p) return;
  if (name) name.textContent = state.user?.firstName || '—';
  const n = p.activeReferred || 0;
  if (heart) { heart.setAttribute('data-size', badgeSize(n)); heart.setAttribute('aria-label', `${L('publicBadgeLabel')} ${n}`); }
  if (count) count.textContent = n;
  const total = $('partnerTotal'); const active = $('partnerActive');
  if (total) total.textContent = p.totalReferred || 0;
  if (active) active.textContent = n;
  const inBot = Boolean(window.Telegram?.WebApp?.initData);
  const inVk = isVkMiniApp();
  const link = $('refLink');
  if (link) link.value = inBot ? (p.botLink || '') : (inVk ? (p.vkRefLink || p.refLink || '') : (p.profileLink || p.refLink || ''));
}
function renderArtifacts() {
  const grid = $('artifactsGrid');
  if (!grid) return;
  const artifacts = state.artifacts || [];
  const unlocked = artifacts.filter((item) => item.unlocked).length;
  if ($('artifactsUnlockedCount')) $('artifactsUnlockedCount').textContent = unlocked;
  if ($('artifactsTotalCount')) $('artifactsTotalCount').textContent = artifacts.length;
  if (!artifacts.length) { grid.innerHTML = `<p class="soft-note">${escapeHtml(L('artifactsLoading'))}</p>`; return; }
  grid.innerHTML = artifacts.map((item) => {
    const text = item.unlocked ? item.unlockedText : item.lockedText;
    const date = item.awardedAt ? `<p class="artifact-date">${escapeHtml(L('artifactAwardedAt'))}: ${escapeHtml(item.awardedAt.slice(0, 10))}</p>` : '';
    const visual = item.unlocked
      ? `<img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.alt)}" loading="lazy">`
      : `<div class="artifact-mystery" role="img" aria-label="${escapeHtml(item.alt || L('artifactMysteryAlt'))}"><span aria-hidden="true">?</span></div>`;
    return `<article class="artifact-card${item.unlocked ? '' : ' is-locked'}" aria-label="${escapeHtml(item.title)}">${visual}<div><h3>${escapeHtml(item.title)}</h3><p class="artifact-short">${escapeHtml(item.shortTitle || '')}</p><p>${escapeHtml(text || '')}</p><p class="field-hint">${escapeHtml(item.triggerText || '')}</p>${date}</div></article>`;
  }).join('');
}
function supportNewLabel(count) {
  const n = Number(count || 0);
  if (locale() !== 'ru') return `${n} new`;
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} новая`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} новые`;
  return `${n} новых`;
}
function renderSupportActions() {
  const box = $('supportActionsList');
  if (!box) return;
  const support = state.support || { badge: { points: 0 }, summary: { newCount: 0 }, actions: [] };
  const points = $('supportBadgePoints');
  if (points) points.textContent = support.badge?.points || 0;
  const count = $('supportNewCount');
  const newCount = Number(support.summary?.newCount || 0);
  const newLabel = supportNewLabel(newCount);
  if (count) { count.textContent = newCount > 0 ? L('supportTabNewShort', { label: newLabel }) : ''; count.hidden = newCount <= 0; }
  const supportTab = $('tab-button-support');
  if (supportTab) supportTab.setAttribute('aria-label', newCount > 0 ? L('supportTabNew', { label: newLabel }) : L('tabSupport'));
  const summary = $('supportNewSummary');
  if (summary) summary.textContent = newCount > 0 ? L('supportNewSummary', { label: newLabel }) : L('supportNoNew');
  const actions = support.actions || [];
  if (!actions.length) { box.innerHTML = `<p class="soft-note">${escapeHtml(L('supportEmpty'))}</p>`; return; }
  box.innerHTML = actions.map((action) => {
    const opened = action.status !== 'available';
    const disclosure = action.disclosureText ? `<p class="field-hint">${escapeHtml(action.disclosureText)}</p>` : '';
    const ad = action.isAd || action.isPartner ? `<span class="support-pill">${escapeHtml(action.isAd ? L('supportAd') : L('supportPartner'))}</span>` : '';
    const statePill = opened ? `<span class="support-pill done">${escapeHtml(L('supportDone'))}</span>` : `<span class="support-pill">${escapeHtml(action.rewardLabel || L('supportReward'))}</span>`;
    return `<article class="support-action-card${opened ? ' is-opened' : ''}" data-support-action-id="${action.id}" aria-label="${escapeHtml(action.title)}"><h3>${escapeHtml(action.title)}</h3><p>${escapeHtml(action.description)}</p>${disclosure}<div class="support-action-meta">${statePill}${ad}</div><button type="button" ${opened ? 'class="secondary" disabled aria-disabled="true"' : ''} data-support-open="${action.id}">${escapeHtml(opened ? L('supportDone') : (action.buttonLabel || L('supportOpen')))}</button></article>`;
  }).join('');
}
function rememberRecoveryNotice(notice) {
  if (notice?.type === 'recovery_bonus') state.recoveryNotice = notice;
}
function renderRecoveryNotice() {
  const box = $('recoveryNotice');
  if (!box) return;
  const notice = state.recoveryNotice;
  box.hidden = !notice;
  if (!notice) return;
  if ($('recoveryNoticeTitle')) $('recoveryNoticeTitle').textContent = notice.title || 'Восстановительный бонус';
  if ($('recoveryNoticeText')) $('recoveryNoticeText').textContent = notice.message || '';
  const close = $('recoveryNoticeClose');
  if (close) close.textContent = L('recoveryNoticeClose');
}
function renderTodayContractReminder() {
  const box = $('todayContractReminder');
  if (!box) return;
  box.hidden = !(state.currentContract && state.currentContract.isLastDay);
}
function showArtifactToast(artifacts = []) {
  const fresh = artifacts.filter((item) => item && !state.artifactQueue.some((queued) => queued.id === item.id));
  if (!fresh.length) return;
  if (!state.artifactQueue.length) {
    const active = document.activeElement;
    state.artifactReturnFocus = active instanceof HTMLElement && active !== document.body && active !== document.documentElement ? active : null;
  }
  state.artifactQueue.push(...fresh);
  renderArtifactToast();
}
function setArtifactBackgroundInert(inert) {
  document.querySelectorAll('#appShell > *:not(#artifactToast)').forEach((element) => {
    if (inert) element.setAttribute('inert', '');
    else element.removeAttribute('inert');
  });
}
function renderArtifactToast() {
  const first = state.artifactQueue[0];
  const toast = $('artifactToast');
  if (!toast || !first) return;
  const img = $('artifactToastImage');
  if ($('artifactToastTitle')) $('artifactToastTitle').textContent = first.title;
  if ($('artifactToastText')) $('artifactToastText').textContent = first.unlockedText;
  toast.hidden = false;
  setArtifactBackgroundInert(true);
  if (img) {
    img.loading = 'eager';
    img.alt = first.alt;
    img.src = first.image;
  }
  $('artifactToastClose')?.focus({ preventScroll: true });
  setStatus(L('artifactUnlockedStatus', { title: first.title }));
}
function hideArtifactToast() {
  state.artifactQueue.shift();
  if (state.artifactQueue.length) { renderArtifactToast(); return; }
  const toast = $('artifactToast');
  if (toast) toast.hidden = true;
  setArtifactBackgroundInert(false);
  const target = state.artifactReturnFocus;
  state.artifactReturnFocus = null;
  const focusTarget = target && document.contains(target) ? target : (document.querySelector(`.tab-bar button[data-tab="${state.activeTab}"]`) || $(`heading-${state.activeTab}`));
  const restore = () => focusTarget?.focus?.({ preventScroll: true });
  restore();
  if (document.activeElement !== focusTarget) window.requestAnimationFrame?.(restore);
}
function keepArtifactDialogFocus(event) {
  if (event.key === 'Escape') { hideArtifactToast(); return; }
  if (event.key !== 'Tab') return;
  const toast = $('artifactToast');
  if (!toast || toast.hidden) return;
  const focusable = Array.from(toast.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((el) => !el.disabled && !el.hidden);
  if (!focusable.length) { event.preventDefault(); toast.focus({ preventScroll: true }); return; }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
function restoreQuickActionFocus() {
  const type = state.quickActionReturnType;
  if (!type) return;
  state.quickActionReturnType = '';
  const run = () => {
    const btn = Array.from(document.querySelectorAll('#quickActions [data-last-quick-entry-type]')).find((item) => item.dataset.lastQuickEntryType === type);
    if (!btn) return;
    btn.focus({ preventScroll: true });
    btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  if (window.requestAnimationFrame) window.requestAnimationFrame(run);
  else window.setTimeout(run, 0);
}
function renderAll() { applyStaticI18n(); renderQuickActions(); renderSummary(); renderWeek(); renderContract(); renderTodayContractReminder(); renderSettings(); renderProfile(); renderArtifacts(); renderSupportActions(); renderVkReminderOffer(); renderRecoveryNotice(); restoreQuickActionFocus(); }
function switchTab(tab) { state.activeTab = tab; document.querySelectorAll('.screen-panel').forEach((p) => { p.hidden = p.id !== `tab-${tab}`; }); document.querySelectorAll('.tab-bar button').forEach((b) => { const active = b.dataset.tab === tab; b.setAttribute('aria-selected', String(active)); if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }); const h = $(`heading-${tab}`); if (h) h.focus({ preventScroll: false }); }
async function loadData() {
  state.publicStatus = '';
  const goal = $('practiceGoal')?.value || 'calm';
  const me = await api('/api/me');
  rememberRecoveryNotice(me.recoveryNotice);
  const historyQuery = state.historyDate ? `?date=${encodeURIComponent(state.historyDate)}&days=7` : '?days=7';
  const [summary, week, history, current, product, profile, artifacts, support] = await Promise.all([api('/api/summary/today'), api('/api/entries?range=week'), api(`/api/history${historyQuery}`), api('/api/contracts/current'), api(`/api/product?goal=${encodeURIComponent(goal)}`), api('/api/profile'), api('/api/artifacts'), api(`/api/support/actions?source=${encodeURIComponent(supportSurface())}`)]);
  state.summary = summary; state.week = week; state.history = history; state.historyDate = history.selectedDate; state.currentContract = current.contract; state.user = me.user; state.product = product; state.profile = profile.profile; state.artifacts = artifacts.artifacts || []; state.support = support;
  storage.set('kopilkaLocale', me.user.locale || 'ru');
  renderAll();
}

// ---------- Site login (outside Telegram Mini App) ----------
async function showLoginScreen(options = {}) {
  const { landing = true } = options;
  const shell = $('appShell');
  const screen = $('loginScreen');
  const landingBlock = $('loginLanding');
  applyStaticI18n();
  if (shell) shell.hidden = true;
  if (screen) screen.hidden = false;
  if (landingBlock) landingBlock.hidden = false;
  document.querySelectorAll('[data-login-landing-only]').forEach((element) => { element.hidden = !landing; });
  if ($('loginRecoveryHint')) $('loginRecoveryHint').hidden = landing;
  await initTelegramLogin();
}

async function showSessionRecovery() {
  await showLoginScreen({ landing: false });
  const status = $('loginStatus');
  if (status) {
    status.textContent = L('sessionExpiredLogin');
    status.classList.add('error');
  }
}

async function initTelegramLogin() {
  let cfg;
  try { cfg = await getPublicConfig(); } catch (e) { cfg = {}; }
  const username = (cfg.botUsername || '').replace(/^@/, '').trim();
  const box = $('telegramLoginButton');
  const hint = $('loginTelegramHint');
  if (!username) { if (hint) hint.textContent = L('loginFailed'); return; }
  if (box) box.innerHTML = '';
  if (!cfg.telegramLoginWidgetEnabled) {
    const ref = captureRefCode();
    const url = `https://t.me/${encodeURIComponent(username)}${ref ? `?startapp=${encodeURIComponent(ref)}` : '?startapp=site'}`;
    const link = document.createElement('a');
    link.className = 'button-like';
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = L('openTelegramButton');
    if (box) box.appendChild(link);
    if (hint) hint.textContent = L('telegramDomainHint');
    return;
  }
  // Load the official Telegram Login Widget script and render the button. It only
  // works after BotFather /setdomain matches this site's host.
  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://telegram.org/js/telegram-widget.js?22';
  script.setAttribute('data-telegram-login', username);
  script.setAttribute('data-size', 'large');
  script.setAttribute('data-radius', '14');
  script.setAttribute('data-onauth', 'window.__kopilkaOnTelegramAuth(user)');
  script.setAttribute('data-request-access', 'write');
  script.onload = () => { if (hint) hint.hidden = true; };
  script.onerror = () => { if (hint) hint.textContent = L('loginFailed'); };
  if (box) box.appendChild(script);
}

async function handleTelegramLogin(user) {
  const status = $('loginStatus');
  try {
    if (status) { status.textContent = L('loginInProgress'); status.classList.remove('error'); }
    const data = await api('/api/auth/telegram-login', { method: 'POST', body: JSON.stringify({ ...user, refCode: captureRefCode(), timezone: detectTimezone() }), authToken: '' });
    rememberRecoveryNotice(data.recoveryNotice);
    state.token = data.token; state.user = data.user; state.sessionRenewalBlocked = false;
    storage.set('kopilkaToken', state.token); storage.set('kopilkaLocale', data.user.locale || 'ru');
    if ($('loginScreen')) $('loginScreen').hidden = true;
    if ($('appShell')) $('appShell').hidden = false;
    $('connectionStatus').textContent = L('telegramSession');
    await loadData();
    setStatus(L('ready'));
  } catch (e) {
    if (status) { status.textContent = e.message || L('loginFailed'); status.classList.add('error'); }
  }
}
window.__kopilkaOnTelegramAuth = handleTelegramLogin;

async function handleVkAuth({ linkOnly = false } = {}) {
  clientLog('before_vk_auth', `linkOnly=${linkOnly}`);
  await initVkBridge();
  let launchParams = vkLaunchParams();
  clientLog('after_vk_init', `hasLaunch=${Boolean(launchParams)} len=${launchParams.length}`);
  if (!launchParams) {
    if (linkOnly) state.vkLinkRequiresOAuth = true;
    else await showSessionRecovery();
    setStatus(L('vkOauthExplicitRequired'), 'error');
    return { oauthRequired: true };
  }
  const endpoint = linkOnly ? '/api/settings/link-vk' : '/api/auth/vk';
  clientLog('post_vk_auth', endpoint);
  let data;
  try {
    data = await api(endpoint, { method: 'POST', body: JSON.stringify({ launchParams, refCode: captureRefCode(), timezone: detectTimezone(), locale: locale() }), ...(linkOnly ? {} : { authToken: '' }) });
  } catch (error) {
    if (error.status !== 401) throw error;
    const bridgeLaunchParams = await freshVkBridgeLaunchParams();
    if (!bridgeLaunchParams || bridgeLaunchParams === launchParams) {
      clientLog('vk_auth_bridge_fallback_unavailable', `hasBridgeLaunch=${Boolean(bridgeLaunchParams)}`);
      if (linkOnly) state.vkLinkRequiresOAuth = true;
      else await showSessionRecovery();
      setStatus(L('vkOauthExplicitRequired'), 'error');
      return { oauthRequired: true };
    }
    clientLog('post_vk_auth_bridge_retry', `${endpoint} len=${bridgeLaunchParams.length}`);
    launchParams = bridgeLaunchParams;
    try {
      data = await api(endpoint, { method: 'POST', body: JSON.stringify({ launchParams, refCode: captureRefCode(), timezone: detectTimezone(), locale: locale() }), ...(linkOnly ? {} : { authToken: '' }) });
    } catch (retryError) {
      if (retryError.status !== 401) throw retryError;
      clientLog('vk_auth_bridge_retry_failed', userSafeErrorMessage(retryError));
      if (linkOnly) state.vkLinkRequiresOAuth = true;
      else await showSessionRecovery();
      setStatus(L('vkOauthExplicitRequired'), 'error');
      return { oauthRequired: true };
    }
  }
  rememberRecoveryNotice(data.recoveryNotice);
  if (linkOnly) {
    state.vkLinkRequiresOAuth = false;
    state.user = data.user;
    renderAll();
    setStatus(L('vkLinked'));
    return data;
  }
  state.token = data.token; state.user = data.user; state.sessionRenewalBlocked = false;
  storage.set('kopilkaToken', state.token); storage.set('kopilkaLocale', data.user.locale || 'ru');
  if ($('loginScreen')) $('loginScreen').hidden = true;
  if ($('appShell')) $('appShell').hidden = false;
  $('connectionStatus').textContent = L('vkSession');
  await loadData();
  setStatus(L('ready'));
  return data;
}

async function authenticate() {
  const inTelegram = Boolean(window.Telegram?.WebApp?.initData);
  const inVk = isVkMiniApp();
  const refCode = captureRefCode();
  if (inVk) {
    await handleVkAuth();
    return;
  }
  if (inTelegram) {
    const initData = window.Telegram.WebApp.initData;
    const data = await api('/api/auth/telegram', { method: 'POST', body: JSON.stringify({ initData, refCode, timezone: detectTimezone() }), authToken: '' });
    rememberRecoveryNotice(data.recoveryNotice);
    state.token = data.token; state.user = data.user; state.sessionRenewalBlocked = false; storage.set('kopilkaToken', state.token); storage.set('kopilkaLocale', data.user.locale || 'ru');
    $('connectionStatus').textContent = L('telegramSession');
    await loadData();
    return;
  }
  if (state.token) {
    try {
      await loadData();
      if ($('appShell')) $('appShell').hidden = false;
      if ($('loginScreen')) $('loginScreen').hidden = true;
      $('connectionStatus').textContent = L('connected');
      return;
    } catch (e) {
      if (e.status === 401) {
        storage.remove('kopilkaToken');
        state.token = '';
      } else {
        const message = e.message || L('actionFailed');
        if ($('appShell')) $('appShell').hidden = false;
        if ($('loginScreen')) $('loginScreen').hidden = true;
        if ($('connectionStatus')) $('connectionStatus').textContent = message;
        setStatus(message, 'error');
        return;
      }
    }
  }
  // Outside Telegram Mini App -> show the site login screen (Telegram / VK).
  await showLoginScreen();
}
async function refreshProduct() { state.product = await api(`/api/product?goal=${encodeURIComponent($('practiceGoal')?.value || 'calm')}`); }
async function loadHistory(date = state.historyDate, focusHeading = false) {
  const query = date ? `?date=${encodeURIComponent(date)}&days=7` : '?days=7';
  const data = await api(`/api/history${query}`);
  state.history = data;
  state.historyDate = data.selectedDate;
  state.historyEditingId = null;
  renderHistory();
  if (focusHeading) $('selectedDayHeading')?.focus({ preventScroll: false });
}
async function saveHistoryEntry(form) {
  const id = Number(form.dataset.historyEditForm);
  const note = new FormData(form).get('note') || '';
  return withBusy(L('saving'), async () => {
    const data = await api(`/api/entries/${id}`, { method: 'PATCH', body: JSON.stringify({ note }) });
    state.summary = data.summary;
    state.week = data.week;
    await loadHistory(state.historyDate, true);
    renderSummary(); renderWeek();
    setStatus(L('historySaved'));
  });
}
async function deleteHistoryEntry(id) {
  if (!window.confirm(L('historyDeleteConfirm'))) return;
  return withBusy(L('saving'), async () => {
    const data = await api(`/api/entries/${id}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) });
    state.summary = data.summary;
    state.week = data.week;
    await loadHistory(state.historyDate, true);
    renderSummary(); renderWeek();
    setStatus(L('historyDeleted'));
  });
}
async function openSupportAction(actionId) {
  return withBusy(L('supportOpening'), async () => {
    const data = await api(`/api/support/actions/${encodeURIComponent(actionId)}/open`, { method: 'POST', body: JSON.stringify({ source: supportSurface() }) });
    state.support = await api(`/api/support/actions?source=${encodeURIComponent(supportSurface())}`);
    renderSupportActions();
    setStatus(L('supportCredited'));
    const url = data.openUrl;
    if (url) {
      try { window.open(url, '_blank', 'noopener'); } catch (_) { window.location.href = url; }
    }
  });
}
async function createEntry(type, note = $('entryNote').value.trim()) {
  let awardedArtifacts = [];
  await withBusy(L('saving'), async () => {
    const data = await api('/api/entries', { method: 'POST', body: JSON.stringify({ type, note }) });
    state.summary = data.summary; state.week = data.week; awardedArtifacts = data.awardedArtifacts || [];
    if (awardedArtifacts.length) state.artifacts = (await api('/api/artifacts')).artifacts || state.artifacts;
    await Promise.all([refreshProduct(), loadHistory()]);
    $('entryNote').value = '';
    if (type === 'gratitude' && $('gratitudeNote')) $('gratitudeNote').value = '';
    renderAll();
  });
  if (awardedArtifacts.length) showArtifactToast(awardedArtifacts);
  else setStatus(type === 'gratitude' ? L('gratitudeSavedStatus') : L('entrySaved'));
}
async function createContract(event) { event.preventDefault(); const payload = Object.fromEntries(new FormData(event.currentTarget).entries()); return withBusy(L('creatingContract'), async () => { const data = await api('/api/contracts', { method: 'POST', body: JSON.stringify(payload) }); state.currentContract = data.contract; await refreshProduct(); renderAll(); setStatus(L('contractCreated')); }); }
async function closeContract(status) {
  let awardedArtifacts = [];
  await withBusy(L('closingContract'), async () => {
    const data = await api(`/api/contracts/${state.currentContract.id}/close`, { method: 'POST', body: JSON.stringify({ status, resultNote: '' }) });
    state.currentContract = null; state.summary = data.summary; state.week = data.week; awardedArtifacts = data.awardedArtifacts || [];
    if (awardedArtifacts.length) state.artifacts = (await api('/api/artifacts')).artifacts || state.artifacts;
    await Promise.all([refreshProduct(), loadHistory()]);
    renderAll();
  });
  if (awardedArtifacts.length) showArtifactToast(awardedArtifacts);
  else setStatus(L('contractClosed'));
}
async function saveSettings(event) { event.preventDefault(); const payload = { timezone: $('timezone').value.trim(), remindersEnabled: $('remindersEnabled').checked, eveningReminderTime: $('eveningReminderTime').value || '20:00' }; return withBusy(L('savingSettings'), async () => { const data = await api('/api/settings/reminders', { method: 'POST', body: JSON.stringify(payload) }); state.user = data.user; renderAll(); setStatus(L('settingsSaved')); }); }
function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
}
async function enableVkReminders() {
  clientLog('vk_reminder_click', `inVk=${isVkMiniApp()} hasBridge=${Boolean(window.vkBridge?.send)}`);
  if (!isVkMiniApp()) throw new Error(L('vkReminderStatusNeedVk'));
  if (!window.vkBridge?.send) {
    clientLog('vk_reminder_no_bridge', navigator.userAgent || '');
    throw new Error(L('vkReminderStatusNeedVk'));
  }
  const cfg = await getPublicConfig();
  clientLog('vk_reminder_config', `group=${Boolean(cfg.vkGroupId)} enabled=${Boolean(cfg.vkMessagesEnabled)}`);
  if (!cfg.vkGroupId || !cfg.vkMessagesEnabled) throw new Error(L('vkReminderDenied'));
  setStatus(L('vkReminderRequesting'));
  let result;
  try {
    result = await withTimeout(window.vkBridge.send('VKWebAppAllowMessagesFromGroup', { group_id: Number(cfg.vkGroupId), key: 'evening_reminders' }), 8000, 'VK permission dialog timeout');
    clientLog('vk_reminder_bridge_result', result || {});
  } catch (error) {
    clientLog('vk_reminder_bridge_error', error || {});
    throw new Error(L('vkReminderDenied'));
  }
  const allowed = result?.result === true || result?.result === 1 || result?.result === '1';
  if (!allowed) {
    clientLog('vk_reminder_not_allowed', JSON.stringify(result || {}).slice(0, 180));
    throw new Error(L('vkReminderDenied'));
  }
  const data = await api('/api/settings/vk-messages', { method: 'POST', body: JSON.stringify({ allowed: true, enableReminders: true }) });
  clientLog('vk_reminder_api_saved', 'ok');
  state.user = data.user;
  renderAll();
  setStatus(L('vkReminderAllowed'));
}
async function setLanguage(lang) { const normalized = I18N.normalizeLocale(lang); storage.set('kopilkaLocale', normalized); if (state.token) { try { const data = await api('/api/settings/locale', { method: 'POST', body: JSON.stringify({ locale: normalized }) }); state.user = data.user; } catch (e) { /* keep local preference */ } } await loadData(); }
async function cleanupDemo() { if (!state.user?.isDemo) { setStatus(L('notDemo'), 'error'); return; } const id = state.user.id; return withBusy(L('deletingDemo'), async () => { await api(`/api/dev/demo-user/${id}`, { method: 'DELETE' }); storage.remove('kopilkaToken'); state.token = ''; state.user = null; state.summary = null; state.week = null; state.currentContract = null; state.support = null; renderAll(); setStatus(L('demoDeleted')); await authenticate(); }); }
async function loadPendingMerge() {
  const mergeToken = storage.get('kopilkaVkMergeToken');
  if (!mergeToken || !state.token) return;
  try {
    const data = await api('/api/account/merge-vk/preview', { method: 'POST', body: JSON.stringify({ mergeToken }) });
    state.pendingMerge = data;
    switchTab('settings');
    renderSettings();
    setStatus(L('mergeNeedsConfirmation'));
  } catch (e) {
    storage.remove('kopilkaVkMergeToken');
    state.pendingMerge = null;
  }
}
async function confirmAccountMerge() {
  const mergeToken = state.pendingMerge?.mergeToken || storage.get('kopilkaVkMergeToken');
  if (!mergeToken) return;
  return withBusy(L('mergeInProgress'), async () => {
    const data = await api('/api/account/merge-vk/confirm', { method: 'POST', body: JSON.stringify({ mergeToken }) });
    storage.remove('kopilkaVkMergeToken');
    state.pendingMerge = null;
    state.user = data.user;
    state.summary = data.summary;
    state.week = data.week;
    await loadData();
    switchTab('settings');
    setStatus(L('mergeDone'));
  });
}
function cancelAccountMerge() {
  storage.remove('kopilkaVkMergeToken');
  state.pendingMerge = null;
  renderSettings();
  setStatus(L('mergeCancelled'));
}
function bindEvents() {
  window.addEventListener('message', (event) => { void receiveVkOAuthHandoff(event); });
  document.querySelector('.tab-bar').addEventListener('click', (event) => { const b = event.target.closest('button[data-tab]'); if (b && !state.busy && !state.publicReadOnly) switchTab(b.dataset.tab); });
  $('historyDate')?.addEventListener('change', async (event) => { if (state.busy || !event.target.value) return; try { await withBusy(L('historyLoading'), () => loadHistory(event.target.value, true)); } catch (e) { setStatus(e.message, 'error'); renderHistory(); } });
  $('historyPrevious')?.addEventListener('click', async () => { if (state.busy || !state.history?.previousDate) return; try { await withBusy(L('historyLoading'), () => loadHistory(state.history.previousDate, true)); } catch (e) { setStatus(e.message, 'error'); } });
  $('historyToday')?.addEventListener('click', async () => { if (state.busy) return; try { await withBusy(L('historyLoading'), () => loadHistory(state.history?.todayDate || '', true)); } catch (e) { setStatus(e.message, 'error'); } });
  $('historyNext')?.addEventListener('click', async () => { if (state.busy || !state.history?.nextDate) return; try { await withBusy(L('historyLoading'), () => loadHistory(state.history.nextDate, true)); } catch (e) { setStatus(e.message, 'error'); } });
  $('historyDays')?.addEventListener('click', async (event) => { const button = event.target.closest('[data-history-date]'); if (!button || state.busy) return; try { await withBusy(L('historyLoading'), () => loadHistory(button.dataset.historyDate, true)); } catch (e) { setStatus(e.message, 'error'); } });
  $('selectedDayEntries')?.addEventListener('click', async (event) => {
    const edit = event.target.closest('[data-history-edit]');
    if (edit && !state.busy) { state.historyEditingId = Number(edit.dataset.historyEdit); renderHistory(); $(`history-note-${state.historyEditingId}`)?.focus(); return; }
    if (event.target.closest('[data-history-cancel]')) { const id = state.historyEditingId; state.historyEditingId = null; renderHistory(); document.querySelector(`[data-history-edit="${id}"]`)?.focus(); return; }
    const remove = event.target.closest('[data-history-delete]');
    if (remove && !state.busy) { try { await deleteHistoryEntry(Number(remove.dataset.historyDelete)); } catch (e) { setStatus(e.message, 'error'); } }
  });
  $('selectedDayEntries')?.addEventListener('submit', async (event) => { const form = event.target.closest('[data-history-edit-form]'); if (!form || state.busy) return; event.preventDefault(); try { await saveHistoryEntry(form); } catch (e) { setStatus(e.message, 'error'); } });
  $('quickActions').addEventListener('click', async (event) => { const b = event.target.closest('button[data-entry-type]'); if (!b || state.busy || state.publicReadOnly) return; if (b.dataset.usedToday === 'true') { b.focus({ preventScroll: true }); return; } state.quickActionReturnType = b.dataset.entryType || ''; try { await createEntry(b.dataset.entryType); } catch (e) { state.quickActionReturnType = ''; setStatus(e.message, 'error'); } });
  $('gratitudePractice')?.addEventListener('click', async (event) => { const hint = event.target.closest('[data-gratitude-hint]'); if (hint && !state.busy && !state.publicReadOnly) { appendGratitudeHint(hint.dataset.gratitudeHint); return; } const b = event.target.closest('[data-gratitude-submit]'); if (!b || state.busy || state.publicReadOnly) return; try { await createEntry('gratitude', $('gratitudeNote')?.value.trim() || ''); } catch (e) { setStatus(e.message, 'error'); } });
  $('supportActionsList')?.addEventListener('click', async (event) => { const b = event.target.closest('button[data-support-open]'); if (!b || state.busy || state.publicReadOnly) return; try { await openSupportAction(b.dataset.supportOpen); } catch (e) { setStatus(e.message, 'error'); } });
  document.querySelectorAll('[data-open-contract]').forEach((btn) => btn.addEventListener('click', () => { if (!state.busy && !state.publicReadOnly) switchTab('contract'); }));
  $('artifactToastClose')?.addEventListener('click', hideArtifactToast);
  $('recoveryNoticeClose')?.addEventListener('click', () => { state.recoveryNotice = null; renderRecoveryNotice(); });
  $('artifactToast')?.addEventListener('keydown', keepArtifactDialogFocus);
  $('contractTemplates').addEventListener('click', (event) => { const b = event.target.closest('button[data-template-id]'); if (b && !state.busy && !state.publicReadOnly) applyTemplate(b.dataset.templateId); });
  $('practiceGoal').addEventListener('change', async (event) => { if (state.busy || state.publicReadOnly) return; try { state.product.practices = await api(`/api/product/practices?goal=${encodeURIComponent(event.target.value)}`); renderPractices(); setStatus(L('practicesUpdated')); } catch (e) { setStatus(e.message, 'error'); } });
  $('contractForm').addEventListener('submit', async (event) => { if (state.publicReadOnly) { event.preventDefault(); return; } try { await createContract(event); } catch (e) { event.preventDefault(); setStatus(e.message, 'error'); } });
  $('contractCurrent').addEventListener('click', async (event) => { const b = event.target.closest('button[data-close-status]'); if (!b || state.busy || state.publicReadOnly) return; try { await closeContract(b.dataset.closeStatus); } catch (e) { setStatus(e.message, 'error'); } });
  $('settingsForm').addEventListener('submit', async (event) => { if (state.publicReadOnly) { event.preventDefault(); return; } try { await saveSettings(event); } catch (e) { event.preventDefault(); setStatus(e.message, 'error'); } });
  document.querySelectorAll('[data-enable-vk-reminders]').forEach((btn) => btn.addEventListener('click', async () => { if (state.busy || state.publicReadOnly) return; try { await withBusy(L('vkReminderRequesting'), enableVkReminders); } catch (e) { setStatus(e.message || L('vkReminderDenied'), 'error'); renderVkReminderOffer(); } }));
  $('accountLinksHeading')?.closest('.summary-card')?.addEventListener('click', async (event) => {
    if (event.target.closest('#confirmAccountMerge')) { try { await confirmAccountMerge(); } catch (e) { setStatus(e.message, 'error'); } }
    if (event.target.closest('#cancelAccountMerge')) cancelAccountMerge();
  });
  $('cleanupDemo').addEventListener('click', async () => { if (state.busy) return; try { await cleanupDemo(); } catch (e) { setStatus(e.message, 'error'); } });
  document.querySelectorAll('[data-lang]').forEach((btn) => btn.addEventListener('click', async () => { if (state.busy) return; try { await setLanguage(btn.dataset.lang); setStatus(L('settingsSaved')); } catch (e) { setStatus(e.message, 'error'); } }));
  const vkBtn = $('vkLoginButton');
  if (vkBtn) vkBtn.addEventListener('click', async () => {
    vkBtn.disabled = true;
    vkBtn.textContent = L('loginVkSoon');
    try { await startVkOAuth('auth', $('loginStatus')); } catch (e) { setLoginStatus(userSafeErrorMessage(e), 'error'); vkBtn.disabled = false; vkBtn.textContent = L('loginVkButton'); }
  });
  const linkVkBtn = $('linkVkAccount');
  if (linkVkBtn) linkVkBtn.addEventListener('click', async () => {
    if (state.busy) return;
    const vkStatus = $('vkLinkStatus');
    linkVkBtn.disabled = true;
    if (vkStatus) vkStatus.textContent = L('vkLinking');
    setStatus(L('vkLinking'));
    try {
      if (state.vkLinkRequiresOAuth || !isVkMiniApp()) {
        await startVkOAuth('link', vkStatus);
      } else {
        const result = await withBusy(L('vkLinking'), () => handleVkAuth({ linkOnly: true }));
        if (result?.oauthRequired) {
          linkVkBtn.disabled = false;
          linkVkBtn.textContent = L('vkOauthOpenLink');
        }
      }
    } catch (e) {
      if (e.data?.mergeRequired) {
        state.pendingMerge = { preview: e.data.preview, mergeToken: e.data.mergeToken };
        storage.set('kopilkaVkMergeToken', e.data.mergeToken);
        renderSettings();
        switchTab('settings');
        setStatus(L('mergeNeedsConfirmation'));
        return;
      }
      const message = userSafeErrorMessage(e);
      if (vkStatus) vkStatus.textContent = message;
      setStatus(message, 'error');
      linkVkBtn.disabled = false;
    }
  });
  const copyBtn = $('copyRefLink');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    const link = $('refLink')?.value;
    if (!link) return;
    if (await copyText(link)) setStatus(L('copied'));
    else showManualShare(link, 'copyFailed');
  });
  async function copyText(value) {
    try {
      if (!navigator.clipboard?.writeText) return false;
      await navigator.clipboard.writeText(value);
      return true;
    } catch (error) {
      clientLog('clipboard_write_failed', userSafeErrorMessage(error));
      return false;
    }
  }
  function showManualShare(url, statusKey = 'copyFailed') {
    const box = $('shareFallback');
    const input = $('shareFallbackLink');
    if (!box || !input || !url) { setStatus(L(statusKey), 'error'); return; }
    box.hidden = false;
    input.value = url;
    input.focus();
    input.select();
    setStatus(L(statusKey), 'error');
  }
  async function shareUrl(url, text) {
    if (!url) { setStatus(L('shareUnavailable'), 'error'); return; }
    if ($('shareFallback')) $('shareFallback').hidden = true;
    const inTelegram = Boolean(window.Telegram?.WebApp?.initData);
    const tg = window.Telegram?.WebApp;
    if (isVkMiniApp() && window.vkBridge?.send) {
      try {
        await window.vkBridge.send('VKWebAppShare', { link: url, text: text || '' });
        setStatus(L('shareOpened'));
        return;
      } catch (error) { clientLog('vk_share_failed', userSafeErrorMessage(error)); }
    }
    if (inTelegram && tg && tg.switchInlineQuery) {
      try { tg.switchInlineQuery(`${text} ${url}`, ['users', 'groups', 'channels']); setStatus(L('shareOpened')); return; } catch (error) { clientLog('telegram_inline_share_failed', userSafeErrorMessage(error)); }
    }
    if (navigator.share) {
      try { await navigator.share({ title: L('appName'), text, url }); setStatus(L('shareCompleted')); return; }
      catch (error) {
        clientLog('native_share_failed', userSafeErrorMessage(error));
        showManualShare(url, error?.name === 'AbortError' ? 'shareCancelled' : 'copyFailed');
        return;
      }
    }
    if (inTelegram && tg && tg.openTelegramLink) {
      try {
        const telegramShareUrl = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text || '')}`;
        tg.openTelegramLink(telegramShareUrl, { force_request: true });
        setStatus(L('shareOpened'));
        return;
      } catch (error) { clientLog('telegram_link_share_failed', userSafeErrorMessage(error)); }
    }
    if (await copyText(url)) setStatus(L('copied'));
    else showManualShare(url, 'copyFailed');
  }
  const shareRefBtn = $('shareRefLink');
  if (shareRefBtn) shareRefBtn.addEventListener('click', () => {
    const inBot = Boolean(window.Telegram?.WebApp?.initData);
    const inVk = isVkMiniApp();
    const url = state.profile ? (inVk ? (state.profile.vkRefLink || state.profile.refLink || '') : (inBot ? (state.profile.botLink || '') : (state.profile.refLink || ''))) : '';
    void shareUrl(url, L('shareRefText'));
  });
  const shareBtn = $('shareProfile');
  if (shareBtn) shareBtn.addEventListener('click', () => {
    const inVk = isVkMiniApp();
    const url = state.profile ? (inVk ? (state.profile.vkProfileLink || state.profile.profileLink || '') : (state.profile.profileLink || '')) : '';
    void shareUrl(url, L('shareProfileText'));
  });
}
async function start() {
  const inTelegram = Boolean(window.Telegram?.WebApp?.initData);
  const inVk = isVkMiniApp();
  if (inTelegram || inVk) { if ($('appShell')) $('appShell').hidden = false; if ($('loginScreen')) $('loginScreen').hidden = true; }
  renderQuickActions(); applyStaticI18n();
  try {
    window.Telegram?.WebApp?.ready?.();
    await authenticate();
    await loadPendingMerge();
    setStatus(state.pendingMerge ? L('mergeNeedsConfirmation') : L('ready'));
  } catch (e) {
    const detail = userSafeErrorMessage(e, inVk ? 'vkOpenFromVk' : 'openFromTelegram');
    clientLog('start_error', detail);
    if (inVk || inTelegram) {
      await showLoginScreen({ landing: false });
      const loginStatus = $('loginStatus');
      if (loginStatus) { loginStatus.textContent = detail || L('connectFailed'); loginStatus.classList.add('error'); }
      return;
    }
    $('connectionStatus').textContent = detail || L('connectFailed');
    setStatus(detail || L('connectFailed'), 'error');
  }
}
// The Telegram WebApp SDK may not be ready when app.js first runs; retry the
// in-Telegram check until initData appears (or a longer timeout). A Mini App
// opening inside Telegram must never be misread as a plain site.
function waitForTelegram(maxTries = 200) {
  return new Promise((resolve) => {
    if (window.Telegram?.WebApp?.initData) return resolve(true);
    let tries = 0;
    const timer = setInterval(() => {
      if (window.Telegram?.WebApp?.initData) { clearInterval(timer); return resolve(true); }
      if (++tries >= maxTries) { clearInterval(timer); return resolve(false); }
    }, 50);
  });
}
// Public profile page: /p/CODE shows someone's public stats (no personal notes).
async function renderPublicProfile(code, options = {}) {
  try {
    const { profile } = await api(`/api/public/${encodeURIComponent(code)}`);
    if (!profile) throw new Error('not found');
    const readOnly = options.readOnly !== false;
    setPublicReadOnlyMode(readOnly);
    const n = profile.activeReferred || 0;
    state.publicStatus = `${L('publicProfileIntro')} ${profile.firstName}`;
    const status = $('connectionStatus');
    if (status) status.textContent = state.publicStatus;
    $('appShell').hidden = false;
    $('loginScreen').hidden = true;
    document.querySelectorAll('.screen-panel').forEach((p) => { p.hidden = p.id !== 'tab-profile'; });
    if ($('profileNameHeading')) $('profileNameHeading').textContent = profile.firstName;
    const heart = document.querySelector('.badge-heart');
    const count = document.querySelector('.badge-heart-count');
    if (heart) { heart.setAttribute('data-size', badgeSize(n)); heart.setAttribute('aria-label', `${L('publicBadgeLabel')} ${n}`); }
    if (count) count.textContent = n;
    const total = $('partnerTotal'); const active = $('partnerActive');
    if (total) total.textContent = profile.totalReferred || 0;
    if (active) active.textContent = n;
    if ($('refLink')) $('refLink').value = `${window.location.origin}/p/${profile.refCode}`;
    // Public stats without texts.
    const today = profile.today || {}; const week = profile.week || {};
    const statsBox = $('publicStats') || (() => { const box = document.createElement('div'); box.id = 'publicStats'; box.className = 'summary-card'; document.getElementById('tab-profile').appendChild(box); return box; })();
    statsBox.innerHTML = `<h2>${escapeHtml(L('publicToday'))}: ${today.todayLife || 0} ${escapeHtml(L('life'))}</h2><h2>${escapeHtml(L('publicWeek'))}: ${week.weekLife || 0} ${escapeHtml(L('life'))}, ${week.activeDays || 0} ${escapeHtml(L('publicActiveDays'))}</h2><p class="soft-note">${escapeHtml(L('publicLoginHint'))}</p><button type="button" id="publicLoginCta">${escapeHtml(L('publicLoginCta'))}</button>`;
    const cta = $('publicLoginCta');
    if (cta) cta.addEventListener('click', async () => {
      if (isVkMiniApp() || window.Telegram?.WebApp?.initData) { await start(); return; }
      await showLoginScreen();
    });
    if (status) status.textContent = state.publicStatus;
    return true;
  } catch (_) {
    $('connectionStatus').textContent = L('publicProfileNotFound');
    await showLoginScreen();
    return false;
  }
}
(async () => {
  fireVkBridgeInit();
  bindEvents(); // bind buttons in every context (site, public profile, Mini App)
  const explicitVkOAuthReturn = new URLSearchParams(window.location.search || '').has('vk_oauth_return');
  const consumedVkOAuth = explicitVkOAuthReturn && await consumeVkOAuthResult();
  if (consumedVkOAuth) { if ($('appShell')) $('appShell').hidden = false; if ($('loginScreen')) $('loginScreen').hidden = true; await start(); return; }
  const inVk = isVkMiniApp();
  clientLog('bootstrap', `inVk=${inVk} hasSearch=${Boolean(window.location.search)} hasHash=${Boolean(window.location.hash)} token=${Boolean(state.token)}`);
  if (inVk) { if ($('appShell')) $('appShell').hidden = false; if ($('loginScreen')) $('loginScreen').hidden = true; }
  // In VK Mini App, a referral link can arrive as a hash payload (#ref=CODE or
  // hash=ref=CODE). Treat it only as signup attribution and always enter the
  // signed VK auth flow first. If we try public-profile routing before auth,
  // repeated referral opens in VK Android can stop before /api/auth/vk.
  if (inVk) { captureRefCode(); await start(); return; }
  const hasTelegramInitData = Boolean(window.Telegram?.WebApp?.initData);
  const looksLikeTelegramLaunch = hasTelegramInitData || Boolean(new URLSearchParams(window.location.search || '').get('tgWebAppData'));
  const telegramReady = await waitForTelegram(looksLikeTelegramLaunch ? 200 : 40);
  const inTelegram = Boolean(telegramReady && window.Telegram?.WebApp?.initData);
  if (inTelegram) {
    if ($('appShell')) $('appShell').hidden = false;
    if ($('loginScreen')) $('loginScreen').hidden = true;
    await start();
    return;
  }
  if (looksLikeTelegramLaunch) { await showLoginScreen({ landing: false }); return; }
  const bridgeLaunchParams = await freshVkBridgeLaunchParams();
  if (bridgeLaunchParams) {
    state.vkBridgeLaunchParams = bridgeLaunchParams;
    if ($('appShell')) $('appShell').hidden = false;
    if ($('loginScreen')) $('loginScreen').hidden = true;
    await start();
    return;
  }
  const publicCode = publicProfileCode();
  if (publicCode) {
    captureRefCode();
    if (state.token) {
      try { await start(); await renderPublicProfile(publicCode, { readOnly: false }); applyStaticI18n(); setPublicReadOnlyMode(false); return; } catch (_) { /* fall through to read-only public profile */ }
    }
    if (await renderPublicProfile(publicCode, { readOnly: true })) { applyStaticI18n(); setPublicReadOnlyMode(true); return; }
  }
  if (state.token) {
    if ($('appShell')) $('appShell').hidden = false;
    if ($('loginScreen')) $('loginScreen').hidden = true;
    await start();
    return;
  }
  await showLoginScreen();
})().catch((error) => {
  const msg = userSafeErrorMessage(error, 'connectFailed');
  clientLog('bootstrap_error', msg);
  try {
    if ($('appShell')) $('appShell').hidden = false;
    if ($('loginScreen')) $('loginScreen').hidden = true;
    if ($('connectionStatus')) $('connectionStatus').textContent = msg;
    setStatus(msg, 'error');
  } catch (_) { /* diagnostics only */ }
});
// Surface any runtime JS error into the status region so it is visible/audible
// (helps a11y users and makes client-side failures diagnosable).
window.addEventListener('error', (event) => {
  const msg = userSafeErrorMessage(event.error || event.message, 'connectFailed');
  try { if ($('connectionStatus')) $('connectionStatus').textContent = msg; if (window.__kopilkaSetDiag) window.__kopilkaSetDiag(msg); } catch (_) {}
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason || {};
  const msg = userSafeErrorMessage(reason, 'connectFailed');
  try { if ($('connectionStatus')) $('connectionStatus').textContent = msg; setStatus(msg, 'error'); if (window.__kopilkaSetDiag) window.__kopilkaSetDiag(msg); } catch (_) {}
});
