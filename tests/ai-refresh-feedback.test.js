'use strict';
// node --test tests/ai-refresh-feedback.test.js
// RED without checkout: save `git show 06fd6ed:public/ai-weekly.js` to a scratch
// file, then AI_REFRESH_SOURCE=/absolute/scratch/file node --test <this-file>.
// Component contracts only; the audit's 22 connected cases remain the E2E evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const source = readFileSync(process.env.AI_REFRESH_SOURCE ||
  join(__dirname, '../public/ai-weekly.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const copy = {
  ru: { refresh: 'Обновить сведения', checking: 'Проверяем сведения…',
    checked: 'Статус обновлён. Новый запрос к ИИ не отправлялся.',
    deleted: 'Текст выжимки удалён.', error: 'Не удалось получить сведения.',
    auth: 'Нужно восстановить вход.' },
  en: { refresh: 'Refresh information', checking: 'Refreshing information…',
    checked: 'Status refreshed. No new AI request was sent.',
    deleted: 'Digest text deleted.', error: 'Could not load the information.',
    auth: 'Please restore your sign-in.' }
};
function metadata(status = null, key = 'week-7') {
  return { available: true, provider: 'Google Gemini', model: 'fixture-model',
    paidMode: false, consentVersion: 'fixture-v1', quota: { allowed: !status },
    period: { key, start: '2026-10-25', end: '2026-10-31', timezone: 'UTC' },
    summary: status ? { id: 'digest-1', status, text: status === 'ready' ? 'Saved facts' : null } : null,
    archive: [] };
}
function harness(language) {
  // Deliberately small DOM surface: unknown IDs/selectors fail instead of silently
  // manufacturing elements. Production event handlers and rendering run unchanged.
  const nodes = new Map();
  const document = { activeElement: null, getElementById: id => nodes.get(id) || null,
    createElement: tag => new Element(tag) };
  class Element {
    constructor(tag = 'div', id = '') {
      Object.assign(this, { tag, id, children: [], dataset: {}, value: '', textContent: '',
        disabled: false, hidden: false, checked: false, attributes: {}, listeners: {} });
      this.classList = { toggle() {} };
      if (id) nodes.set(id, this);
    }
    append(child) { this.children.push(child); if (child.id) nodes.set(child.id, child); }
    replaceChildren() {
      const forget = node => { if (node.id) nodes.delete(node.id); node.children.forEach(forget); };
      this.children.forEach(forget); this.children = [];
    }
    setAttribute(key, value) { this.attributes[key] = value; }
    focus() { document.activeElement = this; }
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
    fire(type) { return Promise.all((this.listeners[type] || []).map(fn => fn({ type, target: this }))); }
    get selectedOptions() { return this.children.filter(child => child.value === this.value); }
    querySelector(selector) {
      const match = /^\[value="([^"]+)"\]$/.exec(selector);
      if (match) return this.children.find(child => child.value === match[1]) || null;
      return this.querySelectorAll(selector)[0] || null;
    }
    querySelectorAll(selector) {
      const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
      const all = descendants(this);
      if (selector === '[data-ai-text]') return all.filter(n => n.dataset.aiText);
      const text = /^\[data-ai-text="([^"]+)"\]$/.exec(selector);
      if (text) return all.filter(n => n.dataset.aiText === text[1]);
      if (selector === '.ai-weekly-saved button') return all.filter(n =>
        n.className === 'ai-weekly-saved').flatMap(n => n.children.filter(c => c.tag === 'button'));
      throw new Error(`Unsupported DOM selector: ${selector}`);
    }
  }
  const root = new Element('section', 'aiWeekly');
  for (const suffix of ['Retention', 'DataDisclosure', 'Provider', 'ConsentBox', 'Privacy',
    'Period', 'Status', 'CustomBox', 'SelectionError', 'Topic', 'Purpose', 'Quota', 'Consent',
    'Create', 'Refresh', 'Recover', 'Days', 'CustomDays', 'DeleteQuestion', 'Archive',
    'Result', 'ArchiveItems', 'Heading', 'DeleteConfirm', 'DeleteCancel', 'DeleteYes']) {
    root.append(new Element('div', `aiWeekly${suffix}`));
  }
  const el = suffix => nodes.get(`aiWeekly${suffix}`);
  for (const [suffix, key] of [['Refresh', 'refresh'], ['Create', 'start']]) el(suffix).dataset.aiText = key;
  for (const key of ['policy', 'consent']) {
    const node = new Element(); node.dataset.aiText = key; root.append(node);
  }
  el('Days').value = '7'; el('CustomDays').value = '7';
  const calls = [];
  let who = 'owner-A';
  const api = (url, options = {}) => {
    assert.equal(options.method || 'GET', 'GET', 'metadata refresh must never generate/delete');
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    calls.push({ url, resolve, reject }); return promise;
  };
  const context = { window: {}, document };
  vm.runInNewContext(source, context, { filename: 'public/ai-weekly.js', timeout: 1000 });
  const app = context.window.KopilkaAiWeekly.create({ api, locale: () => language, identity: () => who });
  app.sync();
  return { app, el, calls, document, status: () => el('Status').textContent,
    owner(value) { who = value; app.sync(); },
    async seed(data) { const done = app.load(); calls.at(-1).resolve(data); await done; },
    async consent() { el('Consent').checked = true; await el('Consent').fire('change'); } };
}

