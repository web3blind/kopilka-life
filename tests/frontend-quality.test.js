'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Execute the actual client functions without network/bootstrap side effects.
function client() {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', textContent: '', disabled: false, hidden: false, dataset: {}, attrs: {}, listeners: {}, style: {},
      addEventListener(kind, callback) { this.listeners[kind] = callback; },
      classList: { toggle() {}, add() {}, remove() {} }, setAttribute(k,v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k] ?? null; }, removeAttribute(k) { delete this.attrs[k]; },
      querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return this; }, replaceChildren() {}, focus() {}, remove() { nodes.delete(id); } });
    return nodes.get(id);
  }
  const document = { getElementById: node, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, body: node('body'), documentElement: node('html') };
  const saved = new Map();
  const window = { scrollX: 0, scrollY: 0, scrollTo(x,y) { this.scrollX=x; this.scrollY=y; }, location: { search: '', hash: '', origin: 'https://local.test', href: 'https://local.test/', pathname: '/' }, localStorage: { getItem: k => saved.get(k), setItem: (k, v) => saved.set(k, v), removeItem: k => saved.delete(k) }, addEventListener() {},
    history: { state: null, entries: [], replaceState(value) { this.state = value; }, pushState(value) { this.entries.push(this.state); this.state = value; }, back() { this.state = this.entries.pop(); } } };
  const c = vm.createContext({ window, document, console, URL, URLSearchParams, Intl, Date, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, navigator: {}, fetch: () => { throw Error('unexpected network'); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/i18n.js'), 'utf8'), c);
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('(async () => {\n  fireVkBridgeInit();')), c);
  return { c, node, run: (s) => vm.runInContext(s, c) };
}

test('Honest step compass is font-independent while other and used icons stay unchanged', () => {
  const { run } = client();
  const svg = run('quickActionIcon(I18N.entryType("ru", "honest_step"), false)');
  assert.match(svg, /^<svg /);
  assert.match(svg, /viewBox="0 0 24 24"/);
  assert.match(svg, /aria-hidden="true" focusable="false"/);
  assert.doesNotMatch(svg, /🧭|<text/);
  assert.equal(run('quickActionIcon(I18N.entryType("ru", "sleep"), false)'), run('escapeHtml(I18N.entryType("ru", "sleep").icon)'));
  assert.equal(run('quickActionIcon(I18N.entryType("en", "honest_step"), true)'), '<img src="/assets/day-scene/honest_step.webp?v=1" alt="" width="30" height="30" decoding="async">');
  assert.equal(run('quickActionIcon({type:"other",icon:"<script>"}, false)'), '&lt;script&gt;');
});

test('gratitude clears only its own draft and commits even if secondary reads fail', async () => {
  const { run, node } = client();
  node('entryNote').value = 'unrelated draft'; node('gratitudeNote').value = 'thanks';
  run(`renderAll = renderQuickActions = renderSummary = renderHistory = () => {}; api = async () => ({ summary: {}, week: {} }); refreshProduct = async () => { throw Error('offline'); }; loadHistory = async () => {};`);
  await run(`createEntry('gratitude', 'thanks')`);
  assert.equal(node('entryNote').value, 'unrelated draft');
  assert.equal(node('gratitudeNote').value, '');
  assert.match(node('statusRegion').textContent, /записана|сохран/i);
});

test('busy cycle preserves focusable aria-disabled quick action and disabled controls', () => {
  const { run, node, c } = client();
  const quick = node('quick'); quick.dataset.entryType = 'sleep'; quick.setAttribute('aria-disabled', 'true');
  const disabled = node('disabled'); disabled.disabled = true;
  c.document.querySelectorAll = selector => selector === 'button,input,textarea,select' ? [quick, disabled] : [];
  run('setBusy(true)');
  assert.equal(quick.disabled, false, 'saving must not remove the active quick action from the accessibility tree');
  assert.equal(disabled.disabled, true);
  run('setBusy(false)');
  assert.equal(quick.disabled, false); assert.equal(disabled.disabled, true);
});

test('requestJson bounds a stalled response and aborts its fetch', async () => {
  const { run, c } = client();
  let aborted = false;
  c.setTimeout = (fn) => setTimeout(fn, 5);
  c.fetch = (_path, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }));
  await assert.rejects(run(`requestJson('/api/me')`), /время|tim|ответ/i);
  assert.equal(aborted, true);
});

test('settings rendering does not overwrite an unsaved form', () => {
  const { run, node } = client();
  node('timezone').value = 'UTC';
  run(`state.user = { timezone: 'Europe/Moscow' }; state.settingsDirty = true; renderVkReminderOffer = () => {}; renderMergePrompt = () => {}; renderSettings();`);
  assert.equal(node('timezone').value, 'UTC');
});

