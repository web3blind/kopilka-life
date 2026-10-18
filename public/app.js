window.KopilkaStartup?.mark('app-executed');
const I18N = window.KopilkaI18n;
const CLIENT_VERSION = '20261007-testers-fixes6';
const storage = {
  get(key) { try { return window.localStorage?.getItem(key) || ''; } catch (_) { return ''; } },
  set(key, value) { try { window.localStorage?.setItem(key, value); } catch (_) { /* storage may be unavailable in some WebViews */ } },
  remove(key) { try { window.localStorage?.removeItem(key); } catch (_) { /* storage may be unavailable in some WebViews */ } }
};
const locale = () => I18N.normalizeLocale(state.user?.locale || storage.get('kopilkaLocale') || 'ru');
const L = (key, params) => I18N.t(locale(), key, params);

const state = { settingsDirty: false, refreshFailed: false, lastRefresh: 0, refreshPending: false, pendingQuickAfterRefresh: null, token: storage.get('kopilkaToken') || '', user: null, summary: null, week: null, history: null, historyDate: '', historyEditingId: null, currentContract: null, product: null, profile: null, publicProfileTarget: null, artifacts: [], artifactQueue: [], support: null, activeTab: 'today', busy: false, publicReadOnly: false, publicStatus: '', pendingMerge: null, recoveryNotice: null, artifactReturnFocus: null, quickActionReturnType: '', quickActionReturnButton: null, sessionRenewalPromise: null, sessionRenewalBlocked: false, vkBridgeLaunchParams: '', vkOAuthWindow: null, vkOAuthChannel: '', vkOAuthAction: '', vkOAuthMonitor: null, vkLinkRequiresOAuth: false };
// Some embedded WebViews omit :active during a held touch. Track only the
// touched control, without cancelling gestures or changing keyboard focus.
(() => {
  if (!window.PointerEvent || typeof document.addEventListener !== 'function') return;
  let pressed = null;
  let pointerId = null;
  const clear = () => { pressed?.removeAttribute('data-touch-pressed'); pressed = null; pointerId = null; };
  document.addEventListener('pointerdown', (event) => {
    if (!['touch', 'pen'].includes(event.pointerType) || !event.isPrimary) return;
    clear();
    const button = event.target.closest?.('button');
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
    pressed = button; pointerId = event.pointerId;
    button.setAttribute('data-touch-pressed', 'true');
  }, { capture: true, passive: true });
  for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, (event) => {
    if (event.pointerId === pointerId) clear();
  }, { capture: true, passive: true });
  document.addEventListener('pointermove', (event) => {
    if (!pressed || event.pointerId !== pointerId) return;
    const r = pressed.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) clear();
  }, { capture: true, passive: true });
  document.addEventListener('scroll', clear, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); });
  window.addEventListener('blur', clear);
})();
let preparedDayStory = null; // Short-lived URL, never stored across sessions.
let vkAuthRetryAt = 0;
let vkAuthCooldownTimer = null;
let vkStartupRetry = false;
function vkAuthCoolingDown() { return Date.now() < vkAuthRetryAt; }
function updateVkAuthCooldown() {
  const seconds = Math.max(0, Math.ceil((vkAuthRetryAt - Date.now()) / 1000));
  for (const [buttonId, statusId] of [['vkLoginButton', 'loginStatus'], ['linkVkAccount', 'vkLinkStatus']]) {
    const button = $(buttonId);
    if (button && !state.vkOAuthWindow) button.disabled = seconds > 0;
    const status = $(statusId);
    if (status && (seconds > 0 || vkAuthCooldownTimer)) status.textContent = seconds > 0 ? L('vkAuthCooldown').replace('{seconds}', seconds) : L('vkAuthRetryReady');
  }
  if (!seconds && vkAuthCooldownTimer) { clearInterval(vkAuthCooldownTimer); vkAuthCooldownTimer = null; }
}
function beginVkAuthCooldown(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  vkAuthRetryAt = Math.max(vkAuthRetryAt, Date.now() + seconds * 1000);
  if (!vkAuthCooldownTimer) vkAuthCooldownTimer = setInterval(updateVkAuthCooldown, 500);
  updateVkAuthCooldown();
}
let authEpoch = 0;
const activeRequests = new Set();
function clearPendingAuth() {
  for (const key of ['googleOAuthMonitor', 'vkOAuthMonitor']) window.clearInterval(state[key]);
  for (const key of ['googleOAuthWindow', 'vkOAuthWindow']) {
    const popup = state[key];
    state[key] = null;
    try { if (popup && popup !== window && !popup.closed) popup.close(); } catch (_) { /* cross-origin popup */ }
  }
  state.googleOAuthChannel = ''; state.googleOAuthAction = '';
  clearVkOAuthPending();
  for (const key of ['kopilkaGoogleOAuthHandoff', 'kopilkaVkOAuthHandoff']) {
    try { sessionStorage.removeItem(key); } catch (_) { /* restricted storage */ }
  }
}
async function retireBrowserPush(token) {
  const bounded = async (operation, milliseconds = 200) => {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('push cleanup timeout')), milliseconds);
      })]);
    } finally { clearTimeout(timer); }
  };
  let registration;
  try {
    registration = await bounded(() => navigator.serviceWorker?.getRegistration('/'));
    if (!registration) return true;
    const subscription = await bounded(() => registration.pushManager.getSubscription());
    // Server removal and browser retirement are independent; never retain a bearer
    // for later retries. Signed-out retries perform only local browser cleanup.
    const remote = subscription && token ? fetch('/api/settings/push', {
      method: 'DELETE', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ endpoint: subscription.endpoint }), signal: AbortSignal.timeout(450)
    }).catch(() => {}) : Promise.resolve();
    try {
      if (subscription && !await bounded(() => subscription.unsubscribe())) throw new Error('unsubscribe failed');
    } catch (_) { if (!await bounded(() => registration.unregister())) return false; }
    try { for (const notice of await bounded(() => registration.getNotifications?.(), 100) || []) notice.close(); } catch (_) { /* subscription already retired */ }
    await remote;
    return true;
  } catch (_) {
    try { return Boolean(await bounded(() => registration?.unregister())); } catch (_) { return false; }
  }
}
async function signOutWebsite() {
  if (!state.user || state.publicReadOnly || !outsideMiniApp()) return;
  const token = state.token;
  authEpoch++;
  clearHistoryEditor();
  for (const controller of activeRequests) controller.abort();
  clearPendingAuth();
  storage.set('kopilkaLogoutEpoch', `${Date.now()}-${Math.random()}`);
  storage.set('kopilkaPushRetirePending', '1');
  for (const key of ['kopilkaToken', 'kopilkaVkMergeToken', 'kopilkaLastAuthError', 'kopilkaPushOwner']) storage.remove(key);
  preparedDayStory = null;
  for (const key of ['user', 'summary', 'week', 'history', 'currentContract', 'product', 'profile', 'support', 'pendingMerge', 'recoveryNotice', 'pendingQuickAfterRefresh']) state[key] = null;
  state.token = ''; state.sessionRenewalBlocked = true; state.settingsDirty = false;
  state.artifacts = []; state.artifactQueue = [];
  $('appShell').hidden = true;
  $('artifactToast').hidden = true;
  // A fresh document discards all private DOM, editor drafts, navigation state
  // and async closures. No account/identity/history deletion or platform logout.
  await Promise.race([retireBrowserPush(token).then(retired => { if (retired) storage.remove('kopilkaPushRetirePending'); }), new Promise(resolve => setTimeout(resolve, 1000))]);
  window.location.replace('/?signed_out=1');
}
window.addEventListener('storage', event => {
  if (event.key !== 'kopilkaLogoutEpoch' || !outsideMiniApp()) return;
  authEpoch++;
  for (const controller of activeRequests) controller.abort();
  clearPendingAuth();
  state.token = ''; setVerifiedUser(null);
  $('appShell').hidden = true;
  window.location.replace('/?signed_out=1');
});
let pendingInstallPrompt = null;
function outsideMiniApp() {
  return !isVkMiniApp() && window.vkBridge?.isWebView?.() !== true &&
    !window.Telegram?.WebApp?.initData && !window.TelegramWebviewProxy &&
    !/(?:^|[?#&])tgWebApp(?:Data|Platform)=/.test(location.search + location.hash);
}
function setVkAttributionVisibility() {
  const inVk = isVkMiniApp();
  for (const id of ['loginIpAttribution', 'appIpAttribution']) {
    const element = $(id);
    if (element) element.hidden = inVk;
  }
}
function renderInstallOffer() {
  const section = $('installAppSection');
  if (!section) return;
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const website = Boolean(state.user && !state.publicReadOnly && outsideMiniApp() && !installed);
  const android = /Android/i.test(navigator.userAgent);
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const desktopChrome = !android && !ios && /\b(?:Chrome|Chromium)\//i.test(navigator.userAgent) &&
    !/\b(?:Edg|OPR)\//i.test(navigator.userAgent);
  $('installAppButton').hidden = !(website && pendingInstallPrompt);
  $('installAppAndroidHint').hidden = !(website && android && !pendingInstallPrompt);
  $('installAppDesktopHint').hidden = !(website && desktopChrome && !pendingInstallPrompt);
  $('installAppIosHint').hidden = !(website && ios);
  const supported = Boolean(android || ios || desktopChrome || pendingInstallPrompt);
  section.hidden = !(website && supported);
  const home = $('installHomeOffer');
  if (!home) return;
  const showHome = website && supported && storage.get('kopilkaInstallHomeDismissed') !== '1';
  $('installHomeButton').hidden = !(showHome && pendingInstallPrompt);
  $('installHomeAndroidHint').hidden = !(showHome && android && !pendingInstallPrompt);
  $('installHomeDesktopHint').hidden = !(showHome && desktopChrome && !pendingInstallPrompt);
  $('installHomeIosHint').hidden = !(showHome && ios);
  home.hidden = !showHome;
}
window.addEventListener('beforeinstallprompt', (event) => {
  if (!outsideMiniApp()) return;
  event.preventDefault();
  pendingInstallPrompt = event;
  renderInstallOffer();
});
window.addEventListener('appinstalled', () => { pendingInstallPrompt = null; renderInstallOffer(); });
function telegramDayStorySupported() {
  const tg = window.Telegram?.WebApp;
  return Boolean(tg?.initData && typeof tg.shareToStory === 'function' &&
    typeof tg.showPopup === 'function' && tg.isVersionAtLeast?.('7.8'));
}
function daySceneDate() {
  return new Intl.DateTimeFormat(locale() === 'ru' ? 'ru-RU' : 'en-US',
    { dateStyle: 'long', timeZone: state.user?.timezone || 'UTC' }).format(new Date());
}
function daySceneStoryKey() {
  return JSON.stringify([state.user?.id || null, locale(), daySceneDate(), [...(state.summary?.todayEntryTypes || [])].sort()]);
}
function preparedDayStoryReady() {
  return preparedDayStory?.key === daySceneStoryKey() && preparedDayStory.expiresAt > Date.now();
}
function applyVkStatusTop() {
  if (new URLSearchParams(window.location.search).get('vk_platform') !== 'mobile_android') return;
  const root = document.documentElement;
  const currentTop = parseFloat(window.getComputedStyle(root).getPropertyValue('--vk-status-top')) || 0;
  root.style.setProperty('--vk-status-top', `${Math.max(64, currentTop)}px`);
}
function fireVkBridgeInit() {
  try {
    applyVkStatusTop();
    if (!vkLaunchParams()) return;
    return window.KopilkaStartup?.initVkBridge?.();
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
    fetch('/api/client-log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload,
      mode: 'same-origin', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', keepalive: true
    }).catch(() => {});
  } catch (_) { /* diagnostics only */ }
}
const $ = (id) => document.getElementById(id);
// Detect the user's timezone from their device clock (IANA zone), fallback UTC.
function detectTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; }
}
// Capture attribution from referral launches and public-profile launches. The
// latter is also parsed separately by publicProfileCode() for display routing.
function captureRefCode() {
  try {
    const sp = String(window.Telegram?.WebApp?.initDataUnsafe?.start_param || '');
    const profileStart = /^profile-([A-Za-z0-9]{4,24})$/.exec(sp);
    const tgRef = referralLikeCode(profileStart ? profileStart[1] : sp);
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
    const startParam = String(window.Telegram?.WebApp?.initDataUnsafe?.start_param || '');
    const telegramMatch = /^profile-([A-Za-z0-9]{4,24})$/.exec(startParam);
    if (telegramMatch) return referralLikeCode(telegramMatch[1]);
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
  if (!window.vkBridge?.send || window.vkBridge.isWebView?.() === false) return '';
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
  const init = fireVkBridgeInit();
  try {
    if (!init) return;
    await Promise.race([
      init,
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
async function startGoogleOAuth(action) {
  // Open synchronously during the click: VK runs the app inside an iframe and
  // Google forbids its sign-in page there. The first-party popup owns the cookie.
  const popup = window.open('/api/auth/google/window', '_blank', 'popup,width=520,height=720');
  if (!popup) throw new Error('Разреши всплывающее окно и попробуй снова.');
  state.googleOAuthWindow = popup;
  state.googleOAuthAction = action;
  try {
    const { launchUrl, channel } = await api('/api/auth/google/start', {
      method: 'POST', authToken: action === 'link' ? state.token : '',
      body: JSON.stringify(action === 'link' ? { link: true } : { refCode: captureRefCode(), timezone: detectTimezone(), locale: locale() })
    });
    const target = new URL(launchUrl);
    if (target.origin !== window.location.origin || target.pathname !== '/api/auth/google/authorize' || !target.searchParams.get('intent') || !channel) throw new Error(L('loginFailed'));
    state.googleOAuthChannel = channel;
    if (popup.closed) throw new Error('Окно входа закрыто. Попробуй снова.');
    popup.location.replace(target.href);
    state.googleOAuthMonitor = window.setInterval(() => {
      if (state.googleOAuthWindow !== popup) { window.clearInterval(state.googleOAuthMonitor); return; }
      if (!popup.closed) return;
      window.clearInterval(state.googleOAuthMonitor);
      state.googleOAuthWindow = null; state.googleOAuthChannel = '';
      $(action === 'link' ? 'linkGoogleAccount' : 'googleLoginButton').disabled = false;
    }, 500);
  } catch (error) {
    if (!popup.closed) popup.close();
    state.googleOAuthWindow = null; state.googleOAuthChannel = '';
    throw error;
  }
}
async function receiveGoogleOAuthHandoff(event) {
  const payload = event.data;
  if (event.origin !== window.location.origin || event.source !== state.googleOAuthWindow ||
      payload?.type !== 'kopilka:google-oauth' || !state.googleOAuthChannel || payload.channel !== state.googleOAuthChannel) return;
  event.source.postMessage({ type: 'kopilka:google-oauth-ack', channel: payload.channel }, event.origin);
  if (state.googleOAuthMonitor) window.clearInterval(state.googleOAuthMonitor);
  const action = state.googleOAuthAction;
  state.googleOAuthWindow = null; state.googleOAuthChannel = '';
  $(action === 'link' ? 'linkGoogleAccount' : 'googleLoginButton').disabled = false;
  if (payload.error) { (action === 'link' ? setStatus : setLoginStatus)(payload.error, 'error'); return; }
  if (action === 'link' && payload.mergeRequired) { showIdentityMerge(payload); return; }
  if (action === 'link' && payload.linked) { await refreshLinkedLogins(); setStatus(L('googleLinkDone')); return; }
  if (action === 'auth' && payload.token) {
    state.token = payload.token; state.sessionRenewalBlocked = false;
    storage.set('kopilkaToken', payload.token);
    await start();
  }
}
window.addEventListener('message', (event) => { void receiveGoogleOAuthHandoff(event); });
async function startVkOAuth(action = 'auth', statusEl = null) {
  if (vkAuthCoolingDown()) { updateVkAuthCooldown(); return; }
  clearVkOAuthPending();
  state.vkOAuthAction = action === 'link' ? 'link' : 'auth';
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  state.vkOAuthChannel = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  let popup = null;
  try {
    // The first-party popup clears this one-shot name before creating its
    // intent. Unlike sessionStorage cloning, this also works across partitions.
    const bootstrap = JSON.stringify({
      action: state.vkOAuthAction, channel: state.vkOAuthChannel, createdAt: Date.now(),
      token: action === 'link' ? state.token : '', refCode: captureRefCode(), timezone: detectTimezone(), locale: locale()
    });
    popup = window.open('/api/auth/vk-oauth/window', bootstrap, 'popup,width=520,height=720');
  } catch (_) { popup = null; }
  if (popup) state.vkOAuthWindow = popup;
  try {
    if (popup && !popup.closed) {
      if (statusEl) statusEl.textContent = L('loginVkSoon');
      // Native hosts may reparent the popup and never update WindowProxy.closed.
      // Bound only this UI wait (not a provider cooldown); detach correlation so
      // a late result cannot sign in after the person has retried/cancelled.
      const deadline = Date.now() + 120000;
      const channel = state.vkOAuthChannel;
      const monitor = window.setInterval(() => {
        if (state.vkOAuthWindow !== popup || state.vkOAuthChannel !== channel) return window.clearInterval(monitor);
        const closed = popup.closed;
        if (!closed && Date.now() < deadline) return;
        const pendingAction = state.vkOAuthAction;
        clearVkOAuthPending();
        restoreVkOAuthAction(pendingAction, L(closed ? 'vkOauthCancelled' : 'vkOauthStartFailed'));
      }, 500);
      state.vkOAuthMonitor = monitor;
    } else {
      const intent = await getVkOAuthIntent(action);
      state.vkOAuthChannel = intent.channel;
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
  document.querySelectorAll('[data-own-profile]').forEach((el) => { el.hidden = state.publicReadOnly; });
  if ($('shareFallback')) $('shareFallback').hidden = true;
  if (!state.publicReadOnly) {
    $('publicStats')?.remove();
    state.publicProfileTarget = null; state.publicStatus = '';
  }
  const nav = document.querySelector('.tab-bar');
  if (nav) nav.hidden = state.publicReadOnly;
  ['copyRefLink', 'shareRefLink'].forEach((id) => { const el = $(id); if (el) el.hidden = state.publicReadOnly; });
  const shareProfile = $('shareProfile');
  if (shareProfile) shareProfile.hidden = false;
  const shareStory = $('shareStory');
  if (shareStory) shareStory.hidden = state.publicReadOnly;
  const artifactsSection = $('artifactsSection');
  if (artifactsSection) artifactsSection.hidden = state.publicReadOnly;
  const linkLabel = document.querySelector('label[for="refLink"]');
  if (linkLabel) linkLabel.textContent = state.publicReadOnly ? L('profileLinkLabel') : L('refLinkLabel');
  if ($('partnerHeading')) $('partnerHeading').textContent = state.publicReadOnly ? L('profileLinkLabel') : L('partnerHeading');
  const hint = $('refLinkHint');
  if (hint) hint.textContent = state.publicReadOnly ? L('profileLinkHint') : L('refLinkHint');
}
let statusRevision = 0;
let statusCategory = 'info';
let statusReturnFocus = null;
// A late Ready publisher in the same startup must not undo a user's dismissal.
let readyNoticeDismissed = false;
function transientStatusDismissible() {
  return ['ready', 'entry-success'].includes(statusCategory) && !state.busy && !state.refreshFailed &&
    !state.pendingMerge && !state.sessionRenewalPromise && !state.sessionRenewalBlocked &&
    Boolean(state.user) && !$('appShell')?.hidden && Boolean($('statusRegion')?.textContent);
}
function readyStatusDismissible() {
  return statusCategory === 'ready' && !state.busy && !state.refreshFailed &&
    !state.pendingMerge && !state.sessionRenewalPromise && !state.sessionRenewalBlocked &&
    Boolean(state.user) && !$('appShell')?.hidden && Boolean($('statusRegion')?.textContent);
}
function syncStatusDismiss() {
  const button = $('dismissStatus');
  if (!button) return; // Older shells keep their mounted live region.
  button.textContent = `× ${L('dismissNotification')}`;
  button.setAttribute('aria-label', L('dismissNotification'));
  button.hidden = !readyStatusDismissible();
  button.disabled = button.hidden;
  const revision = statusRevision;
  button.onclick = () => {
    if (revision !== statusRevision || !readyStatusDismissible()) return;
    const restoreFocus = document.activeElement === button;
    readyNoticeDismissed = true;
    $('statusRegion').textContent = '';
    statusCategory = 'dismissed';
    statusRevision++;
    syncStatusDismiss();
    if (restoreFocus) {
      const prior = statusReturnFocus;
      const safe = prior && prior !== document.body && prior !== document.documentElement &&
        document.contains(prior) && !prior.disabled &&
        !prior.closest?.('[hidden], [inert]') && prior.getClientRects?.().length;
      (safe ? prior : document.querySelector('.tab-bar button[aria-selected="true"]'))?.focus?.({ preventScroll: true });
    }
  };
}
let supportActionNotice = null;
function captureSupportStatus() {
  if (statusCategory === 'support-action-error' && supportActionNotice) return supportActionNotice;
  return { text: $('statusRegion').textContent, type: ['error', 'support-action-error'].includes(statusCategory) ? 'error' : 'info', category: statusCategory, refreshFailed: state.refreshFailed };
}
function setSupportActionError(text, previous) {
  // Auth/refresh may publish a durable warning while the action is pending.
  if (statusCategory === 'error') previous = captureSupportStatus();
  state.refreshFailed ||= previous.refreshFailed;
  if (state.activeTab !== 'support') return;
  supportActionNotice = previous;
  setStatus(text, 'error', 'support-action-error');
}
function clearSupportActionError() {
  if (statusCategory !== 'support-action-error') return;
  const previous = supportActionNotice;
  supportActionNotice = null;
  setStatus(previous?.text || '', previous?.type || 'info', previous?.category || 'info');
}
let copyStatusPrevious = null;
function setStatus(text, type = 'info', category = 'info') {
  if (category === 'ready' && type !== 'error' && readyNoticeDismissed) return;
  const durable = statusCategory === 'copy' ? copyStatusPrevious
    : statusCategory === 'error' || statusCategory === 'support-action-error'
      ? { text: $('statusRegion').textContent, category: statusCategory } : null;
  copyStatusPrevious = category === 'copy' && type !== 'error' ? durable : null;
  statusRevision++;
  statusCategory = category === 'support-action-error' ? category : type === 'error' ? 'error' : category;
  const active = document.activeElement;
  if (category === 'ready' && active !== $('dismissStatus')) statusReturnFocus = active;
  const region = $('statusRegion');
  region.textContent = text + (state.refreshFailed && type !== 'error' && !text.includes(L('refreshPending')) ? ` ${L('refreshPending')}` : '');
  region.classList.toggle('error', type === 'error');
  syncStatusDismiss();
  if (['ready', 'entry-success'].includes(category) && type !== 'error' && !state.refreshFailed) {
    const revision = statusRevision;
    setTimeout(() => {
      // Never erase a newer action, unsaved draft notice, auth or refresh warning.
      if (revision !== statusRevision || !transientStatusDismissible()) return;
      if (category === 'ready' && $('dismissStatus')) $('dismissStatus').onclick?.();
      else setStatus('');
    }, 5000);
  }
  if (category === 'copy' && type !== 'error') {
    const revision = statusRevision;
    setTimeout(() => {
      // A later action, error or warning owns the live region now.
      if (revision !== statusRevision) return;
      if (durable) setStatus(durable.text, 'error', durable.category);
      else setStatus(state.refreshFailed ? L('refreshPending') : '');
    }, 2500);
  }
}
function setLoginStatus(text, type = 'info') {
  const region = $('loginStatus');
  if (!region) return;
  // Provider diagnostics can be English/internal; give an actionable localized
  // recovery instruction rather than leaking callback/state implementation.
  region.textContent = type === 'error' ? L('oauthLoginRetry') : String(text || '');
  region.classList.toggle('error', type === 'error');
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function userSafeErrorMessage(error, fallbackKey = 'actionFailed') {
  const raw = error?.error_data?.error_reason || error?.error_reason || error?.message || error?.error_type || String(error || '');
  const firstLine = String(raw || '').split(/\n|\s+at\s+/)[0].trim();
  const cleaned = firstLine.replace(/^(Error|TypeError|ReferenceError|SyntaxError):\s*/i, '').trim();
  return (cleaned || L(fallbackKey)).slice(0, 180);
}
const busyDisabled = new WeakMap();
function setBusy(isBusy, message = '', busyRegion = document.body) {
  state.busy = isBusy;
  document.querySelectorAll('button,input,textarea,select').forEach((el) => {
    // Keep quick actions in the accessibility tree while saving; the click
    // handler already ignores new actions until the request completes.
    if (isBusy) { busyDisabled.set(el, el.disabled); if (!el.dataset.entryType && el.id !== 'signOutSite') el.disabled = true; }
    else if (el.dataset.entryType) el.disabled = false; // used quick actions stay focusable
    else if (el.getAttribute('aria-disabled') !== null) el.disabled = el.getAttribute('aria-disabled') === 'true';
    else if (busyDisabled.has(el)) el.disabled = busyDisabled.get(el);
    if (!isBusy) busyDisabled.delete(el);
  });
  busyRegion.setAttribute('aria-busy', isBusy ? 'true' : 'false');
  if (message) setStatus(message);
  if (typeof syncStatusDismiss === 'function') syncStatusDismiss();
  if (typeof renderVkReminderOffer === 'function') renderVkReminderOffer();
}
async function withBusy(message, fn, busyRegion = document.body) { state.refreshFailed = false; setBusy(true, message, busyRegion); try { return await fn(); } finally { setBusy(false, '', busyRegion); } }
async function requestJson(path, options = {}, token = state.token) {
  const epoch = authEpoch;
  const logoutEpoch = storage.get('kopilkaLogoutEpoch');
  const headers = { 'content-type': 'application/json', 'x-kopilka-surface': supportSurface(), ...(options.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const controller = new AbortController();
  activeRequests.add(controller);
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(path, { ...options, headers, signal: controller.signal }).catch((error) => {
      if (controller.signal.aborted) throw error;
      // Only fetch transport failures: HTTP/validation explanations stay intact.
      throw new Error(L('networkUnavailable'));
    });
    const data = await res.json();
    if (epoch !== authEpoch || logoutEpoch !== storage.get('kopilkaLogoutEpoch')) throw new Error(L('signedOutSite'));
    if (res.status === 429 && (path === '/api/auth/vk' || path.startsWith('/api/auth/vk-oauth/'))) beginVkAuthCooldown(Number(res.headers.get('Retry-After')));
    return { res, data };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(L('requestTimeout'));
    throw error;
  } finally { clearTimeout(timeout); activeRequests.delete(controller); }
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
      if (!result.res.ok && result.res.status !== 429) {
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
    if (state.user?.id !== result.data.user?.id) preparedDayStory = null;
    setVerifiedUser(result.data.user || state.user);
    state.sessionRenewalBlocked = false;
    storage.set('kopilkaToken', state.token);
    if (state.user?.locale) storage.set('kopilkaLocale', state.user.locale);
    setStatus(L('sessionRenewed'));
    return true;
  })().catch((error) => {
    state.sessionRenewalBlocked = true;
    clientLog('session_renewal_failed', userSafeErrorMessage(error));
    return false;
  }).finally(() => { state.sessionRenewalPromise = null; syncStatusDismiss(); });
  syncStatusDismiss();
  return state.sessionRenewalPromise;
}
async function api(path, options = {}) {
  const epoch = authEpoch;
  const { authToken = state.token, skipSessionRenewal = false, ...requestOptions } = options;
  let result = await requestJson(path, requestOptions, authToken);
  const canRenew = !state.sessionRenewalBlocked && !skipSessionRenewal && !path.startsWith('/api/auth/') && result.res.status === 401 && ['SESSION_EXPIRED', 'SESSION_INVALID'].includes(result.data?.code);
  if (canRenew) {
    if (await renewSurfaceSession()) {
      if (epoch !== authEpoch) throw new Error(L('signedOutSite'));
      result = await requestJson(path, requestOptions);
    }
    else await showSessionRecovery();
  }
  if (epoch !== authEpoch) throw new Error(L('signedOutSite'));
  if (!result.res.ok) {
    const error = new Error(result.res.status === 413 ? L('inputTooLarge') : (result.data.error || L('actionFailed')));
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
    setVerifiedUser(data.user || state.user);
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
  if (!state.vkOAuthWindow || !state.vkOAuthChannel || event.origin !== window.location.origin || event.source !== state.vkOAuthWindow || !payload || payload.type !== 'kopilka:vk-oauth' || payload.channel !== state.vkOAuthChannel || payload.action !== state.vkOAuthAction) return;
  event.source.postMessage({ type: 'kopilka:vk-oauth-ack', channel: payload.channel }, event.origin);
  const pendingAction = state.vkOAuthAction;
  clearVkOAuthPending();
  if (payload.action === 'link' && payload.linkProof) {
    try {
      const finalized = await finalizeVkOAuthLink(payload.linkProof);
      if (finalized.merge) {
        await loadPendingMerge();
        renderSettings();
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
    beginVkAuthCooldown(Number(payload.retryAfter));
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
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', L(el.dataset.i18nAria)));
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = L(el.dataset.i18nPlaceholder); });
  const sceneShare = $('daySceneShare');
  if (sceneShare) {
    const vk = isVkMiniApp();
    const telegramStory = !vk && telegramDayStorySupported();
    const ipad = /\biPad\b/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    sceneShare.hidden = vk && (ipad || !window.vkBridge?.send);
    sceneShare.textContent = L(vk ? 'daySceneStoryVkShort' :
      (telegramStory ? (preparedDayStoryReady() ? 'daySceneStoryTelegramOpen' : 'daySceneStoryTelegramPrepare') : 'daySceneShare'));
    if (vk) sceneShare.setAttribute('aria-label', L('daySceneStoryVk'));
    else sceneShare.removeAttribute('aria-label');
  }
  window.KopilkaDocuments?.refresh();
  const status = $('connectionStatus');
  if (status) status.textContent = state.publicStatus || (state.user ? L('connected') : L('connecting'));
}

// Keep the compass font-independent: older OS emoji fonts can show a missing glyph.
function quickActionIcon(it, used) {
  if (used) return `<img src="/assets/day-scene/${it.type}.webp?v=1" alt="" width="30" height="30" decoding="async">`;
  if (it.type === 'honest_step') return '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M16 8 14 14 8 16 10 10Z" fill="currentColor"/><path d="M16 8 12 12 10 10Z" fill="#bd654b"/></svg>';
  return escapeHtml(it.icon || '✦');
}

// Re-render quick actions using current locale from the local dictionary.
function renderQuickActions() {
  const currentLocale = locale();
  const types = I18N.entryTypes(currentLocale);
  const usedToday = new Set(state.summary?.todayEntryTypes || []);
  const container = $('quickActions');
  const items = [...container.children];
  // Preserve button nodes when only today's entries changed: replacing the
  // grid moves TalkBack's virtual cursor even if DOM focus is restored later.
  if (container.dataset.locale === currentLocale && items.length === types.length &&
      items.every((item, i) => item.querySelector('button[data-entry-type]')?.dataset.entryType === types[i].type)) {
    types.forEach((it, i) => {
      const item = items[i];
      const button = item.querySelector('button[data-entry-type]');
      const used = usedToday.has(it.type);
      const iconChanged = button.dataset.usedToday !== String(used);
      item.dataset.usedToday = button.dataset.usedToday = String(used);
      if (used) button.setAttribute('aria-disabled', 'true');
      else button.removeAttribute('aria-disabled');
      button.setAttribute('aria-label', used ? `${it.title}, ${L('alreadyAddedToday')}` : `${it.title}, ${it.hint}, ${L('addLife', { points: it.points })}`);
      // Preserve decoded images and SVGs on all unchanged actions.
      if (iconChanged) button.querySelector('.qa-icon').innerHTML = quickActionIcon(it, used);
      item.querySelector('.qa-hint').textContent = used ? L('alreadyAddedToday') : it.hint;
      item.querySelector('.qa-points').textContent = used ? L('availableTomorrow') : L('plusLife', { points: it.points });
    });
    return;
  }
  container.innerHTML = types.map((it) => {
    const used = usedToday.has(it.type);
    const aria = used ? `${it.title}, ${L('alreadyAddedToday')}` : `${it.title}, ${it.hint}, ${L('addLife', { points: it.points })}`;
    const icon = quickActionIcon(it, used);
    return `<div class="qa-item" data-used-today="${used ? 'true' : 'false'}"><button type="button" data-entry-type="${it.type}" data-last-quick-entry-type="${it.type}" data-used-today="${used ? 'true' : 'false'}" ${used ? 'aria-disabled="true"' : ''} aria-label="${escapeHtml(aria)}"><span class="qa-icon" aria-hidden="true">${icon}</span><span class="qa-title">${escapeHtml(it.shortTitle)}</span></button><span class="qa-hint" aria-hidden="true">${escapeHtml(used ? L('alreadyAddedToday') : it.hint)}</span><span class="qa-points" aria-hidden="true">${used ? escapeHtml(L('availableTomorrow')) : escapeHtml(L('plusLife', { points: it.points }))}</span></div>`;
  }).join('');
  container.dataset.locale = currentLocale;
}
function renderSummary() {
  const s = state.summary || { totalLife: 0, todayLife: 0, todayEntries: [] };
  $('totalLife').textContent = s.totalLife;
  $('todayLife').textContent = s.todayLife;
  $('todayEntries').innerHTML = s.todayEntries.length ? s.todayEntries.map((e) => `<li>${escapeHtml(e.title)}: +${Number(e.life_points) || 0}. ${escapeHtml(e.note || '')}</li>`).join('') : `<li>${escapeHtml(L('noEntriesToday'))}</li>`;
  window.KopilkaDayScene?.render(s.todayEntryTypes || [], locale());
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
      return `<button type="button" class="secondary" data-gratitude-hint="${escapeHtml(text)}" ${used ? 'disabled aria-disabled="true"' : ''}>${escapeHtml(text)}</button>`;
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
// The live textarea is the only draft store. Never persist private notes in storage.
let historyEditor = null;
let historyDecision = null;
// Both History writers share this fence; identity fencing alone cannot order
// same-user reads. Opening an editor also retires earlier navigation reads.
let historyReadGeneration = 0;
let historyNavigationGeneration = 0;
let historyNavigationBusyOwner = null;
function clearHistoryEditor() {
  historyDeleteDecision?.finish(false, false);
  historyDecision?.finish('cancel', false);
  historyEditor = null;
  state.historyEditingId = null;
  $('selectedDayEntries')?.replaceChildren();
}
function setVerifiedUser(user) {
  if (state.user?.id !== user?.id) {
    readyNoticeDismissed = false;
    if (state.user?.id) authEpoch++;
    templateReplaceDecision?.finish(false, false);
    clearHistoryEditor();
    state.history = null;
    state.historyDate = '';
  }
  Object.assign(state, { user });
}
function openHistoryEditor(id) {
  const entry = state.history?.selectedEntries.find(item => item.id === id && item.editable);
  if (!entry || !state.user?.id) return;
  historyReadGeneration++;
  $('selectedDayEntries').replaceChildren();
  state.historyEditingId = id;
  historyEditor = { id, userId: state.user.id, date: state.historyDate, original: entry.note || '' };
  renderHistory();
  $(`history-note-${id}`)?.focus();
}
async function leaveHistoryEditor() {
  if (historyDecision) return false;
  const editor = historyEditor;
  const field = editor && $(`history-note-${editor.id}`);
  if (!field || editor.userId !== state.user?.id) return true;
  if (field.value === editor.original) return true;
  const epoch = authEpoch;
  const selection = [field.selectionStart, field.selectionEnd, field.selectionDirection];
  const dialog = document.createElement('dialog');
  dialog.id = 'historyUnsavedDialog';
  dialog.setAttribute('aria-labelledby', 'historyUnsavedTitle');
  dialog.setAttribute('aria-describedby', 'historyUnsavedText');
  dialog.style.maxWidth = 'min(30rem, calc(100vw - 2rem))';
  dialog.innerHTML = `<h2 id="historyUnsavedTitle">${escapeHtml(L('historyUnsavedTitle'))}</h2><p id="historyUnsavedText">${escapeHtml(L('historyUnsavedText'))}</p><div class="history-entry-actions"><button type="button" data-history-choice="save">${escapeHtml(L('historySave'))}</button><button type="button" class="secondary" data-history-choice="discard">${escapeHtml(L('historyDiscard'))}</button><button type="button" class="secondary" data-history-choice="cancel">${escapeHtml(L('historyCancel'))}</button></div>`;
  document.body.append(dialog);
  const choice = await new Promise(resolve => {
    const finish = (value, restore = true) => {
      historyDecision = null;
      dialog.close(); dialog.remove();
      if (restore && epoch === authEpoch && editor === historyEditor) {
        $('historyDate').value = editor.date;
        field.focus({ preventScroll: true });
        field.setSelectionRange(...selection);
      }
      resolve(value);
    };
    historyDecision = { finish };
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish('cancel'); });
    dialog.addEventListener('click', event => {
      const choice = event.target.closest('[data-history-choice]');
      if (choice) finish(choice.dataset.historyChoice);
    });
    dialog.showModal();
    dialog.querySelector('[data-history-choice="cancel"]').focus();
  });
  if (epoch !== authEpoch || editor !== historyEditor || editor.userId !== state.user?.id) return false;
  if (choice === 'cancel') return false;
  if (choice === 'save') {
    try {
      const saved = await saveHistoryEntry(field.closest('form'));
      return saved && epoch === authEpoch && editor.userId === state.user?.id;
    }
    catch (error) { setStatus(error.message, 'error'); field.focus({ preventScroll: true }); field.setSelectionRange(...selection); return false; }
  }
  clearHistoryEditor();
  renderHistory();
  return true;
}
function renderHistory() {
  if (historyEditor && historyEditor.userId !== state.user?.id) clearHistoryEditor();
  const history = state.history;
  if (!history) return;
  state.historyDate = history.selectedDate;
  const dateInput = $('historyDate');
  if (dateInput) { dateInput.value = history.selectedDate; dateInput.max = history.todayDate || history.selectedDate; }
  if ($('historyNext')) { $('historyNext').disabled = !history.nextDate; $('historyNext').setAttribute('aria-disabled', String(!history.nextDate)); }
  const life = history.selectedEntries.reduce((sum, entry) => sum + Number(entry.life_points || 0), 0);
  if ($('selectedDaySummary')) $('selectedDaySummary').textContent = L('historyDaySummary', { date: formatHistoryDate(history.selectedDate), count: history.selectedEntries.length, life });
  const list = $('selectedDayEntries');
  if (list && !(state.historyEditingId && $(`history-note-${state.historyEditingId}`))) {
    list.innerHTML = history.selectedEntries.length ? history.selectedEntries.map((entry) => {
      const note = entry.note ? `<p>${escapeHtml(entry.note)}</p>` : '';
      if (state.historyEditingId === entry.id && entry.editable) {
        return `<li><form data-history-edit-form="${entry.id}"><p><strong>${escapeHtml(entry.title)}</strong> · +${Number(entry.life_points) || 0} ${escapeHtml(L('life'))}</p><label for="history-note-${entry.id}">${escapeHtml(L('historyEditLabel', { title: entry.title }))}</label><textarea id="history-note-${entry.id}" name="note" rows="3" maxlength="${Math.max(2000, (entry.note || '').length)}">${escapeHtml(entry.note || '')}</textarea><div class="history-entry-actions"><button type="submit">${escapeHtml(L('historySave'))}</button><button type="button" class="secondary" data-history-cancel>${escapeHtml(L('historyCancel'))}</button></div></form></li>`;
      }
      const actions = entry.editable ? `<div class="history-entry-actions"><button type="button" class="secondary" data-history-edit="${entry.id}">${escapeHtml(L('historyEdit'))}</button><button type="button" class="secondary" data-history-delete="${entry.id}">${escapeHtml(L('historyDelete'))}</button></div>` : `<p class="field-hint">${escapeHtml(L('historyProtected'))}</p>`;
      return `<li><article><h3>${escapeHtml(entry.title)}</h3><p>+${Number(entry.life_points) || 0} ${escapeHtml(L('life'))}</p>${note}${actions}</article></li>`;
    }).join('') : `<li>${escapeHtml(L('historyEmptyDay'))}</li>`;
  }
  if (list && state.historyEditingId) {
    const editor = list.querySelector('[data-history-edit-form]');
    const entry = history.selectedEntries.find((item) => item.id === state.historyEditingId);
    if (editor && entry) {
      editor.querySelector('strong').textContent = entry.title;
      editor.querySelector('label').textContent = L('historyEditLabel', { title: entry.title });
      editor.querySelector('button[type="submit"]').textContent = L('historySave');
      editor.querySelector('[data-history-cancel]').textContent = L('historyCancel');
      // Update labels in place: the textarea owns the unsaved draft and selection.
      const points = editor.querySelector('p');
      if (points.lastChild?.nodeType === 3) points.lastChild.textContent = ` · +${Number(entry.life_points) || 0} ${L('life')}`;
    }
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
function updateContractCounters() {
  // Read the existing native bound; JS length matches maxlength's UTF-16 units.
  // Descriptions are available on focus, without announcing every keystroke.
  document.querySelectorAll('#contractForm [data-contract-counter]').forEach((counter) => {
    const field = $(counter.dataset.contractCounter);
    if (!field || field.maxLength < 0) return;
    counter.textContent = L('contractCharacterCount', { current: field.value.length, max: field.maxLength });
  });
}
function renderContract() {
  const box = $('contractCurrent'); const form = $('contractForm');
  renderContractTemplates();
  updateContractCounters();
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
function renderPractices() { const data = state.product?.practices; if (!data) return; const select = $('practiceGoal'); select.innerHTML = data.goals.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.title)}</option>`).join(''); select.value = data.goal; $('goalPractices').innerHTML = data.practices.map((p) => `<li>${escapeHtml(p)}</li>`).join(''); }
let templateReplaceDecision = null;
async function confirmTemplateReplacement(trigger) {
  const epoch = authEpoch, userId = state.user?.id;
  if (!userId || templateReplaceDecision) return false;
  const dialog = document.createElement('dialog');
  dialog.id = 'templateReplaceDialog';
  dialog.className = 'document-dialog';
  dialog.style.width = 'min(30rem, calc(100% - 1rem))';
  dialog.style.height = 'fit-content';
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'templateReplaceTitle');
  dialog.setAttribute('aria-describedby', 'templateReplaceText');
  dialog.innerHTML = `<div class="document-content"><h2 id="templateReplaceTitle">${escapeHtml(L('templateReplaceTitle'))}</h2><p id="templateReplaceText">${escapeHtml(L('templateReplaceConfirm'))}</p><div class="history-entry-actions"><button type="button" data-template-choice="confirm">${escapeHtml(L('templateReplaceButton'))}</button><button type="button" class="secondary" data-template-choice="cancel">${escapeHtml(L('historyCancel'))}</button></div></div>`;
  document.body.append(dialog);
  const marker = Math.random().toString(36).slice(2);
  window.history.pushState({ ...window.history.state, kopilkaTemplateDialog: marker }, '');
  return new Promise(resolve => {
    let closing = false, choice = false;
    const finish = (confirmed, restore = true, fromHistory = false) => {
      if (!fromHistory && window.history.state?.kopilkaTemplateDialog === marker) {
        if (closing) return;
        closing = true; choice = confirmed;
        window.history.back();
        return;
      }
      templateReplaceDecision = null;
      if (dialog.open) dialog.close();
      dialog.remove();
      const valid = epoch === authEpoch && userId === state.user?.id && !state.publicReadOnly;
      if (restore && valid && state.activeTab === 'contract') {
        const target = trigger?.isConnected ? trigger : $('heading-contract');
        target?.focus({ preventScroll: true });
      }
      resolve(valid && (closing ? choice : confirmed));
    };
    templateReplaceDecision = { finish };
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
    dialog.addEventListener('click', event => {
      const button = event.target.closest('[data-template-choice]');
      if (button) finish(button.dataset.templateChoice === 'confirm');
    });
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const buttons = [...dialog.querySelectorAll('button')];
      if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0].focus(); }
    });
    try {
      dialog.showModal();
      dialog.querySelector('[data-template-choice="cancel"]').focus();
    } catch (_) { finish(false); } // No native fallback: keep the draft if modal opening fails.
  });
}
async function applyTemplate(templateId) {
  const template = (state.product?.contractTemplates || []).find((item) => item.id === templateId);
  if (!template || templateReplaceDecision || state.busy || state.publicReadOnly || !state.user?.id) return;
  const epoch = authEpoch, userId = state.user.id;
  const values = {
    contractTitle: template.title, contractTarget: template.targetValue,
    stakeAmount: template.stakeAmount || '', stakeCurrency: template.stakeCurrency || 'RUB',
    rewardDescription: template.rewardDescription || '', fundDescription: template.fundDescription || ''
  };
  // A default currency is not a draft. Any other nonempty value that would
  // change belongs to the user and needs an explicit replacement decision.
  const replacesDraft = Object.entries(values).some(([id, value]) => {
    const current = $(id).value;
    return current.trim() && current !== value && !(id === 'stakeCurrency' && current === 'RUB');
  });
  const draft = Object.fromEntries(Object.keys(values).map(id => [id, $(id).value]));
  const trigger = [...document.querySelectorAll('[data-template-id]')].find(button => button.dataset.templateId === templateId);
  if (replacesDraft && !await confirmTemplateReplacement(trigger)) return;
  // A delayed choice cannot overwrite a newer draft, identity or navigation.
  if (epoch !== authEpoch || userId !== state.user?.id || state.activeTab !== 'contract' || state.busy || state.publicReadOnly ||
      Object.entries(draft).some(([id, value]) => $(id).value !== value)) return;
  for (const [id, value] of Object.entries(values)) $(id).value = value;
  updateContractCounters();
  setStatus(L('templateApplied', { title: template.title }));
}
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
  syncStatusDismiss();
  if (!pending) { container.hidden = true; container.innerHTML = ''; return; }
  const p = pending.preview || {};
  const r = p.result || {};
  const blocking = p.blocking || [];
  const blockingKeys = {
    demo_account_conflict: 'mergeBlockedDemo',
    entry_conflict: 'mergeBlockedRecords', reminder_conflict: 'mergeBlockedRecords',
    artifact_conflict: 'mergeBlockedRecords', support_action_conflict: 'mergeBlockedRecords',
    settings_conflict: 'mergeBlockedSettings', referrer_conflict: 'mergeBlockedReferrer',
    primary_telegram_conflict: 'mergeBlockedSourceTelegram',
    google_identity_conflict: 'mergeBlockedReverseIdentity',
    email_identity_conflict: 'mergeBlockedReverseIdentity',
    telegram_identity_conflict: 'mergeBlockedSourceTelegram',
    active_contract_conflict: 'mergeBlockedActiveContract',
    source_telegram_conflict: 'mergeBlockedSourceTelegram',
    source_identity_conflict: 'mergeBlockedSourceIdentity',
    source_scheduled_reminder_conflict: 'mergeBlockedScheduledReminder',
    primary_vk_conflict: 'mergeBlockedPrimaryVk',
    support_metadata_conflict: 'mergeBlockedSupportMetadata'
  };
  if (r.transferLogins) {
    blockingKeys.source_identity_conflict = 'mergeBlockedReverseIdentity';
    blockingKeys.source_telegram_conflict = 'mergeBlockedReversePlatform';
  }
  container.hidden = false;
  container.innerHTML = `<h3 id="mergeAccountsHeading" tabindex="-1">${escapeHtml(L('mergeAccountsTitle'))}</h3><p>${escapeHtml(L(r.transferLogins ? 'mergeReverseIntro' : 'mergeAccountsIntro'))}</p><p>${escapeHtml(L('mergeTarget', { name: p.primary?.firstName || '', id: p.primary?.id || '' }))}</p><p>${escapeHtml(L('mergeSource', { name: p.source?.firstName || '', id: p.source?.id || '' }))}</p><ul class="compact-list"><li>${escapeHtml(L('mergeMovedEntries', { count: r.movedEntries || 0 }))}</li><li>${escapeHtml(L('mergeDedupedEntries', { count: r.dedupedQuickEntries || 0 }))}</li><li>${escapeHtml(L('mergeNotes', { count: r.mergedNotes || 0 }))}</li><li>${escapeHtml(L('mergeContracts', { count: r.movedContracts || 0 }))}</li><li>${escapeHtml(L('mergeRemindersDropped', { count: r.scheduledRemindersDropped || 0 }))}</li></ul>${pending.identity ? `<p>${escapeHtml(L('mergeIdentitySettings', { logins: (r.retainedLogins || []).join(', '), timezone: r.timezone || '' }))}</p>` : ''}${blocking.length ? blocking.map((reason) => `<p class="soft-note">${escapeHtml(L(blockingKeys[reason] || 'mergeBlockedUnknown'))}</p>`).join('') : `<button type="button" id="confirmAccountMerge">${escapeHtml(L('mergeConfirm'))}</button>`}<button type="button" id="cancelAccountMerge" class="secondary">${escapeHtml(L('mergeCancel'))}</button>`;
}
function refreshLinkedLogins() {
  if (!state.user) return;
  api('/api/settings/linked-logins').then(({ email, google }) => {
    if ($('linkEmailForm')) $('linkEmailForm').hidden = Boolean(email);
    if ($('linkGoogleAccount')) $('linkGoogleAccount').hidden = Boolean(google) || isVkMiniApp();
    if (email && $('linkEmailCodeForm')) $('linkEmailCodeForm').hidden = true;
    const button = $('unlinkLoginAccounts');
    if (button) button.hidden = !email && !google;
    const status = $('linkedLoginsStatus');
    if (status) status.textContent = `E-mail: ${email ? 'привязан' : 'не привязан'} · Google: ${google ? 'привязан' : 'не привязан'}`;
  }).catch(() => { if ($('unlinkLoginAccounts')) $('unlinkLoginAccounts').hidden = true; });
}
let settingsTimezoneCatalog = null;
let settingsTimezoneCatalogLoading = false;
function renderTimezoneChoices(value) {
  const control = $('timezone');
  // The shell integration supplies a native labeled select; keep old shell safe.
  if (control.tagName !== 'SELECT') { control.value = value; return; }
  if (typeof Intl.supportedValuesOf !== 'function' && !settingsTimezoneCatalog && !settingsTimezoneCatalogLoading) {
    settingsTimezoneCatalogLoading = true;
    api('/api/settings/timezones').then(data => {
      if (Array.isArray(data.timezones)) {
        settingsTimezoneCatalog = data.timezones;
        delete control.dataset.timezoneKey;
        // Read the live draft, not the value captured before the request.
        if (state.user) renderTimezoneChoices(control.value);
      }
    }).catch(() => { /* Keep the current zone and allow catalog retry. */ })
      .finally(() => { settingsTimezoneCatalogLoading = false; });
  }
  const key = `${locale()}|${value}`;
  if (control.dataset.timezoneKey !== key) {
    const choices = I18N.timezoneChoices(value, settingsTimezoneCatalog);
    control.replaceChildren(...choices.map(zone => {
      const option = document.createElement('option');
      option.value = zone;
      option.textContent = I18N.timezoneLabel(locale(), zone);
      return option;
    }));
    if (!I18N.validTimezone(value)) {
      const option = document.createElement('option');
      option.value = value || '';
      option.textContent = L('invalidTimezone');
      control.prepend(option);
    }
    control.dataset.timezoneKey = key;
  }
  control.value = value;
}
function renderSettings() {
  if (!state.user) return;
  if ($('accountLinksSection')) $('accountLinksSection').hidden = isVkMiniApp();
  if (!state.settingsDirty) {
    renderTimezoneChoices(state.user.timezone || 'Asia/Novosibirsk');
    $('remindersEnabled').checked = Boolean(state.user.remindersEnabled);
    $('eveningReminderTime').value = state.user.eveningReminderTime || '20:00';
  }

  if (state.settingsDirty) renderTimezoneChoices($('timezone').value);

  const servicePanel = $('servicePanel');
  if (servicePanel) servicePanel.hidden = !state.user.isDemo;
  if ($('userDebug')) $('userDebug').textContent = `ID: ${state.user.id}. Demo: ${state.user.isDemo ? L('yes') : L('no')}.`;
  const vkStatus = $('vkLinkStatus'); const vkBtn = $('linkVkAccount');
  if (vkStatus) vkStatus.textContent = state.user.vkLinked ? L('vkLinked') : L('vkNotLinked');
  if (vkBtn) { vkBtn.hidden = Boolean(state.user.vkLinked); vkBtn.disabled = false; }
  if ($('linkTelegramAccount')) $('linkTelegramAccount').hidden = Boolean(state.user.telegramLinked) || isVkMiniApp();
  if (isVkMiniApp() && $('telegramLinkHandoff')) $('telegramLinkHandoff').hidden = true;
  if (isVkMiniApp() && $('linkGoogleAccount')) $('linkGoogleAccount').hidden = true;
  renderVkReminderOffer();
  if ($('cleanupDemo')) $('cleanupDemo').disabled = !state.user.isDemo;
  const lang = locale(); $('lang-ru').setAttribute('aria-pressed', String(lang === 'ru')); $('lang-en').setAttribute('aria-pressed', String(lang === 'en'));
  renderMergePrompt();
}
function showTelegramLinkClaim() {
  const initData = window.Telegram?.WebApp?.initData || '';
  const startParam = new URLSearchParams(initData).get('start_param') || '';
  if (!/^link_[A-Za-z0-9_-]{43}$/.test(startParam) || !state.user) return;
  $('telegramLinkClaim').hidden = false;
  switchTab('profile', { record: false });
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
  if (vkReminderStatus) {
    const statusKey = !showVkReminders ? 'vkReminderStatusNeedVk'
      : !state.user.vkMessagesAllowed ? 'vkReminderStatusUnknown'
      : state.user.remindersEnabled ? 'vkReminderStatusOn' : 'vkReminderStatusOff';
    vkReminderStatus.textContent = vkReminderRequestCurrent(vkReminderRequest) ? L('vkReminderRequesting')
      : vkReminderRequestCurrent(vkReminderNotice) ? (vkReminderNotice.key ? L(vkReminderNotice.key) : vkReminderNotice.text) : L(statusKey);
    vkReminderStatus.setAttribute('role', 'status');
  }
  document.querySelectorAll('[data-enable-vk-reminders]').forEach((btn) => {
    const pending = vkReminderRequestCurrent(vkReminderRequest);
    btn.textContent = state.user?.vkMessagesAllowed ? L('vkReminderEnableAgain') : L('vkReminderEnable');
    btn.disabled = state.busy || pending;
    btn.setAttribute('aria-busy', String(pending));
  });
}
function renderProfile() {
  const p = state.profile; const name = $('profileNameHeading'); const heart = document.querySelector('.badge-heart'); const count = document.querySelector('.badge-heart-count');
  if (!p) return;
  state.publicProfileTarget = null;
  setPublicReadOnlyMode(false);
  if ($('siteLogoutSection')) $('siteLogoutSection').hidden = !state.user || !outsideMiniApp();
  if (name) name.textContent = state.user?.firstName || '—';
  const n = p.activeReferred || 0;
  if (heart) { heart.setAttribute('data-size', badgeSize(n)); heart.setAttribute('aria-label', `${L('publicBadgeLabel')} ${n}`); }
  if (count) count.textContent = n;
  const total = $('partnerTotal'); const active = $('partnerActive');
  if (total) total.textContent = p.totalReferred || 0;
  if (active) active.textContent = n;
  const inBot = Boolean(window.Telegram?.WebApp?.initData);
  const inVk = isVkMiniApp();
  if ($('accountLinksSection')) $('accountLinksSection').hidden = inVk;
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
function vkInternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['vk.com', 'vk.ru'].includes(url.hostname) &&
      !url.port && !url.username && !url.password && url.pathname !== '/away.php';
  } catch (_) { return false; }
}
function renderSupportActions() {
  const box = $('supportActionsList');
  if (!box) return;
  const support = state.support || { badge: { points: 0 }, summary: { newCount: 0 }, actions: [] };
  const points = $('supportBadgePoints');
  if (points) points.textContent = support.badge?.points || 0;
  const count = $('supportNewCount');
  const actions = (support.actions || []).filter((action) => !isVkMiniApp() || action.slug === 'share-kopilka' || vkInternalUrl(action.url));
  const newCount = isVkMiniApp() ? actions.filter((action) => action.status === 'available').length : Number(support.summary?.newCount || 0);
  if (count) { count.textContent = newCount > 0 ? L('supportTabNewShort', { count: newCount }) : ''; count.hidden = newCount <= 0; }
  const supportTab = $('tab-button-support');
  if (supportTab) supportTab.setAttribute('aria-label', newCount > 0 ? L('supportTabNew', { count: newCount }) : L('tabSupport'));
  const summary = $('supportNewSummary');
  if (summary) summary.textContent = newCount > 0 ? L('supportNewSummary', { count: newCount }) : L('supportNoNew');
  if (!actions.length) { box.innerHTML = `<p class="soft-note">${escapeHtml(L('supportEmpty'))}</p>`; return; }
  box.innerHTML = actions.map((action) => {
    const opened = action.status !== 'available';
    const nativeCopy = isVkMiniApp() && action.slug === 'share-kopilka';
    const disabled = false; // repeat opening never awards twice (server-idempotent)
    const buttonLabel = nativeCopy ? L('copyRefLink') : (opened ? L('supportOpenAgain') : (action.buttonLabel || L('supportOpen')));
    const disclosure = action.disclosureText ? `<p class="field-hint">${escapeHtml(action.disclosureText)}</p>` : '';
    const ad = action.isAd || action.isPartner ? `<span class="support-pill">${escapeHtml(action.isAd ? L('supportAd') : L('supportPartner'))}</span>` : '';
    const statePill = opened ? `<span class="support-pill done">${escapeHtml(L('supportDone'))}</span>` : `<span class="support-pill">${escapeHtml(action.rewardLabel || L('supportReward'))}</span>`;
    return `<article class="support-action-card${opened ? ' is-opened' : ''}" data-support-action-id="${action.id}" aria-label="${escapeHtml(action.title)}"><h3>${escapeHtml(action.title)}</h3><p>${escapeHtml(action.description)}</p>${disclosure}<div class="support-action-meta">${statePill}${ad}</div><button type="button" ${disabled ? 'class="secondary" disabled aria-disabled="true"' : ''} data-support-open="${action.id}">${escapeHtml(buttonLabel)}</button></article>`;
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
function showArtifactToast(artifacts = [], fromHistory = false, announce = true) {
  const fresh = artifacts.filter((item) => item && !state.artifactQueue.some((queued) => queued.id === item.id));
  if (!fresh.length) return;
  if (!state.artifactQueue.length) {
    const active = document.activeElement;
    state.artifactReturnFocus = active instanceof HTMLElement && active !== document.body && active !== document.documentElement ? active : null;
  }
  const alreadyOpen = state.artifactQueue.length > 0;
  state.artifactQueue.push(...fresh);
  if (!fromHistory) saveNavigation(alreadyOpen, state.artifactQueue.slice());
  renderArtifactToast(announce);
}
let artifactScrollLock = null;
function setArtifactBackgroundInert(inert) {
  if (inert && !artifactScrollLock) {
    artifactScrollLock = { x: window.scrollX, y: window.scrollY, style: document.body.getAttribute('style') };
    Object.assign(document.body.style, { position: 'fixed', top: `-${artifactScrollLock.y}px`, left: `-${artifactScrollLock.x}px`, width: '100%', overflow: 'hidden' });
  } else if (!inert && artifactScrollLock) {
    const saved = artifactScrollLock;
    artifactScrollLock = null;
    if (saved.style === null) document.body.removeAttribute('style');
    else document.body.setAttribute('style', saved.style);
    window.scrollTo({ left: saved.x, top: saved.y, behavior: 'instant' });
  }
  document.querySelectorAll('#appShell > *:not(#artifactToast)').forEach((element) => {
    if (inert) element.setAttribute('inert', '');
    else element.removeAttribute('inert');
  });
}
function renderArtifactToast(announce = true) {
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
  if (announce) setStatus(L('artifactUnlockedStatus', { title: first.title }), 'info', 'entry-success');
}
function hideArtifactToast({ fromHistory = false, dismissAll = false } = {}) {
  if (!state.artifactQueue.length) return;
  if (dismissAll) state.artifactQueue = []; else state.artifactQueue.shift();
  if (state.artifactQueue.length) { saveNavigation(true, state.artifactQueue.slice()); renderArtifactToast(); return; }
  if (!fromHistory && window.history.state?.kopilkaView?.artifacts?.length) window.history.back();
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
  // The original button survived the update. Leave the screen reader's
  // position alone rather than forcing a second focus move after a frame.
  if (state.quickActionReturnButton?.isConnected) { state.quickActionReturnButton = null; return; }
  state.quickActionReturnButton = null;
  const run = () => {
    const btn = Array.from(document.querySelectorAll('#quickActions [data-last-quick-entry-type]')).find((item) => item.dataset.lastQuickEntryType === type);
    if (!btn) return;
    btn.focus({ preventScroll: true });
    btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  if (window.requestAnimationFrame) window.requestAnimationFrame(run);
  else window.setTimeout(run, 0);
}
function renderAll() { applyStaticI18n(); setVkAttributionVisibility(); renderQuickActions(); renderSummary(); renderWeek(); renderContract(); renderTodayContractReminder(); renderSettings(); renderInstallOffer(); renderProfile(); renderArtifacts(); renderSupportActions(); renderVkReminderOffer(); renderRecoveryNotice(); restoreQuickActionFocus(); }
const navigationOwner = Math.random().toString(36).slice(2);
function navigationState(artifacts = []) { return { owner: navigationOwner, tab: state.activeTab, artifacts }; }
function saveNavigation(replace = false, artifacts = []) {
  const current = { ...window.history.state, kopilkaView: navigationState(artifacts) };
  window.history[replace ? 'replaceState' : 'pushState'](current, '');
}
function settingsDraftChanged() {
  if (!state.user || state.publicReadOnly) return false;
  return $('timezone').value !== (state.user.timezone || 'Asia/Novosibirsk') ||
    $('remindersEnabled').checked !== Boolean(state.user.remindersEnabled) ||
    ($('eveningReminderTime').value || '20:00') !== (state.user.eveningReminderTime || '20:00');
}
function switchTab(tab, { record = true, focus = true } = {}) {
  if (!['today', 'week', 'contract', 'settings', 'support', 'profile'].includes(tab)) return;
  const leavingDirtySettings = state.activeTab === 'settings' && tab !== 'settings' && settingsDraftChanged();
  const changed = state.activeTab !== tab;
  if (changed) clearSupportActionError();
  if (record && changed && !state.publicReadOnly) {
    saveNavigation(true);
    state.activeTab = tab;
    saveNavigation();
  } else state.activeTab = tab;
  document.querySelectorAll('.screen-panel').forEach((p) => { p.hidden = p.id !== `tab-${tab}`; });
  document.querySelectorAll('.tab-bar button').forEach((b) => {
    const active = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(active)); b.tabIndex = active ? 0 : -1;
    if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  if (tab === 'profile' && !state.publicReadOnly) refreshLinkedLogins();
  if (tab === 'settings' && state.user && !state.publicReadOnly) void refreshPushStatus();
  if (focus) $(`heading-${tab}`)?.focus({ preventScroll: false });
  if (leavingDirtySettings) setStatus(L('settingsUnsaved'), 'info', 'unsaved-settings');
}
function restoreNavigation(event) {
  if (templateReplaceDecision) { templateReplaceDecision.finish(false, true, true); return; }
  if (historyDeleteDecision) { historyDeleteDecision.finish(false, true, true); return; }
  // The legal reader owns its own history entry and is registered first.
  if (document.querySelector('.document-dialog[open]') || state.publicReadOnly) return;
  const view = event.state?.kopilkaView;
  if (view?.owner !== navigationOwner) return;
  if (state.artifactQueue.length) hideArtifactToast({ fromHistory: true, dismissAll: true });
  if (view.tab !== state.activeTab) switchTab(view.tab, { record: false });
  if (view.artifacts?.length) showArtifactToast(view.artifacts, true);
}
function handleTabKey(event) {
  if (state.busy || state.publicReadOnly || !event.target.closest('button[data-tab]')) return;
  const tabs = [...document.querySelectorAll('.tab-bar button[data-tab]')];
  const index = tabs.indexOf(event.target.closest('button[data-tab]'));
  let next;
  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  else return;
  event.preventDefault();
  switchTab(tabs[next].dataset.tab, { focus: false }); tabs[next].focus();
}
// Foreground/return refresh is throttled; an idle open page notices a new local
// date once a minute. Never replace an active editor, modal or settings draft.
function localDay() {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: state.user?.timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch (_) { return ''; }
}
let refreshedDay = '';
const vkSharePending = new Set();
let vkShareRequestId = 0;
let vkShareReturnUntil = 0;
async function refreshOnReturn(force = false) {
  // Native share restoration is not a return from another app. Its focus and
  // visibility events can straddle the Bridge callback; keep that brief return quiet.
  // A lost Bridge callback must not disable ordinary refresh indefinitely.
  for (const request of vkSharePending) {
    if (request.until <= Date.now()) vkSharePending.delete(request);
  }
  if (!force && (vkSharePending.size || Date.now() < vkShareReturnUntil)) return;
  if (!state.token || !state.user || state.publicReadOnly || state.busy || state.refreshPending || document.hidden || state.historyEditingId || state.artifactQueue.length || document.querySelector('.document-dialog[open]') || $('appShell').hidden) return;
  if (!force && Date.now() - state.lastRefresh < 60000 && refreshedDay === localDay()) return;
  // Refresh only when the user isn't typing; settings and entry drafts stay in DOM.
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  state.refreshPending = true;
  const focused = document.activeElement;
  const focusedId = focused?.id;
  const quickType = focused?.dataset?.entryType;
  try {
    await withBusy('', loadData); refreshedDay = localDay(); state.refreshFailed = false;
    if (!focused?.isConnected) {
      const replacement = focusedId ? $(focusedId) : quickType ? document.querySelector(`button[data-entry-type="${quickType}"]`) : null;
      replacement?.focus({ preventScroll: true });
    }
  }
  catch (_) { state.lastRefresh = Date.now(); setStatus(L('refreshUnavailable'), 'error'); }
  finally {
    state.refreshPending = false;
    const pending = state.pendingQuickAfterRefresh;
    state.pendingQuickAfterRefresh = null;
    if (pending && state.user?.id === pending.userId && state.token && !state.busy &&
        !state.publicReadOnly && state.activeTab === 'today' && !$('appShell').hidden &&
        !new Set(state.summary?.todayEntryTypes || []).has(pending.type)) {
      const button = [...document.querySelectorAll('#quickActions button[data-entry-type]')]
        .find((item) => item.dataset.entryType === pending.type);
      if (button && button.dataset.usedToday !== 'true') {
        state.quickActionReturnType = pending.type;
        state.quickActionReturnButton = button;
        try { await createEntry(pending.type, pending.note); }
        catch (error) {
          state.quickActionReturnType = '';
          state.quickActionReturnButton = null;
          setStatus(error.message, 'error');
        }
      }
    }
  }
}

async function loadData() {
  let epoch = authEpoch;
  const historyGeneration = ++historyReadGeneration;
  state.publicStatus = '';
  const goal = $('practiceGoal')?.value || 'calm';
  const me = await api('/api/me');
  if (epoch !== authEpoch || historyGeneration !== historyReadGeneration) return;
  setVerifiedUser(me.user);
  epoch = authEpoch;
  rememberRecoveryNotice(me.recoveryNotice);
  const followToday = !state.historyEditingId && state.historyDate === state.history?.todayDate;
  const historyDate = followToday ? '' : state.historyDate;
  const historyQuery = historyDate ? `?date=${encodeURIComponent(historyDate)}&days=7` : '?days=7';
  const historyRead = api(`/api/history${historyQuery}`).catch(error => {
    if (epoch !== authEpoch || historyGeneration !== historyReadGeneration) return null;
    throw error;
  });
  const [summary, week, history, current, product, profile, artifacts, support] = await Promise.all([api('/api/summary/today'), api('/api/entries?range=week'), historyRead, api('/api/contracts/current'), api(`/api/product?goal=${encodeURIComponent(goal)}`), api('/api/profile'), api('/api/artifacts'), api(`/api/support/actions?source=${encodeURIComponent(supportSurface())}`)]);
  if (state.user?.id !== me.user?.id) preparedDayStory = null;
  if (storage.get('kopilkaPushRetirePending') || (storage.get('kopilkaPushOwner') && storage.get('kopilkaPushOwner') !== String(me.user.id))) {
    storage.set('kopilkaPushRetirePending', '1');
    const retired = await Promise.race([retireBrowserPush(state.token), new Promise(resolve => setTimeout(() => resolve(false), 1000))]);
    if (retired) storage.remove('kopilkaPushRetirePending');
    storage.remove('kopilkaPushOwner');
  }
  if (epoch !== authEpoch) return;
  if (history && historyGeneration === historyReadGeneration) {
    if (history.selectedDate !== state.historyDate) clearHistoryEditor();
    state.history = history; state.historyDate = history.selectedDate;
  }
  state.summary = summary; state.week = week; state.currentContract = current.contract; setVerifiedUser(me.user); state.product = product; state.profile = profile.profile; state.artifacts = artifacts.artifacts || []; state.support = support;
  storage.set('kopilkaLocale', me.user.locale || 'ru');
  state.lastRefresh = Date.now();
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
  const vk = isVkMiniApp();
  for (const id of ['loginIntro', 'emailLoginForm', 'emailCodeForm', 'emailLoginStatus']) {
    if ($(id)) $(id).hidden = vk;
  }
  if ($('googleLoginButton')) $('googleLoginButton').hidden = vk;
  if ($('telegramLoginButton')) $('telegramLoginButton').hidden = vk;
  if ($('loginTelegramHint')) $('loginTelegramHint').hidden = vk;
  if (!vk) await initTelegramLogin();
}

async function showSessionRecovery() {
  setStatus(L('sessionExpiredLogin'), 'error');
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
    preparedDayStory = null;
    state.token = data.token; setVerifiedUser(data.user); state.sessionRenewalBlocked = false;
    storage.set('kopilkaToken', state.token); storage.set('kopilkaLocale', data.user.locale || 'ru');
    if ($('loginScreen')) $('loginScreen').hidden = true;
    if ($('appShell')) $('appShell').hidden = false;
    $('connectionStatus').textContent = L('telegramSession');
    await loadData();
    setStatus(L('ready'), 'info', 'ready');
  } catch (e) {
    if (status) { status.textContent = e.message || L('loginFailed'); status.classList.add('error'); }
  }
}
window.__kopilkaOnTelegramAuth = handleTelegramLogin;
window.__kopilkaOnTelegramLink = async (user) => {
  try {
    const result = await api('/api/settings/link-telegram', { method: 'POST', body: JSON.stringify({ loginData: user }) });
    setVerifiedUser(result.user); renderSettings(); setStatus(L('telegramLinkDone'));
  } catch (error) {
    if (error.data?.mergeRequired) { showIdentityMerge(error.data); return; }
    $('telegramLinkStatus').textContent = userSafeErrorMessage(error);
  }
};

async function handleVkAuth({ linkOnly = false, suppressReady = false } = {}) {
  if (!linkOnly && !suppressReady) readyNoticeDismissed = false;
  if (vkAuthCoolingDown()) { updateVkAuthCooldown(); return { throttled: true }; }
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
    setVerifiedUser(data.user);
    renderAll();
    setStatus(L('vkLinked'));
    return data;
  }
  preparedDayStory = null;
  state.token = data.token; setVerifiedUser(data.user); state.sessionRenewalBlocked = false;
  storage.set('kopilkaToken', state.token); storage.set('kopilkaLocale', data.user.locale || 'ru');
  if ($('loginScreen')) $('loginScreen').hidden = true;
  if ($('appShell')) $('appShell').hidden = false;
  $('connectionStatus').textContent = L('vkSession');
  await loadData();
  if (!suppressReady) setStatus(L('ready'), 'info', 'ready');
  return data;
}

async function authenticate({ suppressReady = false } = {}) {
  const epoch = authEpoch;
  const inTelegram = Boolean(window.Telegram?.WebApp?.initData);
  const inVk = isVkMiniApp();
  const refCode = captureRefCode();
  if (inVk) {
    await handleVkAuth({ suppressReady });
    return;
  }
  if (inTelegram) {
    const initData = window.Telegram.WebApp.initData;
    const data = await api('/api/auth/telegram', { method: 'POST', body: JSON.stringify({ initData, refCode, timezone: detectTimezone() }), authToken: '' });
    rememberRecoveryNotice(data.recoveryNotice);
    preparedDayStory = null;
    state.token = data.token; setVerifiedUser(data.user); state.sessionRenewalBlocked = false; storage.set('kopilkaToken', state.token); storage.set('kopilkaLocale', data.user.locale || 'ru');
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
      if (epoch !== authEpoch) return;
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
  const epoch = authEpoch;
  const userId = state.user?.id;
  if (date !== state.historyDate && !await leaveHistoryEditor()) return false;
  if (epoch !== authEpoch || userId !== state.user?.id) return false;
  const generation = ++historyReadGeneration;
  const current = () => epoch === authEpoch && userId === state.user?.id && generation === historyReadGeneration;
  const query = date ? `?date=${encodeURIComponent(date)}&days=7` : '?days=7';
  let data;
  try { data = await api(`/api/history${query}`); }
  catch (error) { if (!current()) return false; throw error; }
  if (!current()) return false;
  if (data.selectedDate !== state.historyDate) clearHistoryEditor();
  state.history = data;
  state.historyDate = data.selectedDate;
  renderHistory();
  if (focusHeading && !state.historyEditingId) $('selectedDayHeading')?.focus({ preventScroll: false });
  return true;
}
async function navigateHistory(date) {
  const navigation = ++historyNavigationGeneration;
  const epoch = authEpoch;
  const current = () => navigation === historyNavigationGeneration && epoch === authEpoch;
  if (!await leaveHistoryEditor() || !current()) return;
  const owner = {};
  const inheritsNavigationBusy = historyNavigationBusyOwner !== null && state.busy;
  historyNavigationBusyOwner = owner;
  state.refreshFailed = false;
  // Ownership transfer keeps the first navigation's enabled-state snapshot.
  // Resnapshotting already-disabled controls would leave them locked forever.
  if (inheritsNavigationBusy) setStatus(L('historyLoading'));
  else setBusy(true, L('historyLoading'));
  try {
    const loaded = await loadHistory(date, true);
    if (loaded !== false && current()) setStatus(L('historyLoaded'));
  } catch (error) {
    if (current()) throw error;
  } finally {
    // A retired navigation must not unlock controls owned by a newer one.
    if (historyNavigationBusyOwner === owner) {
      historyNavigationBusyOwner = null;
      if (epoch === authEpoch) setBusy(false);
    }
  }
}
function reconcileHistoryEntry(entry, deleted = false) {
  if (!state.history || !entry || entry.entry_date !== state.history.selectedDate) return;
  let entries = state.history.selectedEntries.filter((item) => item.id !== entry.id);
  if (!deleted) entries.push(entry);
  state.history.selectedEntries = entries;
  const day = state.history.days?.find((item) => item.date === state.history.selectedDate);
  if (day) { day.entryCount = entries.length; day.life = entries.reduce((sum, item) => sum + Number(item.life_points || 0), 0); day.titles = entries.map((item) => item.title); }
}
async function saveHistoryEntry(form) {
  const id = Number(form.dataset.historyEditForm);
  const note = new FormData(form).get('note') || '';
  const position = { left: window.scrollX, top: window.scrollY };
  return withBusy(L('saving'), async () => {
    const data = await api(`/api/entries/${id}`, { method: 'PATCH', body: JSON.stringify({ note }) });
    state.summary = data.summary;
    state.week = data.week;
    reconcileHistoryEntry(data.entry);
    clearHistoryEditor();
    renderHistory(); // Commit is authoritative even when the subsequent read fails.
    await refreshAfterCommit([() => loadHistory(state.historyDate)]);
    renderSummary(); renderWeek();
    document.querySelector(`[data-history-edit="${id}"]`)?.focus({ preventScroll: true });
    window.scrollTo({ ...position, behavior: 'instant' });
    setStatus(L(state.refreshFailed ? 'historySavedRefreshFailed' : 'historySaved'));
    return !state.refreshFailed;
  });
}
let historyDeleteDecision = null;
async function confirmHistoryDelete(id) {
  if (historyDeleteDecision || historyDecision || state.busy || state.publicReadOnly) return false;
  const entry = state.history?.selectedEntries.find(item => Number(item.id) === id && item.editable);
  if (!entry || !state.user?.id) return false;
  const epoch = authEpoch, userId = state.user.id;
  const trigger = document.querySelector(`[data-history-delete="${id}"]`);
  const dialog = document.createElement('dialog');
  dialog.id = 'historyDeleteDialog';
  dialog.className = 'document-dialog';
  dialog.style.width = 'min(30rem, calc(100% - 1rem))';
  dialog.style.height = 'fit-content';
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'historyDeleteTitle');
  dialog.setAttribute('aria-describedby', 'historyDeleteText');
  dialog.innerHTML = `<div class="document-content"><h2 id="historyDeleteTitle">${escapeHtml(L('historyDelete'))}</h2><p id="historyDeleteText">${escapeHtml(L('historyDeleteConfirm'))}</p><div class="history-entry-actions"><button type="button" data-history-delete-choice="confirm">${escapeHtml(L('historyDelete'))}</button><button type="button" class="secondary" data-history-delete-choice="cancel">${escapeHtml(L('historyCancel'))}</button></div></div>`;
  document.body.append(dialog);
  const marker = Math.random().toString(36).slice(2);
  window.history.pushState({ ...window.history.state, kopilkaDeleteDialog: marker }, '');
  return new Promise(resolve => {
    let closing = false, choice = false;
    const finish = (confirmed, restore = true, fromHistory = false) => {
      if (!fromHistory && window.history.state?.kopilkaDeleteDialog === marker) {
        if (closing) return;
        closing = true; choice = confirmed;
        window.history.back();
        return;
      }
      historyDeleteDecision = null;
      dialog.close(); dialog.remove();
      const valid = epoch === authEpoch && userId === state.user?.id;
      if (restore && valid) {
        const target = trigger?.isConnected ? trigger : document.querySelector(`[data-history-delete="${id}"]`) || $('heading-week');
        target?.focus({ preventScroll: true });
      }
      resolve(valid && (closing ? choice : confirmed));
    };
    historyDeleteDecision = { finish };
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
    dialog.addEventListener('click', event => {
      const button = event.target.closest('[data-history-delete-choice]');
      if (button) finish(button.dataset.historyDeleteChoice === 'confirm');
    });
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const buttons = [...dialog.querySelectorAll('button')];
      if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0].focus(); }
    });
    dialog.showModal();
    dialog.querySelector('[data-history-delete-choice="cancel"]').focus();
  });
}
async function deleteHistoryEntry(id) {
  const epoch = authEpoch, userId = state.user?.id;
  const scroll = { left: window.scrollX, top: window.scrollY };
  const ids = (state.history?.selectedEntries || []).filter(item => item.editable).map(item => Number(item.id));
  const index = ids.indexOf(Number(id));
  const nextId = ids[index + 1] ?? ids[index - 1];
  if (!await confirmHistoryDelete(id)) return;
  if (state.busy || state.publicReadOnly || !state.history?.selectedEntries.some(item => Number(item.id) === id && item.editable)) return;
  await withBusy(L('saving'), async () => {
    const data = await api(`/api/entries/${id}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) });
    state.summary = data.summary;
    state.week = data.week;
    reconcileHistoryEntry(state.history?.selectedEntries.find((item) => Number(item.id) === Number(id)), true);
    if (state.historyEditingId === id) clearHistoryEditor();
    renderHistory();
    await refreshAfterCommit([() => loadHistory(state.historyDate, true)]);
    renderQuickActions(); renderSummary(); renderWeek();
    setStatus(L('historyDeleted'));
  });
  // Re-render removes the old trigger. Focus an enabled neighbour only after
  // withBusy releases controls; keep the list position, not the page heading.
  if (epoch !== authEpoch || userId !== state.user?.id || state.activeTab !== 'week') return;
  const target = document.querySelector(`[data-history-delete="${nextId}"]`) || $('historyDate');
  target?.focus({ preventScroll: true });
  window.scrollTo({ ...scroll, behavior: 'instant' });
  // Native dialog/history focus restoration can land after the close event.
  requestAnimationFrame(() => {
    if (epoch === authEpoch && userId === state.user?.id && state.activeTab === 'week') window.scrollTo({ ...scroll, behavior: 'instant' });
  });
}
async function creditSupportAction(actionId) {
  const data = await api(`/api/support/actions/${encodeURIComponent(actionId)}/open`, { method: 'POST', body: JSON.stringify({ source: supportSurface() }) });
  if (data.action) state.support.actions = state.support.actions.map((item) => String(item.id) === String(actionId) ? data.action : item);
  if (data.badge) state.support.badge = data.badge;
  if (data.summary) state.support.summary = data.summary;
  renderSupportActions();
}
function openPlatformUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(L('supportOpenFailed'));
  if (isVkMiniApp()) {
    if (!vkInternalUrl(url.href)) throw new Error(L('supportOpenFailed'));
    const app = /^\/app([1-9]\d*)$/.exec(url.pathname);
    if (app) {
      if (!window.vkBridge?.send) throw new Error(L('supportOpenFailed'));
      // VKWebAppOpenURL is not a VK Bridge event. Open Mini Apps with the
      // supported numeric app ID and location, never a full URL as app_id.
      return withTimeout(window.vkBridge.send('VKWebAppOpenApp', {
        app_id: Number(app[1]), location: url.hash.slice(1)
      }), 10000, L('supportOpenFailed')).then((result) => {
        if (result?.result !== true) throw new Error(L('supportOpenFailed'));
      }).catch(() => { throw new Error(L('supportOpenFailed')); });
    }
    // Other VK pages use a new browsing context, without replacing the
    // signed Mini App document or asking to join a community.
  }
  const tg = window.Telegram?.WebApp;
  if (tg?.initData) {
    if (url.hostname === 't.me' && tg.openTelegramLink) tg.openTelegramLink(url.href);
    else if (tg.openLink) tg.openLink(url.href);
    else throw new Error(L('supportOpenFailed'));
    return Promise.resolve();
  }
  // Called before the first await, while the browser still has user activation.
  const popup = window.open(url.href, '_blank');
  if (!popup) throw new Error(L('supportOpenFailed'));
  try { popup.opener = null; }
  catch (error) { popup.close(); throw error; }
  return Promise.resolve();
}
async function openSupportAction(actionId, previous = captureSupportStatus()) {
  if (state.busy) return;
  const action = state.support?.actions?.find((item) => String(item.id) === String(actionId));
  if (isVkMiniApp() && action?.slug === 'share-kopilka') {
    return withBusy(L('copyingLink'), async () => {
      // Use the verified profile's VK referral, never the generic action URL.
      let link;
      try { link = new URL(state.profile?.vkRefLink || ''); } catch (_) { /* not loaded */ }
      if (!link || link.protocol !== 'https:' || !['vk.com', 'vk.ru'].includes(link.host) ||
          link.pathname !== '/app54723764' || link.username || link.password) {
        setSupportActionError(L('shareUnavailable'), previous);
        return;
      }
      try {
        if (!window.vkBridge?.send) throw new Error('VK bridge unavailable');
        const result = await withTimeout(window.vkBridge.send('VKWebAppCopyText', { text: link.href }), 10000, 'VK copy timeout');
        if (result?.result !== true) throw new Error('VK copy was not confirmed');
      } catch (error) {
        clientLog('vk_support_copy_failed', userSafeErrorMessage(error));
        setSupportActionError(L('copyRetry'), previous);
        return;
      }
      // The server remains the idempotent reward authority. A failed/cancelled
      // bridge call must never reach the credit endpoint; repeats just copy.
      if (action.status === 'available') {
        try { await creditSupportAction(actionId); }
        catch (_) { setSupportActionError(`${L('copied')} ${L('supportCreditUnavailable')}`, previous); return; }
      }
      setStatus(L('copied'), 'info', 'copy');
    });
  }
  if (!action?.url) throw new Error(L('supportOpenFailed'));
  return withBusy(L('supportOpening'), async () => {
    await openPlatformUrl(action.url);
    if (action.status === 'available') {
      try { await creditSupportAction(actionId); }
      catch (_) { setSupportActionError(L('supportCreditUnavailable'), previous); return; }
      setStatus(L('supportCredited'));
    } else setStatus(L('supportOpened'));
  });
}
async function createEntry(type, note = $('entryNote').value.trim()) {
  let awardedArtifacts = [];
  const epoch = authEpoch, userId = state.user?.id;
  const current = () => epoch === authEpoch && userId === state.user?.id;
  await withBusy(L('saving'), async () => {
    const data = await api('/api/entries', { method: 'POST', body: JSON.stringify({ type, note }) });
    if (!current()) return;
    state.summary = data.summary; state.week = data.week; awardedArtifacts = data.awardedArtifacts || [];
    reconcileHistoryEntry(data.entry);
    const field = $(type === 'gratitude' ? 'gratitudeNote' : 'entryNote');
    if (field && field.value.trim() === note) field.value = '';
    // POST is the commit authority. Paint in place and announce now, not after
    // secondary reads (nor on blur/swipe). Keep status outside the busy subtree.
    renderQuickActions(); renderSummary(); renderHistory();
    setStatus(awardedArtifacts.length ? L('artifactUnlockedStatus', { title: awardedArtifacts[0].title })
      : type === 'gratitude' ? L('gratitudeSavedStatus') : L('entrySaved'), 'info', 'entry-success');
    await refreshAfterCommit([refreshProduct, () => state.historyEditingId ? undefined : loadHistory(), async () => {
      if (awardedArtifacts.length) state.artifacts = (await api('/api/artifacts')).artifacts || state.artifacts;
    }]);
    if (!current()) return;
    renderAll();
    if (state.refreshFailed) setStatus(L('refreshPending'));
  }, $('quickActions'));
  // Preserve the existing artifact dialog after controls are enabled. Its
  // success was already announced at commit; opening it must not repeat that.
  if (current() && awardedArtifacts.length) showArtifactToast(awardedArtifacts, false, false);
}
async function createContract(event) { event.preventDefault(); const payload = Object.fromEntries(new FormData(event.currentTarget).entries()); return withBusy(L('creatingContract'), async () => { const data = await api('/api/contracts', { method: 'POST', body: JSON.stringify(payload) }); state.currentContract = data.contract; await refreshAfterCommit([refreshProduct]); renderAll(); setStatus(L('contractCreated')); }); }
async function closeContract(status) {
  let awardedArtifacts = [];
  await withBusy(L('closingContract'), async () => {
    const data = await api(`/api/contracts/${state.currentContract.id}/close`, { method: 'POST', body: JSON.stringify({ status, resultNote: '' }) });
    state.currentContract = null; state.summary = data.summary; state.week = data.week; awardedArtifacts = data.awardedArtifacts || [];
    await refreshAfterCommit([refreshProduct, () => state.historyEditingId ? undefined : loadHistory(), async () => {
      if (awardedArtifacts.length) state.artifacts = (await api('/api/artifacts')).artifacts || state.artifacts;
    }]);
    renderAll();
  });
  if (awardedArtifacts.length) showArtifactToast(awardedArtifacts);
  else setStatus(L('contractClosed'));
}
async function refreshPushStatus() {
  const status = $('pushStatus'), enable = $('enablePush'), disable = $('disablePush');
  if (!state.user || !status) return;
  const userId = state.user.id;
  enable.hidden = disable.hidden = true;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window) || !window.isSecureContext) {
    status.textContent = L('pushUnsupported'); return;
  }
  try {
    const info = await api('/api/settings/push');
    if (state.user?.id !== userId) return;
    if (!info.available) { status.textContent = L('pushUnconfigured'); return; }
    const registration = await navigator.serviceWorker.getRegistration('/');
    const subscription = await registration?.pushManager.getSubscription();
    const current = subscription ? await api('/api/settings/push/status', {
      method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint })
    }) : { subscribed: false };
    if (state.user?.id !== userId) return;
    if (Notification.permission === 'denied') status.textContent = L('pushDenied');
    else status.textContent = L(current.subscribed ? 'pushOn' : 'pushOff');
    enable.hidden = current.subscribed || Notification.permission === 'denied';
    disable.hidden = !current.subscribed;
  } catch (_) { status.textContent = L('pushError'); }
}
function applicationServerKey(value) {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}
async function enableBrowserPush() {
  if (!state.user || !window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  const userId = state.user.id;
  const info = await api('/api/settings/push');
  if (!info.available) { $('pushStatus').textContent = L('pushUnconfigured'); return; }
  // Never request permission on load or from a background refresh.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') { await refreshPushStatus(); return; }
  const registration = await navigator.serviceWorker.register('/push-sw.js', { scope: '/' });
  // A fresh registration may still be installing when register() resolves.
  await withTimeout(navigator.serviceWorker.ready, 12000, 'Push worker did not activate');
  let subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    const owned = await api('/api/settings/push/status', { method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }) });
    if (!owned.subscribed) { await subscription.unsubscribe(); subscription = null; }
  }
  if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(info.publicKey) });
  if (state.user?.id !== userId) { await subscription.unsubscribe(); return; }
  try {
    await api('/api/settings/push', { method: 'POST', body: JSON.stringify(subscription.toJSON()) });
    storage.set('kopilkaPushOwner', String(userId));
  } catch (error) { await subscription.unsubscribe(); throw error; }
  await refreshPushStatus();
}
async function disableBrowserPush() {
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    await api('/api/settings/push', { method: 'DELETE', body: JSON.stringify({ endpoint: subscription.endpoint }) });
    await subscription.unsubscribe();
  }
  storage.remove('kopilkaPushOwner');
  await refreshPushStatus();
}
async function saveSettings(event) {
  event.preventDefault();
  state.settingsDirty = true;
  const timezone = $('timezone').value;
  if (!I18N.validTimezone(timezone)) {
    setStatus(L('invalidTimezone'), 'error');
    return;
  }
  const payload = { timezone, remindersEnabled: $('remindersEnabled').checked, eveningReminderTime: $('eveningReminderTime').value || '20:00' };
  // Compare the draft to confirmed server values, not the input/change flag:
  // reverted edits are no-ops, while a failed save must remain retryable.
  const confirmed = state.user && {
    timezone: state.user.timezone || 'Asia/Novosibirsk',
    remindersEnabled: Boolean(state.user.remindersEnabled),
    eveningReminderTime: state.user.eveningReminderTime || '20:00'
  };
  if (confirmed && Object.keys(payload).every((key) => payload[key] === confirmed[key])) {
    state.settingsDirty = false;
    return;
  }
  settingsSaveRevision++; // A later explicit settings save supersedes pending permission intent.
  return withBusy(L('savingSettings'), async () => {
    const data = await api('/api/settings/reminders', { method: 'POST', body: JSON.stringify(payload) });
    setVerifiedUser(data.user);
    state.settingsDirty = false;
    await refreshAfterCommit([loadData]);
    renderAll();
    setStatus(L('settingsSaved'));
  });
}
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(message instanceof Error ? message : new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}
// A committed mutation must not be presented as failed because a read failed.
async function refreshAfterCommit(tasks) {
  const results = await Promise.allSettled(tasks.map((task) => Promise.resolve().then(task)));
  if (results.some((result) => result.status === 'rejected')) { state.refreshFailed = true; state.lastRefresh = 0; }
}
let vkReminderRequest = null;
let vkReminderNotice = null;
let settingsSaveRevision = 0;
function vkReminderRequestCurrent(request) {
  return Boolean(request && request.epoch === authEpoch && request.token === state.token
    && request.userId === state.user?.id && !state.publicReadOnly);
}
async function enableVkReminders() {
  // Only this operation waits for VK. Never treat focus or silence as consent.
  if (vkReminderRequestCurrent(vkReminderRequest)) return;
  const request = { epoch: authEpoch, token: state.token, userId: state.user?.id,
    settingsRevision: settingsSaveRevision, statusRevision: -1 };
  vkReminderRequest = request;
  vkReminderNotice = null;
  const current = () => vkReminderRequest === request && vkReminderRequestCurrent(request)
    && request.settingsRevision === settingsSaveRevision;
  const reminderError = key => Object.assign(new Error(L(key)), { reminderKey: key });
  const publish = (text, type = 'info', key = '') => {
    if (!current()) return;
    vkReminderNotice = { ...request, text, key };
    if (!state.busy && statusRevision === request.statusRevision) {
      setStatus(text, type); request.statusRevision = statusRevision;
    }
  };
  try {
    if (!isVkMiniApp() || !window.vkBridge?.send) throw reminderError('vkReminderStatusNeedVk');
    if (!state.user || !state.token) return;
    setStatus(L('vkReminderRequesting'));
    request.statusRevision = statusRevision;
    renderVkReminderOffer();
    const cfg = await getPublicConfig();
    if (!current()) return;
    if (!cfg.vkGroupId || !cfg.vkMessagesEnabled) throw reminderError('vkReminderDenied');
    const timeoutError = reminderError('vkReminderNoResult');
    let result;
    try {
      result = await withTimeout(window.vkBridge.send('VKWebAppAllowMessagesFromGroup',
        { group_id: Number(cfg.vkGroupId), key: 'evening_reminders' }), 8000, timeoutError);
    } catch (error) {
      clientLog('vk_reminder_bridge_error', error || {});
      throw reminderError(error === timeoutError ? 'vkReminderNoResult' : 'vkReminderDenied');
    }
    clientLog('vk_reminder_bridge_result', result || {});
    if (!current()) return;
    if (!(result?.result === true || result?.result === 1 || result?.result === '1')) throw reminderError('vkReminderDenied');
    // Serialize only the short server mutation, not the permission dialog.
    const deadline = Date.now() + 15000;
    while (state.busy) {
      if (!current()) return;
      if (Date.now() >= deadline) throw reminderError('networkUnavailable');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!current()) return;
    await withBusy('', async () => {
      const data = await api('/api/settings/vk-messages', { method: 'POST',
        body: JSON.stringify({ allowed: true, enableReminders: true }) });
      if (!current()) return;
      setVerifiedUser(data.user);
      publish(L('vkReminderAllowed'), 'info', 'vkReminderAllowed');
      renderAll();
    });
    publish(L('vkReminderAllowed'), 'info', 'vkReminderAllowed');
  } catch (error) {
    publish(error.message || L('vkReminderDenied'), 'error', error.reminderKey || (!error.message ? 'vkReminderDenied' : ''));
    throw error;
  } finally {
    if (vkReminderRequest === request) vkReminderRequest = null;
    renderVkReminderOffer();
  }
}
async function setLanguage(lang) {
  const normalized = I18N.normalizeLocale(lang);
  if (normalized === locale()) return;
  return withBusy(L('savingSettings'), async () => {
    if (state.token) { const data = await api('/api/settings/locale', { method: 'POST', body: JSON.stringify({ locale: normalized }) }); setVerifiedUser(data.user); }
    storage.set('kopilkaLocale', normalized);
    await refreshAfterCommit([loadData]);
    renderAll(); setStatus(L('settingsSaved'));
    if (state.activeTab === 'settings') void refreshPushStatus();
  });
}
async function cleanupDemo() { if (!state.user?.isDemo) { setStatus(L('notDemo'), 'error'); return; } const id = state.user.id; return withBusy(L('deletingDemo'), async () => { await api(`/api/dev/demo-user/${id}`, { method: 'DELETE' }); storage.remove('kopilkaToken'); state.token = ''; setVerifiedUser(null); preparedDayStory = null; state.summary = null; state.week = null; state.currentContract = null; state.support = null; renderAll(); setStatus(L('demoDeleted')); await authenticate(); }); }
function showIdentityMerge(offer) {
  state.pendingMerge = { ...offer, identity: true };
  storage.set('kopilkaVkMergeToken', offer.mergeToken);
  switchTab('profile'); renderSettings();
  $('mergeAccountsHeading')?.focus();
  setStatus(L('mergeNeedsConfirmation'));
}
function identityOfferToken(token) { return /^[A-Za-z0-9_-]{43}$/.test(String(token || '')); }
async function loadPendingMerge() {
  const mergeToken = storage.get('kopilkaVkMergeToken');
  if (!mergeToken || !state.token) return;
  try {
    const identity = identityOfferToken(mergeToken);
    const data = await api(identity ? '/api/account/merge-identity/preview' : '/api/account/merge-vk/preview', { method: 'POST', body: JSON.stringify({ mergeToken }) });
    state.pendingMerge = { ...data, identity };
    switchTab('profile');
    renderSettings();
    $('mergeAccountsHeading')?.focus();
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
    const identity = identityOfferToken(mergeToken);
    const data = await api(identity ? '/api/account/merge-identity/confirm' : '/api/account/merge-vk/confirm', { method: 'POST', body: JSON.stringify({ mergeToken, confirm: true }) });
    state.token = data.token;
    storage.set('kopilkaToken', data.token);
    storage.remove('kopilkaVkMergeToken');
    state.pendingMerge = null;
    preparedDayStory = null;
    authEpoch++;
    clearHistoryEditor();
    setVerifiedUser(data.user);
    state.summary = data.summary;
    state.week = data.week;
    await refreshAfterCommit([loadData]);
    renderAll(); switchTab('profile');
    setStatus(L('mergeDone'));
  });
}
function cancelAccountMerge() {
  storage.remove('kopilkaVkMergeToken');
  state.pendingMerge = null;
  renderSettings();
  setStatus(L('mergeCancelled'));
}
function keepFocusedControlVisible(event) {
  const control = event.target;
  if (!control?.closest?.('.main-content') || !control.matches('button,input,textarea,select,a')) return;
  const nav = document.querySelector('.tab-bar');
  if (!nav || nav.hidden || !nav.getClientRects().length) return;
  const rect = control.getBoundingClientRect();
  const viewport = window.visualViewport;
  const viewportBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
  const top = Math.min(nav.getBoundingClientRect().top, viewportBottom);
  const activeEditable = control === document.activeElement && control.matches('input,textarea,select');
  if (rect.bottom > top - 8 && (rect.top < window.innerHeight || activeEditable)) {
    const viewportTop = Math.max(0, viewport ? viewport.offsetTop : 0);
    // When navigation fills most of the viewport, do not reveal the bottom by hiding the field's top.
    const availableScroll = Math.max(0, rect.top - viewportTop - 8);
    window.scrollBy({ top: Math.min(rect.bottom - top + 8, availableScroll), behavior: 'instant' });
  }
}
function bindEvents() {
  document.addEventListener('focusin', keepFocusedControlVisible);
  const revealActiveControl = () => {
    // Keyboard resize must not override explicit scroll restoration to a link/button.
    const control = document.activeElement;
    if (control?.matches('input,textarea,select')) keepFocusedControlVisible({ target: control });
  };
  window.addEventListener('resize', revealActiveControl);
  window.visualViewport?.addEventListener('resize', revealActiveControl);
  // Keep the symbolic amount a decimal draft. Reject the entire invalid edit
  // rather than silently turning e.g. a pasted negative into a positive amount.
  // Partial decimals remain editable; the existing submit/backend rules still
  // require a complete nonnegative decimal. Do not interrupt IME composition.
  const stakeAmount = $('stakeAmount');
  const decimalDraft = (value) => /^\d*(?:[.,]\d*)?$/.test(value);
  let amountDraft = { value: stakeAmount.value, start: 0, end: 0 };
  let amountComposing = false;
  const rememberAmount = () => {
    if (decimalDraft(stakeAmount.value)) amountDraft = {
      value: stakeAmount.value, start: stakeAmount.selectionStart, end: stakeAmount.selectionEnd
    };
  };
  const checkAmount = () => {
    if (decimalDraft(stakeAmount.value)) rememberAmount();
    else {
      stakeAmount.value = amountDraft.value;
      stakeAmount.setSelectionRange(amountDraft.start, amountDraft.end);
    }
  };
  const acceptsAmountInsertion = (text) => decimalDraft(
    stakeAmount.value.slice(0, stakeAmount.selectionStart) + text +
    stakeAmount.value.slice(stakeAmount.selectionEnd)
  );
  stakeAmount.addEventListener('beforeinput', (event) => {
    if (amountComposing || event.isComposing) return;
    rememberAmount();
    if (event.inputType.startsWith('insert') && event.data != null && !acceptsAmountInsertion(event.data)) event.preventDefault();
  });
  stakeAmount.addEventListener('paste', (event) => {
    if (amountComposing) return;
    rememberAmount();
    const text = event.clipboardData?.getData('text/plain');
    if (text != null && !acceptsAmountInsertion(text)) event.preventDefault();
  });
  stakeAmount.addEventListener('compositionstart', () => { rememberAmount(); amountComposing = true; });
  stakeAmount.addEventListener('compositionend', () => { amountComposing = false; checkAmount(); });
  stakeAmount.addEventListener('input', (event) => { if (!amountComposing && !event.isComposing) checkAmount(); });
  $('settingsForm').addEventListener('input', () => { state.settingsDirty = settingsDraftChanged(); });
  $('settingsForm').addEventListener('change', () => { state.settingsDirty = settingsDraftChanged(); });
  window.addEventListener('beforeunload', (event) => {
    if (!settingsDraftChanged()) return;
    event.preventDefault(); event.returnValue = '';
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && readyStatusDismissible() &&
        !document.querySelector('dialog[open], .document-dialog[open]')) $('dismissStatus')?.click();
  });
  document.addEventListener('click', (event) => {
    if (readyStatusDismissible() && !event.target.closest('#statusRegion, #dismissStatus')) $('dismissStatus')?.click();
  });
  window.addEventListener('message', (event) => { void receiveVkOAuthHandoff(event); });
  document.querySelector('.tab-bar').addEventListener('keydown', handleTabKey);
  document.querySelectorAll('.tab-bar button').forEach((b) => { b.tabIndex = b.dataset.tab === state.activeTab ? 0 : -1; });
  saveNavigation(true);
  window.addEventListener('beforeunload', event => {
    const field = historyEditor && $(`history-note-${historyEditor.id}`);
    if (!field || historyEditor.userId !== state.user?.id || field.value === historyEditor.original) return;
    event.preventDefault();
    event.returnValue = ''; // Browser-owned warning; no durable private-note storage.
  });
  window.addEventListener('popstate', restoreNavigation);
  window.addEventListener('focus', () => { void refreshOnReturn(); });
  window.addEventListener('pageshow', () => { void refreshOnReturn(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshOnReturn(); });
  window.setInterval(() => { if (refreshedDay !== localDay() || state.refreshFailed) void refreshOnReturn(); }, 60000);
  document.querySelector('.tab-bar').addEventListener('click', (event) => { const b = event.target.closest('button[data-tab]'); if (b && !state.busy && !state.publicReadOnly) switchTab(b.dataset.tab); });
  $('historyDate')?.addEventListener('change', async (event) => { if (state.busy || !event.target.value) return; try { await navigateHistory(event.target.value); } catch (e) { setStatus(e.message, 'error'); renderHistory(); } });
  $('historyPrevious')?.addEventListener('click', async () => { if (state.busy || !state.history?.previousDate) return; try { await navigateHistory(state.history.previousDate); } catch (e) { setStatus(e.message, 'error'); } });
  $('historyToday')?.addEventListener('click', async () => { if (state.busy) return; try { await navigateHistory(state.history?.todayDate || ''); } catch (e) { setStatus(e.message, 'error'); } });
  $('historyNext')?.addEventListener('click', async () => { if (state.busy || !state.history?.nextDate) return; try { await navigateHistory(state.history.nextDate); } catch (e) { setStatus(e.message, 'error'); } });
  $('historyDays')?.addEventListener('click', async (event) => { const button = event.target.closest('[data-history-date]'); if (!button || state.busy) return; try { await navigateHistory(button.dataset.historyDate); } catch (e) { setStatus(e.message, 'error'); } });
  $('selectedDayEntries')?.addEventListener('click', async (event) => {
    const edit = event.target.closest('[data-history-edit]');
    if (edit && !state.busy && !historyDecision) { const id = Number(edit.dataset.historyEdit); if (await leaveHistoryEditor()) openHistoryEditor(id); return; }
    if (event.target.closest('[data-history-cancel]') && !state.busy && !historyDecision) { const id = state.historyEditingId; if (!await leaveHistoryEditor()) return; clearHistoryEditor(); renderHistory(); document.querySelector(`[data-history-edit="${id}"]`)?.focus(); return; }
    const remove = event.target.closest('[data-history-delete]');
    if (remove && !state.busy) { try { await deleteHistoryEntry(Number(remove.dataset.historyDelete)); } catch (e) { setStatus(e.message, 'error'); } }
  });
  $('selectedDayEntries')?.addEventListener('submit', async (event) => { const form = event.target.closest('[data-history-edit-form]'); if (!form || state.busy) return; event.preventDefault(); try { await saveHistoryEntry(form); } catch (e) { setStatus(e.message, 'error'); } });
  $('quickActions').addEventListener('click', async (event) => {
    const b = event.target.closest('.qa-item')?.querySelector('button[data-entry-type]');
    if (!b || state.publicReadOnly || b.dataset.usedToday === 'true') return;
    if (state.busy) {
      // A returning Mini App may refresh in the background while a button is
      // already visible. Remember one intentional tap; never replay duplicates
      // or a tap across an account/tab change.
      if (state.refreshPending && state.user?.id && state.summary && !state.pendingQuickAfterRefresh) {
        state.pendingQuickAfterRefresh = {
          type: b.dataset.entryType, userId: state.user.id, note: $('entryNote').value.trim()
        };
        setStatus(L('saving'));
      }
      return;
    }
    state.quickActionReturnType = b.dataset.entryType || '';
    state.quickActionReturnButton = b;
    try { await createEntry(b.dataset.entryType); }
    catch (error) {
      state.quickActionReturnType = '';
      state.quickActionReturnButton = null;
      setStatus(error.message, 'error');
    }
  });
  $('daySceneShare')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (button.disabled || state.busy || state.publicReadOnly) return;
    if (telegramDayStorySupported() && !isVkMiniApp() && preparedDayStoryReady()) {
      const tg = window.Telegram.WebApp;
      const { url, destination } = preparedDayStory;
      try {
        tg.showPopup({ message: L('daySceneStoryTelegramConfirm'), buttons: [
          { id: 'share', type: 'default', text: L('storyConfirmButton') },
          { id: 'cancel', type: 'cancel' }
        ] }, (id) => {
          if (id !== 'share') { setStatus(L('daySceneStoryTelegramCanceled')); return; }
          if (!preparedDayStoryReady() || preparedDayStory?.url !== url) {
            preparedDayStory = null;
            applyStaticI18n();
            setStatus(L('daySceneStoryTelegramExpired'), 'error');
            return;
          }
          try {
            tg.shareToStory(url, { text: L('daySceneTitle'),
              widget_link: { url: destination, name: L('daySceneStoryOpenApp') } });
            setStatus(L('daySceneStoryTelegramRequested'));
          } catch (_) { setStatus(L('daySceneStoryTelegramError'), 'error'); }
        });
      } catch (_) { setStatus(L('daySceneStoryTelegramError'), 'error'); }
      return;
    }
    // Track this operation separately from the foreground-refresh busy snapshot.
    button.setAttribute('aria-disabled', 'true');
    button.disabled = true;
    try {
      const date = daySceneDate();
      if (telegramDayStorySupported() && !isVkMiniApp()) {
        preparedDayStory = null;
        setStatus(L('daySceneStoryTelegramPreparing'));
        const key = daySceneStoryKey();
        const picture = await window.KopilkaDayScene.share(locale(), date, 'telegram');
        const { url } = await api('/api/day-scene-story', {
          method: 'POST', headers: { 'content-type': 'image/png' }, body: picture
        });
        const media = new URL(url);
        if (media.origin !== location.origin ||
            (media.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(media.hostname))) throw new Error('Invalid story media URL');
        const config = await getPublicConfig();
        const username = String(config.botUsername || '').replace(/^@/, '');
        if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new Error('Telegram bot link unavailable');
        if (key !== daySceneStoryKey()) throw new Error('Day scene changed while preparing');
        preparedDayStory = { key, url, destination: `https://t.me/${username}?startapp`, expiresAt: Date.now() + 9 * 60 * 1000 };
        applyStaticI18n();
        setStatus(L('daySceneStoryTelegramReady'));
        return;
      }
      const result = await window.KopilkaDayScene.share(locale(), date, isVkMiniApp() ? 'vk' : 'web');
      if (result === 'story_editor') setStatus(L('daySceneStoryOpened'));
      if (result === 'cancelled' && isVkMiniApp()) setStatus(L('daySceneStoryCanceled'));
      if (result === 'shared') setStatus(L('daySceneShared'));
      if (result === 'downloaded') setStatus(L('daySceneDownloaded'));
    } catch (_) { setStatus(L(telegramDayStorySupported() && !isVkMiniApp() ? 'daySceneStoryTelegramError' : (isVkMiniApp() ? 'daySceneStoryError' : 'daySceneShareError')), 'error'); }
    finally {
      button.setAttribute('aria-disabled', 'false');
      button.disabled = state.busy;
      applyStaticI18n();
    }
  });
  $('gratitudePractice')?.addEventListener('click', async (event) => { const hint = event.target.closest('[data-gratitude-hint]'); if (hint && !state.busy && !state.publicReadOnly) { appendGratitudeHint(hint.dataset.gratitudeHint); return; } const b = event.target.closest('[data-gratitude-submit]'); if (!b || state.busy || state.publicReadOnly) return; try { await createEntry('gratitude', $('gratitudeNote')?.value.trim() || ''); } catch (e) { setStatus(e.message, 'error'); } });
  $('supportActionsList')?.addEventListener('click', async (event) => { const b = event.target.closest('button[data-support-open]'); if (!b || state.busy || state.publicReadOnly) return; const previous = captureSupportStatus(); try { await openSupportAction(b.dataset.supportOpen, previous); } catch (_) { setSupportActionError(L('supportOpenFailed'), previous); } });
  document.querySelectorAll('[data-open-contract]').forEach((btn) => btn.addEventListener('click', () => { if (!state.busy && !state.publicReadOnly) switchTab('contract'); }));
  $('artifactToastClose')?.addEventListener('click', hideArtifactToast);
  $('recoveryNoticeClose')?.addEventListener('click', () => { state.recoveryNotice = null; renderRecoveryNotice(); });
  $('artifactToast')?.addEventListener('keydown', keepArtifactDialogFocus);
  $('contractTemplates').addEventListener('click', (event) => { const b = event.target.closest('button[data-template-id]'); if (b && !state.busy && !state.publicReadOnly) applyTemplate(b.dataset.templateId); });
  $('practiceGoal').addEventListener('change', async (event) => { if (state.busy || state.publicReadOnly) return; try { state.product.practices = await api(`/api/product/practices?goal=${encodeURIComponent(event.target.value)}`); renderPractices(); setStatus(L('practicesUpdated')); } catch (e) { setStatus(e.message, 'error'); } });
  $('contractForm').addEventListener('input', updateContractCounters);
  $('contractForm').addEventListener('change', updateContractCounters);
  // The reset event precedes the native value reset.
  $('contractForm').addEventListener('reset', () => queueMicrotask(updateContractCounters));
  $('contractForm').addEventListener('submit', async (event) => { if (state.publicReadOnly) { event.preventDefault(); return; } try { await createContract(event); } catch (e) { event.preventDefault(); setStatus(e.message, 'error'); } });
  $('contractCurrent').addEventListener('click', async (event) => { const b = event.target.closest('button[data-close-status]'); if (!b || state.busy || state.publicReadOnly) return; try { await closeContract(b.dataset.closeStatus); } catch (e) { setStatus(e.message, 'error'); } });
  $('settingsForm').addEventListener('submit', async (event) => { if (state.publicReadOnly) { event.preventDefault(); return; } try { await saveSettings(event); } catch (e) { event.preventDefault(); setStatus(e.message, 'error'); } });
  const promptInstall = async () => {
    if (!pendingInstallPrompt || !state.user || !outsideMiniApp()) return;
    const offer = pendingInstallPrompt;
    pendingInstallPrompt = null;
    renderInstallOffer();
    try {
      await offer.prompt();
      if ((await offer.userChoice)?.outcome === 'dismissed') {
        storage.set('kopilkaInstallHomeDismissed', '1');
        renderInstallOffer();
      }
    } catch (_) { /* browser controls availability and cancellation */ }
  };
  $('installAppButton')?.addEventListener('click', promptInstall);
  $('installHomeButton')?.addEventListener('click', promptInstall);
  $('installHomeDismiss')?.addEventListener('click', () => {
    storage.set('kopilkaInstallHomeDismissed', '1');
    renderInstallOffer();
    $('heading-today')?.focus({ preventScroll: true });
  });
  $('signOutSite')?.addEventListener('click', () => { void signOutWebsite(); });
  $('enablePush')?.addEventListener('click', async () => {
    if (state.busy || state.publicReadOnly) return;
    $('enablePush').disabled = true;
    try { await enableBrowserPush(); } catch (_) { $('pushStatus').textContent = L('pushError'); }
    finally { $('enablePush').disabled = false; }
  });
  $('disablePush')?.addEventListener('click', async () => {
    if (state.busy || state.publicReadOnly) return;
    $('disablePush').disabled = true;
    try { await disableBrowserPush(); } catch (_) { $('pushStatus').textContent = L('pushError'); }
    finally { $('disablePush').disabled = false; }
  });
  document.querySelectorAll('[data-enable-vk-reminders]').forEach((btn) => btn.addEventListener('click', async () => { if (state.busy || state.publicReadOnly) return; try { await enableVkReminders(); } catch (_) { /* The request owns its notice; never overwrite a newer action. */ } }));
  $('accountLinksHeading')?.closest('.summary-card')?.addEventListener('click', async (event) => {
    if (event.target.closest('#confirmAccountMerge')) { try { await confirmAccountMerge(); } catch (e) { setStatus(e.message, 'error'); } }
    if (event.target.closest('#cancelAccountMerge')) cancelAccountMerge();
  });
  $('cleanupDemo').addEventListener('click', async () => { if (state.busy) return; try { await cleanupDemo(); } catch (e) { setStatus(e.message, 'error'); } });
  document.querySelectorAll('[data-lang]').forEach((btn) => btn.addEventListener('click', async () => { if (state.busy) return; try { await setLanguage(btn.dataset.lang); setStatus(L('settingsSaved')); } catch (e) { setStatus(e.message, 'error'); } }));
  const vkBtn = $('vkLoginButton');
  $('googleLoginButton')?.addEventListener('click', async () => {
    if (isVkMiniApp()) return;
    const button = $('googleLoginButton'); button.disabled = true;
    try { await startGoogleOAuth('auth'); }
    catch (e) { setLoginStatus(e.message, 'error'); button.disabled = false; }
  });
  $('emailLoginForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = $('emailLoginStatus');
    try {
      await api('/api/auth/email/request', { method: 'POST', authToken: '', body: JSON.stringify({ email: $('emailLoginAddress').value }) });
      $('emailCodeForm').hidden = false;
      status.textContent = L('emailCheckInbox'); status.classList.remove('error');
    } catch (e) { status.textContent = e.message; status.classList.add('error'); }
  });
  $('emailCodeForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = $('emailLoginStatus');
    try {
      const data = await api('/api/auth/email/verify', { method: 'POST', authToken: '', body: JSON.stringify({
        email: $('emailLoginAddress').value, code: $('emailLoginCode').value,
        refCode: captureRefCode(), timezone: detectTimezone(), locale: locale()
      }) });
      state.token = data.token; setVerifiedUser(data.user); state.sessionRenewalBlocked = false;
      storage.set('kopilkaToken', data.token); storage.set('kopilkaLocale', data.user.locale || 'ru');
      $('emailLoginCode').value = '';
      $('loginScreen').hidden = true; $('appShell').hidden = false;
      $('connectionStatus').textContent = L('emailConnected');
      await loadData(); setStatus(L('ready'), 'info', 'ready');
    } catch (e) { $('emailLoginCode').value = ''; status.textContent = e.message; status.classList.add('error'); }
  });
  if (vkBtn) vkBtn.addEventListener('click', async () => {
    if (vkAuthCoolingDown()) { updateVkAuthCooldown(); return; }
    vkBtn.disabled = true;
    vkBtn.textContent = L('loginVkSoon');
    try {
      if (vkStartupRetry && isVkMiniApp()) { vkStartupRetry = false; await start(); }
      else await startVkOAuth('auth', $('loginStatus'));
    } catch (e) { setLoginStatus(userSafeErrorMessage(e), 'error'); }
    finally { if (!state.vkOAuthWindow) restoreVkOAuthAction('auth'); if (vkAuthCoolingDown()) updateVkAuthCooldown(); }
  });
  const linkVkBtn = $('linkVkAccount');
  $('linkGoogleAccount')?.addEventListener('click', async () => {
    if (isVkMiniApp()) return;
    const button = $('linkGoogleAccount'); button.disabled = true;
    try { await startGoogleOAuth('link'); }
    catch (e) { setStatus(e.message, 'error'); button.disabled = false; }
  });
  $('unlinkLoginAccounts')?.addEventListener('click', async () => {
    if (!state.user || state.publicReadOnly) return;
    if (!window.confirm('Отвязать e-mail и Google? После этого они не откроют этот аккаунт. VK/Telegram и данные сохранятся.')) return;
    const button = $('unlinkLoginAccounts'); button.disabled = true;
    try {
      await api('/api/settings/unlink-logins', { method: 'POST', body: JSON.stringify({ confirm: true }) });
      $('linkEmailCodeForm').hidden = true;
      $('linkEmailCode').value = '';
      refreshLinkedLogins();
    } catch (e) { $('linkedLoginsStatus').textContent = e.message; }
    finally { button.disabled = false; }
  });
  $('linkTelegramAccount')?.addEventListener('click', async () => {
    if (isVkMiniApp()) return;
    const status = $('telegramLinkStatus');
    try {
      if (window.Telegram?.WebApp?.initData) {
        const result = await api('/api/settings/link-telegram', { method: 'POST', body: JSON.stringify({ initData: window.Telegram.WebApp.initData }) });
        setVerifiedUser(result.user); renderSettings(); setStatus(L('telegramLinkDone'));
      } else {
        const cfg = await getPublicConfig();
        if (!cfg.botUsername) throw new Error(L('telegramDomainHint'));
        const handoff = await api('/api/settings/telegram-link-intent', { method: 'POST', body: '{}' });
        const url = new URL(handoff.launchUrl);
        if (url.protocol !== 'https:' || url.hostname !== 't.me' || url.pathname !== `/${cfg.botUsername.replace(/^@/, '')}` ||
            url.searchParams.get('startapp') !== `link_${handoff.intent}` || !/^[A-Za-z0-9_-]{43}$/.test(handoff.intent)) throw new Error(L('loginFailed'));
        state.telegramLinkIntent = handoff.intent;
        $('telegramLinkOpen').href = url.href;
        $('telegramLinkHandoff').hidden = false;
        status.textContent = L('telegramLinkHandoffHint');
      }
    } catch (error) {
      if (error.data?.mergeRequired) { showIdentityMerge(error.data); return; }
      status.textContent = userSafeErrorMessage(error);
    }
  });
  $('telegramLinkFinish')?.addEventListener('click', async () => {
    if (isVkMiniApp()) return;
    const status = $('telegramLinkStatus');
    try {
      if (!state.telegramLinkIntent) throw new Error(L('telegramLinkExpired'));
      const result = await api('/api/settings/telegram-link-complete', { method: 'POST', body: JSON.stringify({ intent: state.telegramLinkIntent }) });
      if (result.pending) { status.textContent = L('telegramLinkPending'); return; }
      state.telegramLinkIntent = ''; $('telegramLinkHandoff').hidden = true;
      setVerifiedUser(result.user); renderSettings(); status.textContent = L('telegramLinkDone');
    } catch (error) {
      if (error.data?.mergeRequired) {
        state.telegramLinkIntent = ''; $('telegramLinkHandoff').hidden = true;
        showIdentityMerge(error.data); return;
      }
      status.textContent = userSafeErrorMessage(error);
    }
  });
  $('telegramLinkConsent')?.addEventListener('click', async () => {
    const button = $('telegramLinkConsent'); button.disabled = true;
    try {
      await api('/api/auth/telegram-link-claim', { method: 'POST', authToken: '',
        body: JSON.stringify({ initData: window.Telegram?.WebApp?.initData || '' }) });
      button.hidden = true;
      $('telegramLinkClaimStatus').textContent = L('telegramLinkClaimed');
    } catch (error) {
      $('telegramLinkClaimStatus').textContent = userSafeErrorMessage(error);
      button.disabled = false;
    }
  });
  $('linkEmailForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = $('emailLinkStatus');
    try {
      await api('/api/auth/email/request', { method: 'POST', body: JSON.stringify({ email: $('linkEmailAddress').value, link: true }) });
      $('linkEmailCodeForm').hidden = false;
      status.textContent = L('emailCheckInbox'); status.classList.remove('error');
    } catch (e) { status.textContent = e.message; status.classList.add('error'); }
  });
  $('linkEmailCodeForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = $('emailLinkStatus');
    try {
      await api('/api/auth/email/verify', { method: 'POST', body: JSON.stringify({
        email: $('linkEmailAddress').value, code: $('linkEmailCode').value, link: true
      }) });
      $('linkEmailCode').value = ''; $('linkEmailCodeForm').hidden = true;
      status.textContent = L('emailLinkDone'); status.classList.remove('error');
      refreshLinkedLogins();
    } catch (e) {
      $('linkEmailCode').value = '';
      if (e.data?.mergeRequired) { $('linkEmailCodeForm').hidden = true; showIdentityMerge(e.data); return; }
      status.textContent = e.message; status.classList.add('error');
    }
  });
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
        switchTab('profile');
        $('mergeAccountsHeading')?.focus();
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
    if ($('shareFallback')) $('shareFallback').hidden = true;
    if (await copyText(link)) setStatus(`${L('copied')} ${L('referralPrivacyNotice')}`, 'info', 'copy');
    else showManualShare(link, 'copyFailed', 'error', true);
  });
  async function copyText(value) {
    try {
      if (isVkMiniApp()) {
        if (!window.vkBridge?.send) return false;
        const result = await withTimeout(window.vkBridge.send('VKWebAppCopyText', { text: value }), 10000, 'VK copy timeout');
        return result?.result === true;
      }
      if (!navigator.clipboard?.writeText) return false;
      await navigator.clipboard.writeText(value);
      return true;
    } catch (error) {
      clientLog('clipboard_write_failed', userSafeErrorMessage(error));
      return false;
    }
  }
  function showManualShare(url, statusKey = 'copyFailed', statusType = 'error', referral = false) {
    const box = $('shareFallback');
    const input = $('shareFallbackLink');
    const message = referral ? `${L(statusKey)} ${L('referralPrivacyNotice')}` : L(statusKey);
    if (!box || !input || !url) { setStatus(message, statusType); return; }
    box.hidden = false;
    input.value = url;
    // Set the description before the existing manual-copy focus/selection.
    // Explicitly clear referral context for later profile/story fallbacks.
    if (referral) input.setAttribute('aria-describedby', 'shareFallbackHint referralPrivacyNotice');
    else input.removeAttribute('aria-describedby');
    input.focus();
    input.select();
    setStatus(message, statusType);
  }
  function vkShareResultStatus(result) {
    // Native VK returned an `items` envelope during an authenticated Android share;
    // SDK 3.0.2 can also spread response arrays into numeric-key objects.
    const rows = Array.isArray(result) ? result : (result && typeof result === 'object'
      ? (Array.isArray(result.items) ? result.items : (typeof result.type === 'string' ? [result] : Object.keys(result)
        .filter(key => /^(0|[1-9]\d*)$/.test(key)).map(key => result[key]))) : []);
    const published = rows.some(row => row && (
      (row.type === 'story' && typeof row.story_id === 'string' && row.story_id.trim()) ||
      (row.type === 'post' && typeof row.post_id === 'string' && row.post_id.trim())));
    if (published) return 'sharePublicationCompleted';
    if (rows.some(row => row?.type === 'message' && Array.isArray(row.users) && row.users.length > 0)) return 'shareCompleted';
    if (result?.result === true && !result.type && rows.length === 0) return 'shareActionCompleted';
    return 'shareUnconfirmed';
  }
  function vkShareWasCancelled(error) {
    return error?.error_type === 'client_error' && error?.error_data?.error_code === 4;
  }
  async function shareUrl(url, text, referral = false) {
    if (!url) { setStatus(L('shareUnavailable'), 'error'); return; }
    if ($('shareFallback')) $('shareFallback').hidden = true;
    const inTelegram = Boolean(window.Telegram?.WebApp?.initData);
    const tg = window.Telegram?.WebApp;
    if (isVkMiniApp() && window.vkBridge?.send) {
      const shareRequest = { id: ++vkShareRequestId, until: Date.now() + 30000 };
      for (const request of vkSharePending) {
        if (request.until <= Date.now()) vkSharePending.delete(request);
      }
      vkSharePending.add(shareRequest);
      try {
        const result = await window.vkBridge.send('VKWebAppShare', { link: url, text: text || '' });
        if (shareRequest.id !== vkShareRequestId) return;
        const statusKey = vkShareResultStatus(result);
        if (statusKey === 'shareUnconfirmed') {
          if (referral) showManualShare(url, statusKey, 'info', true);
          else showManualShare(url, statusKey, 'info');
        }
        else setStatus(L(statusKey));
        return;
      } catch (error) {
        if (shareRequest.id !== vkShareRequestId) return;
        if (vkShareWasCancelled(error)) {
          // Cancellation must not open/select a field (and the mobile keyboard),
          // move scroll, or initiate another sharing/copying action.
          setStatus(L('shareCancelled'));
          return;
        }
        clientLog('vk_share_failed', userSafeErrorMessage(error));
      } finally {
        vkSharePending.delete(shareRequest);
        if (shareRequest.id === vkShareRequestId) vkShareReturnUntil = Date.now() + 1000;
      }
    }
    if (inTelegram && tg && tg.switchInlineQuery) {
      try { tg.switchInlineQuery(`${text} ${url}`, ['users', 'groups', 'channels']); setStatus(L('shareOpened')); return; } catch (error) { clientLog('telegram_inline_share_failed', userSafeErrorMessage(error)); }
    }
    if (navigator.share) {
      try { await navigator.share({ title: L('appName'), text, url }); setStatus(L('shareCompleted')); return; }
      catch (error) {
        clientLog('native_share_failed', userSafeErrorMessage(error));
        const statusKey = error?.name === 'AbortError' ? 'shareCancelled' : 'copyFailed';
        if (referral) showManualShare(url, statusKey, 'error', true);
        else showManualShare(url, statusKey);
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
    if (await copyText(url)) setStatus(referral ? `${L('copied')} ${L('referralPrivacyNotice')}` : L('copied'), 'info', 'copy');
    else if (referral) showManualShare(url, 'copyFailed', 'error', true);
    else showManualShare(url, 'copyFailed');
  }
  const shareRefBtn = $('shareRefLink');
  if (shareRefBtn) shareRefBtn.addEventListener('click', () => {
    const inBot = Boolean(window.Telegram?.WebApp?.initData);
    const inVk = isVkMiniApp();
    const url = state.profile ? (inVk ? (state.profile.vkRefLink || state.profile.refLink || '') : (inBot ? (state.profile.botLink || '') : (state.profile.refLink || ''))) : '';
    void shareUrl(url, L('shareRefText'), true);
  });
  const shareBtn = $('shareProfile');
  if (shareBtn) shareBtn.addEventListener('click', () => {
    const inVk = isVkMiniApp();
    const p = state.publicProfileTarget || state.profile;
    const url = p ? (inVk ? (p.vkProfileLink || p.profileLink || '') : (p.profileLink || '')) : '';
    void shareUrl(url, L('shareProfileText'));
  });
  async function storyImageDataUri(url) {
    const response = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
    if (!response.ok || response.headers.get('content-type') !== 'image/png') throw new Error('story image unavailable');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 3 * 1024 * 1024) throw new Error('story image size invalid');
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return `data:image/png;base64,${window.btoa(binary)}`;
  }
  const storyBtn = $('shareStory');
  let vkStoryInFlight = false;
  if (storyBtn) storyBtn.addEventListener('click', async () => {
    const p = state.publicProfileTarget || state.profile;
    const inVk = isVkMiniApp();
    const tg = window.Telegram?.WebApp;
    const inTelegram = Boolean(tg?.initData);
    const destination = p ? (inVk ? (p.vkProfileLink || p.profileLink || '') : (inTelegram ? (p.telegramProfileLink || p.profileLink || '') : (p.profileLink || ''))) : '';
    if (!destination) { setStatus(L('shareUnavailable'), 'error'); return; }
    if ($('shareFallback')) $('shareFallback').hidden = true;
    if (inTelegram && typeof tg.shareToStory === 'function') {
      const mediaUrl = p.telegramStoryCardUrl || '';
      if (mediaUrl.startsWith('https://')) {
        try {
          if (!tg.isVersionAtLeast?.('7.8') || typeof tg.showPopup !== 'function') {
            showManualShare(destination, 'storyUnsupported', 'info');
            return;
          }
          // Android records native popup button presses as user gestures; a
          // TalkBack DOM click alone may not update its lastClickMs guard.
          clientLog('telegram_story_confirmation', `platform=${tg.platform || 'unknown'} sdk=${tg.version || 'unknown'}`);
          tg.showPopup({ message: L('storyConfirmMessage'), buttons: [
            { id: 'share', type: 'default', text: L('storyConfirmButton') },
            { id: 'cancel', type: 'cancel' }
          ] }, (buttonId) => {
            if (buttonId !== 'share') {
              clientLog('telegram_story_cancelled', 'confirmation');
              showManualShare(destination, 'storyCancelled', 'info');
              return;
            }
            try {
              // Keep synchronous with the native confirmation, without fetch/await.
              tg.shareToStory(mediaUrl, { text: L('shareProfileText'), widget_link: { url: destination, name: L('storyWidgetName') } });
              clientLog('telegram_story_requested', `platform=${tg.platform || 'unknown'} sdk=${tg.version || 'unknown'}`);
              setStatus(L('storyEditorRequested'));
            } catch (error) {
              clientLog('telegram_story_failed', userSafeErrorMessage(error));
              showManualShare(destination, 'storyLoadFailed');
            }
          });
          return;
        } catch (error) {
          clientLog('telegram_story_failed', userSafeErrorMessage(error));
          showManualShare(destination, 'storyLoadFailed');
          return;
        }
      }
    }
    if (inVk && window.vkBridge?.send) {
      if (vkStoryInFlight || state.busy) return;
      vkStoryInFlight = true;
      storyBtn.setAttribute('aria-disabled', 'true');
      storyBtn.disabled = true;
      try {
        const blob = await storyImageDataUri(p.vkStoryCardUrl || '');
        await window.vkBridge.send('VKWebAppShowStoryBox', {
          background_type: 'image',
          blob,
          attachment: { text: 'open', type: 'url', url: destination }
        });
        setStatus(L('storyEditorOpened'));
        return;
      } catch (error) {
        const detail = userSafeErrorMessage(error);
        if (/user denied|cancel/i.test(detail)) {
          showManualShare(destination, 'storyCancelled', 'info');
          return;
        }
        clientLog('vk_story_failed', detail);
        showManualShare(destination, 'storyLoadFailed');
        return;
      } finally {
        vkStoryInFlight = false;
        storyBtn.setAttribute('aria-disabled', 'false');
        storyBtn.disabled = state.busy;
      }
    }
    showManualShare(destination, 'storyUnsupported', 'info');
  });
}
async function start() {
  readyNoticeDismissed = false;
  setVkAttributionVisibility();
  const inTelegram = Boolean(window.Telegram?.WebApp?.initData);
  const inVk = isVkMiniApp();
  if (inTelegram || inVk) { if ($('appShell')) $('appShell').hidden = false; if ($('loginScreen')) $('loginScreen').hidden = true; }
  // Do not expose actionable quick buttons before the first authenticated
  // summary arrives; a TalkBack press during startup would be silently lost.
  applyStaticI18n();
  try {
    window.Telegram?.WebApp?.ready?.();
    // Startup owns the final Ready, after any saved merge offer is resolved.
    await authenticate({ suppressReady: true });
    await loadPendingMerge();
    setStatus(state.pendingMerge ? L('mergeNeedsConfirmation') : L('ready'), 'info', state.pendingMerge ? 'merge' : 'ready');
  } catch (e) {
    const detail = userSafeErrorMessage(e, inVk ? 'vkOpenFromVk' : 'openFromTelegram');
    clientLog('start_error', detail);
    if (inVk || inTelegram) {
      await showLoginScreen({ landing: false });
      const loginStatus = $('loginStatus');
      if (loginStatus) { loginStatus.textContent = detail || L('connectFailed'); loginStatus.classList.add('error'); }
      if (inVk && e.status === 429) { vkStartupRetry = true; updateVkAuthCooldown(); }
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
    const readOnly = true; // never mix the visitor's private controls with another owner's data
    setPublicReadOnlyMode(readOnly);
    const n = profile.activeReferred || 0;
    state.publicStatus = `${L('publicProfileIntro')} ${profile.firstName}`;
    const status = $('connectionStatus');
    if (status) status.textContent = state.publicStatus;
    $('appShell').hidden = false;
    $('loginScreen').hidden = true;
    switchTab('profile', { record: false, focus: false });
    if ($('profileNameHeading')) $('profileNameHeading').textContent = profile.firstName;
    const heart = document.querySelector('.badge-heart');
    const count = document.querySelector('.badge-heart-count');
    if (heart) { heart.setAttribute('data-size', badgeSize(n)); heart.setAttribute('aria-label', `${L('publicBadgeLabel')} ${n}`); }
    if (count) count.textContent = n;
    const total = $('partnerTotal'); const active = $('partnerActive');
    if (total) total.textContent = profile.totalReferred || 0;
    if (active) active.textContent = n;
    const publicProfileLink = `${window.location.origin}/p/${profile.refCode}`;
    // Sharing while viewing somebody else's public profile must never fall
    // back to the authenticated recipient's own state.profile destination.
    state.publicProfileTarget = { profileLink: publicProfileLink, vkProfileLink: publicProfileLink };
    if ($('refLink')) $('refLink').value = publicProfileLink;
    // Public stats without texts.
    const today = profile.today || {}; const week = profile.week || {};
    const statsBox = $('publicStats') || (() => { const box = document.createElement('div'); box.id = 'publicStats'; box.className = 'summary-card'; document.getElementById('tab-profile').appendChild(box); return box; })();
    statsBox.innerHTML = `<h2>${escapeHtml(L('publicToday'))}: ${today.todayLife || 0} ${escapeHtml(L('life'))}</h2><h2>${escapeHtml(L('publicWeek'))}: ${week.weekLife || 0} ${escapeHtml(L('life'))}, ${week.activeDays || 0} ${escapeHtml(L('publicActiveDays'))}</h2><p class="soft-note">${escapeHtml(L('publicLoginHint'))}</p><button type="button" id="publicLoginCta">${escapeHtml(L('publicLoginCta'))}</button>`;
    const cta = $('publicLoginCta');
    if (cta) cta.addEventListener('click', async () => {
      try {
        if (state.token) { await withBusy(L('connecting'), loadData); switchTab('today', { record: false }); return; }
        if (isVkMiniApp() || window.Telegram?.WebApp?.initData) { await start(); switchTab('today', { record: false }); return; }
        await showLoginScreen();
      } catch (error) { setStatus(userSafeErrorMessage(error), 'error'); }
    });
    if (status) status.textContent = state.publicStatus;
    return true;
  } catch (_) {
    state.publicProfileTarget = null;
    $('connectionStatus').textContent = L('publicProfileNotFound');
    await showLoginScreen();
    return false;
  }
}
(async () => {
  fireVkBridgeInit();
  setVkAttributionVisibility();
  bindEvents(); // bind buttons in every context (site, public profile, Mini App)
  if (new URLSearchParams(window.location.search || '').has('google_oauth_return')) {
    const stored = sessionStorage.getItem('kopilkaGoogleOAuthHandoff');
    sessionStorage.removeItem('kopilkaGoogleOAuthHandoff');
    const clean = new URL(window.location.href); clean.searchParams.delete('google_oauth_return');
    window.history.replaceState({}, '', clean.pathname + clean.search + clean.hash);
    let result = null;
    try { result = JSON.parse(stored || 'null'); } catch (_) { /* missing handoff */ }
    if (result?.type === 'kopilka:google-oauth' && result.token) {
      state.token = result.token; state.sessionRenewalBlocked = false;
      storage.set('kopilkaToken', result.token);
      await start(); return;
    }
    if (result?.mergeRequired && state.token) { await start(); showIdentityMerge(result); return; }
    if (result?.linked && state.token) { await start(); setStatus(L('googleLinkDone')); return; }
    if (state.token) { await start(); setStatus(result?.error || L('loginFailed'), 'error'); return; }
    await showLoginScreen(); setLoginStatus(result?.error || L('loginFailed'), 'error'); return;
  }
  const explicitVkOAuthReturn = new URLSearchParams(window.location.search || '').has('vk_oauth_return');
  const consumedVkOAuth = explicitVkOAuthReturn && await consumeVkOAuthResult();
  if (consumedVkOAuth) { if ($('appShell')) $('appShell').hidden = false; if ($('loginScreen')) $('loginScreen').hidden = true; await start(); return; }
  if (explicitVkOAuthReturn) {
    window.history.replaceState({}, '', '/');
    storage.remove('kopilkaLastAuthError');
    if (state.token) { await start(); setStatus(L('oauthLoginRetry'), 'error'); }
    else { await showLoginScreen(); setLoginStatus(L('oauthLoginRetry'), 'error'); }
    return;
  }
  const inVk = isVkMiniApp();
  clientLog('bootstrap', `inVk=${inVk} hasSearch=${Boolean(window.location.search)} hasHash=${Boolean(window.location.hash)} token=${Boolean(state.token)}`);
  if (inVk) { if ($('appShell')) $('appShell').hidden = false; if ($('loginScreen')) $('loginScreen').hidden = true; }
  // A VK referral remains attribution-only. A profile hash authenticates the
  // signed recipient first, then replaces their dashboard with the owner's
  // public projection.
  if (inVk) {
    const profileCode = publicProfileCode();
    captureRefCode();
    await start();
    if (profileCode && state.user) { await renderPublicProfile(profileCode, { readOnly: true }); applyStaticI18n(); setPublicReadOnlyMode(true); }
    return;
  }
  const hasTelegramInitData = Boolean(window.Telegram?.WebApp?.initData);
  const looksLikeTelegramLaunch = hasTelegramInitData || /(?:^|[?#&])tgWebApp(?:Data|Platform)=/.test(window.location.search + window.location.hash) || Boolean(window.TelegramWebviewProxy);
  const telegramReady = looksLikeTelegramLaunch ? await waitForTelegram(200) : hasTelegramInitData;
  const inTelegram = Boolean(telegramReady && window.Telegram?.WebApp?.initData);
  if (inTelegram) {
    if ($('appShell')) $('appShell').hidden = false;
    if ($('loginScreen')) $('loginScreen').hidden = true;
    const profileCode = publicProfileCode();
    captureRefCode();
    await start();
    showTelegramLinkClaim();
    if (profileCode && state.user) { await renderPublicProfile(profileCode, { readOnly: true }); applyStaticI18n(); setPublicReadOnlyMode(true); }
    return;
  }
  if (looksLikeTelegramLaunch) { await showLoginScreen({ landing: false }); return; }
  const bridgeLaunchParams = await freshVkBridgeLaunchParams();
  if (bridgeLaunchParams) {
    state.vkBridgeLaunchParams = bridgeLaunchParams;
    if ($('appShell')) $('appShell').hidden = false;
    if ($('loginScreen')) $('loginScreen').hidden = true;
    const profileCode = publicProfileCode();
    captureRefCode();
    await start();
    if (profileCode && state.user) { await renderPublicProfile(profileCode, { readOnly: true }); applyStaticI18n(); setPublicReadOnlyMode(true); }
    return;
  }
  const publicCode = publicProfileCode();
  if (publicCode) {
    captureRefCode();
    if (state.token) {
      try { await start(); if (await renderPublicProfile(publicCode, { readOnly: true })) { applyStaticI18n(); setPublicReadOnlyMode(true); } return; } catch (_) { /* fall through to read-only public profile */ }
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
  if (new URLSearchParams(location.search).has('signed_out')) {
    window.history.replaceState({}, '', '/');
    setLoginStatus(L('signedOutSite'));
    $('loginStatus').tabIndex = -1;
    $('loginStatus').focus();
  }
})().catch((error) => {
  const msg = userSafeErrorMessage(error, 'connectFailed');
  clientLog('bootstrap_error', msg);
  try {
    if ($('appShell')) $('appShell').hidden = false;
    if ($('loginScreen')) $('loginScreen').hidden = true;
    if ($('connectionStatus')) $('connectionStatus').textContent = msg;
    setStatus(msg, 'error');
  } catch (_) { /* diagnostics only */ }
}).finally(() => window.KopilkaDocuments?.refresh());
// Register the worker for normal browser visits, not only after Push opt-in.
// This does not request notification permission and does not delay data loading.
window.addEventListener('load', () => {
  if (!outsideMiniApp() || !('serviceWorker' in navigator)) return;
  window.setTimeout(async () => {
    if (storage.get('kopilkaPushRetirePending')) {
      const retired = await retireBrowserPush('');
      if (!retired) return; // Keep retry marker; don't replace an unresolved old registration.
      storage.remove('kopilkaPushRetirePending');
    }
    navigator.serviceWorker.register('/push-sw.js', { scope: '/' }).catch(() => {});
  }, 0);
}, { once: true });
// Keep the final legal links above the fixed navigation even when text grows,
// labels wrap, or a WebView changes size. CSS supplies a no-JS fallback.
const tabBar = document.querySelector('.tab-bar');
if (tabBar && typeof ResizeObserver === 'function') {
  new ResizeObserver(() => {
    const height = tabBar.getBoundingClientRect().height;
    if (height > 0) document.documentElement.style.setProperty('--measured-nav-height', `${Math.ceil(height)}px`);
  }).observe(tabBar);
}

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
