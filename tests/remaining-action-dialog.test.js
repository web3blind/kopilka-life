'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function statuses() {
  const region = { textContent: '', classList: { error: false, contains() { return this.error; }, toggle(_key, value) { this.error = value; } } };
  const ctx = vm.createContext({ state: { activeTab: 'support', refreshFailed: false }, statusRevision: 0, statusCategory: 'info', statusReturnFocus: null, document: { activeElement: null }, $: id => id === 'statusRegion' ? region : null, L: key => key, syncStatusDismiss() {} });
  const source = app.slice(app.indexOf('let supportActionNotice = null;'), app.indexOf('function setLoginStatus('));
  vm.runInContext(source, ctx);
  return { ctx, region, run: code => vm.runInContext(code, ctx) };
}
test('only Useful action errors clear; durable warning is restored, repeated failure does not lose it', () => {
  const { ctx, region, run } = statuses();
  run("setStatus('durable recovery / merge / unsaved warning', 'error'); previous = captureSupportStatus(); setStatus('opening'); setSupportActionError('action failed', previous)");
  assert.equal(ctx.statusCategory, 'support-action-error');
  assert.equal(region.textContent, 'action failed');
  run("previous = captureSupportStatus(); setStatus('opening'); setSupportActionError('retry failed', previous); clearSupportActionError()");
  assert.equal(region.textContent, 'durable recovery / merge / unsaved warning');
  assert.equal(ctx.statusCategory, 'error');
  run('clearSupportActionError()');
  assert.equal(region.textContent, 'durable recovery / merge / unsaved warning');
});
test('refresh warning/flag survive action failure; suffix is not duplicated on restoration', () => {
  const { ctx, region, run } = statuses();
  run("state.refreshFailed=true;setStatus('committed'); previous=captureSupportStatus();state.refreshFailed=false;setStatus('opening');setSupportActionError('failed',previous);clearSupportActionError()");
  assert.equal(ctx.state.refreshFailed, true);
  assert.equal(region.textContent, 'committed refreshPending');
});
test('a newer durable auth error wins over the pre-action snapshot; unrelated warnings never clear', () => {
  const { ctx, region, run } = statuses();
  run("setStatus('ready');previous=captureSupportStatus();setStatus('opening');setStatus('session expired', 'error');setSupportActionError('action failed',previous);clearSupportActionError()");
  assert.equal(region.textContent, 'session expired');
  run("setStatus('new merge warning','error');clearSupportActionError()");
  assert.equal(region.textContent, 'new merge warning');
  assert.equal(ctx.statusCategory, 'error');
});
test('styled delete gate replaces only entry native confirm and guards ordinary owned entries', () => {
  const flow = app.slice(app.indexOf('let historyDeleteDecision = null;'), app.indexOf('async function creditSupportAction('));
  assert.doesNotMatch(flow, /window\.confirm/);
  assert.match(flow, /await confirmHistoryDelete\(id\)/);
  assert.match(flow, /item\.editable/);
  assert.match(flow, /epoch === authEpoch && userId === state\.user\?\.id/);
  assert.match(flow, /dialog\.className = 'document-dialog'/);
  assert.match(flow, /aria-labelledby/);
  assert.match(flow, /aria-describedby/);
  assert.match(flow, /addEventListener\('cancel'/);
  assert.match(flow, /history\.back\(\)/);
  assert.match(flow, /data-history-delete-choice="cancel"\]'\)\.focus\(\)/);
});