test('VK permission waits are single-flight and cannot save after account replacement', async () => {
  const { run, c } = client();
  let resolveBridge; let sends = 0; let writes = 0;
  c.bridgeRequest = () => { sends++; return new Promise(resolve => { resolveBridge = resolve; }); };
  c.permissionSave = async () => { writes++; return { user: { id: 10 } }; };
  run(`state.user = { id: 10 }; state.token = 'fixture'; isVkMiniApp = () => true;
    getPublicConfig = async () => ({ vkGroupId: 1, vkMessagesEnabled: true });
    clientLog = () => {}; renderAll = () => {}; api = permissionSave;
    window.vkBridge = { send: bridgeRequest };`);
  const pending = run('enableVkReminders()');
  await new Promise(setImmediate);
  await run('enableVkReminders()');
  assert.equal(sends, 1); assert.equal(run('state.busy'), false);
  run('setVerifiedUser({ id: 20 })');
  resolveBridge({ result: true }); await pending;
  assert.equal(writes, 0); assert.equal(run('state.user.id'), 20);
});

test('VK permission save waits for an existing foreground mutation without releasing its lock', async () => {
  const { run, c } = client();
  let resolveBridge; let releaseForeground; let writes = 0;
  c.bridgeRequest = () => new Promise(resolve => { resolveBridge = resolve; });
  c.foreground = () => new Promise(resolve => { releaseForeground = resolve; });
  c.permissionSave = async () => { writes++; return { user: { id: 10, vkMessagesAllowed: true } }; };
  run(`state.user = { id: 10 }; state.token = 'fixture'; isVkMiniApp = () => true;
    getPublicConfig = async () => ({ vkGroupId: 1, vkMessagesEnabled: true });
    clientLog = () => {}; renderAll = () => {}; api = permissionSave;
    window.vkBridge = { send: bridgeRequest };`);
  const permission = run('enableVkReminders()'); await new Promise(setImmediate);
  const busy = run("withBusy('Foreground save', foreground)");
  resolveBridge({ result: true }); await new Promise(setImmediate);
  assert.equal(writes, 0); assert.equal(run('state.busy'), true);
  releaseForeground(); await busy; await permission;
  assert.equal(writes, 1); assert.equal(run('state.busy'), false);
});

test('email link controls follow verified linked status and return after unlink', async () => {
  const { run, node } = client();
  run(`state.user = { id: 10 }; api = async () => ({ email: true, google: false }); refreshLinkedLogins();`);
  await new Promise(setImmediate);
  assert.equal(node('linkEmailForm').hidden, true);
  assert.equal(node('linkEmailCodeForm').hidden, true);
  assert.equal(node('unlinkLoginAccounts').hidden, false);
  assert.match(node('linkedLoginsStatus').textContent, /E-mail: привязан/);
  run(`api = async () => ({ email: false, google: false }); refreshLinkedLogins();`);
  await new Promise(setImmediate);
  assert.equal(node('linkEmailForm').hidden, false);
  assert.equal(node('unlinkLoginAccounts').hidden, true);
  run(`api = async () => ({ email: false, google: true }); refreshLinkedLogins();`);
  await new Promise(setImmediate);
  assert.equal(node('linkEmailForm').hidden, false);
  assert.equal(node('unlinkLoginAccounts').hidden, false);
});

test('Google link control follows verified identity and returns after unlink', async () => {
  const { run, node } = client();
  run(`state.user = { id: 10 }; api = async () => ({ email: false, google: true }); refreshLinkedLogins();`);
  await new Promise(setImmediate);
  assert.equal(node('linkGoogleAccount').hidden, true);
  run(`api = async () => ({ email: false, google: false }); refreshLinkedLogins();`);
  await new Promise(setImmediate);
  assert.equal(node('linkGoogleAccount').hidden, false);
});

