const I18N = window.KopilkaI18n;
const locale = () => I18N.normalizeLocale(state.user?.locale || localStorage.getItem('kopilkaLocale') || 'ru');
const L = (key, params) => I18N.t(locale(), key, params);

const state = { token: localStorage.getItem('kopilkaToken') || '', user: null, summary: null, week: null, currentContract: null, product: null, profile: null, activeTab: 'today', busy: false };
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
    if (tgRef) { localStorage.setItem('kopilkaRef', tgRef); return tgRef; }
    const url = new URL(window.location.href);
    const qRef = referralLikeCode(url.searchParams.get('ref'));
    if (qRef) { localStorage.setItem('kopilkaRef', qRef); return qRef; }
    const vkHash = parseHashParams(vkLaunchHash() || window.location.hash);
    const vkRef = referralLikeCode(vkHash.get('ref') || vkHash.get('profile'));
    if (vkRef) { localStorage.setItem('kopilkaRef', vkRef); return vkRef; }
    const p = /^\/p\/([A-Za-z0-9]+)/.exec(url.pathname);
    const pathRef = referralLikeCode(p ? p[1] : '');
    if (pathRef) { localStorage.setItem('kopilkaRef', pathRef); return pathRef; }
  } catch (_) { /* ignore */ }
  return localStorage.getItem('kopilkaRef') || '';
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
  if (!raw) return '';
  if (raw.startsWith('#') && raw.includes('?')) return raw.slice(raw.indexOf('?'));
  return raw;
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
async function initVkBridge() {
  try { if (window.vkBridge?.send) await window.vkBridge.send('VKWebAppInit'); } catch (_) { /* VK Bridge init is best-effort */ }
}
async function getVkOAuthUrl(action = 'auth') {
  const cfg = await api('/api/config');
  if (!cfg.vkOAuthEnabled) throw new Error(L('vkOauthNotConfigured'));
  const data = await api('/api/auth/vk-oauth/start', {
    method: 'POST',
    body: JSON.stringify({ action, refCode: captureRefCode(), timezone: detectTimezone(), locale: locale() })
  });
  if (!data.authUrl) throw new Error(L('vkOauthStartFailed'));
  return data.authUrl;
}
function goToVkOAuth(authUrl, statusEl = null) {
  window.location.href = authUrl;
  window.setTimeout(() => {
    if (statusEl) statusEl.innerHTML = `${escapeHtml(L('vkOauthRedirectFallback'))} <a href="${escapeHtml(authUrl)}">${escapeHtml(L('vkOauthOpenLink'))}</a>`;
  }, 1200);
}
async function startVkOAuth(action = 'auth', statusEl = null) {
  const authUrl = await getVkOAuthUrl(action);
  goToVkOAuth(authUrl, statusEl);
}
function setStatus(text, type = 'info') { const region = $('statusRegion'); region.textContent = text; region.classList.toggle('error', type === 'error'); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function setBusy(isBusy, message = '') { state.busy = isBusy; document.querySelectorAll('button,input,textarea,select').forEach((el) => { if (el.id === 'cleanupDemo' && state.user && !state.user.isDemo) return; el.disabled = isBusy; }); document.body.setAttribute('aria-busy', isBusy ? 'true' : 'false'); if (message) setStatus(message); }
async function withBusy(message, fn) { setBusy(true, message); try { return await fn(); } finally { setBusy(false); } }
async function api(path, options = {}) { const headers = { 'content-type': 'application/json', ...(options.headers || {}) }; if (state.token) headers.authorization = `Bearer ${state.token}`; const res = await fetch(path, { ...options, headers }); const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || L('actionFailed')); return data; }
function consumeVkOAuthResult() {
  if (!window.location.hash || !window.location.hash.includes('vk_oauth_')) return false;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const token = params.get('vk_oauth_token');
  const error = params.get('vk_oauth_error');
  if (token) {
    state.token = token;
    localStorage.setItem('kopilkaToken', token);
    const clean = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState({}, document.title, clean || '/');
    return true;
  }
  if (error) {
    const clean = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState({}, document.title, clean || '/');
    try { localStorage.setItem('kopilkaLastAuthError', error); } catch (_) {}
  }
  return false;
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
  $('connectionStatus').textContent = L('connecting');
}

