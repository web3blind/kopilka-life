const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'public/i18n.js'), 'utf8');
const fields = ['contractTitle', 'contractTarget', 'stakeAmount', 'stakeCurrency', 'rewardDescription', 'fundDescription'];

test('each existing bounded contract field has a labeled, quiet, described counter preserving stake hints', () => {
  for (const id of fields) {
    const control = html.match(new RegExp(`<(?:input|textarea) id="${id}"[^>]*>`))[0];
    const counter = html.match(new RegExp(`<p id="${id}Counter"[^>]*>`))[0];
    assert.match(control, new RegExp(`aria-describedby="[^"]*${id}Counter`));
    assert.match(html, new RegExp(`<label for="${id}"`));
    assert.match(counter, new RegExp(`data-contract-counter="${id}"`));
    assert.doesNotMatch(counter, /aria-live|role="(?:status|alert)"/);
  }
  assert.match(html, /aria-describedby="stakeHint stakeFormatHint stakeAmountCounter"/);
  // No new result-note flow: the existing close path still sends no note.
  assert.match(app, /JSON.stringify\(\{ status, resultNote: '' \}\)/);
});

test('counter helper reads native limits and UTF16 lengths without touching values, focus, or selection', () => {
  const source = app.slice(app.indexOf('function updateContractCounters()'), app.indexOf('function renderContract()'));
  assert(source.startsWith('function updateContractCounters()'));
  const dictionary = {};
  vm.runInNewContext(i18n, { window: dictionary, Intl, Date });
  let lang = 'ru';
  const controls = Object.fromEntries(fields.map((id, index) => [id, { value: index ? '' : '🌱', maxLength: 23 + index, selectionStart: 1, selectionEnd: 2 }]));
  const counters = fields.map((id) => ({ dataset: { contractCounter: id }, textContent: '' }));
  const context = { document: { querySelectorAll: () => counters }, $: (id) => controls[id], L: (key, params) => dictionary.KopilkaI18n.t(lang, key, params) };
  vm.createContext(context); vm.runInContext(source, context);
  const before = JSON.stringify(controls);
  context.updateContractCounters();
  assert.equal(counters[0].textContent, '2 из 23 символов');
  assert.equal(counters[1].textContent, '0 из 24 символов');
  assert.equal(JSON.stringify(controls), before);
  lang = 'en'; controls.contractTitle.maxLength = 10; controls.contractTitle.value = 'x'.repeat(11);
  context.updateContractCounters();
  assert.equal(counters[0].textContent, '11 of 10 characters');
  assert.equal(controls.contractTitle.value, 'x'.repeat(11), 'no silent truncation even above native limit');
});

test('contract lifecycle updates counters on render, template application, input/change, and post-native reset', () => {
  const render = app.slice(app.indexOf('function renderContract()'), app.indexOf('function renderContractTemplates()'));
  assert.match(render, /updateContractCounters\(\)/);
  const template = app.slice(app.indexOf('function applyTemplate('), app.indexOf('function renderMergePrompt()'));
  assert.match(template, /await confirmTemplateReplacement\(trigger\)/);
  assert.doesNotMatch(template, /window\.confirm/);
  assert.match(template, /\.value = value;\s*updateContractCounters\(\)/);
  for (const event of ['input', 'change']) assert(app.includes(`$('contractForm').addEventListener('${event}', updateContractCounters)`));
  assert(app.includes("$('contractForm').addEventListener('reset', () => queueMicrotask(updateContractCounters))"));
});