test('VK OAuth pending merge preview opens the actual profile confirmation and preserves explicit choice', async () => {
  const { run, node } = client();
  run(`state.user = { id: 10, locale: 'ru' }; state.token = 'fixture'; storage.set('kopilkaVkMergeToken', 'fixture-merge-token');
    api = async (path) => { if (path !== '/api/account/merge-vk/preview') throw Error('unexpected write');
      return { mergeToken: 'fixture-merge-token', preview: { primary: { id: 10, firstName: 'Target' }, source: { id: 20, firstName: 'Source' }, result: { movedEntries: 1 }, blocking: [], canMerge: true } }; };`);
  await run('loadPendingMerge()');
  assert.equal(run('state.activeTab'), 'profile');
  assert.equal(node('accountMergePrompt').hidden, false);
  assert.match(node('accountMergePrompt').innerHTML, /Target.*10/);
  assert.match(node('accountMergePrompt').innerHTML, /Source.*20/);
  assert.match(node('accountMergePrompt').innerHTML, /id="confirmAccountMerge"/);
  assert.match(node('accountMergePrompt').innerHTML, /id="cancelAccountMerge"/);
  assert.equal(run('state.pendingMerge.mergeToken'), 'fixture-merge-token');
});

test('identity proof preview is read-only until explicit confirmation and cancel discards the offer', async () => {
  const { run, node } = client();
  const token = 'a'.repeat(43);
  run(`state.user = { id: 10, locale: 'ru' }; state.token = 'fixture';
    showIdentityMerge({ mergeToken: '${token}', preview: { primary: { id: 10, firstName: 'Target' }, source: { id: 20, firstName: 'Source' },
      result: { retainedLogins: ['email','google'], timezone: 'UTC', movedEntries: 2 }, blocking: [], canMerge: true } });`);
  assert.match(node('accountMergePrompt').innerHTML, /email, google/);
  assert.match(node('accountMergePrompt').innerHTML, /id="confirmAccountMerge"/);
  run(`window.recorded = []; api = async (path, opts) => { window.recorded.push([path, JSON.parse(opts.body)]);
    return { mergeToken: '${token}', preview: state.pendingMerge.preview }; };`);
  await run('loadPendingMerge()');
  assert.equal(run('window.recorded[0][0]'), '/api/account/merge-identity/preview');
  assert.equal(run('window.recorded.length'), 1);
  run('api = async (path, opts) => { window.recorded.push([path, JSON.parse(opts.body)]); throw Error("stop before commit"); }; withBusy = (_, fn) => fn();');
  await assert.rejects(run('confirmAccountMerge()'), /stop before commit/);
  assert.equal(run('window.recorded[1][0]'), '/api/account/merge-identity/confirm');
  assert.equal(run('window.recorded[1][1].confirm'), true);
  run('cancelAccountMerge()');
  assert.equal(run('state.pendingMerge'), null);
  assert.equal(run('storage.get("kopilkaVkMergeToken")'), '');
});

test('Telegram handoff UI requires explicit Mini App consent and initiating-session completion', async () => {
  const { run, node, c } = client();
  const intent = 'a'.repeat(43);
  c.document.querySelector = () => node('generic');
  c.window.setInterval = () => 1;
  run(`state.user = { id: 10, telegramLinked: false, locale: 'ru' }; state.token = 'initiator';
    getPublicConfig = async () => ({ botUsername: 'fixture_bot', telegramLoginWidgetEnabled: false });
    window.calls = []; api = async (path, opts) => { window.calls.push([path, opts]);
      if (path === '/api/settings/telegram-link-intent') return { intent: '${intent}', launchUrl: 'https://t.me/fixture_bot?startapp=link_${intent}' };
      if (path === '/api/settings/telegram-link-complete') return { pending: true };
      if (path === '/api/auth/telegram-link-claim') return { ok: true };
    }; bindEvents();`);
  await node('linkTelegramAccount').listeners.click();
  assert.equal(node('telegramLinkOpen').href, `https://t.me/fixture_bot?startapp=link_${intent}`);
  assert.equal(node('telegramLinkHandoff').hidden, false);
  assert.equal(run('window.calls.length'), 1, 'no merge before proof');
  c.window.Telegram = { WebApp: { initData: `start_param=link_${intent}&hash=fixture` } };
  run('showTelegramLinkClaim()');
  assert.equal(node('telegramLinkClaim').hidden, false);
  assert.equal(run('window.calls.some(([path]) => path === "/api/auth/telegram-link-claim" || path === "/api/settings/telegram-link-complete")'), false, 'showing proof prompt does not claim or complete');
  await node('telegramLinkConsent').listeners.click();
  assert.equal(run('window.calls.at(-1)[0]'), '/api/auth/telegram-link-claim');
  assert.equal(run('window.calls.at(-1)[1].authToken'), '');
  await node('telegramLinkFinish').listeners.click();
  assert.equal(run('window.calls.at(-1)[0]'), '/api/settings/telegram-link-complete');
  assert.equal(run('window.calls.at(-1)[1].body'), JSON.stringify({ intent }));
  assert.equal(node('telegramLinkHandoff').hidden, false, 'pending confirmation keeps original context');
});

