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
    if (!nodes.has(id)) nodes.set(id, { id, value: '', textContent: '', disabled: false, hidden: false, dataset: {}, attrs: {},
      classList: { toggle() {}, add() {}, remove() {} }, setAttribute(k,v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k] ?? null; }, removeAttribute(k) { delete this.attrs[k]; },
      querySelector() { return null; }, querySelectorAll() { return []; }, focus() {}, remove() { nodes.delete(id); } });
    return nodes.get(id);
  }
  const document = { getElementById: node, querySelectorAll: () => [], querySelector: () => null, body: node('body'), documentElement: node('html') };
  const window = { location: { search: '', hash: '', origin: 'https://local.test', href: 'https://local.test/', pathname: '/' }, localStorage: {}, addEventListener() {},
    history: { state: null, entries: [], replaceState(value) { this.state = value; }, pushState(value) { this.entries.push(this.state); this.state = value; }, back() { this.state = this.entries.pop(); } } };
  const c = vm.createContext({ window, document, console, URL, URLSearchParams, Intl, Date, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, navigator: {}, fetch: () => { throw Error('unexpected network'); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/i18n.js'), 'utf8'), c);
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('(async () => {\n  fireVkBridgeInit();')), c);
  return { c, node, run: (s) => vm.runInContext(s, c) };
}

test('gratitude clears only its own draft and commits even if secondary reads fail', async () => {
  const { run, node } = client();
  node('entryNote').value = 'unrelated draft'; node('gratitudeNote').value = 'thanks';
  run(`renderAll = () => {}; api = async () => ({ summary: {}, week: {} }); refreshProduct = async () => { throw Error('offline'); }; loadHistory = async () => {};`);
  await run(`createEntry('gratitude', 'thanks')`);
  assert.equal(node('entryNote').value, 'unrelated draft');
  assert.equal(node('gratitudeNote').value, '');
  assert.match(node('statusRegion').textContent, /записана|сохран/i);
});

test('busy cycle preserves focusable aria-disabled quick action and disabled controls', () => {
  const { run, node, c } = client();
  const quick = node('quick'); quick.dataset.entryType = 'sleep'; quick.setAttribute('aria-disabled', 'true');
  const disabled = node('disabled'); disabled.disabled = true;
  c.document.querySelectorAll = () => [quick, disabled];
  run('setBusy(true); setBusy(false)');
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

test('failed or blocked external opening does not credit a support action', async () => {
  const { run, c } = client();
  c.window.open = () => null;
  run(`state.support = { actions: [{ id: 1, status: 'available', url: 'https://example.org/' }] }; api = () => { throw Error('must not credit'); };`);
  await assert.rejects(run('openSupportAction(1)'), /открыть/);
  assert.equal(run('state.busy'), false);
});
