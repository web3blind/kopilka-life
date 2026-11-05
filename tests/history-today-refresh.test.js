const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/app.js'), 'utf8');
function fixture() {
  const requests = [], handlers = {}, replies = [];
  const context = vm.createContext({ Intl, Date, performance: { now: () => context.now }, now: 0,
    state: { user: { id: 1, timezone: 'UTC' }, historyDate: '2000-01-01', history: { selectedDate: '2000-01-01', todayDate: '2000-01-01' } },
    $: id => ({ addEventListener: (event, fn) => { handlers[id] = fn; }, focus() {} }),
    api: async url => { requests.push(url); const next = replies.shift(); if (next instanceof Error) throw next; return next || { selectedDate: '2026-11-05', todayDate: '2026-11-05', selectedEntries: [{ note: 'external append' }] }; },
    leaveHistoryEditor: async () => context.leave !== false,
    clearHistoryEditor() {}, renderHistory() {}, setStatus() {}, L: x => x,
    setBusy: value => { context.state.busy = value; }, leave: true
  });
  vm.runInContext('let authEpoch=0, historyReadGeneration=0, historyNavigationGeneration=0, historyNavigationBusyOwner=null;', context);
  // Execute the actual declarations and registered handler, not copies of their logic.
  vm.runInContext(source.slice(source.indexOf('function localDay()'), source.indexOf('let refreshedDay')), context);
  vm.runInContext(source.slice(source.indexOf('async function loadHistory('), source.indexOf('function reconcileHistoryEntry(')), context);
  const start = source.indexOf('  // Coalesce only 600ms');
  vm.runInContext(source.slice(start, source.indexOf("  $('historyNext')", start)), context);
  return { context, requests, replies, click: () => handlers.historyToday(), run: code => vm.runInContext(code, context) };
}
test('first same-Today read and later refresh fetch external entries; finite burst never slides', async () => {
  const f = fixture(); await f.click(); assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0], '/api/history?days=7');
  assert.equal(f.context.state.history.selectedEntries[0].note, 'external append');
  for (const now of [100, 300, 590]) { f.context.now = now; await f.click(); }
  assert.equal(f.requests.length, 1);
  f.context.now = 601; await f.click(); assert.equal(f.requests.length, 2);
});
test('failed read immediately retries; failed Previous retires previous successful cooldown', async () => {
  const f = fixture(); f.replies.push(new Error('failed GET')); await f.click();
  assert.equal(f.requests.length, 1); await f.click(); assert.equal(f.requests.length, 2);
  f.replies.push(new Error('failed Previous'));
  await assert.rejects(f.run("navigateHistory('2026-11-04')"));
  await f.click(); assert.equal(f.requests.length, 4);
});
test('canonical server today ignores stale cached todayDate, and local-day change retires cooldown', async () => {
  const f = fixture(); await f.click(); assert.equal(f.requests[0], '/api/history?days=7');
  f.run("localDay = () => 'new-local-day'"); await f.click(); assert.equal(f.requests.length, 2);
});
test('cancelled editor does not read or mark; same-day editor is never skipped', async () => {
  const f = fixture(); f.context.leave = false; f.context.state.historyEditingId = 9;
  await f.click(); assert.equal(f.requests.length, 0);
  f.context.leave = true; await f.click(); assert.equal(f.requests.length, 1);
  await f.click(); assert.equal(f.requests.length, 2);
});
test('identity and read-generation retirement cannot reuse successful cooldown', async () => {
  const f = fixture(); await f.click(); f.run('authEpoch++'); await f.click();
  f.context.state.user.id = 2; await f.click();
  f.run('historyReadGeneration++'); await f.click(); assert.equal(f.requests.length, 4);
});
test('real localDay retires a successful read at midnight and timezone date changes', async () => {
  const f = fixture();
  let instant = '2026-11-05T23:59:59Z';
  f.context.Date = class extends Date { constructor() { super(instant); } };
  const before = f.run('localDay()'); await f.click();
  instant = '2026-11-06T00:00:01Z'; assert.notEqual(f.run('localDay()'), before);
  await f.click(); assert.equal(f.requests.length, 2);
  f.context.state.user.timezone = 'America/Los_Angeles';
  assert.equal(f.run('localDay()'), before);
  await f.click(); assert.equal(f.requests.length, 3);
});
test('in-flight owner or editor retirement cannot apply a read or mark a cooldown', async () => {
  for (const retire of ['authEpoch++', 'state.user.id++', 'historyReadGeneration++']) {
    const f = fixture(); let finish;
    f.context.api = () => new Promise(resolve => { finish = resolve; });
    const pending = f.click();
    // Reach the actual loadHistory await, then retire its owning scope.
    await new Promise(setImmediate);
    assert.ok(finish); f.run(retire);
    finish({ selectedDate: '1999-01-01', todayDate: '1999-01-01' });
    await pending;
    assert.equal(f.context.state.historyDate, '2000-01-01');
    f.context.state.busy = false;
    f.context.api = async url => { f.requests.push(url); return { selectedDate: '2026-11-05', todayDate: '2026-11-05' }; };
    await f.click(); assert.equal(f.requests.length, 1);
  }
});
test('stale navigation never returns success or creates a cooldown', async () => {
  const f = fixture(); f.context.api = async () => { f.run('historyReadGeneration++'); return { selectedDate: '2026-11-05' }; };
  assert.notEqual(await f.run("navigateHistory('')"), true);
  f.context.api = async url => { f.requests.push(url); return { selectedDate: '2026-11-05', todayDate: '2026-11-05' }; };
  await f.click(); assert.equal(f.requests.length, 1);
});