// Re-render quick actions using current locale from the local dictionary.
function renderQuickActions() {
  const types = I18N.entryTypes(locale());
  const usedToday = new Set(state.summary?.todayEntryTypes || []);
  $('quickActions').innerHTML = types.map((it) => {
    const used = usedToday.has(it.type);
    const aria = used ? `${it.title}, ${L('alreadyAddedToday')}` : `${it.title}, ${it.hint}, ${L('addLife', { points: it.points })}`;
    return `<button type="button" data-entry-type="${it.type}" ${used ? 'disabled aria-disabled="true"' : ''} aria-label="${escapeHtml(aria)}"><span class="qa-title">${escapeHtml(it.title)}</span><span class="qa-hint">${escapeHtml(used ? L('alreadyAddedToday') : it.hint)}</span><span class="qa-points">${used ? escapeHtml(L('availableTomorrow')) : `+${it.points} ЖИЗНЬ`}</span></button>`;
  }).join('');
}
function renderSummary() {
  const s = state.summary || { totalLife: 0, todayLife: 0, todayEntries: [] };
  $('totalLife').textContent = s.totalLife;
  $('todayLife').textContent = s.todayLife;
  $('todayEntries').innerHTML = s.todayEntries.length ? s.todayEntries.map((e) => `<li>${escapeHtml(e.title)}: +${Number(e.life_points) || 0}. ${escapeHtml(e.note || '')}</li>`).join('') : `<li>${escapeHtml(L('noEntriesToday'))}</li>`;
  renderDailyHint();
}
function renderDailyHint() { const hint = state.product?.dailyHint; if (!hint) return; $('dailyHintTitle').textContent = hint.title; $('dailyHintText').textContent = hint.text; $('dailyHintAction').textContent = hint.action; }
function renderWeek() {
  const w = state.week || { weekLife: 0, activeDays: 0, days: [], topCategories: [] };
  $('weekLife').textContent = w.weekLife;
  $('activeDays').textContent = w.activeDays;
  $('weekDays').innerHTML = w.days.length ? w.days.map((d) => `<li>${escapeHtml(d.date)}: ${Number(d.life) || 0} ${escapeHtml(L('life'))}. ${d.titles.slice(0, 3).map(escapeHtml).join(', ')}</li>`).join('') : `<li>${escapeHtml(L('noWeek'))}</li>`;
  $('topCategories').innerHTML = w.topCategories.length ? w.topCategories.map((i) => `<li>${escapeHtml(i.title)}: ${Number(i.count) || 0}</li>`).join('') : `<li>${escapeHtml(L('noCategories'))}</li>`;
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
  box.innerHTML = `<section class="contract-box" aria-labelledby="currentContractHeading"><h2 id="currentContractHeading">${escapeHtml(L('currentContract'))}</h2><p><strong>${escapeHtml(c.title)}</strong></p><p>${escapeHtml(L('period'))}: ${escapeHtml(c.week_start)} — ${escapeHtml(c.week_end)}</p><p>${escapeHtml(L('criteria'))}: ${escapeHtml(c.target_value)}</p><p>${escapeHtml(L('careFund'))}: ${escapeHtml(c.stake_amount || L('notSpecified'))} ${escapeHtml(c.stake_currency || '')}</p><p>${escapeHtml(L('giftSelf'))}: ${escapeHtml(c.reward_description || L('canChooseLater'))}</p><div class="close-actions">${closeButtons}<button type="button" data-close-status="cancelled" class="secondary">${escapeHtml(L('closeCancelled'))}</button></div></section>`;
}
function renderContractTemplates() { const templates = state.product?.contractTemplates || []; const box = $('contractTemplates'); if (!box) return; box.innerHTML = templates.length ? templates.map((t) => `<button type="button" class="secondary" data-template-id="${escapeHtml(t.id)}">${escapeHtml(t.title)}</button>`).join('') : `<p class="soft-note">${escapeHtml(L('templatesLoading'))}</p>`; }
function renderWeeklyReview() { const review = state.product?.weeklyReview; if (!review) return; $('weeklyReviewText').textContent = review.summaryText; $('weeklyReviewQuestions').innerHTML = review.questions.map((q) => `<li>${escapeHtml(q)}</li>`).join(''); }
function renderPractices() { const data = state.product?.practices; if (!data) return; const select = $('practiceGoal'); if (select.options.length === 0) { select.innerHTML = data.goals.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.title)}</option>`).join(''); } select.value = data.goal; $('goalPractices').innerHTML = data.practices.map((p) => `<li>${escapeHtml(p)}</li>`).join(''); }
function applyTemplate(templateId) { const t = (state.product?.contractTemplates || []).find((item) => item.id === templateId); if (!t) return; $('contractTitle').value = t.title; $('contractTarget').value = t.targetValue; $('stakeAmount').value = t.stakeAmount || ''; $('stakeCurrency').value = t.stakeCurrency || 'RUB'; $('rewardDescription').value = t.rewardDescription || ''; $('fundDescription').value = t.fundDescription || ''; setStatus(L('templateApplied', { title: t.title })); }
function renderSettings() { if (!state.user) return; $('timezone').value = state.user.timezone || 'Asia/Novosibirsk'; $('remindersEnabled').checked = Boolean(state.user.remindersEnabled); $('eveningReminderTime').value = state.user.eveningReminderTime || '20:00'; $('userDebug').textContent = `ID: ${state.user.id}. Demo: ${state.user.isDemo ? L('yes') : L('no')}.`; const vkStatus = $('vkLinkStatus'); const vkBtn = $('linkVkAccount'); if (vkStatus) vkStatus.textContent = state.user.vkLinked ? L('vkLinked') : L('vkNotLinked'); if (vkBtn) { vkBtn.hidden = Boolean(state.user.vkLinked); vkBtn.disabled = false; } if ($('cleanupDemo')) $('cleanupDemo').disabled = !state.user.isDemo; const lang = locale(); $('lang-ru').setAttribute('aria-pressed', String(lang === 'ru')); $('lang-en').setAttribute('aria-pressed', String(lang === 'en')); }
function badgeSize(n) { if (n === 0) return 'small'; if (n >= 50) return 'xlarge'; if (n >= 10) return 'large'; return 'small'; }
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
  const link = $('refLink');
  if (link) link.value = inBot ? (p.botLink || '') : (p.profileLink || p.refLink || '');
}
function renderAll() { applyStaticI18n(); renderQuickActions(); renderSummary(); renderWeek(); renderContract(); renderSettings(); renderProfile(); }
function switchTab(tab) { state.activeTab = tab; document.querySelectorAll('.screen-panel').forEach((p) => { p.hidden = p.id !== `tab-${tab}`; }); document.querySelectorAll('.tab-bar button').forEach((b) => { const active = b.dataset.tab === tab; b.setAttribute('aria-selected', String(active)); if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }); const h = $(`heading-${tab}`); if (h) h.focus({ preventScroll: false }); }
async function loadData() {
  const goal = $('practiceGoal')?.value || 'calm';
  const [summary, week, current, me, product, profile] = await Promise.all([api('/api/summary/today'), api('/api/entries?range=week'), api('/api/contracts/current'), api('/api/me'), api(`/api/product?goal=${encodeURIComponent(goal)}`), api('/api/profile')]);
  state.summary = summary; state.week = week; state.currentContract = current.contract; state.user = me.user; state.product = product; state.profile = profile.profile;
  localStorage.setItem('kopilkaLocale', me.user.locale || 'ru');
  renderAll();
}

// ---------- Site login (outside Telegram Mini App) ----------
async function showLoginScreen() {
  const shell = $('appShell');
  const screen = $('loginScreen');
  applyStaticI18n();
  if (shell) shell.hidden = true;
  if (screen) screen.hidden = false;
  await initTelegramLogin();
}

async function initTelegramLogin() {
  let cfg;
  try { cfg = await api('/api/config'); } catch (e) { cfg = {}; }
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
    const data = await api('/api/auth/telegram-login', { method: 'POST', body: JSON.stringify({ ...user, refCode: captureRefCode(), timezone: detectTimezone() }) });
    state.token = data.token; state.user = data.user;
    localStorage.setItem('kopilkaToken', state.token); localStorage.setItem('kopilkaLocale', data.user.locale || 'ru');
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
  await initVkBridge();
  const launchParams = vkLaunchParams();
  if (!launchParams) {
    return startVkOAuth(linkOnly ? 'link' : 'auth');
  }
  const endpoint = linkOnly ? '/api/settings/link-vk' : '/api/auth/vk';
  const data = await api(endpoint, { method: 'POST', body: JSON.stringify({ launchParams, refCode: captureRefCode(), timezone: detectTimezone(), locale: locale() }) });
  if (linkOnly) {
    state.user = data.user;
    renderAll();
    setStatus(L('vkLinked'));
    return data;
  }
  state.token = data.token; state.user = data.user;
  localStorage.setItem('kopilkaToken', state.token); localStorage.setItem('kopilkaLocale', data.user.locale || 'ru');
  if ($('loginScreen')) $('loginScreen').hidden = true;
  if ($('appShell')) $('appShell').hidden = false;
  $('connectionStatus').textContent = L('vkSession');
  await loadData();
  setStatus(L('ready'));
  return data;
}

async function authenticate() {
  if (state.token) { try { await loadData(); $('connectionStatus').textContent = L('connected'); return; } catch (e) { localStorage.removeItem('kopilkaToken'); state.token = ''; } }
  const inTelegram = Boolean(window.Telegram?.WebApp?.initData);
  const inVk = isVkMiniApp();
  const refCode = captureRefCode();
  if (inVk) {
    await handleVkAuth();
    return;
  }
  if (inTelegram) {
    const initData = window.Telegram.WebApp.initData;
    const data = await api('/api/auth/telegram', { method: 'POST', body: JSON.stringify({ initData, refCode, timezone: detectTimezone() }) });
    state.token = data.token; state.user = data.user; localStorage.setItem('kopilkaToken', state.token); localStorage.setItem('kopilkaLocale', data.user.locale || 'ru');
    $('connectionStatus').textContent = L('telegramSession');
    await loadData();
    return;
  }
  // Outside Telegram Mini App -> show the site login screen (Telegram / VK).
  await showLoginScreen();
}
async function refreshProduct() { state.product = await api(`/api/product?goal=${encodeURIComponent($('practiceGoal')?.value || 'calm')}`); }
async function createEntry(type) { return withBusy(L('saving'), async () => { const data = await api('/api/entries', { method: 'POST', body: JSON.stringify({ type, note: $('entryNote').value.trim() }) }); state.summary = data.summary; state.week = data.week; await refreshProduct(); $('entryNote').value = ''; renderAll(); setStatus(L('entrySaved')); }); }
async function createContract(event) { event.preventDefault(); const payload = Object.fromEntries(new FormData(event.currentTarget).entries()); return withBusy(L('creatingContract'), async () => { const data = await api('/api/contracts', { method: 'POST', body: JSON.stringify(payload) }); state.currentContract = data.contract; await refreshProduct(); renderAll(); setStatus(L('contractCreated')); }); }
async function closeContract(status) { return withBusy(L('closingContract'), async () => { const data = await api(`/api/contracts/${state.currentContract.id}/close`, { method: 'POST', body: JSON.stringify({ status, resultNote: '' }) }); state.currentContract = null; state.summary = data.summary; state.week = data.week; await refreshProduct(); renderAll(); setStatus(L('contractClosed')); }); }
async function saveSettings(event) { event.preventDefault(); const payload = { timezone: $('timezone').value.trim(), remindersEnabled: $('remindersEnabled').checked, eveningReminderTime: $('eveningReminderTime').value || '20:00' }; return withBusy(L('savingSettings'), async () => { const data = await api('/api/settings/reminders', { method: 'POST', body: JSON.stringify(payload) }); state.user = data.user; renderAll(); setStatus(L('settingsSaved')); }); }
async function setLanguage(lang) { const normalized = I18N.normalizeLocale(lang); localStorage.setItem('kopilkaLocale', normalized); if (state.token) { try { const data = await api('/api/settings/locale', { method: 'POST', body: JSON.stringify({ locale: normalized }) }); state.user = data.user; } catch (e) { /* keep local preference */ } } await loadData(); }
async function cleanupDemo() { if (!state.user?.isDemo) { setStatus(L('notDemo'), 'error'); return; } const id = state.user.id; return withBusy(L('deletingDemo'), async () => { await api(`/api/dev/demo-user/${id}`, { method: 'DELETE' }); localStorage.removeItem('kopilkaToken'); state.token = ''; state.user = null; state.summary = null; state.week = null; state.currentContract = null; renderAll(); setStatus(L('demoDeleted')); await authenticate(); }); }
function bindEvents() {
  document.querySelector('.tab-bar').addEventListener('click', (event) => { const b = event.target.closest('button[data-tab]'); if (b && !state.busy) switchTab(b.dataset.tab); });
  $('quickActions').addEventListener('click', async (event) => { const b = event.target.closest('button[data-entry-type]'); if (!b || state.busy) return; try { await createEntry(b.dataset.entryType); } catch (e) { setStatus(e.message, 'error'); } });
  $('contractTemplates').addEventListener('click', (event) => { const b = event.target.closest('button[data-template-id]'); if (b && !state.busy) applyTemplate(b.dataset.templateId); });
  $('practiceGoal').addEventListener('change', async (event) => { if (state.busy) return; try { state.product.practices = await api(`/api/product/practices?goal=${encodeURIComponent(event.target.value)}`); renderPractices(); setStatus(L('practicesUpdated')); } catch (e) { setStatus(e.message, 'error'); } });
  $('contractForm').addEventListener('submit', async (event) => { try { await createContract(event); } catch (e) { event.preventDefault(); setStatus(e.message, 'error'); } });
  $('contractCurrent').addEventListener('click', async (event) => { const b = event.target.closest('button[data-close-status]'); if (!b || state.busy) return; try { await closeContract(b.dataset.closeStatus); } catch (e) { setStatus(e.message, 'error'); } });
  $('settingsForm').addEventListener('submit', async (event) => { try { await saveSettings(event); } catch (e) { event.preventDefault(); setStatus(e.message, 'error'); } });
  $('cleanupDemo').addEventListener('click', async () => { if (state.busy) return; try { await cleanupDemo(); } catch (e) { setStatus(e.message, 'error'); } });
  document.querySelectorAll('[data-lang]').forEach((btn) => btn.addEventListener('click', async () => { if (state.busy) return; try { await setLanguage(btn.dataset.lang); setStatus(L('settingsSaved')); } catch (e) { setStatus(e.message, 'error'); } }));
  const vkBtn = $('vkLoginButton');
  if (vkBtn) vkBtn.addEventListener('click', async () => {
    vkBtn.disabled = true;
    vkBtn.textContent = L('loginVkSoon');
    try { await handleVkAuth(); } catch (e) { setLoginStatus(e.message || L('actionFailed'), 'error'); vkBtn.disabled = false; vkBtn.textContent = L('loginVkButton'); }
  });
  const linkVkBtn = $('linkVkAccount');
  if (linkVkBtn) linkVkBtn.addEventListener('click', async () => {
    if (state.busy) return;
    const vkStatus = $('vkLinkStatus');
    linkVkBtn.disabled = true;
    if (vkStatus) vkStatus.textContent = L('vkLinking');
    setStatus(L('vkLinking'));
    try {
      if (isVkMiniApp()) {
        await withBusy(L('vkLinking'), () => handleVkAuth({ linkOnly: true }));
      } else {
        const authUrl = await getVkOAuthUrl('link');
        goToVkOAuth(authUrl, vkStatus);
      }
    } catch (e) {
      const message = e.message || L('actionFailed');
      if (vkStatus) vkStatus.textContent = message;
      setStatus(message, 'error');
      linkVkBtn.disabled = false;
    }
  });
  const copyBtn = $('copyRefLink');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    const link = $('refLink')?.value;
    if (!link) return;
    try { await navigator.clipboard.writeText(link); } catch (_) { /* fallback */ }
    setStatus(L('copied'));
  });
  // Native share. Prefer the OS share sheet (navigator.share) — it works reliably
  // in Telegram's Android WebView; fall back to the Telegram forward composer
  // (openTelegramLink) which can silently no-op on some clients. Guaranteed result.
  function shareUrl(url, text) {
    const dbg = (msg) => { try { setStatus(msg); console.log('[share]', msg); } catch (_) {} };
    const finish = () => { try { navigator.clipboard.writeText(url); dbg('Ссылка скопирована (share недоступен).'); } catch (_) { window.prompt(L('refLinkLabel'), url); } };
    if (!url) { dbg('Share: нет ссылки (профиль не загружен)'); return; }
    const inTelegram = Boolean(window.Telegram?.WebApp?.initData);
    const tg = window.Telegram?.WebApp;
    const botInline = Boolean(tg && (tg.initDataUnsafe?.bot_inline ?? tg.botInline ?? tg.version));
    dbg(`Share: url=${url} tg=${inTelegram} sdk=${!!tg} ver=${tg ? (tg.version || '?') : '—'} inline=${tg ? !!tg.switchInlineQuery : false} botInline=${tg ? !!(tg.initDataUnsafe && tg.initDataUnsafe.bot_inline) : '?'}`);
    // 1) VK Mini App native share: official VK Bridge share dialog.
    if (isVkMiniApp() && window.vkBridge?.send) {
      dbg('Share: открываю VKWebAppShare…');
      try {
        window.vkBridge.send('VKWebAppShare', { link: url, text: text || '' })
          .then(() => dbg(L('shareOpened')))
          .catch((e) => { dbg('Share: VKWebAppShare ошибка: ' + (e && e.message ? e.message : String(e))); finish(); });
        return;
      } catch (e) { dbg('Share: VKWebAppShare ошибка: ' + (e && e.message ? e.message : String(e))); }
    }
    // 2) Telegram inline mode: opens the native chat picker and sends the composed
    //    text+link to the chosen chat via answerInlineQuery. Reliable (plain list).
    if (inTelegram && tg && tg.switchInlineQuery) {
      dbg('Share: открываю выбор чата (inline)…');
      try { tg.switchInlineQuery(`${text} ${url}`, ['users', 'groups', 'channels']); return; } catch (e) { dbg('Share: switchInlineQuery ошибка: ' + (e && e.message ? e.message : String(e))); }
    }
    // 2) OS share sheet (best effort, may be unavailable in WebView).
    if (navigator.share) {
      dbg('Share: открываю системное окно…');
      let done = false;
      const timer = setTimeout(() => { if (!done) { dbg('Share: окно не открылось, копирую.'); finish(); } }, 1500);
      navigator.share({ title: 'Копилка жизни', text, url }).then(() => { clearTimeout(timer); done = true; }).catch((e) => { clearTimeout(timer); done = true; dbg('Share: системное окно: ' + (e && e.message ? e.message : String(e))); if (navigator.clipboard) finish(); });
      return;
    }
    // 3) Telegram forward composer (best effort; may no-op on some clients).
    if (inTelegram && tg && tg.openTelegramLink) {
      try {
        const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text || '')}`;
        dbg(`Share: открываю композер Telegram (ver=${tg.version || '?'})…`);
        tg.openTelegramLink(shareUrl, { force_request: true });
        return;
      } catch (e) { dbg('Share: openTelegramLink ошибка: ' + (e && e.message ? e.message : String(e))); }
    }
    // 4) Last resort: copy.
    dbg('Share: нативный share недоступен, копирую.');
    finish();
  }
  const shareRefBtn = $('shareRefLink');
  if (shareRefBtn) shareRefBtn.addEventListener('click', () => {
    const inBot = Boolean(window.Telegram?.WebApp?.initData);
    const inVk = isVkMiniApp();
    const url = state.profile ? (inVk ? (state.profile.vkRefLink || state.profile.refLink || '') : (inBot ? (state.profile.botLink || '') : (state.profile.refLink || ''))) : '';
    shareUrl(url, L('shareRefText'));
  });
  const shareBtn = $('shareProfile');
  if (shareBtn) shareBtn.addEventListener('click', () => {
    const inVk = isVkMiniApp();
    const url = state.profile ? (inVk ? (state.profile.vkProfileLink || state.profile.profileLink || '') : (state.profile.profileLink || '')) : '';
    shareUrl(url, L('shareProfileText'));
  });
}
async function start() {
  const inTelegram = Boolean(window.Telegram?.WebApp?.initData);
  const inVk = isVkMiniApp();
  if (inTelegram || inVk) { if ($('appShell')) $('appShell').hidden = false; if ($('loginScreen')) $('loginScreen').hidden = true; }
  renderQuickActions(); applyStaticI18n();
  try { window.Telegram?.WebApp?.ready?.(); await authenticate(); setStatus(L('ready')); } catch (e) { const detail = (e && (e.stack || e.message)) ? (e.stack || e.message) : String(e); $('connectionStatus').textContent = detail || L('connectFailed'); setStatus(detail || L('openFromTelegram'), 'error'); }
}
// The Telegram WebApp SDK may not be ready when app.js first runs; retry the
// in-Telegram check until initData appears (or a longer timeout). A Mini App
// opening inside Telegram must never be misread as a plain site.
function waitForTelegram() {
  return new Promise((resolve) => {
    if (window.Telegram?.WebApp?.initData) return resolve(true);
    let tries = 0;
    const timer = setInterval(() => {
      if (window.Telegram?.WebApp?.initData) { clearInterval(timer); return resolve(true); }
      if (++tries >= 200) { clearInterval(timer); return resolve(false); } // ~10s
    }, 50);
  });
}
// Public profile page: /p/CODE shows someone's public stats (no personal notes).
async function renderPublicProfile(code) {
  try {
    const { profile } = await api(`/api/public/${encodeURIComponent(code)}`);
    if (!profile) throw new Error('not found');
    const n = profile.activeReferred || 0;
    $('connectionStatus').textContent = `${L('publicProfileIntro')} ${profile.firstName}`;
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
    return true;
  } catch (_) {
    $('connectionStatus').textContent = L('publicProfileNotFound');
    await showLoginScreen();
    return false;
  }
}
(async () => {
  bindEvents(); // bind buttons in every context (site, public profile, Mini App)
  const consumedVkOAuth = consumeVkOAuthResult();
  if (consumedVkOAuth) { if ($('appShell')) $('appShell').hidden = false; if ($('loginScreen')) $('loginScreen').hidden = true; await start(); return; }
  const publicCode = publicProfileCode();
  if (publicCode) { captureRefCode(); if (await renderPublicProfile(publicCode)) { applyStaticI18n(); return; } }
  const inVk = isVkMiniApp();
  if (inVk) { await start(); return; }
  const hasWebApp = await waitForTelegram();
  // Inside Telegram Mini App we must have signed initData. The SDK object alone
  // is also present on the plain website because we load telegram-web-app.js.
  const inTelegram = Boolean(hasWebApp && window.Telegram?.WebApp?.initData);
  if (inTelegram) { if ($('appShell')) $('appShell').hidden = false; if ($('loginScreen')) $('loginScreen').hidden = true; }
  if (!inTelegram) { await showLoginScreen(); return; }
  await start();
})();
// Surface any runtime JS error into the status region so it is visible/audible
// (helps a11y users and makes client-side failures diagnosable).
window.addEventListener('error', (event) => {
  const msg = event.error ? `${event.error.name || ''}: ${event.error.message || ''}` : (event.message || 'JS error');
  try { if ($('connectionStatus')) $('connectionStatus').textContent = msg; if (window.__kopilkaSetDiag) window.__kopilkaSetDiag(msg); } catch (_) {}
});