test('practice options are refreshed on locale switch', () => {
  const { run, node } = client(); node('practiceGoal').options = [{}];
  run(`state.product = { practices: { goals: [{ id: 'calm', title: 'Calm' }], goal: 'calm', practices: [] } }; renderPractices();`);
  assert.match(node('practiceGoal').innerHTML || '', /Calm/);
});

test('history editor preserves merged notes above the normal length limit', () => {
  const { run, node, c } = client();
  c.document.getElementById = (id) => id.startsWith('history-note-') ? null : node(id);
  for (const length of [0, 1200, 4010]) {
    run(`state.historyEditingId = 1; state.history = { selectedDate: '2026-09-19', days: [], selectedEntries: [{ id: 1, editable: true, note: 'x'.repeat(${length}) }] }; renderHistory();`);
    assert.match(node('selectedDayEntries').innerHTML, new RegExp(`maxlength="${Math.max(2000, length)}"`));
    assert.ok(node('selectedDayEntries').innerHTML.includes('x'.repeat(length)));
  }
});

test('merge blockers render their own localized reason and never allow confirmation', () => {
  const { run, node } = client();
  const cases = [
    ['active_contract_conflict', /активный договор/, /active contract/],
    ['source_telegram_conflict', /отдельным Telegram/, /separate Telegram/],
    ['primary_vk_conflict', /другим VK/, /another VK/],
    ['support_metadata_conflict', /данные полезных действий различаются/, /records differ/],
    ['unknown_future_reason', /сохранности данных/, /preserve your data/]
  ];
  for (const [reason, ru, en] of cases) for (const [locale, expected] of [['ru', ru], ['en', en]]) {
    run(`state.user = { locale: '${locale}' }; state.pendingMerge = { preview: { blocking: ['${reason}'] } }; renderMergePrompt();`);
    assert.match(node('accountMergePrompt').innerHTML, expected);
    assert.doesNotMatch(node('accountMergePrompt').innerHTML, /id="confirmAccountMerge"/);
  }
});

test('reverse merge shows precise blocked provider conflict without confirmation', () => {
  const { run, node } = client();
  run(`state.user = { locale: 'ru' }; state.pendingMerge = { preview: {
    primary: { id: 10, firstName: 'VK' }, source: { id: 20, firstName: 'Google' },
    result: { transferLogins: true }, blocking: ['source_identity_conflict'], canMerge: false } }; renderMergePrompt();`);
  assert.match(node('accountMergePrompt').innerHTML, /VK.*10/);
  assert.match(node('accountMergePrompt').innerHTML, /Google.*20/);
  assert.match(node('accountMergePrompt').innerHTML, /в обоих аккаунтах/);
  assert.doesNotMatch(node('accountMergePrompt').innerHTML, /id="confirmAccountMerge"/);
});

test('tab history leaves legal-reader entries alone and restores the app afterward', () => {
  const { run, c } = client();
  run(`saveNavigation(true); switchTab('week');`);
  assert.equal(c.window.history.state.kopilkaView.tab, 'week');
  const week = c.window.history.state;
  c.document.querySelector = () => ({ open: true });
  run(`switchTab('settings'); restoreNavigation({ state: { kopilkaView: { owner: navigationOwner, tab: 'week' } } });`);
  assert.equal(run('state.activeTab'), 'settings');
  c.document.querySelector = () => null;
  c.targetState = week;
  run(`restoreNavigation({ state: targetState });`);
  assert.equal(run('state.activeTab'), 'week');
  run(`restoreNavigation({ state: { kopilkaView: { owner: 'foreign', tab: 'today' } } });`);
  assert.equal(run('state.activeTab'), 'week');
});

test('artifact queue uses one history entry, closes back to tab, and restores forward', () => {
  const { run, c, node } = client();
  c.HTMLElement = class {};
  run(`saveNavigation(true); switchTab('week'); showArtifactToast([{ id: 1, title: 'One' }, { id: 2, title: 'Two' }]);`);
  const entries = c.window.history.entries.length;
  run('hideArtifactToast()');
  assert.equal(c.window.history.entries.length, entries);
  assert.equal(run('state.artifactQueue[0].id'), 2);
  c.forwardState = c.window.history.state;
  run('hideArtifactToast(); restoreNavigation({ state: window.history.state });');
  assert.equal(run('state.activeTab'), 'week');
  assert.equal(node('artifactToast').hidden, true);
  run('restoreNavigation({ state: forwardState });');
  assert.equal(run('state.artifactQueue[0].id'), 2);
  assert.equal(node('artifactToast').hidden, false);
});

