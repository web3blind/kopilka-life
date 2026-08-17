const I18N = window.KopilkaI18n;
const locale = () => I18N.normalizeLocale(state.user?.locale || localStorage.getItem('kopilkaLocale') || 'ru');
const L = (key, params) => I18N.t(locale(), key, params);

const state = { token: localStorage.getItem('kopilkaToken') || '', user: null, summary: null, week: null, currentContract: null, product: null, activeTab: 'today', busy: false };
const $ = (id) => document.getElementById(id);
function setStatus(text, type = 'info') { const region = $('statusRegion'); region.textContent = text; region.classList.toggle('error', type === 'error'); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function setBusy(isBusy, message = '') { state.busy = isBusy; document.querySelectorAll('button,input,textarea,select').forEach((el) => { if (el.id === 'cleanupDemo' && state.user && !state.user.isDemo) return; el.disabled = isBusy; }); document.body.setAttribute('aria-busy', isBusy ? 'true' : 'false'); if (message) setStatus(message); }
async function withBusy(message, fn) { setBusy(true, message); try { return await fn(); } finally { setBusy(false); } }
async function api(path, options = {}) { const headers = { 'content-type': 'application/json', ...(options.headers || {}) }; if (state.token) headers.authorization = `Bearer ${state.token}`; const res = await fetch(path, { ...options, headers }); const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || L('actionFailed')); return data; }

// Translate all [data-i18n] static nodes and set document lang.
function applyStaticI18n() {
  const lang = locale();
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    el.textContent = L(key);
  });
  $('connectionStatus').textContent = L('connecting');
}