for (const language of ['ru', 'en']) {
  const text = copy[language];
  test(`${language}: manual refresh exposes loading/completion and preserves saved nodes`, async () => {
    for (const state of ['deleted', 'ready']) {
      const h = harness(language);
      await h.seed(metadata(state));
      const before = h.status();
      const saved = h.el('Result').children[0];
      if (saved) saved.children.at(-1).focus();
      const focused = h.document.activeElement;
      const count = h.calls.length;
      const done = h.el('Refresh').fire('click');
      assert.equal(h.calls.length, count + 1, 'exactly one read per click');
      assert.equal(h.status(), text.checking);
      assert.equal(h.el('Refresh').textContent, text.refresh);
      assert.equal(h.el('Refresh').disabled, true);
      assert.equal(h.el('Result').attributes['aria-busy'], 'true');
      h.calls.at(-1).resolve(metadata(state)); await done;
      assert.equal(h.status(), `${before} ${text.checked}`);
      assert.equal(h.el('Refresh').disabled, false);
      assert.equal(h.el('Result').attributes['aria-busy'], 'false');
      assert.equal(h.el('Result').children[0], saved, 'unchanged result is not rebuilt');
      assert.equal(h.document.activeElement, focused);
    }
  });
  test(`${language}: successful refresh leaves consented Prepare available; implicit reads do not claim completion`, async () => {
    const h = harness(language);
    await h.seed(metadata()); await h.consent();
    assert.equal(h.status(), '');
    assert.equal(h.el('Create').hidden, false);
    assert.equal(h.el('Create').disabled, false);
    const done = h.el('Refresh').fire('click');
    assert.equal(h.el('Create').disabled, true);
    h.calls.at(-1).resolve(metadata()); await done;
    assert.equal(h.status(), text.checked);
    assert.equal(h.el('Consent').checked, true);
    assert.equal(h.el('Create').hidden, false);
    assert.equal(h.el('Create').disabled, false, 'completion feedback must not gate Prepare');
    await h.seed(metadata());
    assert.equal(h.status(), '');
    const changed = h.el('Refresh').fire('click');
    h.calls.at(-1).resolve({ ...metadata(), model: 'different-model' }); await changed;
    assert.equal(h.el('Consent').checked, false, 'changed disclosure requires new consent');
    assert.equal(h.el('Create').disabled, true);
  });
  test(`${language}: failed/auth refresh clears consent and never announces success or retries`, async () => {
    for (const status of [503, 401]) {
      const h = harness(language);
      await h.seed(metadata()); await h.consent();
      const done = h.el('Refresh').fire('click');
      h.calls.at(-1).reject(Object.assign(new Error('controlled read failure'), { status }));
      await done; await tick();
      assert.ok(h.status().startsWith(status === 401 ? text.auth : text.error));
      assert.equal(h.status().includes(text.checked), false);
      assert.equal(h.el('Consent').checked, false);
      assert.equal(h.el('Result').attributes['aria-busy'], 'false');
      assert.equal(h.el('Recover').hidden, status !== 401);
      assert.equal(h.el('Refresh').hidden, status === 401);
      assert.equal(h.calls.length, 2, 'no automatic retry');
    }
  });
  test(`${language}: selection and identity fence late reads, including stale auth failures`, async () => {
    const h = harness(language);
    await h.seed(metadata()); await h.consent();
    const stale = h.el('Refresh').fire('click');
    const old = h.calls.at(-1);
    h.el('Days').value = '14'; h.el('Topic').value = 'rest';
    await h.el('Days').fire('change');
    assert.equal(h.el('Consent').checked, false);
    assert.equal(h.calls.at(-1).url, '/api/ai-weekly-summary?days=14&topic=rest');
    old.resolve(metadata('deleted')); await stale;
    assert.equal(h.status(), text.checking, 'stale finally must not clear newer loading');
    h.calls.at(-1).resolve(metadata(null, 'week-14')); await tick();
    assert.equal(h.status(), '', 'selection read is not a manual completion');
    const identityStale = h.el('Refresh').fire('click');
    const oldOwner = h.calls.at(-1);
    h.owner('owner-B');
    await h.seed(metadata('deleted', 'owner-B-week'));
    const current = h.status();
    oldOwner.reject(Object.assign(new Error('old owner expired'), { status: 401 }));
    await identityStale;
    assert.equal(h.status(), current);
    assert.ok(h.status().startsWith(text.deleted));
    assert.equal(h.el('Recover').hidden, true);
    assert.equal(h.el('Consent').checked, false);
    h.el('Days').value = 'other'; h.el('CustomDays').value = '31';
    const count = h.calls.length;
    await h.el('Days').fire('change'); await h.el('Refresh').fire('click');
    assert.equal(h.calls.length, count, 'invalid selection cannot issue a read');
    assert.equal(h.el('Refresh').disabled, true);
  });
}