test('contract template cancellation preserves every nonempty draft field', async () => {
  const { run, node } = client();
  const fields = ['contractTitle', 'contractTarget', 'stakeAmount', 'stakeCurrency', 'rewardDescription', 'fundDescription'];
  fields.forEach((id, i) => { node(id).value = `draft ${i}`; });
  run(`state.user={id:1}; state.activeTab='contract'; confirmTemplateReplacement=async()=>false;`);
  await run(`state.product = { contractTemplates: [{id:'new', title:'New', targetValue:'Goal'}] }; applyTemplate('new');`);
  fields.forEach((id, i) => assert.equal(node(id).value, `draft ${i}`));
  run(`confirmTemplateReplacement=async()=>true`);
  await run(`applyTemplate('new')`);
  assert.equal(node('contractTitle').value, 'New');
  assert.equal(node('contractTarget').value, 'Goal');
  assert.equal(node('stakeCurrency').value, 'RUB');
});

test('template replacement cannot cross a changed draft, identity, tab, read-only mode or busy state', async () => {
  for (const change of ["$('contractTitle').value='newer draft'", 'authEpoch++', 'state.user={id:2}', "state.activeTab='today'", 'state.publicReadOnly=true', 'state.busy=true']) {
    const { run, node, c } = client();
    node('contractTitle').value = 'original draft';
    let decide;
    c.chooseTemplate = () => new Promise(resolve => { decide = resolve; });
    run(`state.user={id:1};state.activeTab='contract';state.product={contractTemplates:[{id:'new',title:'New',targetValue:'Goal'}]};confirmTemplateReplacement=chooseTemplate;`);
    const pending = run(`applyTemplate('new')`);
    run(change); decide(true); await pending;
    assert.notEqual(node('contractTitle').value, 'New', change);
  }
});

test('7639521 dismissed Ready ignores late duplicates but preserves newer warnings and a new identity', () => {
  const { run, node } = client();
  run(`state.user={id:1};setStatus(L('ready'),'info','ready')`);
  node('dismissStatus').onclick();
  assert.equal(node('statusRegion').textContent, '');
  run(`setStatus(L('ready'),'info','ready')`);
  assert.equal(node('statusRegion').textContent, '');
  run(`setStatus('durable warning','error');setStatus(L('ready'),'info','ready')`);
  assert.equal(node('statusRegion').textContent, 'durable warning');
  run(`setVerifiedUser({id:2});setStatus(L('ready'),'info','ready')`);
  assert.notEqual(node('statusRegion').textContent, '');
  assert.equal(node('dismissStatus').hidden, false);
});

test('history day navigation finishes its loading status in both locales', async () => {
  const { run, node } = client();
  for (const lang of ['ru', 'en']) {
    run(`state.user = {locale:'${lang}'}; loadHistory = async () => {};`);
    await run(`navigateHistory('2026-10-05')`);
    assert.equal(run('state.busy'), false);
    assert.doesNotMatch(node('statusRegion').textContent, /Загружаем|Loading|undefined/);
    assert.match(node('statusRegion').textContent, /История обновлена|History updated/);
  }
});

test('VK app links use the actual supported bridge method and failed opening cannot credit', async () => {
  const { run, c, node } = client();
  c.window.location.search = '?vk_app_id=54723764&vk_user_id=1&sign=fixture';
  const calls = [];
  c.window.vkBridge = { send: async (method, params) => { calls.push([method, params]); return {result: true}; } };
  await run(`openPlatformUrl('https://vk.ru/app12345#path=start')`);
  assert.equal(calls[0][0], 'VKWebAppOpenApp');
  assert.equal(calls[0][1].app_id, 12345);
  assert.equal(calls[0][1].location, 'path=start');
  c.window.vkBridge.send = async () => { throw {error_data: {error_reason: 'not supported'}}; };
  run(`state.support = {actions:[{id:1,status:'available',url:'https://vk.ru/app12345'}]}; api = () => { throw Error('must not credit'); };`);
  await assert.rejects(run('openSupportAction(1)'), /открыть/);
  assert.equal(run('state.busy'), false);
  assert.notEqual(run(`L('supportOpenFailed')`), undefined);
});

test('failed or blocked external opening does not credit a support action', async () => {
  const { run, c } = client();
  c.window.open = () => null;
  run(`state.support = { actions: [{ id: 1, status: 'available', url: 'https://example.org/' }] }; api = () => { throw Error('must not credit'); };`);
  await assert.rejects(run('openSupportAction(1)'), /открыть/);
  assert.equal(run('state.busy'), false);
});