// Re-render quick actions using current locale from the local dictionary.
function renderQuickActions() {
  const types = I18N.entryTypes(locale());
  $('quickActions').innerHTML = types.map((it) => `<button type="button" data-entry-type="${it.type}" aria-label="${escapeHtml(it.title)}, ${escapeHtml(it.hint)}, ${escapeHtml(L('addLife', { points: it.points }))}"><span class="qa-title">${escapeHtml(it.title)}</span><span class="qa-hint">${escapeHtml(it.hint)}</span><span class="qa-points">+${it.points} ЖИЗНЬ</span></button>`).join('');
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
  box.innerHTML = `<section class="contract-box" aria-labelledby="currentContractHeading"><h2 id="currentContractHeading">${escapeHtml(L('currentContract'))}</h2><p><strong>${escapeHtml(c.title)}</strong></p><p>${escapeHtml(L('period'))}: ${escapeHtml(c.week_start)} — ${escapeHtml(c.week_end)}</p><p>${escapeHtml(L('criteria'))}: ${escapeHtml(c.target_value)}</p><p>${escapeHtml(L('careFund'))}: ${escapeHtml(c.stake_amount || L('notSpecified'))} ${escapeHtml(c.stake_currency || '')}</p><p>${escapeHtml(L('giftSelf'))}: ${escapeHtml(c.reward_description || L('canChooseLater'))}</p><div class="close-actions"><button type="button" data-close-status="completed">${escapeHtml(L('closeCompleted'))}</button><button type="button" data-close-status="not_completed_donated" class="secondary">${escapeHtml(L('closeNotCompletedDonated'))}</button><button type="button" data-close-status="too_hard" class="secondary">${escapeHtml(L('closeTooHard'))}</button><button type="button" data-close-status="cancelled" class="secondary">${escapeHtml(L('closeCancelled'))}</button></div></section>`;
}
function renderContractTemplates() { const templates = state.product?.contractTemplates || []; const box = $('contractTemplates'); if (!box) return; box.innerHTML = templates.length ? templates.map((t) => `<button type="button" class="secondary" data-template-id="${escapeHtml(t.id)}">${escapeHtml(t.title)}</button>`).join('') : `<p class="soft-note">${escapeHtml(L('templatesLoading'))}</p>`; }
function renderWeeklyReview() { const review = state.product?.weeklyReview; if (!review) return; $('weeklyReviewText').textContent = review.summaryText; $('weeklyReviewQuestions').innerHTML = review.questions.map((q) => `<li>${escapeHtml(q)}</li>`).join(''); }
function renderPractices() { const data = state.product?.practices; if (!data) return; const select = $('practiceGoal'); if (select.options.length === 0) { select.innerHTML = data.goals.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.title)}</option>`).join(''); } select.value = data.goal; $('goalPractices').innerHTML = data.practices.map((p) => `<li>${escapeHtml(p)}</li>`).join(''); }
function applyTemplate(templateId) { const t = (state.product?.contractTemplates || []).find((item) => item.id === templateId); if (!t) return; $('contractTitle').value = t.title; $('contractTarget').value = t.targetValue; $('stakeAmount').value = t.stakeAmount || ''; $('stakeCurrency').value = t.stakeCurrency || 'RUB'; $('rewardDescription').value = t.rewardDescription || ''; $('fundDescription').value = t.fundDescription || ''; setStatus(L('templateApplied', { title: t.title })); }
function renderSettings() { if (!state.user) return; $('timezone').value = state.user.timezone || 'Asia/Novosibirsk'; $('remindersEnabled').checked = Boolean(state.user.remindersEnabled); $('eveningReminderTime').value = state.user.eveningReminderTime || '20:00'; $('userDebug').textContent = `ID: ${state.user.id}. Demo: ${state.user.isDemo ? L('yes') : L('no')}.`; if ($('cleanupDemo')) $('cleanupDemo').disabled = !state.user.isDemo; const lang = locale(); $('lang-ru').setAttribute('aria-pressed', String(lang === 'ru')); $('lang-en').setAttribute('aria-pressed', String(lang === 'en')); }
function renderAll() { applyStaticI18n(); renderQuickActions(); renderSummary(); renderWeek(); renderContract(); renderSettings(); }
function switchTab(tab) { state.activeTab = tab; document.querySelectorAll('.screen-panel').forEach((p) => { p.hidden = p.id !== `tab-${tab}`; }); document.querySelectorAll('.tab-bar button').forEach((b) => { const active = b.dataset.tab === tab; b.setAttribute('aria-selected', String(active)); if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }); const h = $(`heading-${tab}`); if (h) h.focus({ preventScroll: false }); }
async function loadData() {
  const goal = $('practiceGoal')?.value || 'calm';
  const [summary, week, current, me, product] = await Promise.all([api('/api/summary/today'), api('/api/entries?range=week'), api('/api/contracts/current'), api('/api/me'), api(`/api/product?goal=${encodeURIComponent(goal)}`)]);
  state.summary = summary; state.week = week; state.currentContract = current.contract; state.user = me.user; state.product = product;
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
  // Load the official Telegram Login Widget script and render the button.
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
    const data = await api('/api/auth/telegram-login', { method: 'POST', body: JSON.stringify(user) });
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

async function authenticate() {
  if (state.token) { try { await loadData(); $('connectionStatus').textContent = L('connected'); return; } catch (e) { localStorage.removeItem('kopilkaToken'); state.token = ''; } }
  const inTelegram = Boolean(window.Telegram?.WebApp?.initData);
  if (inTelegram) {
    const initData = window.Telegram.WebApp.initData;
    const data = await api('/api/auth/telegram', { method: 'POST', body: JSON.stringify({ initData }) });
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
  if (vkBtn) vkBtn.addEventListener('click', () => { vkBtn.disabled = true; vkBtn.textContent = L('loginVkSoon'); });
}
async function start() {
  const inTelegram = Boolean(window.Telegram?.WebApp?.initData);
  if (inTelegram) { if ($('appShell')) $('appShell').hidden = false; if ($('loginScreen')) $('loginScreen').hidden = true; }
  renderQuickActions(); bindEvents(); applyStaticI18n();
  try { window.Telegram?.WebApp?.ready?.(); await authenticate(); setStatus(L('ready')); } catch (e) { const detail = (e && e.message) ? e.message : String(e); $('connectionStatus').textContent = detail || L('connectFailed'); setStatus(detail || L('openFromTelegram'), 'error'); }
}
// The Telegram WebApp SDK may not be ready when app.js first runs; retry the
// in-Telegram check until initData appears (or a short timeout), so a Mini App
// opening inside Telegram is never misread as a plain site.
function waitForTelegram() {
  return new Promise((resolve) => {
    if (window.Telegram?.WebApp?.initData) return resolve(true);
    let tries = 0;
    const timer = setInterval(() => {
      if (window.Telegram?.WebApp?.initData) { clearInterval(timer); return resolve(true); }
      if (++tries >= 40) { clearInterval(timer); return resolve(false); } // ~2s
    }, 50);
  });
}
(async () => {
  const inTelegram = await waitForTelegram();
  if (inTelegram && $('appShell')) $('appShell').hidden = false;
  if (!inTelegram) { await showLoginScreen(); return; }
  await start();
})();
// Surface any runtime JS error into the status region so it is visible/audible
// (helps a11y users and makes client-side failures diagnosable).
window.addEventListener('error', (event) => {
  const msg = event.error ? `${event.error.name || ''}: ${event.error.message || ''}` : (event.message || 'JS error');
  try { if ($('connectionStatus')) $('connectionStatus').textContent = msg; if (window.__kopilkaSetDiag) window.__kopilkaSetDiag(msg); } catch (_) {}
});
